# EdgeReport

The truth your PnL has been hiding.

A free trading performance analyzer for Tradovate. Upload your CSV or Excel export — EdgeReport audits your win rate, reward ratio, and behavioural patterns like overtrading and revenge trading, then tells you exactly what to fix.

No account needed. No data stored. Everything runs in your browser.

---

## Deploy to Vercel

1. Push this repo to GitHub
2. Go to [vercel.com](https://vercel.com) → New Project
3. Import your GitHub repo
4. Click Deploy — that's it

Vercel auto-detects Next.js. No configuration needed.

---

## Run Locally

```bash
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000)

---

## How It Works

- **CSV & Excel support** — parses both formats natively in the browser, no server needed
- **Zero dependencies** — xlsx parsing is done by reading the zip + XML manually using `DecompressionStream`
- **No data storage** — files are read client-side and never leave the user's machine
- **Behavioural detection** — scans for overtrading (too many trades on loss days) and revenge trading (big spike losses after winning streaks)
