import { useEffect, useMemo, useState } from "react";
import type { EquityPoint, PerformanceStats, Trade, TradeStatus } from "@ztrade/shared";
import { api, ApiError } from "../lib/api";
import { EmptyState, ErrorBanner, Metric, Panel } from "../components/Ui";
import { EquityChart } from "../components/EquityChart";
import { Icon } from "../components/Shell";
import {
  dateTime,
  pct,
  pnlClass,
  prettyPair,
  profitFactor,
  signedUsd,
  usd,
} from "../lib/format";

const PAGE_SIZE = 25;
const STATUSES: Array<TradeStatus | "All"> = ["All", "Filled", "Open", "Cancelled"];

const RANGES = [
  { label: "1D", ms: 24 * 60 * 60 * 1000 },
  { label: "1W", ms: 7 * 24 * 60 * 60 * 1000 },
  { label: "1M", ms: 30 * 24 * 60 * 60 * 1000 },
  { label: "ALL", ms: null },
] as const;

export function TradeHistory() {
  const [trades, setTrades] = useState<Trade[]>([]);
  const [total, setTotal] = useState(0);
  const [stats, setStats] = useState<PerformanceStats | null>(null);
  const [equity, setEquity] = useState<EquityPoint[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const [page, setPage] = useState(0);
  const [status, setStatus] = useState<TradeStatus | "All">("All");
  const [search, setSearch] = useState("");
  const [rangeLabel, setRangeLabel] = useState<(typeof RANGES)[number]["label"]>("1M");

  const from = useMemo(() => {
    const range = RANGES.find((r) => r.label === rangeLabel);
    return range?.ms ? Date.now() - range.ms : undefined;
  }, [rangeLabel]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);

    // Debounced so typing in the search box doesn't fire a request per keystroke.
    const timer = window.setTimeout(() => {
      Promise.all([
        api.trades({
          limit: PAGE_SIZE,
          offset: page * PAGE_SIZE,
          status,
          search: search || undefined,
          from,
        }),
        api.stats({ from }),
        api.equity({ from }),
      ])
        .then(([tradePage, statsResult, equityResult]) => {
          if (cancelled) return;
          setTrades(tradePage.trades);
          setTotal(tradePage.total);
          setStats(statsResult);
          setEquity(equityResult);
          setError(null);
        })
        .catch((err: ApiError) => !cancelled && setError(err.message))
        .finally(() => !cancelled && setLoading(false));
    }, 250);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [page, status, search, from]);

  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div className="space-y-4">
      <ErrorBanner message={error} />

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
        <Metric
          label="Win Rate"
          value={stats ? pct(stats.winRate, 2, false) : "—"}
          valueClassName="text-primary"
        />
        <Metric label="Avg Win" value={stats ? signedUsd(stats.avgWin) : "—"} valueClassName="text-primary" />
        <Metric label="Avg Loss" value={stats ? signedUsd(stats.avgLoss) : "—"} valueClassName="text-error" />
        <Metric label="Profit Factor" value={stats ? profitFactor(stats.profitFactor) : "—"} />
        <Metric
          label="Sharpe Ratio"
          value={stats ? stats.sharpeRatio.toFixed(2) : "—"}
          hint="Per-trade, not annualised"
        />
      </div>

      <Panel
        title="Cumulative P&L Performance"
        actions={
          <div className="flex gap-1">
            {RANGES.map((range) => (
              <button
                key={range.label}
                onClick={() => {
                  setRangeLabel(range.label);
                  setPage(0);
                }}
                className={`px-2.5 py-1 font-mono text-[10px] uppercase tracking-wider transition-colors ${
                  rangeLabel === range.label
                    ? "border border-primary text-primary"
                    : "border border-transparent text-on-surface-variant hover:text-on-surface"
                }`}
              >
                {range.label}
              </button>
            ))}
          </div>
        }
        bodyClassName="p-2"
      >
        <EquityChart points={equity} height={260} />
      </Panel>

      <Panel
        title="Trade Log"
        actions={
          <a
            className="btn-outline"
            href={api.exportCsvUrl({ status, from })}
            download
          >
            <Icon name="download" className="text-[14px]" /> Export CSV
          </a>
        }
        bodyClassName="p-0"
      >
        <div className="flex flex-wrap items-center gap-3 border-b border-outline-variant p-3">
          <div className="relative flex-1 min-w-[180px]">
            <Icon
              name="search"
              className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-[16px] text-outline"
            />
            <input
              className="field pl-9"
              placeholder="Filter by pair…"
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                setPage(0);
              }}
            />
          </div>

          <div className="flex gap-1">
            {STATUSES.map((option) => (
              <button
                key={option}
                onClick={() => {
                  setStatus(option);
                  setPage(0);
                }}
                className={`px-2.5 py-1.5 font-mono text-[10px] uppercase tracking-wider transition-colors ${
                  status === option
                    ? "border border-primary text-primary"
                    : "border border-outline-variant text-on-surface-variant hover:text-on-surface"
                }`}
              >
                {option}
              </button>
            ))}
          </div>
        </div>

        {loading && trades.length === 0 ? (
          <EmptyState icon="hourglass_empty" message="Loading trades…" />
        ) : trades.length === 0 ? (
          <EmptyState icon="receipt_long" message="No trades match these filters" />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[720px] font-mono text-xs">
              <thead>
                <tr className="border-b border-outline-variant text-left text-[10px] uppercase tracking-widest text-on-surface-variant">
                  <th className="px-4 py-2.5 font-medium">Time</th>
                  <th className="px-4 py-2.5 font-medium">Pair</th>
                  <th className="px-4 py-2.5 font-medium">Side</th>
                  <th className="px-4 py-2.5 text-right font-medium">Size</th>
                  <th className="px-4 py-2.5 text-right font-medium">Entry</th>
                  <th className="px-4 py-2.5 text-right font-medium">Exit</th>
                  <th className="px-4 py-2.5 text-right font-medium">P&amp;L</th>
                  <th className="px-4 py-2.5 font-medium">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-outline-variant">
                {trades.map((trade) => (
                  <tr key={trade.id} className="hover:bg-surface-container-low">
                    <td className="px-4 py-2.5 text-outline">{dateTime(trade.openedAt)}</td>
                    <td className="px-4 py-2.5 text-on-surface">{prettyPair(trade.symbol)}</td>
                    <td className="px-4 py-2.5">
                      <span className={trade.side === "LONG" ? "text-primary" : "text-error"}>
                        {trade.side}
                      </span>
                    </td>
                    <td className="metric px-4 py-2.5 text-right text-on-surface-variant">
                      {trade.size}
                    </td>
                    <td className="metric px-4 py-2.5 text-right text-on-surface-variant">
                      {usd(trade.entryPrice)}
                    </td>
                    <td className="metric px-4 py-2.5 text-right text-on-surface-variant">
                      {trade.exitPrice !== null ? usd(trade.exitPrice) : "—"}
                    </td>
                    <td className={`metric px-4 py-2.5 text-right ${pnlClass(trade.pnl)}`}>
                      {signedUsd(trade.pnl)}
                    </td>
                    <td className="px-4 py-2.5 text-on-surface-variant">{trade.status}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <div className="flex items-center justify-between border-t border-outline-variant px-4 py-3 font-mono text-[11px] text-on-surface-variant">
          <span>
            Showing {trades.length} of {total.toLocaleString()} trades
          </span>
          <div className="flex items-center gap-2">
            <button
              className="btn-outline px-2 py-1"
              disabled={page === 0}
              onClick={() => setPage((p) => Math.max(0, p - 1))}
              aria-label="Previous page"
            >
              <Icon name="chevron_left" className="text-[16px]" />
            </button>
            <span>
              {page + 1} / {pageCount}
            </span>
            <button
              className="btn-outline px-2 py-1"
              disabled={page + 1 >= pageCount}
              onClick={() => setPage((p) => p + 1)}
              aria-label="Next page"
            >
              <Icon name="chevron_right" className="text-[16px]" />
            </button>
          </div>
        </div>
      </Panel>
    </div>
  );
}
