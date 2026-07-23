import { useEffect, useState } from "react";
import type { DashboardSnapshot } from "@ztrade/shared";
import { api, ApiError } from "../lib/api";
import type { LiveFeed } from "../lib/useLiveFeed";
import { Badge, EmptyState, ErrorBanner, Panel } from "../components/Ui";
import { EquityChart } from "../components/EquityChart";
import { Icon } from "../components/Shell";
import {
  pct,
  pnlClass,
  prettyPair,
  signedUsd,
  time,
  usd,
} from "../lib/format";

export function Dashboard({ feed }: { feed: LiveFeed }) {
  const [snapshot, setSnapshot] = useState<DashboardSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api
      .dashboard()
      .then((data) => !cancelled && setSnapshot(data))
      .catch((err: ApiError) => !cancelled && setError(err.message));
    return () => {
      cancelled = true;
    };
  }, []);

  // The socket is authoritative once connected; the fetch above is just the
  // first paint.
  const status = feed.status ?? snapshot?.status ?? null;
  const account = feed.account ?? snapshot?.account ?? null;
  const position = feed.position ?? snapshot?.position ?? null;
  const signals = feed.signals.length ? feed.signals : (snapshot?.signals ?? []);
  const trades = feed.trades.length ? feed.trades : (snapshot?.recentTrades ?? []);
  const latency = feed.latencyMs ?? status?.latencyMs ?? null;

  const running = status?.state === "RUNNING";

  async function control(action: "start" | "stop" | "emergency"): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      if (action === "start") await api.startEngine();
      else if (action === "stop") await api.stopEngine();
      else {
        const confirmed = window.confirm(
          "FORCE CLOSE will market-close every open position immediately. Continue?",
        );
        if (!confirmed) return;
        await api.emergencyStop();
      }
    } catch (err) {
      setError((err as ApiError).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <ErrorBanner message={error} />

      {/* Execution engine control bar */}
      <Panel
        title="Execution Engine"
        actions={
          <div className="flex items-center gap-2">
            {running ? (
              <button
                className="btn-outline"
                disabled={busy}
                onClick={() => void control("stop")}
              >
                <Icon name="stop" className="text-[14px]" /> Stop Bot
              </button>
            ) : (
              <button
                className="btn-primary"
                disabled={busy}
                onClick={() => void control("start")}
              >
                <Icon name="play_arrow" className="text-[14px]" /> Start Bot
              </button>
            )}
            <button
              className="btn-danger"
              disabled={busy}
              onClick={() => void control("emergency")}
            >
              <Icon name="warning" className="text-[14px]" /> Force Close
            </button>
          </div>
        }
      >
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <div>
            <div className="font-mono text-[10px] uppercase tracking-widest text-on-surface-variant">
              Status
            </div>
            <div className="mt-1.5 flex items-center gap-2">
              <span
                className={`h-2 w-2 rounded-full ${
                  running ? "animate-pulse-dot bg-primary" : "bg-outline"
                }`}
              />
              <span
                className={`font-mono text-sm font-semibold ${
                  status?.state === "ERROR" ? "text-error" : "text-on-surface"
                }`}
              >
                {status?.state ?? "UNKNOWN"}
              </span>
            </div>
            {status?.error && (
              <p className="mt-1 font-mono text-[10px] text-error">{status.error}</p>
            )}
          </div>

          <div>
            <div className="font-mono text-[10px] uppercase tracking-widest text-on-surface-variant">
              Active Strategy
            </div>
            <div className="mt-1.5 font-mono text-sm text-on-surface">
              {status?.activeStrategyName ?? "None armed"}
            </div>
          </div>

          <div>
            <div className="font-mono text-[10px] uppercase tracking-widest text-on-surface-variant">
              Live Heartbeat
            </div>
            <div className="mt-1.5 font-mono text-sm text-on-surface">
              {latency !== null ? (
                <span className={latency > 100 ? "text-secondary-container" : "text-primary"}>
                  {latency}ms Latency
                </span>
              ) : (
                <span className="text-outline">—</span>
              )}
            </div>
          </div>

          <div>
            <div className="font-mono text-[10px] uppercase tracking-widest text-on-surface-variant">
              Equity
            </div>
            <div className="metric mt-1.5 text-sm text-on-surface">
              {account ? usd(account.equity) : "—"}
            </div>
          </div>
        </div>
      </Panel>

      {/* Current position */}
      <div className="grid gap-4 lg:grid-cols-3">
        <Panel title="Current Position" className="lg:col-span-2">
          {position ? (
            <div className="grid gap-4 sm:grid-cols-4">
              <div>
                <div className="font-mono text-[10px] uppercase tracking-widest text-on-surface-variant">
                  Instrument
                </div>
                <div className="mt-1.5 flex items-center gap-2 font-mono text-sm text-on-surface">
                  {prettyPair(position.symbol)}
                  <Badge tone={position.side === "LONG" ? "success" : "danger"}>
                    {position.side}
                  </Badge>
                </div>
              </div>
              <div>
                <div className="font-mono text-[10px] uppercase tracking-widest text-on-surface-variant">
                  Entry Price
                </div>
                <div className="metric mt-1.5 text-sm text-on-surface">
                  {usd(position.entryPrice)}
                </div>
              </div>
              <div>
                <div className="font-mono text-[10px] uppercase tracking-widest text-on-surface-variant">
                  Mark Price
                </div>
                <div className="metric mt-1.5 text-sm text-on-surface">
                  {usd(position.markPrice)}
                </div>
              </div>
              <div>
                <div className="font-mono text-[10px] uppercase tracking-widest text-on-surface-variant">
                  Unrealised P&amp;L
                </div>
                <div className={`metric mt-1.5 text-sm ${pnlClass(position.unrealisedPnl)}`}>
                  {signedUsd(position.unrealisedPnl)} ({pct(position.unrealisedPnlPct)})
                </div>
              </div>
            </div>
          ) : (
            <EmptyState icon="account_balance_wallet" message="No open position" />
          )}
        </Panel>

        <Panel title="Signal Feed" bodyClassName="max-h-72 overflow-y-auto p-0">
          {signals.length === 0 ? (
            <EmptyState icon="sensors" message="No signals yet" />
          ) : (
            <ul className="divide-y divide-outline-variant">
              {signals.map((signal) => (
                <li
                  key={signal.id}
                  className="flex items-center gap-3 px-4 py-2.5 font-mono text-xs"
                >
                  <Badge tone={signal.action === "BUY" ? "success" : "danger"}>
                    {signal.action}
                  </Badge>
                  <span className="text-outline">{time(signal.at)}</span>
                  <span className="text-on-surface">{prettyPair(signal.symbol)}</span>
                  <span className="truncate text-on-surface-variant">{signal.reason}</span>
                  <span className="ml-auto text-primary">
                    {Math.round(signal.confidence * 100)}%
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </div>

      {/* Equity + recent executions */}
      <Panel
        title="Equity Growth"
        actions={
          snapshot && (
            <span
              className={`metric font-mono text-xs ${pnlClass(snapshot.stats.netPnl)}`}
            >
              {signedUsd(snapshot.stats.netPnl)} net
            </span>
          )
        }
        bodyClassName="p-2"
      >
        <EquityChart points={snapshot?.equityCurve ?? []} />
      </Panel>

      <Panel title="Recent Executions" bodyClassName="p-0">
        {trades.length === 0 ? (
          <EmptyState icon="receipt_long" message="No executions recorded" />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] font-mono text-xs">
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
                    <td className="px-4 py-2.5 text-outline">{time(trade.openedAt)}</td>
                    <td className="px-4 py-2.5 text-on-surface">
                      {prettyPair(trade.symbol)}
                    </td>
                    <td className="px-4 py-2.5">
                      <span
                        className={
                          trade.side === "LONG" ? "text-primary" : "text-error"
                        }
                      >
                        {trade.side}
                      </span>
                    </td>
                    <td className="metric px-4 py-2.5 text-right text-on-surface-variant">
                      {trade.size}
                    </td>
                    <td className="metric px-4 py-2.5 text-right text-on-surface-variant">
                      {trade.entryPrice}
                    </td>
                    <td className="metric px-4 py-2.5 text-right text-on-surface-variant">
                      {trade.exitPrice ?? "—"}
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
      </Panel>
    </div>
  );
}
