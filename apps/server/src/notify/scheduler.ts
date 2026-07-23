import { performanceStats, startOfUtcDay, symbolStats } from "../db.js";
import { logger } from "../bus.js";
import { notifier } from "./telegram.js";

/**
 * Fires the daily summary shortly after 00:00 UTC.
 *
 * The Settings screen has had a "Daily Summary" toggle since the first version,
 * but nothing ever sent one — this closes that gap.
 *
 * Uses a self-rescheduling timeout rather than a fixed interval so it stays
 * aligned to the UTC boundary even if the process drifts or the machine sleeps.
 */
const SUMMARY_OFFSET_MS = 60_000; // A minute past midnight, so the day is fully closed.

let timer: NodeJS.Timeout | null = null;

function msUntilNextRun(now = Date.now()): number {
  const nextMidnight = startOfUtcDay(now) + 24 * 60 * 60 * 1000;
  return nextMidnight + SUMMARY_OFFSET_MS - now;
}

export function buildSummary(from: number, to: number): string {
  const stats = performanceStats(from, to);
  const bySymbol = symbolStats(from, to);

  if (stats.totalTrades === 0) {
    return "📊 <b>ZTrade daily summary</b>\nNo trades closed in the last 24 hours.";
  }

  const lines = [
    "📊 <b>ZTrade daily summary</b>",
    `Trades: ${stats.totalTrades}`,
    `Win rate: ${(stats.winRate * 100).toFixed(1)}%`,
    `Net P&L: ${stats.netPnl >= 0 ? "+" : ""}${stats.netPnl.toFixed(2)} USDT`,
    `Fees: ${stats.totalFees.toFixed(2)} USDT`,
    `Max drawdown: ${stats.maxDrawdown.toFixed(2)} USDT`,
    `Expectancy: ${stats.expectancy >= 0 ? "+" : ""}${stats.expectancy.toFixed(2)} per trade`,
  ];

  if (bySymbol.length > 0) {
    lines.push("", "<b>By symbol</b>");
    for (const s of bySymbol.slice(0, 5)) {
      lines.push(
        `${s.symbol}: ${s.trades} trades, ${(s.winRate * 100).toFixed(0)}% win, ` +
          `${s.netPnl >= 0 ? "+" : ""}${s.netPnl.toFixed(2)}`,
      );
    }
  }

  return lines.join("\n");
}

async function run(): Promise<void> {
  try {
    const to = Date.now();
    const from = to - 24 * 60 * 60 * 1000;
    await notifier.dailySummary(buildSummary(from, to));
  } catch (err) {
    logger.error(`Daily summary failed: ${(err as Error).message}`);
  } finally {
    schedule();
  }
}

function schedule(): void {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => void run(), msUntilNextRun());
  // Do not hold the process open just for the summary.
  timer.unref?.();
}

export function startScheduler(): void {
  schedule();
  logger.info(
    `Daily summary scheduled in ${Math.round(msUntilNextRun() / 60_000)} minute(s)`,
  );
}

export function stopScheduler(): void {
  if (timer) clearTimeout(timer);
  timer = null;
}
