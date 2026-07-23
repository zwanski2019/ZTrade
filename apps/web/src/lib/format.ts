/** Display helpers. All money is quoted in USDT. */

export function usd(value: number, decimals = 2): string {
  const sign = value < 0 ? "-" : "";
  return `${sign}$${Math.abs(value).toLocaleString("en-US", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  })}`;
}

/** Money with an explicit +/- — used wherever P&L is shown. */
export function signedUsd(value: number, decimals = 2): string {
  return `${value >= 0 ? "+" : ""}${usd(value, decimals)}`;
}

/** Takes a fraction (0.024) and renders a percentage ("+2.40%"). */
export function pct(fraction: number, decimals = 2, signed = true): string {
  const value = fraction * 100;
  const sign = signed && value >= 0 ? "+" : "";
  return `${sign}${value.toFixed(decimals)}%`;
}

export function num(value: number, decimals = 2): string {
  return value.toLocaleString("en-US", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

export function time(at: number): string {
  return new Date(at).toLocaleTimeString("en-GB", { hour12: false });
}

export function dateTime(at: number): string {
  const d = new Date(at);
  return `${d.toISOString().slice(0, 10)} ${d.toLocaleTimeString("en-GB", {
    hour12: false,
  })}`;
}

export function relativeTime(at: number): string {
  const seconds = Math.floor((Date.now() - at) / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86_400)}d ago`;
}

/** Tailwind class for a P&L value: green up, red down, muted flat. */
export function pnlClass(value: number): string {
  if (value > 0) return "text-primary";
  if (value < 0) return "text-error";
  return "text-on-surface-variant";
}

/** "BTCUSDT" -> "BTC/USDT" for display; the API always uses the raw form. */
export function prettyPair(symbol: string): string {
  const quotes = ["USDT", "USDC", "USD"];
  for (const quote of quotes) {
    if (symbol.endsWith(quote)) {
      return `${symbol.slice(0, -quote.length)}/${quote}`;
    }
  }
  return symbol;
}

export function profitFactor(value: number): string {
  return Number.isFinite(value) ? value.toFixed(2) : "∞";
}
