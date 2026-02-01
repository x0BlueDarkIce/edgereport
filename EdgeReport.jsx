"use client";

import { useState, useCallback, useRef } from "react";

// ─────────────────────────────────────────────
// BENCHMARK
// ─────────────────────────────────────────────
const BENCHMARK_RATIO = 1;

// ─────────────────────────────────────────────
// GUIDE LINKS
// ─────────────────────────────────────────────
const GUIDES = {
  winRate:     "https://vedictrades.blog/how-to-improve-your-win-rate-without-changing-your-strategy/",
  scaling:     "https://vedictrades.blog/the-scaling-guide-how-to-grow-without-blowing-up/",
  overtrading: "https://vedictrades.blog/how-to-fix-overtrading-without-blowing-funded-accounts-2026-free-guide/",
  psychology:  "https://vedictrades.blog/how-to-fix-your-trading-psychology-the-truth-nobody-likes/",
};

// ─────────────────────────────────────────────
// PARSE PnL — handles BOTH formats:
//   CSV:  "$2.00"  |  "$(25.00)"  |  "$1,160.00"
//   XLSX: 450  |  -210  |  0  (raw numbers)
// ─────────────────────────────────────────────
function parsePnL(raw) {
  if (raw === null || raw === undefined || raw === "") return 0;
  if (typeof raw === "number") return raw;
  const s = String(raw).replace(/[\$,\s]/g, "");
  if (s.startsWith("(") && s.endsWith(")")) return -parseFloat(s.slice(1, -1));
  return parseFloat(s) || 0;
}

// ─────────────────────────────────────────────
// PARSE DATE — handles both:
//   CSV:  "01/26/2026 19:02:09"  (string)
//   XLSX: Date object or Excel serial number
// ─────────────────────────────────────────────
function parseDate(raw) {
  if (!raw) return "unknown";
  if (raw instanceof Date) {
    const m = String(raw.getMonth() + 1).padStart(2, "0");
    const d = String(raw.getDate()).padStart(2, "0");
    const y = raw.getFullYear();
    return m + "/" + d + "/" + y;
  }
  return String(raw).trim().split(" ")[0] || "unknown";
}

// ─────────────────────────────────────────────
// CSV PARSER
// ─────────────────────────────────────────────
function parseCSV(text) {
  const lines = text.split(/\r?\n/).filter(l => l.trim());
  if (lines.length < 2) return [];
  function splitRow(line) {
    const cols = []; let cur = ""; let inQ = false;
    for (const ch of line) {
      if (ch === '"') inQ = !inQ;
      else if (ch === ',' && !inQ) { cols.push(cur); cur = ""; }
      else cur += ch;
    }
    cols.push(cur); return cols;
  }
  const headers = splitRow(lines[0]).map(h => h.trim());
  const idx = { sym: headers.indexOf("symbol"), pnl: headers.indexOf("pnl"), buyTs: headers.indexOf("boughtTimestamp") };
  const trades = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = splitRow(lines[i]);
    if (cols.length <= idx.pnl) continue;
    trades.push({
      symbol: (cols[idx.sym] || "").trim(),
      pnl:    parsePnL(cols[idx.pnl]),
      date:   parseDate(cols[idx.buyTs]),
    });
  }
  return trades;
}

// ─────────────────────────────────────────────
// XLSX PARSER — fully native, zero dependencies.
// xlsx = zip of XML. We parse the zip via its central directory (at the end),
// inflate each entry with DecompressionStream, then read sharedStrings + sheet1.
// ─────────────────────────────────────────────

// Find the End-of-Central-Directory record and return the central directory offset
function findCentralDir(buf) {
  for (let i = buf.byteLength - 22; i >= 0; i--) {
    if (buf[i] === 0x50 && buf[i+1] === 0x4b && buf[i+2] === 0x05 && buf[i+3] === 0x06) {
      const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
      return { offset: view.getUint32(i + 16, true), size: view.getUint32(i + 12, true) };
    }
  }
  return null;
}

// Parse central directory → map of name → { data (compressed bytes), compMethod }
function parseZipEntries(buf) {
  const cd = findCentralDir(buf);
  if (!cd) return {};
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const entries = {};
  let off = cd.offset;
  const end = cd.offset + cd.size;
  while (off < end) {
    if (view.getUint32(off, true) !== 0x02014b50) break;
    const compMethod = view.getUint16(off + 10, true);
    const compSize   = view.getUint32(off + 20, true);
    const fnLen      = view.getUint16(off + 28, true);
    const exLen      = view.getUint16(off + 30, true);
    const cmtLen     = view.getUint16(off + 32, true);
    const localOff   = view.getUint32(off + 42, true);
    const name       = new TextDecoder().decode(buf.slice(off + 46, off + 46 + fnLen));
    // local header: skip to actual data
    const localFnLen = view.getUint16(localOff + 26, true);
    const localExLen = view.getUint16(localOff + 28, true);
    const dataStart  = localOff + 30 + localFnLen + localExLen;
    entries[name] = { data: buf.slice(dataStart, dataStart + compSize), compMethod };
    off += 46 + fnLen + exLen + cmtLen;
  }
  return entries;
}

// Inflate one entry using DecompressionStream (browser native)
async function inflateEntry(entry) {
  if (entry.compMethod === 0) return entry.data; // stored, no compression
  const ds = new DecompressionStream("deflate-raw");
  const writer = ds.writable.getWriter();
  writer.write(entry.data);
  writer.close();
  const reader = ds.readable.getReader();
  const chunks = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  const total = chunks.reduce((s, c) => s + c.length, 0);
  const out = new Uint8Array(total);
  let pos = 0;
  chunks.forEach(c => { out.set(c, pos); pos += c.length; });
  return out;
}

// Extract all text contents of a given XML tag
function getXmlText(xml, tag) {
  const re = new RegExp("<" + tag + "[^>]*>([\\s\\S]*?)<\\/" + tag + ">", "g");
  const hits = []; let m;
  while ((m = re.exec(xml)) !== null) hits.push(m[1]);
  return hits;
}

// Excel serial → JS Date
function excelDateToJS(serial) {
  return new Date(Date.UTC(1899, 11, 30) + serial * 86400000);
}

async function parseXLSX(buffer) {
  const buf = new Uint8Array(buffer);
  const entries = parseZipEntries(buf);

  // Shared strings table
  let sharedStrings = [];
  const ssKey = Object.keys(entries).find(k => k.toLowerCase().includes("sharedstrings"));
  if (ssKey) {
    const ssXml = new TextDecoder().decode(await inflateEntry(entries[ssKey]));
    sharedStrings = getXmlText(ssXml, "si").map(si => getXmlText(si, "t").join(""));
  }

  // Sheet1
  const sheetKey = Object.keys(entries).find(k => /sheet1\.xml$/i.test(k));
  if (!sheetKey) return [];
  const sheetXml = new TextDecoder().decode(await inflateEntry(entries[sheetKey]));

  // Parse rows → cells
  const rows = [];
  for (const rowBlock of getXmlText(sheetXml, "row")) {
    const cellRe = /<c\s([^>]*)>([\s\S]*?)<\/c>/g;
    const cells = []; let cm;
    while ((cm = cellRe.exec(rowBlock)) !== null) {
      const typeMatch = cm[1].match(/t="([^"]+)"/);
      const type = typeMatch ? typeMatch[1] : null;
      const valMatch = cm[2].match(/<v>([^<]*)<\/v>/);
      const raw = valMatch ? valMatch[1] : "";
      if (type === "s") cells.push(sharedStrings[parseInt(raw)] || "");
      else if (type === "inlineStr") cells.push(getXmlText(cm[2], "t").join(""));
      else cells.push(raw === "" ? "" : Number(raw));
    }
    rows.push(cells);
  }

  if (rows.length < 2) return [];
  const headers = rows[0].map(h => String(h).trim());
  const idx = { sym: headers.indexOf("symbol"), pnl: headers.indexOf("pnl"), buyTs: headers.indexOf("boughtTimestamp") };

  const trades = [];
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    if (!row || row.length <= idx.pnl) continue;
    let dateVal = row[idx.buyTs];
    if (typeof dateVal === "number" && dateVal > 40000 && dateVal < 60000) dateVal = excelDateToJS(dateVal);
    trades.push({
      symbol: String(row[idx.sym] || "").trim(),
      pnl:    parsePnL(row[idx.pnl]),
      date:   parseDate(dateVal),
    });
  }
  return trades;
}

// ─────────────────────────────────────────────
// COMPUTE METRICS
// ─────────────────────────────────────────────
function computeMetrics(trades) {
  const wins      = trades.filter(t => t.pnl > 0);
  const losses    = trades.filter(t => t.pnl < 0);
  const breakEven = trades.filter(t => t.pnl === 0);
  const totalPnL  = trades.reduce((s, t) => s + t.pnl, 0);
  const avgWin    = wins.length ? wins.reduce((s, t) => s + t.pnl, 0) / wins.length : 0;
  const avgLoss   = losses.length ? Math.abs(losses.reduce((s, t) => s + t.pnl, 0)) / losses.length : 0;
  const winRate   = trades.length ? (wins.length / trades.length) * 100 : 0;
  const rewardRatio = avgLoss ? avgWin / avgLoss : (avgWin > 0 ? Infinity : 0);
  const byDate = {};
  trades.forEach(t => { if (!byDate[t.date]) byDate[t.date] = []; byDate[t.date].push(t); });
  return {
    totalTrades: trades.length, wins: wins.length, losses: losses.length, breakEven: breakEven.length,
    totalPnL, avgWin, avgLoss, winRate, rewardRatio, byDate,
  };
}

// ─────────────────────────────────────────────
// BEHAVIOURAL FLAGS
// ─────────────────────────────────────────────
function detectOvertrading(metrics) {
  const flagged = [];
  Object.entries(metrics.byDate).forEach(([date, dayTrades]) => {
    const w  = dayTrades.filter(t => t.pnl > 0).length;
    const l  = dayTrades.filter(t => t.pnl < 0).length;
    const be = dayTrades.filter(t => t.pnl === 0).length;
    if (dayTrades.length > 4 && be > 1 && l > w && l > be)
      flagged.push({ date, total: dayTrades.length, wins: w, losses: l, be });
  });
  return flagged;
}

function detectRevengeTrades(trades, avgLoss) {
  if (!avgLoss) return [];
  const SPIKE = 2;
  const instances = [];
  for (let i = 2; i < trades.length; i++) {
    if (trades[i-2].pnl > 0 && trades[i-1].pnl > 0 && trades[i].pnl < 0 && Math.abs(trades[i].pnl) >= avgLoss * SPIKE)
      instances.push({
        date: trades[i].date,
        prevWins: [trades[i-2].pnl, trades[i-1].pnl],
        spikeLoss: trades[i].pnl,
        multiplier: (Math.abs(trades[i].pnl) / avgLoss).toFixed(2),
      });
  }
  return instances;
}

// ─────────────────────────────────────────────
// VERDICT ENGINE
// ─────────────────────────────────────────────
function generateVerdict(m) {
  const profitable  = m.totalPnL > 0;
  const rewardGood  = m.rewardRatio >= BENCHMARK_RATIO;
  const winRateGood = m.winRate > 50;

  if (profitable) return [{
    type: "success", title: "Profitable — Consider Scaling Up",
    message: "Your total PnL is +$" + m.totalPnL.toFixed(2) + " — you are in the green. Your reward ratio is " + m.rewardRatio.toFixed(2) + ":1 and your win rate is " + m.winRate.toFixed(1) + "%. Your edge is proven. Now is a great time to consider scaling up to more accounts to multiply your returns systematically.",
    guide: { label: "📈 Free 2026 Scaling Guide", url: GUIDES.scaling },
  }];
  if (rewardGood && !winRateGood) return [{
    type: "warning", title: "Your Reward Is Good — Work On Your Win Rate",
    message: "Your reward ratio is " + m.rewardRatio.toFixed(2) + ":1 (avg win $" + m.avgWin.toFixed(2) + " vs avg loss $" + m.avgLoss.toFixed(2) + ") — when you win, you win well. But your win rate is " + m.winRate.toFixed(1) + "%, below the 50% threshold needed to turn a profit. Focus on only taking your highest-conviction setups.",
    guide: { label: "📖 Free 2026 Win Rate Guide", url: GUIDES.winRate },
  }];
  if (!rewardGood && !winRateGood) return [{
    type: "danger", title: "Work On Your Win Rate First",
    message: "Your reward ratio is " + m.rewardRatio.toFixed(2) + ":1 (avg win $" + m.avgWin.toFixed(2) + " vs avg loss $" + m.avgLoss.toFixed(2) + ") and your win rate is " + m.winRate.toFixed(1) + "% — both below target. Priority fix is your win rate. Once you consistently win above 50%, you can work on extending reward.",
    guide: { label: "📖 Free 2026 Win Rate Guide", url: GUIDES.winRate },
  }];
  if (!rewardGood && winRateGood) return [{
    type: "warning", title: "Win Rate Is Fine — Improve Your Reward Ratio",
    message: "Your win rate is " + m.winRate.toFixed(1) + "% — you win more often than you lose. But your reward ratio is only " + m.rewardRatio.toFixed(2) + ":1 (avg win $" + m.avgWin.toFixed(2) + " vs avg loss $" + m.avgLoss.toFixed(2) + "). Tighten stops and let winners run longer.",
    guide: { label: "📖 Free 2026 Win Rate Guide", url: GUIDES.winRate },
  }];
  return [];
}

// ─────────────────────────────────────────────
// UI
// ─────────────────────────────────────────────
const C = { bg: "#0e1015", card: "rgba(255,255,255,0.035)", border: "rgba(255,255,255,0.08)", muted: "#6b6e7a", accent: "#6366f1" };

function MetricCard({ label, value, sub, color, icon }) {
  const [hov, setHov] = useState(false);
  return (
    <div onMouseEnter={() => setHov(true)} onMouseLeave={() => setHov(false)} style={{
      background: C.card, border: "1px solid " + (hov ? C.accent : C.border),
      borderRadius: 14, padding: "20px 18px", transition: "border-color 0.25s",
    }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <span style={{ fontSize: 10, color: C.muted, textTransform: "uppercase", letterSpacing: 1.4, fontWeight: 600 }}>{label}</span>
        <span style={{ fontSize: 16, opacity: 0.7 }}>{icon}</span>
      </div>
      <div style={{ marginTop: 10, fontSize: 24, fontWeight: 700, color: color || "#fff", fontFamily: "'SF Mono','Fira Code',monospace", letterSpacing: -0.5 }}>{value}</div>
      {sub && <div style={{ marginTop: 3, fontSize: 11, color: "#555" }}>{sub}</div>}
    </div>
  );
}

const ALERT_MAP = {
  success: { bg: "rgba(34,197,94,0.1)",  bdr: "rgba(34,197,94,0.3)",  clr: "#22c55e", ico: "✓" },
  warning: { bg: "rgba(234,179,8,0.1)",  bdr: "rgba(234,179,8,0.3)",  clr: "#eab308", ico: "⚠" },
  danger:  { bg: "rgba(239,68,68,0.1)",  bdr: "rgba(239,68,68,0.3)",  clr: "#ef4444", ico: "!" },
};

function AlertBanner({ alert }) {
  const [hov, setHov] = useState(false);
  const s = ALERT_MAP[alert.type];
  return (
    <div style={{ background: s.bg, border: "1px solid " + s.bdr, borderRadius: 14, padding: "22px 22px" }}>
      <div style={{ display: "flex", gap: 16, alignItems: "flex-start" }}>
        <div style={{
          width: 36, height: 36, borderRadius: "50%", background: s.clr, flexShrink: 0,
          display: "flex", alignItems: "center", justifyContent: "center", fontSize: 17, fontWeight: 800, color: "#fff",
        }}>{s.ico}</div>
        <div>
          <div style={{ fontSize: 15, fontWeight: 700, color: s.clr, marginBottom: 7 }}>{alert.title}</div>
          <p style={{ fontSize: 13.5, color: "#a8aab5", margin: 0, lineHeight: 1.75 }}>{alert.message}</p>
          {alert.guide && (
            <a href={alert.guide.url} target="_blank" rel="noopener noreferrer"
              onMouseEnter={() => setHov(true)} onMouseLeave={() => setHov(false)}
              style={{
                display: "inline-flex", alignItems: "center", gap: 6, marginTop: 16,
                padding: "9px 18px", borderRadius: 8, textDecoration: "none", fontSize: 13, fontWeight: 600,
                color: s.clr, border: "1px solid " + s.bdr,
                background: hov ? "rgba(255,255,255,0.1)" : "rgba(255,255,255,0.05)", transition: "background 0.2s",
              }}>
              {alert.guide.label} <span style={{ fontSize: 11 }}>→</span>
            </a>
          )}
        </div>
      </div>
    </div>
  );
}

function BehaviouralFlag({ type, title, icon, message, days, guide }) {
  const [hov, setHov] = useState(false);
  const colors = {
    overtrading: { bg: "rgba(168,85,247,0.1)", bdr: "rgba(168,85,247,0.3)", clr: "#a855f7" },
    revenge:     { bg: "rgba(251,146,60,0.1)", bdr: "rgba(251,146,60,0.3)", clr: "#fb923c" },
  };
  const s = colors[type];
  return (
    <div style={{ background: s.bg, border: "1px solid " + s.bdr, borderRadius: 14, padding: "20px 22px" }}>
      <div style={{ display: "flex", gap: 14, alignItems: "flex-start" }}>
        <div style={{
          width: 38, height: 38, borderRadius: 10, background: s.clr, flexShrink: 0,
          display: "flex", alignItems: "center", justifyContent: "center", fontSize: 18,
        }}>{icon}</div>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 14, fontWeight: 700, color: s.clr, marginBottom: 5 }}>{title}</div>
          <p style={{ fontSize: 13, color: "#a8aab5", margin: 0, lineHeight: 1.7 }}>{message}</p>
          {days && days.length > 0 && (
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 12 }}>
              {days.map((d, i) => (
                <span key={i} style={{
                  fontSize: 11, fontFamily: "monospace", padding: "4px 10px", borderRadius: 6,
                  background: "rgba(255,255,255,0.06)", border: "1px solid " + s.bdr, color: "#b0b3be",
                }}>{d}</span>
              ))}
            </div>
          )}
          {guide && (
            <a href={guide.url} target="_blank" rel="noopener noreferrer"
              onMouseEnter={() => setHov(true)} onMouseLeave={() => setHov(false)}
              style={{
                display: "inline-flex", alignItems: "center", gap: 6, marginTop: 14,
                padding: "8px 16px", borderRadius: 8, textDecoration: "none", fontSize: 12.5, fontWeight: 600,
                color: s.clr, border: "1px solid " + s.bdr,
                background: hov ? "rgba(255,255,255,0.1)" : "rgba(255,255,255,0.05)", transition: "background 0.2s",
              }}>
              {guide.label} <span style={{ fontSize: 11 }}>→</span>
            </a>
          )}
        </div>
      </div>
    </div>
  );
}

function WinRateBar({ winRate }) {
  return (
    <div style={{ marginTop: 6 }}>
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 7 }}>
        <span style={{ fontSize: 10, color: C.muted, textTransform: "uppercase", letterSpacing: 1.2, fontWeight: 600 }}>Win Rate Progress</span>
        <span style={{ fontSize: 10, color: "#555" }}>50% target</span>
      </div>
      <div style={{ height: 7, borderRadius: 4, background: "rgba(255,255,255,0.07)", overflow: "hidden" }}>
        <div style={{
          height: "100%", borderRadius: 4, width: Math.min(winRate, 100) + "%",
          background: winRate > 50 ? "linear-gradient(90deg,#22c55e,#4ade80)" : "linear-gradient(90deg,#ef4444,#f87171)",
          transition: "width 0.8s cubic-bezier(.4,0,.2,1)",
        }} />
      </div>
      <div style={{ display: "flex", justifyContent: "space-between", marginTop: 5 }}>
        <span style={{ fontSize: 11, fontWeight: 700, color: winRate > 50 ? "#22c55e" : "#ef4444", fontFamily: "monospace" }}>{winRate.toFixed(1)}%</span>
        <span style={{ fontSize: 10, color: "#444" }}>{"need >50% to be profitable"}</span>
      </div>
    </div>
  );
}

function RewardRatioBar({ ratio }) {
  const pct = Math.min((ratio / 2) * 100, 100);
  return (
    <div style={{ marginTop: 6 }}>
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 7 }}>
        <span style={{ fontSize: 10, color: C.muted, textTransform: "uppercase", letterSpacing: 1.2, fontWeight: 600 }}>Reward Ratio</span>
        <span style={{ fontSize: 10, color: "#555" }}>1:1 benchmark</span>
      </div>
      <div style={{ height: 7, borderRadius: 4, background: "rgba(255,255,255,0.07)", overflow: "hidden", position: "relative" }}>
        <div style={{
          height: "100%", borderRadius: 4, width: pct + "%",
          background: ratio >= 1 ? "linear-gradient(90deg,#6366f1,#818cf8)" : "linear-gradient(90deg,#ef4444,#f87171)",
          transition: "width 0.8s cubic-bezier(.4,0,.2,1)",
        }} />
        <div style={{ position: "absolute", top: 0, left: "50%", width: 2, height: "100%", background: "rgba(255,255,255,0.35)", transform: "translateX(-50%)" }} />
      </div>
      <div style={{ display: "flex", justifyContent: "space-between", marginTop: 5 }}>
        <span style={{ fontSize: 11, fontWeight: 700, color: ratio >= 1 ? "#818cf8" : "#ef4444", fontFamily: "monospace" }}>{ratio === Infinity ? "∞" : ratio.toFixed(2)}:1</span>
        <span style={{ fontSize: 10, color: "#444" }}>marker = 1:1</span>
      </div>
    </div>
  );
}

function DailyTable({ byDate }) {
  const dates = Object.keys(byDate).sort();
  return (
    <div>
      <div style={{ fontSize: 10, color: C.muted, textTransform: "uppercase", letterSpacing: 1.4, fontWeight: 600, marginBottom: 10 }}>Daily Breakdown</div>
      <div style={{ overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12.5 }}>
          <thead>
            <tr style={{ borderBottom: "1px solid " + C.border }}>
              {["Date","Trades","W","L","BE","PnL"].map(h => (
                <th key={h} style={{ textAlign: "left", padding: "9px 10px", color: "#555", fontWeight: 600, fontSize: 10, textTransform: "uppercase", letterSpacing: 1 }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {dates.map(date => {
              const t = byDate[date];
              const pnl = t.reduce((s, x) => s + x.pnl, 0);
              return (
                <tr key={date} style={{ borderBottom: "1px solid rgba(255,255,255,0.04)" }}>
                  <td style={{ padding: "9px 10px", color: "#b0b3be", fontFamily: "monospace", fontSize: 11.5 }}>{date}</td>
                  <td style={{ padding: "9px 10px", color: "#8a8d9a" }}>{t.length}</td>
                  <td style={{ padding: "9px 10px", color: "#22c55e" }}>{t.filter(x => x.pnl > 0).length}</td>
                  <td style={{ padding: "9px 10px", color: "#ef4444" }}>{t.filter(x => x.pnl < 0).length}</td>
                  <td style={{ padding: "9px 10px", color: "#555" }}>{t.filter(x => x.pnl === 0).length}</td>
                  <td style={{ padding: "9px 10px", fontWeight: 700, fontFamily: "monospace", color: pnl >= 0 ? "#22c55e" : "#ef4444" }}>
                    {(pnl >= 0 ? "+" : "") + "$" + pnl.toFixed(2)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function AdviceCard({ label, status, advice }) {
  const good = status === "good" || status === "solid" || status === "within range";
  return (
    <div style={{ background: C.card, border: "1px solid " + C.border, borderRadius: 11, padding: "15px 18px" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
        <span style={{ fontSize: 13, fontWeight: 600, color: "#ddd" }}>{label}</span>
        <span style={{
          fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.8,
          color: good ? "#22c55e" : "#eab308",
          background: good ? "rgba(34,197,94,0.12)" : "rgba(234,179,8,0.12)",
          padding: "3px 9px", borderRadius: 20,
        }}>{status}</span>
      </div>
      <p style={{ fontSize: 12.5, color: "#8a8d9a", margin: 0, lineHeight: 1.65 }}>{advice}</p>
    </div>
  );
}

// ─────────────────────────────────────────────
// MAIN APP
// ─────────────────────────────────────────────
export default function TradingAnalyzer() {

  const [metrics, setMetrics]       = useState(null);
  const [alerts, setAlerts]         = useState([]);
  const [behavFlags, setBehavFlags] = useState([]);
  const [fileName, setFileName]     = useState("");
  const [error, setError]           = useState("");
  const [dragging, setDragging]     = useState(false);
  const [loading, setLoading]       = useState(false);
  const fileRef = useRef();

  function runAnalysis(trades) {
    if (!trades.length) { setError("No valid trades found. Check that this is a Tradovate CSV or Excel export."); setLoading(false); return; }
    const m = computeMetrics(trades);
    setMetrics(m);
    setAlerts(generateVerdict(m));

    const flags = [];
    const otDays = detectOvertrading(m);
    if (otDays.length) flags.push({
      type: "overtrading", icon: "🔥", title: "Overtrading Detected",
      message: "On " + otDays.length + " day" + (otDays.length > 1 ? "s" : "") + " you took more than 4 trades, had multiple break-evens, and the majority were losses. This pattern suggests you kept forcing trades after the session had turned against you instead of stepping away. Overtrading bleeds your account through unnecessary commissions and emotional losses.",
      days: otDays.map(d => d.date + " — " + d.total + " trades (" + d.wins + "W " + d.losses + "L " + d.be + "BE)"),
      guide: { label: "📖 Fix Your Overtrading", url: GUIDES.overtrading },
    });
    const rtInstances = detectRevengeTrades(trades, m.avgLoss);
    if (rtInstances.length) flags.push({
      type: "revenge", icon: "⚡", title: "Revenge Trading Detected",
      message: rtInstances.length + " time" + (rtInstances.length > 1 ? "s" : "") + " you were on a winning streak and then took a loss that was " + rtInstances.map(r => r.multiplier + "x").join(", ") + " your average loss. Taking a disproportionately large loss right after wins is a classic sign of emotional re-entry — you likely chased the market to \"get it back\" instead of waiting for your next clean setup.",
      days: rtInstances.map(r => r.date + " — wins [+$" + r.prevWins[0].toFixed(0) + ", +$" + r.prevWins[1].toFixed(0) + "] → loss $" + r.spikeLoss.toFixed(0) + " (" + r.multiplier + "x avg)"),
      guide: { label: "📖 Fix Your Psychology", url: GUIDES.psychology },
    });
    setBehavFlags(flags);
    setLoading(false);
  }

  const processFile = useCallback((file) => {
    if (!file) return;
    setError(""); setFileName(file.name); setLoading(true);
    const ext = file.name.split(".").pop().toLowerCase();

    if (ext === "csv") {
      const reader = new FileReader();
      reader.onload = (e) => {
        try { runAnalysis(parseCSV(e.target.result)); }
        catch (err) { setError("Could not parse this CSV. Make sure it's a valid Tradovate export."); setLoading(false); }
      };
      reader.readAsText(file);
    } else if (ext === "xlsx" || ext === "xls") {
      const reader = new FileReader();
      reader.onload = async (e) => {
        try {
          const buffer = e.target.result;
          const trades = await parseXLSX(buffer);
          runAnalysis(trades);
        } catch (err) { setError("Could not parse this Excel file. Make sure it's a valid Tradovate export."); setLoading(false); }
      };
      reader.readAsArrayBuffer(file);
    } else {
      setError("Unsupported file type. Please upload a .csv, .xlsx, or .xls file.");
      setLoading(false);
    }
  }, []);

  const onDrop = useCallback((e) => { e.preventDefault(); setDragging(false); if (e.dataTransfer.files[0]) processFile(e.dataTransfer.files[0]); }, [processFile]);
  const reset = () => { setMetrics(null); setAlerts([]); setBehavFlags([]); setFileName(""); setError(""); if (fileRef.current) fileRef.current.value = ""; };

  return (
    <div style={{ minHeight: "100vh", background: C.bg, color: "#fff", fontFamily: "'Inter','Segoe UI',sans-serif", padding: "44px 20px" }}>
      <div style={{ maxWidth: 700, margin: "0 auto" }}>

        <div style={{ textAlign: "center", marginBottom: 34 }}>
          <div style={{ fontSize: 10, color: C.accent, textTransform: "uppercase", letterSpacing: 3.5, fontWeight: 700, marginBottom: 8 }}>Trading Analytics</div>
          <h1 style={{ fontSize: 26, fontWeight: 700, margin: 0, letterSpacing: -0.5 }}>
            Edge<span style={{ color: C.accent }}>Report</span>
          </h1>
          <p style={{ fontSize: 12.5, color: C.muted, marginTop: 6, marginBottom: 0 }}>Upload your Tradovate CSV or Excel export to get a full breakdown and personalized feedback.</p>
        </div>

        <div
          onClick={() => fileRef.current.click()}
          onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
          onDragLeave={() => setDragging(false)}
          onDrop={onDrop}
          style={{
            border: "2px dashed " + (dragging ? C.accent : "rgba(255,255,255,0.14)"),
            borderRadius: 16, padding: "30px 20px", textAlign: "center", cursor: "pointer",
            background: dragging ? "rgba(99,102,241,0.05)" : "rgba(255,255,255,0.02)", transition: "all 0.25s",
          }}>
          <input ref={fileRef} type="file" accept=".csv,.xlsx,.xls" onChange={e => { if (e.target.files[0]) processFile(e.target.files[0]); }} style={{ display: "none" }} />
          <div style={{ fontSize: 26, marginBottom: 6 }}>📁</div>
          <div style={{ fontSize: 14, color: "#b0b3be", fontWeight: 500 }}>{fileName ? "✓  " + fileName : "Drag & drop your PnL file here"}</div>
          <div style={{ fontSize: 11.5, color: "#555", marginTop: 4 }}>{fileName ? "Click to change" : "or click to browse · CSV & Excel supported"}</div>
        </div>

        <div style={{ textAlign: "center", marginTop: 14 }}>
          <button type="button"
            onClick={() => window.open("https://vedictrades.blog/edgereport/", "_blank", "noopener,noreferrer")}
            style={{
              display: "inline-flex", alignItems: "center", gap: 7,
              padding: "8px 18px", borderRadius: 8, border: "1px solid rgba(99,102,241,0.3)",
              background: "rgba(99,102,241,0.07)", color: C.accent,
              fontSize: 12.5, fontWeight: 600, cursor: "pointer", transition: "background 0.2s",
            }}
            onMouseEnter={e => e.currentTarget.style.background = "rgba(99,102,241,0.14)"}
            onMouseLeave={e => e.currentTarget.style.background = "rgba(99,102,241,0.07)"}
          >
            <span style={{ fontSize: 13 }}>📚</span> How to Use
          </button>
        </div>

        {loading && (
          <div style={{ textAlign: "center", marginTop: 24, color: C.muted, fontSize: 13 }}>
            <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
            <div style={{
              display: "inline-block", width: 18, height: 18, border: "2px solid " + C.accent,
              borderTopColor: "transparent", borderRadius: "50%",
              animation: "spin 0.6s linear infinite", marginRight: 8, verticalAlign: "middle",
            }} />
            Analyzing…
          </div>
        )}

        {error && <div style={{ marginTop: 10, padding: "10px 15px", background: "rgba(239,68,68,0.1)", border: "1px solid rgba(239,68,68,0.25)", borderRadius: 8, color: "#ef4444", fontSize: 13 }}>{error}</div>}

        {metrics && (
          <div style={{ marginTop: 34 }}>
            <div style={{ marginBottom: 6 }}>
              <div style={{ fontSize: 10, color: C.muted, textTransform: "uppercase", letterSpacing: 1.4, fontWeight: 600, marginBottom: 8 }}>Verdict</div>
              {alerts.map((a, i) => <AlertBanner key={i} alert={a} />)}
            </div>

            {behavFlags.length > 0 && (
              <div style={{ marginTop: 22 }}>
                <div style={{ fontSize: 10, color: C.muted, textTransform: "uppercase", letterSpacing: 1.4, fontWeight: 600, marginBottom: 8 }}>Behavioural Flags</div>
                <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                  {behavFlags.map((f, i) => <BehaviouralFlag key={i} type={f.type} title={f.title} icon={f.icon} message={f.message} days={f.days} guide={f.guide} />)}
                </div>
              </div>
            )}

            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))", gap: 10, marginTop: 26 }}>
              <MetricCard label="Total PnL"    value={(metrics.totalPnL >= 0 ? "+" : "") + "$" + metrics.totalPnL.toFixed(2)} color={metrics.totalPnL >= 0 ? "#22c55e" : "#ef4444"} sub={metrics.totalTrades + " trades"} icon="💰" />
              <MetricCard label="Win Rate"     value={metrics.winRate.toFixed(1) + "%"} color={metrics.winRate > 50 ? "#22c55e" : "#ef4444"} sub={metrics.wins + "W · " + metrics.losses + "L · " + metrics.breakEven + "BE"} icon="🎯" />
              <MetricCard label="Avg Win"      value={"$" + metrics.avgWin.toFixed(2)} color="#818cf8" sub="per winning trade" icon="📈" />
              <MetricCard label="Avg Loss"     value={"$" + metrics.avgLoss.toFixed(2)} color="#f87171" sub="per losing trade" icon="📉" />
              <MetricCard label="Reward Ratio" value={(metrics.rewardRatio === Infinity ? "∞" : metrics.rewardRatio.toFixed(2)) + ":1"} color={metrics.rewardRatio >= 1 ? "#818cf8" : "#ef4444"} sub="avg win / avg loss" icon="⚖️" />
              <MetricCard label="Break Even"   value={"" + metrics.breakEven} sub="trades at $0" icon="➖" />
            </div>

            {/* Sponsor Strip */}
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginTop: 14 }}>
              <a href="https://lucidtrading.com/ref/vedictrades/" target="_blank" rel="noopener noreferrer" style={{ textDecoration: "none" }}>
                <div style={{
                  background: "linear-gradient(135deg, #0a0c10 0%, #141824 100%)",
                  border: "1px solid rgba(168,180,220,0.18)",
                  borderRadius: 12, padding: "14px 16px",
                  display: "flex", alignItems: "center", gap: 14,
                  transition: "border-color 0.25s, background 0.25s", cursor: "pointer",
                }}
                onMouseEnter={e => { e.currentTarget.style.borderColor = "rgba(168,180,220,0.4)"; e.currentTarget.style.background = "linear-gradient(135deg, #0f1118 0%, #1a1f30 100%)"; }}
                onMouseLeave={e => { e.currentTarget.style.borderColor = "rgba(168,180,220,0.18)"; e.currentTarget.style.background = "linear-gradient(135deg, #0a0c10 0%, #141824 100%)"; }}
                >
                  <img src={"data:image/png;base64,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"} alt="Lucid Trading" style={{ height: 36, width: "auto", objectFit: "contain", flexShrink: 0 }} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 11, fontWeight: 700, color: "#c8cde8", letterSpacing: 0.3 }}>Lucid Trading</div>
                    <div style={{ fontSize: 10, color: "#a8b4dc", marginTop: 2, fontWeight: 600 }}>Up to 40% off →</div>
                  </div>
                </div>
              </a>

              <a href="https://tradeify.co/?ref=Vedic" target="_blank" rel="noopener noreferrer" style={{ textDecoration: "none" }}>
                <div style={{
                  background: "linear-gradient(135deg, #0a1410 0%, #0f1f1a 100%)",
                  border: "1px solid rgba(61,203,138,0.22)",
                  borderRadius: 12, padding: "14px 16px",
                  display: "flex", alignItems: "center", gap: 14,
                  transition: "border-color 0.25s, background 0.25s", cursor: "pointer",
                }}
                onMouseEnter={e => { e.currentTarget.style.borderColor = "rgba(61,203,138,0.45)"; e.currentTarget.style.background = "linear-gradient(135deg, #0d1a16 0%, #142a22 100%)"; }}
                onMouseLeave={e => { e.currentTarget.style.borderColor = "rgba(61,203,138,0.22)"; e.currentTarget.style.background = "linear-gradient(135deg, #0a1410 0%, #0f1f1a 100%)"; }}
                >
                  <img src={"data:image/png;base64,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"} alt="Tradeify" style={{ height: 36, width: "auto", objectFit: "contain", flexShrink: 0 }} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 11, fontWeight: 700, color: "#ffffff" }}>Tradeify</div>
                    <div style={{ fontSize: 10, color: "#3dcb8a", marginTop: 2, fontWeight: 600 }}>Up to 30% off →</div>
                  </div>
                </div>
              </a>
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginTop: 14 }}>
              <div style={{ background: C.card, border: "1px solid " + C.border, borderRadius: 12, padding: "16px 18px" }}>
                <WinRateBar winRate={metrics.winRate} />
              </div>
              <div style={{ background: C.card, border: "1px solid " + C.border, borderRadius: 12, padding: "16px 18px" }}>
                <RewardRatioBar ratio={metrics.rewardRatio} />
              </div>
            </div>

            <div style={{ marginTop: 22 }}>
              <div style={{ fontSize: 10, color: C.muted, textTransform: "uppercase", letterSpacing: 1.4, fontWeight: 600, marginBottom: 10 }}>Metric Advice</div>
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                <AdviceCard label="Win Rate" status={metrics.winRate > 50 ? "good" : "needs work"}
                  advice={metrics.winRate > 50
                    ? "At " + metrics.winRate.toFixed(1) + "% you're winning more often than losing. Keep refining your entry criteria — only take setups where you have the highest conviction."
                    : "At " + metrics.winRate.toFixed(1) + "% you're losing more often than winning. Be more selective. Wait for your best setups and cut out low-conviction trades entirely."} />
                <AdviceCard label="Reward Ratio" status={metrics.rewardRatio >= 1 ? "solid" : "needs work"}
                  advice={metrics.rewardRatio >= 1
                    ? "Your avg win ($" + metrics.avgWin.toFixed(2) + ") is " + metrics.rewardRatio.toFixed(2) + "x your avg loss ($" + metrics.avgLoss.toFixed(2) + "). You capture more on wins than you lose on losses — this is the edge that compounds over time."
                    : "Your avg win ($" + metrics.avgWin.toFixed(2) + ") is only " + metrics.rewardRatio.toFixed(2) + "x your avg loss ($" + metrics.avgLoss.toFixed(2) + "). Your losses are outweighing your wins. Tighten stops or let winners run to bring this ratio to at least 1:1."} />
                <AdviceCard label="Avg Loss" status={metrics.avgLoss <= 400 ? "within range" : "review needed"}
                  advice={metrics.avgLoss <= 400
                    ? "Your average loss of $" + metrics.avgLoss.toFixed(2) + " is controlled. Keep your risk management disciplined — never risk more than you're comfortable losing on any single trade."
                    : "Your average loss is $" + metrics.avgLoss.toFixed(2) + ", above $400. Review your stop-loss placement. Risk should be defined and locked in before entering any trade."} />
                <AdviceCard label="Avg Win" status={metrics.avgWin >= metrics.avgLoss ? "solid" : "extend targets"}
                  advice={metrics.avgWin >= metrics.avgLoss
                    ? "You're averaging $" + metrics.avgWin.toFixed(2) + " per win. Your reward capture is working — continue letting winners develop before taking profit."
                    : "Your average win of $" + metrics.avgWin.toFixed(2) + " is less than your average loss ($" + metrics.avgLoss.toFixed(2) + "). Work on extending your take-profit targets. Use trailing stops to lock in gains while allowing room to run."} />
              </div>
            </div>

            <div style={{ background: C.card, border: "1px solid " + C.border, borderRadius: 12, padding: "18px 18px", marginTop: 22 }}>
              <DailyTable byDate={metrics.byDate} />
            </div>

            <div style={{ textAlign: "center", marginTop: 30 }}>
              <button onClick={reset} style={{
                background: "rgba(255,255,255,0.05)", border: "1px solid " + C.border,
                color: C.muted, padding: "8px 20px", borderRadius: 8, cursor: "pointer", fontSize: 12.5, transition: "background 0.2s",
              }}
              onMouseEnter={e => e.currentTarget.style.background = "rgba(255,255,255,0.1)"}
              onMouseLeave={e => e.currentTarget.style.background = "rgba(255,255,255,0.05)"}
              >Reset — Analyze Another File</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
