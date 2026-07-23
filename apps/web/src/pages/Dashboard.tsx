import { useEffect, useState } from "react";
import type { DashboardSnapshot } from "@ztrade/shared";
import { api, ApiError } from "../lib/api";
import type { LiveFeed } from "../lib/useLiveFeed";
import { Badge, EmptyState, ErrorBanner, Panel } from "../components/Ui";
import { EquityChart } from "../components/EquityChart";
import { IntelPanel } from "../components/IntelPanel";
import { LiveBookPanel } from "../components/LiveBookPanel";
import { Icon } from "../components/Shell";
import { pct, pnlClass, prettyPair, signedUsd, time, usd } from "../lib/format";

export function Dashboard({ feed }: { feed: LiveFeed }) {
  const [snapshot, setSnapshot] = useState<DashboardSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void refresh();
  }, []);

  async function refresh(): Promise<void> {
    try {
      setSnapshot(await api.dashboard());
    } catch (err) {
      setError((err as ApiError).message);
    }
  }

  // The socket is authoritative once connected; the fetch above is just the
  // first paint.
  const status = feed.status ?? snapshot?.status ?? null;
  const account = feed.account ?? snapshot?.account ?? null;
  const position = feed.position ?? snapshot?.position ?? null;
  const signals = feed.signals.length ? feed.signals : (snapshot?.signals ?? []);
  const trades = feed.trades.length ? feed.trades : (snapshot?.recentTrades ?? []);
  const latency = feed.latencyMs ?? status?.latencyMs ?? null;
  const breaker = feed.circuitBreaker ?? status?.circuitBreaker ?? null;

  const running = status?.state === "RUNNING";

  async function control(action: "start" | "stop" | "emergency"): Promise<void> {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      if (action === "start") await api.startEngine();
      else if (action === "stop") await api.stopEngine();
      else {
        const confirmed = window.confirm(
          "FORCE CLOSE will market-close every open position immediately. Continue?",
        );
        if (!confirmed) return;
        const result = await api.emergencyStop();
        setNotice(`Emergency stop complete — ${result.closed} position(s) closed.`);
      }
      await refresh();
    } catch (err) {
      setError((err as ApiError).message);
    } finally {
      setBusy(false);
    }
  }

  async function resetBreaker(): Promise<void> {
    setBusy(true);
    try {
      await api.resetCircuitBreaker();
      setNotice("Circuit breaker reset.");
    } catch (err) {
      setError((err as ApiError).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <ErrorBanner message={error} />
      {notice && (
        <div className="border border-outline-variant bg-surface-container-low px-4 py-2.5 font-mono text-xs text-on-surface-variant">
          {notice}
        </div>
      )}

      {/* Execution engine control bar */}
      <Panel
        title="Execution Engine"
        actions={
          <div className="flex items-center gap-2">
            {breaker?.tripped && (
              <button className="btn-outline" disabled={busy} onClick={() => void resetBreaker()}>
                <Icon name="restart_alt" className="text-[14px]" /> Reset Breaker
              </button>
            )}
            {running ? (
              <button className="btn-outline" disabled={busy} onClick={() => void control("stop")}>
                <Icon name="stop" className="text-[14px]" /> Stop Bot
              </button>
            ) : (
              <button className="btn-primary" disabled={busy} onClick={() => void control("start")}>
                <Icon name="play_arrow" className="text-[14px]" /> Start Bot
              </button>
            )}
            <button className="btn-danger" disabled={busy} onClick={() => void control("emergency")}>
              <Icon name="warning" className="text-[14px]" /> Force Close
            </button>
          </div>
        }
      >
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
          <Readout label="Status">
            <span className="flex items-center gap-2">
              <span
                className={`h-2 w-2 rounded-full ${
                  running ? "animate-pulse-dot bg-primary" : "bg-outline"
                }`}
              />
              <span className={status?.state === "ERROR" ? "text-error" : "text-on-surface"}>
                {status?.state ?? "UNKNOWN"}
              </span>
            </span>
            {status?.error && (
              <p className="mt-1 font-mono text-[10px] text-error">{status.error}</p>
            )}
          </Readout>

          <Readout label="Active Strategy">
            {status?.activeStrategyName ?? "None armed"}
          </Readout>

          <Readout label="Live Heartbeat">
            {latency !== null ? (
              <span className={latency > 1000 ? "text-secondary-container" : "text-primary"}>
                {latency}ms Latency
              </span>
            ) : (
              <span className="text-outline">—</span>
            )}
          </Readout>

          <Readout label="Equity">{account ? usd(account.equity) : "—"}</Readout>

          <Readout label="Realised Today">
            <span className={pnlClass(breaker?.realisedPnlToday ?? 0)}>
              {breaker ? signedUsd(breaker.realisedPnlToday) : "—"}
            </span>
          </Readout>
        </div>
      </Panel>

      {/* Current position */}
      <div className="grid gap-4 lg:grid-cols-3">
        <Panel title="Current Position" className="lg:col-span-2">
          {position ? (
            <div className="grid gap-4 sm:grid-cols-4">
              <Readout label="Instrument">
                <span className="flex items-center gap-2">
                  {prettyPair(position.symbol)}
                  <Badge tone={position.side === "LONG" ? "success" : "danger"}>
                    {position.side}
                  </Badge>
                </span>
              </Readout>
              <Readout label="Entry Price">{usd(position.entryPrice)}</Readout>
              <Readout label="Mark Price">{usd(position.markPrice)}</Readout>
              <Readout label="Unrealised P&L">
                <span className={pnlClass(position.unrealisedPnl)}>
                  {signedUsd(position.unrealisedPnl)} ({pct(position.unrealisedPnlPct)})
                </span>
              </Readout>
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
                <li key={signal.id} className="px-4 py-2.5 font-mono text-xs">
                  <div className="flex items-center gap-3">
                    <Badge tone={signal.action === "BUY" ? "success" : "danger"}>
                      {signal.action}
                    </Badge>
                    <span className="text-outline">{time(signal.at)}</span>
                    <span className="text-on-surface">{prettyPair(signal.symbol)}</span>
                    <span className="truncate text-on-surface-variant">{signal.reason}</span>
                    <span className="ml-auto text-primary">
                      {Math.round(signal.confidence * 100)}%
                    </span>
                  </div>
                  {/* Why a signal did NOT trade is usually the more useful fact. */}
                  {!signal.acted && signal.skippedReason && (
                    <div className="mt-1 pl-1 text-[10px] text-outline">
                      skipped — {signal.skippedReason}
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </div>

      <Panel
        title="Equity Growth"
        actions={
          snapshot && (
            <span className={`metric font-mono text-xs ${pnlClass(snapshot.stats.netPnl)}`}>
              {signedUsd(snapshot.stats.netPnl)} net
            </span>
          )
        }
        bodyClassName="p-2"
      >
        <EquityChart points={snapshot?.equityCurve ?? []} />
      </Panel>

      <LiveBookPanel symbols={["BTCUSDT", "ETHUSDT"]} />

      <IntelPanel />

      <Panel title="Recent Executions" bodyClassName="p-0">
        {trades.length === 0 ? (
          <EmptyState icon="receipt_long" message="No executions recorded" />
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
                    <td className="px-4 py-2.5 text-outline">{time(trade.openedAt)}</td>
                    <td className="px-4 py-2.5 text-on-surface">
                      {prettyPair(trade.symbol)}
                      {trade.paper && <span className="ml-2 text-[10px] text-outline">PAPER</span>}
                    </td>
                    <td className="px-4 py-2.5">
                      <span className={trade.side === "LONG" ? "text-primary" : "text-error"}>
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
                      {trade.status === "Open" ? "—" : signedUsd(trade.pnl)}
                    </td>
                    <td className="px-4 py-2.5 text-on-surface-variant">
                      {trade.status}
                      {trade.closeReason && (
                        <span className="ml-1 text-[10px] text-outline">
                          {trade.closeReason}
                        </span>
                      )}
                    </td>
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

function Readout({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="font-mono text-[10px] uppercase tracking-widest text-on-surface-variant">
        {label}
      </div>
      <div className="metric mt-1.5 font-mono text-sm text-on-surface">{children}</div>
    </div>
  );
}
