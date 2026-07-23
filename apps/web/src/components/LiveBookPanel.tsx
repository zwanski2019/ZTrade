import { useEffect, useState } from "react";
import { api, type MarketDataSnapshot } from "../lib/api";
import { Badge, EmptyState, Panel } from "./Ui";
import { Icon } from "./Shell";
import { num, prettyPair } from "../lib/format";

/**
 * Phase 1 read-only live orderbook.
 *
 * Renders the L2 ladder rebuilt from the WS stream, plus the integrity
 * counters that prove the rebuild is sound (gaps, crossed books) and the
 * measured latency budget.
 *
 * Critically: when the server reports a stale book it sends `book: null` and
 * this component renders the DEGRADED state rather than the last known
 * prices. Showing a frozen ladder that looks live is exactly how an operator
 * ends up trusting a price that no longer exists.
 */
const POLL_MS = 1_000;

export function LiveBookPanel({ symbols }: { symbols: string[] }) {
  const [data, setData] = useState<MarketDataSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);

  useEffect(() => {
    let cancelled = false;

    const poll = (): void => {
      api
        .marketData(12)
        .then((d) => !cancelled && setData(d))
        .catch(() => {
          /* Read-only view; a transient failure just skips a frame. */
        });
    };

    poll();
    const timer = window.setInterval(poll, POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);

  async function toggle(): Promise<void> {
    setStarting(true);
    setError(null);
    try {
      if (data?.running) await api.stopMarketData();
      else await api.startMarketData(symbols);
      setData(await api.marketData(12));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setStarting(false);
    }
  }

  const ing = data?.ingestion ?? null;

  return (
    <Panel
      title="Live Orderbook (L2)"
      actions={
        <div className="flex items-center gap-3">
          {ing && (
            <span className="font-mono text-[10px] uppercase tracking-wider text-on-surface-variant">
              p50 {ing.latency.p50 ?? "—"}ms · p99 {ing.latency.p99 ?? "—"}ms
            </span>
          )}
          <button className="btn-outline" disabled={starting} onClick={() => void toggle()}>
            <Icon name={data?.running ? "stop" : "play_arrow"} className="text-[14px]" />
            {data?.running ? "Stop Feed" : "Start Feed"}
          </button>
        </div>
      }
    >
      {error && (
        <p className="mb-3 border border-error bg-error-container px-3 py-2 font-mono text-[11px] text-on-error-container">
          {error}
        </p>
      )}

      {!data?.running ? (
        <EmptyState icon="lan" message="Feed stopped — start it to stream the live book" />
      ) : (
        <div className="space-y-4">
          {/* Integrity counters: the evidence that the rebuild is sound. */}
          {ing && (
            <div className="flex flex-wrap gap-4 border-b border-outline-variant pb-3 font-mono text-[11px]">
              <Stat label="msgs" value={num(ing.messages, 0)} />
              <Stat
                label="invalid"
                value={num(ing.invalid, 0)}
                tone={ing.invalid > 0 ? "text-error" : undefined}
              />
              <Stat
                label="gaps"
                value={num(ing.gaps, 0)}
                tone={ing.gaps > 0 ? "text-secondary-container" : undefined}
              />
              <Stat
                label="stale books"
                value={num(ing.staleBooks, 0)}
                tone={ing.staleBooks > 0 ? "text-error" : undefined}
              />
              <Stat label="reconnects" value={num(ing.reconnects, 0)} />
            </div>
          )}

          <div className="grid gap-4 lg:grid-cols-2">
            {data.books.map((view) => {
              const feature = data.features.find((f) => f.symbol === view.symbol);
              return (
                <div key={view.symbol} className="border border-outline-variant">
                  <div className="flex flex-wrap items-center justify-between gap-2 border-b border-outline-variant px-3 py-2">
                    <span className="font-mono text-xs text-on-surface">
                      {prettyPair(view.symbol)}
                    </span>
                    <div className="flex items-center gap-2">
                      <Badge tone={view.status === "HEALTHY" ? "success" : "danger"}>
                        {view.status}
                      </Badge>
                      <span className="font-mono text-[10px] text-outline">
                        u={view.updateId}
                      </span>
                    </div>
                  </div>

                  {view.book ? (
                    <>
                      <BookLadder bids={view.book.bids} asks={view.book.asks} />
                      {feature && (
                        <div className="flex flex-wrap gap-3 border-t border-outline-variant px-3 py-2 font-mono text-[10px] text-on-surface-variant">
                          <span>spread {feature.spreadBps?.toFixed(3) ?? "—"}bps</span>
                          <span>imb {feature.imbalance?.toFixed(3) ?? "—"}</span>
                          <span>micro {feature.microprice?.toFixed(2) ?? "—"}</span>
                          <span>flow {feature.flowImbalance?.toFixed(3) ?? "—"}</span>
                        </div>
                      )}
                    </>
                  ) : (
                    // Deliberately NOT the last known ladder.
                    <div className="px-3 py-6 text-center font-mono text-[11px] text-error">
                      <Icon name="warning" className="mr-1 align-[-3px] text-[14px]" />
                      Book is {view.status.toLowerCase()} — prices withheld
                      {view.reason && (
                        <div className="mt-1 text-[10px] text-outline">{view.reason}</div>
                      )}
                    </div>
                  )}

                  <div className="border-t border-outline-variant px-3 py-1.5 font-mono text-[10px] text-outline">
                    snapshots {view.stats.snapshots} · deltas {view.stats.deltas} · gaps{" "}
                    <span className={view.stats.gaps > 0 ? "text-secondary-container" : ""}>
                      {view.stats.gaps}
                    </span>{" "}
                    · crossed{" "}
                    <span className={view.stats.crossed > 0 ? "text-error" : ""}>
                      {view.stats.crossed}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </Panel>
  );
}

function BookLadder({
  bids,
  asks,
}: {
  bids: Array<{ price: number; size: number }>;
  asks: Array<{ price: number; size: number }>;
}) {
  // Depth bars are scaled to the largest level on screen, so the shape of the
  // book is readable at a glance rather than needing the numbers parsed.
  const maxSize = Math.max(
    ...bids.map((l) => l.size),
    ...asks.map((l) => l.size),
    Number.EPSILON,
  );

  return (
    <div className="grid grid-cols-2 gap-px font-mono text-[11px]">
      <div>
        {bids.map((level) => (
          <Level key={`b${level.price}`} level={level} maxSize={maxSize} side="bid" />
        ))}
      </div>
      <div>
        {[...asks].reverse().map((level) => (
          <Level key={`a${level.price}`} level={level} maxSize={maxSize} side="ask" />
        ))}
      </div>
    </div>
  );
}

function Level({
  level,
  maxSize,
  side,
}: {
  level: { price: number; size: number };
  maxSize: number;
  side: "bid" | "ask";
}) {
  const pct = Math.min(100, (level.size / maxSize) * 100);
  return (
    <div className="relative flex justify-between px-3 py-0.5">
      <span
        aria-hidden="true"
        className={`absolute inset-y-0 ${side === "bid" ? "right-0 bg-primary/15" : "left-0 bg-error/15"}`}
        style={{ width: `${pct}%` }}
      />
      <span className={`relative ${side === "bid" ? "text-primary" : "text-error"}`}>
        {level.price}
      </span>
      <span className="relative text-on-surface-variant">{level.size}</span>
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <span className="text-on-surface-variant">
      {label} <span className={tone ?? "text-on-surface"}>{value}</span>
    </span>
  );
}
