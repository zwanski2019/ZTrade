import { useEffect, useState } from "react";
import { api, type SystemInfo } from "../lib/api";
import { Badge, EmptyState, Panel } from "../components/Ui";
import { Icon } from "../components/Shell";
import { num, prettyPair } from "../lib/format";

/**
 * The System screen — the "hidden work" made visible.
 *
 * Most of ZTrade is engine internals and framework packages with no UI of their
 * own: the L2 rebuild, the reconciliation loop, the hash-chained audit, the
 * ship gates, the exact-decimal money. This page surfaces the live state of all
 * of it in one place, so the operator can see the machinery, not just the
 * trading terminal on top of it.
 */
const POLL_MS = 2_000;

export function System() {
  const [sys, setSys] = useState<SystemInfo | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const poll = (): void => {
      api
        .system()
        .then((s) => !cancelled && setSys(s))
        .catch((e) => !cancelled && setError((e as Error).message));
    };
    poll();
    const timer = window.setInterval(poll, POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);

  if (error) {
    return (
      <div className="panel p-6 font-mono text-xs text-error">Could not load system state: {error}</div>
    );
  }
  if (!sys) {
    return <EmptyState icon="hourglass_empty" message="Loading system state…" />;
  }

  const eng = sys.engine;
  const ing = sys.pipeline.ingestion;

  return (
    <div className="space-y-4">
      <div>
        <h1 className="font-mono text-lg font-semibold text-on-surface">System</h1>
        <p className="font-mono text-xs text-on-surface-variant">
          The engine internals, data pipeline, ship gates and audit chain — the machinery
          under the terminal.
        </p>
      </div>

      {/* Engine internals */}
      <Panel title="Execution Engine">
        <div className="grid gap-4 sm:grid-cols-3 lg:grid-cols-4">
          <Cell label="State">
            <span className="flex items-center gap-2">
              <span
                className={`h-2 w-2 rounded-full ${
                  eng.state === "RUNNING" ? "animate-pulse-dot bg-primary" : "bg-outline"
                }`}
              />
              <span className={eng.state === "ERROR" ? "text-error" : "text-on-surface"}>
                {eng.state}
              </span>
            </span>
          </Cell>
          <Cell label="Mode">
            <Badge tone={eng.mode === "LIVE" ? "warning" : "neutral"}>{eng.mode}</Badge>{" "}
            <span className="text-[11px] text-outline">{eng.network}</span>
          </Cell>
          <Cell label="Strategy">{eng.activeStrategy ?? "None armed"}</Cell>
          <Cell label="Heartbeat latency">
            {eng.latencyMs !== null ? `${eng.latencyMs}ms` : "—"}
          </Cell>
          <Cell label="Uptime">{eng.uptimeMs > 0 ? formatUptime(eng.uptimeMs) : "—"}</Cell>
          <Cell label="Open positions">{num(eng.openPositions, 0)}</Cell>
          <Cell label="Circuit breaker">
            <span
              className={
                eng.breakerState === "TRIPPED"
                  ? "text-error"
                  : eng.breakerState === "WATCHING"
                    ? "text-secondary-container"
                    : "text-primary"
              }
            >
              {eng.breakerState}
            </span>
          </Cell>
          <Cell label="Exchange">
            <span className={eng.exchangeConnected ? "text-primary" : "text-outline"}>
              {eng.exchangeConnected ? "connected" : "offline"}
            </span>
          </Cell>
        </div>
      </Panel>

      {/* Data pipeline — the L2/ingestion work */}
      <Panel title="Data Pipeline (L2 ingestion)">
        {!sys.pipeline.running || !ing ? (
          <EmptyState icon="lan" message="Feed stopped — start it from the dashboard" />
        ) : (
          <>
            <div className="mb-3 flex flex-wrap gap-4 border-b border-outline-variant pb-3 font-mono text-[11px]">
              <Stat label="messages" value={num(ing.messages, 0)} />
              <Stat label="invalid" value={num(ing.invalid, 0)} bad={ing.invalid > 0} />
              <Stat label="gaps" value={num(ing.gaps, 0)} warn={ing.gaps > 0} />
              <Stat label="stale books" value={num(ing.staleBooks, 0)} bad={ing.staleBooks > 0} />
              <Stat label="reconnects" value={num(ing.reconnects, 0)} />
              <Stat label="latency p50" value={`${ing.latency.p50 ?? "—"}ms`} />
              <Stat label="p99" value={`${ing.latency.p99 ?? "—"}ms`} />
            </div>
            <div className="grid gap-2 sm:grid-cols-2">
              {sys.pipeline.books.map((b) => (
                <div
                  key={b.symbol}
                  className="flex items-center justify-between border border-outline-variant px-3 py-2 font-mono text-[11px]"
                >
                  <span className="text-on-surface">{prettyPair(b.symbol)}</span>
                  <span className="flex items-center gap-3 text-outline">
                    <Badge tone={b.status === "HEALTHY" ? "success" : "danger"}>{b.status}</Badge>
                    <span>Δ{num(b.stats.deltas, 0)}</span>
                    <span className={b.stats.gaps > 0 ? "text-secondary-container" : ""}>
                      gaps {b.stats.gaps}
                    </span>
                    <span className={b.stats.crossed > 0 ? "text-error" : ""}>
                      crossed {b.stats.crossed}
                    </span>
                  </span>
                </div>
              ))}
            </div>
          </>
        )}
      </Panel>

      <div className="grid gap-4 lg:grid-cols-2">
        {/* Ship gates */}
        <Panel title="Ship Gates">
          <p className="mb-3 font-mono text-[11px] text-on-surface-variant">
            The safety properties that must hold before real money. Proven by the test suites,
            not merely asserted.
          </p>
          <ul className="divide-y divide-outline-variant">
            {sys.gates.map((g) => (
              <li key={g.id} className="flex items-center gap-3 py-2 font-mono text-xs">
                <Icon
                  name={g.status === "done" ? "check_circle" : "pending"}
                  className={`text-[16px] ${g.status === "done" ? "text-primary" : "text-secondary-container"}`}
                />
                <span className="text-outline">#{g.id}</span>
                <span className="text-on-surface">{g.name}</span>
              </li>
            ))}
          </ul>
        </Panel>

        {/* Audit chain — the tamper-evident record */}
        <Panel title="Audit Chain">
          <p className="mb-3 font-mono text-[11px] leading-relaxed text-on-surface-variant">
            Every money- and security-relevant action is hash-chained:
            <code className="mx-1 text-primary">h(n) = SHA256(h(n-1) ‖ entry)</code>. Editing any
            historical entry breaks the chain. This is the "prove what the bot did" record.
          </p>
          <div className="space-y-2 font-mono text-xs">
            <Row label="Integrity">
              {sys.audit.chainValid ? (
                <span className="flex items-center gap-1.5 text-primary">
                  <Icon name="verified" className="text-[14px]" /> VERIFIED
                </span>
              ) : (
                <span className="text-error">
                  BROKEN at #{sys.audit.brokenAt} — {sys.audit.reason}
                </span>
              )}
            </Row>
            <Row label="Entries">{num(sys.audit.entries, 0)}</Row>
            <Row label="Chain head">
              <span className="text-outline">{sys.audit.head}…</span>
            </Row>
          </div>
        </Panel>
      </div>

      {/* Architecture / build */}
      <Panel title={`Architecture · v${sys.build.version} · ${sys.build.tests} tests`}>
        <p className="mb-3 font-mono text-[11px] text-on-surface-variant">
          ZTrade is a monorepo of typed packages behind interfaces. The terminal is one app on
          top; these are the framework layers underneath.
        </p>
        <div className="grid gap-2 sm:grid-cols-2">
          {sys.build.packages.map((p) => (
            <div key={p.name} className="border border-outline-variant px-3 py-2">
              <div className="font-mono text-xs text-primary">{p.name}</div>
              <div className="mt-0.5 font-mono text-[11px] text-on-surface-variant">{p.role}</div>
            </div>
          ))}
        </div>
      </Panel>
    </div>
  );
}

function Cell({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="font-mono text-[10px] uppercase tracking-widest text-on-surface-variant">
        {label}
      </div>
      <div className="metric mt-1 font-mono text-sm text-on-surface">{children}</div>
    </div>
  );
}

function Stat({ label, value, warn, bad }: { label: string; value: string; warn?: boolean; bad?: boolean }) {
  return (
    <span className="text-on-surface-variant">
      {label}{" "}
      <span className={bad ? "text-error" : warn ? "text-secondary-container" : "text-on-surface"}>
        {value}
      </span>
    </span>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between border-b border-outline-variant pb-2">
      <span className="text-on-surface-variant">{label}</span>
      <span>{children}</span>
    </div>
  );
}

function formatUptime(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}
