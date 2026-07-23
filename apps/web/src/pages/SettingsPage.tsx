import { useEffect, useRef, useState } from "react";
import type {
  AuditEntry,
  CircuitBreakerConfig,
  Settings,
  TelegramSettings,
} from "@ztrade/shared";
import { api, ApiError } from "../lib/api";
import type { LiveFeed } from "../lib/useLiveFeed";
import { Badge, ErrorBanner, Panel, Toggle } from "../components/Ui";
import { Icon } from "../components/Shell";
import { setToken } from "../lib/auth";
import { dateTime, signedUsd, time } from "../lib/format";

/** Placeholder the server sends in place of a stored secret. */
const MASKED = "••••••••";

export function SettingsPage({ feed }: { feed: LiveFeed }) {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [telegram, setTelegram] = useState<TelegramSettings | null>(null);
  const [breaker, setBreaker] = useState<CircuitBreakerConfig | null>(null);
  const [audit, setAudit] = useState<AuditEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api
      .settings()
      .then((s) => {
        setSettings(s);
        setTelegram(s.telegram);
        setBreaker(s.circuitBreaker);
        document.documentElement.classList.toggle("hc", s.ui.highContrast);
      })
      .catch((err: ApiError) => setError(err.message));

    api.audit(50).then(setAudit).catch(() => setAudit([]));
  }, []);

  function report(fn: () => Promise<void>): () => void {
    return () => {
      setBusy(true);
      setError(null);
      setNotice(null);
      fn()
        .catch((err) => setError((err as ApiError).message))
        .finally(() => setBusy(false));
    };
  }

  const saveTelegram = report(async () => {
    if (!telegram) return;
    await api.saveTelegram({
      enabled: telegram.enabled,
      // The server only ever sends a placeholder, so sending it back would
      // overwrite the real token with bullets. Omit it unless it was retyped.
      botToken: telegram.botToken === MASKED ? undefined : telegram.botToken,
      chatId: telegram.chatId,
      notifyTradeOpened: telegram.notifyTradeOpened,
      notifyTradeClosed: telegram.notifyTradeClosed,
      notifyDailySummary: telegram.notifyDailySummary,
      notifyErrors: telegram.notifyErrors,
    });
    setNotice("Telegram settings saved.");
  });

  const saveBreaker = report(async () => {
    if (!breaker) return;
    await api.saveCircuitBreaker(breaker);
    setNotice("Circuit breaker settings saved.");
  });

  const testTelegram = report(async () => {
    const { ok } = await api.testTelegram();
    setNotice(ok ? "Test message sent." : "Telegram rejected the request.");
  });

  const testExchange = report(async () => {
    const result = await api.testExchange();
    setNotice(
      result.ok
        ? `Bybit reachable — ${result.latencyMs ?? "?"}ms round trip.`
        : `Bybit check failed${result.reason ? `: ${result.reason}` : ""}.`,
    );
  });

  const emergencyStop = report(async () => {
    const confirmed = window.confirm(
      "EMERGENCY STOP will market-close every open position and halt the engine. Continue?",
    );
    if (!confirmed) return;
    const result = await api.emergencyStop();
    setNotice(`Emergency stop complete — ${result.closed} position(s) closed.`);
  });

  async function toggleHighContrast(next: boolean): Promise<void> {
    document.documentElement.classList.toggle("hc", next);
    setSettings((s) => (s ? { ...s, ui: { highContrast: next } } : s));
    try {
      await api.saveUi({ highContrast: next });
    } catch (err) {
      setError((err as ApiError).message);
    }
  }

  const mainnet = settings?.exchange.network === "MAINNET";
  const breakerState = feed.circuitBreaker ?? feed.status?.circuitBreaker ?? null;

  return (
    <div className="space-y-4">
      <ErrorBanner message={error} />
      {notice && (
        <div className="border border-outline-variant bg-surface-container-low px-4 py-2.5 font-mono text-xs text-on-surface-variant">
          {notice}
        </div>
      )}

      <div>
        <h1 className="font-mono text-lg font-semibold text-on-surface">
          System Configuration
        </h1>
        <p className="font-mono text-xs text-on-surface-variant">
          Manage API connections, notification bots, and security fail-safes.
        </p>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Panel
          title="Exchange API"
          actions={
            <button className="btn-outline" disabled={busy} onClick={testExchange}>
              Test
            </button>
          }
        >
          <div className="mb-4 flex flex-wrap items-center gap-2">
            <Badge tone={mainnet ? "danger" : "success"}>
              {settings?.exchange.network ?? "…"}
            </Badge>
            <Badge tone={settings?.exchange.tradingEnabled ? "warning" : "neutral"}>
              {settings?.exchange.tradingEnabled ? "Live orders" : "Paper"}
            </Badge>
            {settings?.exchange.credentialsValid && <Badge tone="success">Verified</Badge>}
            {mainnet && (
              <span className="font-mono text-[11px] text-error">
                Trading against real funds
              </span>
            )}
          </div>

          <div className="space-y-3">
            <div>
              <label className="field-label">Bybit API Key</label>
              <input
                className="field"
                readOnly
                value={settings?.exchange.apiKeyMasked ?? "not configured"}
              />
            </div>
            <div>
              <label className="field-label">API Secret</label>
              <input
                className="field"
                readOnly
                value={settings?.exchange.hasSecret ? MASKED : "not configured"}
              />
            </div>
          </div>

          <p className="mt-4 border border-outline-variant p-3 font-mono text-[11px] leading-relaxed text-on-surface-variant">
            <Icon name="info" className="mr-1 align-[-3px] text-[14px]" />
            Credentials are read from <code className="text-primary">.env</code> at startup
            and cannot be changed from the browser — that would mean storing trading keys in
            the database and accepting them over HTTP. Edit{" "}
            <code className="text-primary">BYBIT_API_KEY</code> /{" "}
            <code className="text-primary">BYBIT_API_SECRET</code> and restart the server.
          </p>
        </Panel>

        {/* Circuit breaker */}
        <Panel
          title="Circuit Breaker"
          actions={
            <button className="btn-primary" disabled={busy} onClick={saveBreaker}>
              Save
            </button>
          }
        >
          {breaker && (
            <>
              <p className="mb-4 font-mono text-[11px] leading-relaxed text-on-surface-variant">
                Per-trade limits cap one bad trade; this caps a bad <em>day</em>. Ten trades
                each losing an acceptable 1% is still a 10% drawdown.
              </p>

              <Toggle
                label="Enabled"
                checked={breaker.enabled}
                onChange={(v) => setBreaker({ ...breaker, enabled: v })}
              />

              <div className="mt-3 grid gap-4 sm:grid-cols-2">
                <div>
                  <label className="field-label" htmlFor="max-daily-loss">
                    Max Daily Loss (%)
                  </label>
                  <input
                    id="max-daily-loss"
                    type="number"
                    min="0"
                    step="0.5"
                    className="field"
                    value={breaker.maxDailyLossPct}
                    onChange={(e) =>
                      setBreaker({ ...breaker, maxDailyLossPct: Number(e.target.value) })
                    }
                  />
                </div>
                <div>
                  <label className="field-label" htmlFor="max-losses">
                    Max Consecutive Losses
                  </label>
                  <input
                    id="max-losses"
                    type="number"
                    min="0"
                    className="field"
                    value={breaker.maxConsecutiveLosses}
                    onChange={(e) =>
                      setBreaker({
                        ...breaker,
                        maxConsecutiveLosses: Number(e.target.value),
                      })
                    }
                  />
                </div>
                <div>
                  <label className="field-label" htmlFor="cooldown">
                    Cooldown (minutes)
                  </label>
                  <input
                    id="cooldown"
                    type="number"
                    min="0"
                    className="field"
                    value={breaker.cooldownMinutes}
                    onChange={(e) =>
                      setBreaker({ ...breaker, cooldownMinutes: Number(e.target.value) })
                    }
                  />
                </div>
              </div>

              <div className="mt-2 border-t border-outline-variant">
                <Toggle
                  label="Flatten on trip"
                  description="Also close open positions, not just stop opening new ones"
                  checked={breaker.flattenOnTrip}
                  onChange={(v) => setBreaker({ ...breaker, flattenOnTrip: v })}
                />
              </div>

              {breakerState && (
                <div className="mt-3 border border-outline-variant p-3 font-mono text-[11px]">
                  <div className="flex justify-between">
                    <span className="text-on-surface-variant">Status</span>
                    <span className={breakerState.tripped ? "text-error" : "text-primary"}>
                      {breakerState.tripped ? "TRIPPED" : "Armed"}
                    </span>
                  </div>
                  <div className="mt-1 flex justify-between">
                    <span className="text-on-surface-variant">Realised today</span>
                    <span className="metric">{signedUsd(breakerState.realisedPnlToday)}</span>
                  </div>
                  <div className="mt-1 flex justify-between">
                    <span className="text-on-surface-variant">Loss streak</span>
                    <span className="metric">{breakerState.consecutiveLosses}</span>
                  </div>
                </div>
              )}
            </>
          )}
        </Panel>

        <Panel
          title="Telegram Bot"
          actions={
            <div className="flex gap-2">
              <button className="btn-outline" disabled={busy} onClick={testTelegram}>
                Test
              </button>
              <button className="btn-primary" disabled={busy} onClick={saveTelegram}>
                Save
              </button>
            </div>
          }
        >
          {telegram && (
            <>
              <div className="space-y-3">
                <div>
                  <label className="field-label" htmlFor="bot-token">
                    Bot Token
                  </label>
                  <input
                    id="bot-token"
                    type="password"
                    className="field"
                    placeholder="123456:ABC-DEF…"
                    value={telegram.botToken ?? ""}
                    onChange={(e) =>
                      setTelegram((t) => (t ? { ...t, botToken: e.target.value } : t))
                    }
                  />
                  <p className="mt-1 font-mono text-[10px] text-outline">
                    Stored encrypted (AES-256-GCM). Leave as-is to keep the current token.
                  </p>
                </div>
                <div>
                  <label className="field-label" htmlFor="chat-id">
                    Chat ID
                  </label>
                  <input
                    id="chat-id"
                    className="field"
                    placeholder="-1001234567890"
                    value={telegram.chatId ?? ""}
                    onChange={(e) =>
                      setTelegram((t) => (t ? { ...t, chatId: e.target.value } : t))
                    }
                  />
                </div>
              </div>

              <div className="mt-4 divide-y divide-outline-variant border-t border-outline-variant">
                <Toggle
                  label="Enabled"
                  checked={telegram.enabled}
                  onChange={(v) => setTelegram((t) => (t ? { ...t, enabled: v } : t))}
                />
                <Toggle
                  label="Trade Opened"
                  checked={telegram.notifyTradeOpened}
                  disabled={!telegram.enabled}
                  onChange={(v) => setTelegram((t) => (t ? { ...t, notifyTradeOpened: v } : t))}
                />
                <Toggle
                  label="Trade Closed"
                  checked={telegram.notifyTradeClosed}
                  disabled={!telegram.enabled}
                  onChange={(v) => setTelegram((t) => (t ? { ...t, notifyTradeClosed: v } : t))}
                />
                <Toggle
                  label="Daily Summary"
                  description="Sent just after 00:00 UTC"
                  checked={telegram.notifyDailySummary}
                  disabled={!telegram.enabled}
                  onChange={(v) => setTelegram((t) => (t ? { ...t, notifyDailySummary: v } : t))}
                />
                <Toggle
                  label="Error Alerts"
                  checked={telegram.notifyErrors}
                  disabled={!telegram.enabled}
                  onChange={(v) => setTelegram((t) => (t ? { ...t, notifyErrors: v } : t))}
                />
              </div>
            </>
          )}
        </Panel>

        <Panel title="Interface & Session">
          <Toggle
            label="High Contrast Mode"
            description="Increases contrast for better visibility"
            checked={settings?.ui.highContrast ?? false}
            onChange={(v) => void toggleHighContrast(v)}
          />
          <div className="mt-4 border-t border-outline-variant pt-4">
            <button
              className="btn-outline w-full"
              onClick={() => {
                setToken(null);
                window.location.reload();
              }}
            >
              <Icon name="logout" className="text-[14px]" /> Forget API token
            </button>
            <p className="mt-2 font-mono text-[10px] text-outline">
              Clears the token from this browser. You will need it again to get back in.
            </p>
          </div>
        </Panel>

        <Panel title="Emergency Kill Switch">
          <p className="font-mono text-[11px] leading-relaxed text-on-surface-variant">
            Market-closes every open position, cancels resting orders and halts the engine.
            Use when something is wrong and you want to be flat immediately.
          </p>
          <button className="btn-danger mt-4 w-full" disabled={busy} onClick={emergencyStop}>
            <Icon name="warning" className="text-[14px]" />
            Emergency Stop — Close All
          </button>
          <div className="mt-3 flex items-center gap-2 font-mono text-[11px] text-on-surface-variant">
            <span
              className={`h-2 w-2 rounded-full ${
                feed.status?.state === "RUNNING" ? "animate-pulse-dot bg-primary" : "bg-outline"
              }`}
            />
            {feed.status?.state === "RUNNING" ? "System armed & ready" : "Engine stopped"}
          </div>
        </Panel>

        <Panel title="Audit Log" bodyClassName="max-h-80 overflow-y-auto p-0">
          {audit.length === 0 ? (
            <p className="p-4 font-mono text-[11px] text-outline">No recorded actions yet.</p>
          ) : (
            <ul className="divide-y divide-outline-variant font-mono text-[11px]">
              {audit.map((entry) => (
                <li key={entry.id} className="px-4 py-2">
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-primary">{entry.action}</span>
                    <span className="shrink-0 text-outline">{dateTime(entry.at)}</span>
                  </div>
                  <div className="text-on-surface-variant">{entry.detail}</div>
                  {entry.actor && (
                    <div className="text-[10px] text-outline">from {entry.actor}</div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </div>

      <LogStream feed={feed} />
    </div>
  );
}

function LogStream({ feed }: { feed: LiveFeed }) {
  const [autoScroll, setAutoScroll] = useState(true);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (autoScroll) endRef.current?.scrollIntoView({ block: "nearest" });
  }, [feed.logs, autoScroll]);

  const toneFor = (level: string): string => {
    if (level === "ERROR") return "text-error";
    if (level === "WARN") return "text-secondary-container";
    if (level === "TRADE") return "text-primary";
    return "text-on-surface-variant";
  };

  return (
    <Panel
      title="SYSTEM_LOGS_STREAM"
      actions={
        <button
          className="btn-outline"
          onClick={() => setAutoScroll((v) => !v)}
          aria-pressed={autoScroll}
        >
          <Icon name={autoScroll ? "pause" : "play_arrow"} className="text-[14px]" />
          {autoScroll ? "Pause" : "Follow"}
        </button>
      }
      bodyClassName="p-0"
    >
      <div className="max-h-80 overflow-y-auto bg-surface-container-lowest p-3 font-mono text-[11px] leading-relaxed">
        {feed.logs.length === 0 ? (
          <p className="text-outline">Waiting for engine output…</p>
        ) : (
          feed.logs.map((entry) => (
            <div key={entry.id} className="flex gap-2">
              <span className="shrink-0 text-outline">[{time(entry.at)}]</span>
              <span className={`shrink-0 ${toneFor(entry.level)}`}>{entry.level}:</span>
              <span className="text-on-surface-variant">{entry.message}</span>
            </div>
          ))
        )}
        <div ref={endRef} />
      </div>
    </Panel>
  );
}
