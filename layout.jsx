export const metadata = {
  title: "EdgeReport — The truth your PnL has been hiding.",
  description: "Upload your Tradovate CSV or Excel export. EdgeReport audits your win rate, reward ratio, and scans for overtrading and revenge trading — then tells you exactly what to fix.",
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet" />
      </head>
      <body style={{ margin: 0, padding: 0, background: "#0e1015" }}>
        {children}
      </body>
    </html>
  );
}
