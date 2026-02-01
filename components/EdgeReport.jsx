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
          <a href="" target="_blank" rel="noopener noreferrer"
            style={{
              display: "inline-flex", alignItems: "center", gap: 7,
              padding: "8px 18px", borderRadius: 8, textDecoration: "none", fontSize: 12.5, fontWeight: 600,
              color: C.accent, border: "1px solid rgba(99,102,241,0.3)",
              background: "rgba(99,102,241,0.07)", transition: "background 0.2s",
            }}
            onMouseEnter={e => e.currentTarget.style.background = "rgba(99,102,241,0.14)"}
            onMouseLeave={e => e.currentTarget.style.background = "rgba(99,102,241,0.07)"}
          >
            <span style={{ fontSize: 13 }}>📚</span> How to Use
          </a>
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
