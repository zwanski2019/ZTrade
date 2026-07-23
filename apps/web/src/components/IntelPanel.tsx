import { useEffect, useState } from "react";
import type { MarketIntel, MarketRegime } from "@ztrade/shared";
import { api } from "../lib/api";
import { Badge, EmptyState, Panel } from "./Ui";
import { Icon } from "./Shell";
import { num, prettyPair } from "../lib/format";

const REGIME_TONE: Record<MarketRegime, "success" | "warning" | "danger" | "neutral"> = {
  TRENDING: "success",
  RANGING: "neutral",
  VOLATILE: "danger",
  TRANSITIONAL: "warning",
  UNKNOWN: "neutral",
};

/** Fear & Greed colour follows the index's own convention. */
function sentimentTone(value: number): string {
  if (value <= 25) return "text-error";
  if (value >= 75) return "text-secondary-container";
  return "text-on-surface";
}

export function IntelPanel() {
  const [intel, setIntel] = useState<MarketIntel | null>(null);

  useEffect(() => {
    let cancelled = false;

    const load = (): void => {
      api
        .intel()
        .then((r) => !cancelled && setIntel(r.intel))
        .catch(() => {
          /* Intelligence is optional; the dashboard works without it. */
        });
    };

    load();
    // Free providers are cached server-side, so polling this often is cheap.
    const timer = window.setInterval(load, 30_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);

  const correlations = Object.entries(intel?.correlations ?? {})
    .sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]))
    .slice(0, 4);

  return (
    <Panel
      title="Market Intelligence"
      actions={
        intel?.degraded.length ? (
          <span
            className="font-mono text-[10px] uppercase tracking-wider text-secondary-container"
            title={`Unavailable: ${intel.degraded.join(", ")}`}
          >
            <Icon name="cloud_off" className="mr-1 align-[-2px] text-[12px]" />
            degraded
          </span>
        ) : null
      }
    >
      {!intel || intel.at === 0 ? (
        <EmptyState icon="radar" message="No intelligence gathered yet — start the engine" />
      ) : (
        <div className="space-y-4">
          {/* Global context */}
          <div className="grid gap-3 sm:grid-cols-3">
            <Readout label="Fear & Greed">
              {intel.fearGreed ? (
                <span className={sentimentTone(intel.fearGreed.value)}>
                  {intel.fearGreed.value}{" "}
                  <span className="text-[11px] text-on-surface-variant">
                    {intel.fearGreed.classification}
                  </span>
                </span>
              ) : (
                <span className="text-outline">—</span>
              )}
            </Readout>

            <Readout label="BTC Dominance">
              {intel.btcDominance !== null ? `${num(intel.btcDominance, 1)}%` : "—"}
            </Readout>

            <Readout label="Total Cap 24h">
              {intel.marketCapChangePct24h !== null ? (
                <span
                  className={
                    intel.marketCapChangePct24h >= 0 ? "text-primary" : "text-error"
                  }
                >
                  {intel.marketCapChangePct24h >= 0 ? "+" : ""}
                  {num(intel.marketCapChangePct24h, 2)}%
                </span>
              ) : (
                "—"
              )}
            </Readout>
          </div>

          {/* Per-symbol */}
          {intel.symbols.length > 0 && (
            <div className="overflow-x-auto border-t border-outline-variant pt-3">
              <table className="w-full min-w-[560px] font-mono text-xs">
                <thead>
                  <tr className="text-left text-[10px] uppercase tracking-widest text-on-surface-variant">
                    <th className="py-1.5 pr-3 font-medium">Pair</th>
                    <th className="py-1.5 pr-3 font-medium">Regime</th>
                    <th className="py-1.5 pr-3 text-right font-medium">ADX</th>
                    <th className="py-1.5 pr-3 text-right font-medium">ATR</th>
                    <th className="py-1.5 pr-3 text-right font-medium">Funding</th>
                    <th className="py-1.5 pr-3 text-right font-medium">OI Δ</th>
                    <th className="py-1.5 text-right font-medium">vs Consensus</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-outline-variant">
                  {intel.symbols.map((s) => (
                    <tr key={s.symbol}>
                      <td className="py-2 pr-3 text-on-surface">{prettyPair(s.symbol)}</td>
                      <td className="py-2 pr-3">
                        <Badge tone={REGIME_TONE[s.regime]}>{s.regime}</Badge>
                      </td>
                      <td className="metric py-2 pr-3 text-right text-on-surface-variant">
                        {num(s.adx, 1)}
                      </td>
                      <td className="metric py-2 pr-3 text-right text-on-surface-variant">
                        {num(s.volatility * 100, 2)}%
                      </td>
                      <td
                        className={`metric py-2 pr-3 text-right ${
                          s.fundingRate === null
                            ? "text-outline"
                            : s.fundingRate > 0
                              ? "text-error"
                              : "text-primary"
                        }`}
                        title="Positive funding means longs are paying — a long-heavy book"
                      >
                        {s.fundingRate !== null
                          ? `${(s.fundingRate * 100).toFixed(4)}%`
                          : "—"}
                      </td>
                      <td
                        className={`metric py-2 pr-3 text-right ${
                          (s.openInterestChangePct ?? 0) >= 0
                            ? "text-on-surface-variant"
                            : "text-secondary-container"
                        }`}
                      >
                        {s.openInterestChangePct !== null
                          ? `${s.openInterestChangePct >= 0 ? "+" : ""}${num(s.openInterestChangePct, 1)}%`
                          : "—"}
                      </td>
                      <td
                        className={`metric py-2 text-right ${
                          Math.abs(s.consensusDeviationBps ?? 0) > 100
                            ? "text-error"
                            : "text-on-surface-variant"
                        }`}
                        title="Deviation from the median price across independent venues"
                      >
                        {s.consensusDeviationBps !== null
                          ? `${s.consensusDeviationBps >= 0 ? "+" : ""}${num(s.consensusDeviationBps, 0)}bps`
                          : "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {/* Correlation — concentration risk the position count cannot see */}
          {correlations.length > 0 && (
            <div className="border-t border-outline-variant pt-3">
              <div className="mb-2 font-mono text-[10px] uppercase tracking-widest text-on-surface-variant">
                Return Correlation
              </div>
              <div className="flex flex-wrap gap-2">
                {correlations.map(([pair, value]) => (
                  <span
                    key={pair}
                    className={`border px-2 py-1 font-mono text-[11px] ${
                      Math.abs(value) >= 0.85
                        ? "border-error text-error"
                        : "border-outline-variant text-on-surface-variant"
                    }`}
                    title={
                      Math.abs(value) >= 0.85
                        ? "Highly correlated — these are effectively one position"
                        : undefined
                    }
                  >
                    {pair.split("|").map(prettyPair).join(" ↔ ")} {value.toFixed(2)}
                  </span>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </Panel>
  );
}

function Readout({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="font-mono text-[10px] uppercase tracking-widest text-on-surface-variant">
        {label}
      </div>
      <div className="metric mt-1 font-mono text-sm text-on-surface">{children}</div>
    </div>
  );
}
