import { useEffect, useState } from "react";
import type { BacktestResult, StrategyConfig, StrategyKind } from "@ztrade/shared";
import { api, ApiError } from "../lib/api";
import { Badge, ErrorBanner, Panel } from "../components/Ui";
import { Icon } from "../components/Shell";
import { num, pct, signedUsd, usd } from "../lib/format";

const KINDS: Array<{ value: StrategyKind; label: string; blurb: string }> = [
  { value: "MOMENTUM", label: "Momentum", blurb: "MACD crossover confirmed by RSI" },
  { value: "MEAN_REVERSION", label: "Mean Reversion", blurb: "Fade Bollinger band pierces" },
  { value: "GRID", label: "Grid", blurb: "Ladder around a rolling mean" },
  { value: "CUSTOM", label: "Custom Script", blurb: "Not implemented — needs a sandbox" },
];

const BLANK: Omit<StrategyConfig, "updatedAt"> = {
  id: "",
  name: "New Strategy",
  kind: "MOMENTUM",
  enabled: false,
  pairs: ["BTCUSDT"],
  risk: {
    maxPositionSize: 100,
    stopLossPct: 2,
    takeProfitPct: 4,
    maxTradesPerDay: 10,
    globalRiskCap: 500,
  },
  params: { interval: "5" },
};

export function StrategyConfigPage() {
  const [strategies, setStrategies] = useState<StrategyConfig[]>([]);
  const [draft, setDraft] = useState<Omit<StrategyConfig, "updatedAt">>(BLANK);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [backtesting, setBacktesting] = useState(false);
  const [backtest, setBacktest] = useState<BacktestResult | null>(null);
  const [newPair, setNewPair] = useState("");

  useEffect(() => {
    void reload();
  }, []);

  async function reload(): Promise<void> {
    try {
      const list = await api.strategies();
      setStrategies(list);
      // Prefer the armed strategy; otherwise the most recent one.
      const preferred = list.find((s) => s.enabled) ?? list[0];
      if (preferred) setDraft(preferred);
    } catch (err) {
      setError((err as ApiError).message);
    }
  }

  function patchRisk(key: keyof StrategyConfig["risk"], raw: string): void {
    const value = Number(raw);
    if (!Number.isFinite(value)) return;
    setDraft((d) => ({ ...d, risk: { ...d.risk, [key]: value } }));
  }

  function addPair(): void {
    const symbol = newPair.trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
    if (!symbol) return;
    if (draft.pairs.includes(symbol)) {
      setError(`${symbol} is already in the list`);
      return;
    }
    setDraft((d) => ({ ...d, pairs: [...d.pairs, symbol] }));
    setNewPair("");
    setError(null);
  }

  async function save(): Promise<void> {
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const saved = await api.saveStrategy({ ...draft, id: draft.id || undefined } as never);
      setDraft(saved);
      await reload();
      setNotice(
        saved.enabled
          ? `Saved and armed "${saved.name}".`
          : `Saved "${saved.name}". It is not armed — enable it to let the engine trade it.`,
      );
    } catch (err) {
      setError((err as ApiError).message);
    } finally {
      setSaving(false);
    }
  }

  async function runBacktest(): Promise<void> {
    if (!draft.id) {
      setError("Save the strategy before running a backtest.");
      return;
    }
    setBacktesting(true);
    setError(null);
    try {
      setBacktest(await api.backtest(draft.id, { candles: 500 }));
    } catch (err) {
      setError((err as ApiError).message);
    } finally {
      setBacktesting(false);
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

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="font-mono text-lg font-semibold text-on-surface">Strategy Config</h1>
          <p className="font-mono text-xs text-on-surface-variant">
            Define execution logic and risk parameters
          </p>
        </div>
        <div className="flex gap-2">
          <button className="btn-outline" onClick={() => setDraft({ ...BLANK })}>
            <Icon name="add" className="text-[14px]" /> New
          </button>
          <button className="btn-primary" disabled={saving} onClick={() => void save()}>
            <Icon name="save" className="text-[14px]" />
            {saving ? "Saving…" : "Save & Apply"}
          </button>
        </div>
      </div>

      {strategies.length > 1 && (
        <Panel title="Saved Strategies" bodyClassName="flex flex-wrap gap-2 p-4">
          {strategies.map((s) => (
            <button
              key={s.id}
              onClick={() => setDraft(s)}
              className={`border px-3 py-1.5 font-mono text-xs transition-colors ${
                s.id === draft.id
                  ? "border-primary text-primary"
                  : "border-outline-variant text-on-surface-variant hover:border-outline"
              }`}
            >
              {s.name}
              {s.enabled && <span className="ml-2 text-primary">●</span>}
            </button>
          ))}
        </Panel>
      )}

      <div className="grid gap-4 lg:grid-cols-3">
        <div className="space-y-4 lg:col-span-2">
          <Panel title="Algorithm Core">
            <label className="field-label" htmlFor="strategy-name">
              Strategy Name
            </label>
            <input
              id="strategy-name"
              className="field mb-4"
              value={draft.name}
              onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
            />

            <div className="grid gap-2 sm:grid-cols-2">
              {KINDS.map((kind) => {
                const selected = draft.kind === kind.value;
                const disabled = kind.value === "CUSTOM";
                return (
                  <button
                    key={kind.value}
                    disabled={disabled}
                    onClick={() => setDraft((d) => ({ ...d, kind: kind.value }))}
                    className={`border p-3 text-left transition-colors ${
                      selected
                        ? "border-primary bg-surface-container"
                        : "border-outline-variant hover:border-outline"
                    } ${disabled ? "cursor-not-allowed opacity-40" : ""}`}
                  >
                    <div
                      className={`font-mono text-xs uppercase tracking-wider ${
                        selected ? "text-primary" : "text-on-surface"
                      }`}
                    >
                      {kind.label}
                    </div>
                    <div className="mt-1 text-[11px] text-on-surface-variant">
                      {kind.blurb}
                    </div>
                  </button>
                );
              })}
            </div>
          </Panel>

          <Panel title="Risk Parameters">
            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <label className="field-label" htmlFor="max-position">
                  Max Position Size ($)
                </label>
                <input
                  id="max-position"
                  type="number"
                  min="1"
                  className="field"
                  value={draft.risk.maxPositionSize}
                  onChange={(e) => patchRisk("maxPositionSize", e.target.value)}
                />
              </div>
              <div>
                <label className="field-label" htmlFor="global-cap">
                  Global Risk Cap ($)
                </label>
                <input
                  id="global-cap"
                  type="number"
                  min="1"
                  className="field"
                  value={draft.risk.globalRiskCap}
                  onChange={(e) => patchRisk("globalRiskCap", e.target.value)}
                />
              </div>
              <div>
                <label className="field-label" htmlFor="stop-loss">
                  Stop-Loss Threshold (%)
                </label>
                <input
                  id="stop-loss"
                  type="number"
                  min="0.1"
                  step="0.1"
                  className="field"
                  value={draft.risk.stopLossPct}
                  onChange={(e) => patchRisk("stopLossPct", e.target.value)}
                />
              </div>
              <div>
                <label className="field-label" htmlFor="take-profit">
                  Take-Profit Target (%)
                </label>
                <input
                  id="take-profit"
                  type="number"
                  min="0.1"
                  step="0.1"
                  className="field"
                  value={draft.risk.takeProfitPct}
                  onChange={(e) => patchRisk("takeProfitPct", e.target.value)}
                />
              </div>
              <div>
                <label className="field-label" htmlFor="max-trades">
                  Max Trades / Day
                </label>
                <input
                  id="max-trades"
                  type="number"
                  min="0"
                  className="field"
                  value={draft.risk.maxTradesPerDay}
                  onChange={(e) => patchRisk("maxTradesPerDay", e.target.value)}
                />
              </div>
              <div>
                <label className="field-label" htmlFor="interval">
                  Candle Interval (min)
                </label>
                <select
                  id="interval"
                  className="field"
                  value={String(draft.params.interval ?? "5")}
                  onChange={(e) =>
                    setDraft((d) => ({
                      ...d,
                      params: { ...d.params, interval: e.target.value },
                    }))
                  }
                >
                  {["1", "3", "5", "15", "30", "60", "240"].map((v) => (
                    <option key={v} value={v}>
                      {v}m
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <label className="mt-5 flex cursor-pointer items-center gap-3 border-t border-outline-variant pt-4">
              <input
                type="checkbox"
                className="h-4 w-4 accent-[#00FF41]"
                checked={draft.enabled}
                onChange={(e) => setDraft((d) => ({ ...d, enabled: e.target.checked }))}
              />
              <span className="font-mono text-xs uppercase tracking-wider text-on-surface">
                Arm this strategy
              </span>
              <span className="text-[11px] text-on-surface-variant">
                Only one strategy can be armed at a time
              </span>
            </label>
          </Panel>
        </div>

        <div className="space-y-4">
          <Panel title="Allowed Trading Pairs">
            <div className="flex flex-wrap gap-2">
              {draft.pairs.map((pair) => (
                <span
                  key={pair}
                  className="inline-flex items-center gap-2 border border-outline-variant px-2.5 py-1 font-mono text-xs text-on-surface"
                >
                  {pair}
                  <button
                    aria-label={`Remove ${pair}`}
                    className="text-outline hover:text-error"
                    onClick={() =>
                      setDraft((d) => ({
                        ...d,
                        pairs: d.pairs.filter((p) => p !== pair),
                      }))
                    }
                  >
                    <Icon name="close" className="text-[14px]" />
                  </button>
                </span>
              ))}
            </div>

            <div className="mt-3 flex gap-2">
              <input
                className="field"
                placeholder="SOLUSDT"
                value={newPair}
                onChange={(e) => setNewPair(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && addPair()}
              />
              <button className="btn-outline shrink-0" onClick={addPair}>
                <Icon name="add" className="text-[14px]" /> Add
              </button>
            </div>
          </Panel>

          <Panel
            title="Backtest Engine"
            actions={
              <button
                className="btn-outline"
                disabled={backtesting}
                onClick={() => void runBacktest()}
              >
                <Icon name="play_arrow" className="text-[14px]" />
                {backtesting ? "Running…" : "Run"}
              </button>
            }
          >
            {backtest ? (
              <dl className="space-y-3 font-mono text-xs">
                <Row label="Win Rate" value={pct(backtest.winRate, 1, false)} />
                <Row label="Max Drawdown" value={usd(backtest.maxDrawdown)} />
                <Row label="Trades Count" value={num(backtest.tradesCount, 0)} />
                <Row
                  label="Net P&L"
                  value={signedUsd(backtest.netPnl)}
                  tone={backtest.netPnl >= 0 ? "text-primary" : "text-error"}
                />
              </dl>
            ) : (
              <p className="font-mono text-[11px] leading-relaxed text-on-surface-variant">
                Replays the strategy over the last 500 candles. Fills are modelled at the
                candle close with no slippage, and a candle that spans both stop and target
                is counted as a stop — so treat these numbers as optimistic-case bounds.
              </p>
            )}
          </Panel>

          {draft.enabled && (
            <div className="border border-outline-variant p-3">
              <Badge tone="success">Armed</Badge>
              <p className="mt-2 font-mono text-[11px] text-on-surface-variant">
                The engine will trade this strategy when started.
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function Row({
  label,
  value,
  tone = "text-on-surface",
}: {
  label: string;
  value: string;
  tone?: string;
}) {
  return (
    <div className="flex items-center justify-between border-b border-outline-variant pb-2">
      <dt className="text-on-surface-variant">{label}</dt>
      <dd className={`metric ${tone}`}>{value}</dd>
    </div>
  );
}
