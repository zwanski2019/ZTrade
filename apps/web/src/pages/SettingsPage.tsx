import { useEffect, useRef, useState } from "react";
import type { Settings, TelegramSettings } from "@ztrade/shared";
import { api, ApiError } from "../lib/api";
import type { LiveFeed } from "../lib/useLiveFeed";
import { Badge, ErrorBanner, Panel, Toggle } from "../components/Ui";
import { Icon } from "../components/Shell";
import { time } from "../lib/format";

export function SettingsPage({ feed }: { feed: LiveFeed }) {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [telegram, setTelegram] = useState<TelegramSettings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api
      .settings()
      .then((s) => {
        setSettings(s);
        setTelegram(s.telegram);
        document.documentElement.classList.toggle("hc", s.ui.highContrast);
      })
      .catch((err: ApiError) => setError(err.message));
  }, []);

  async function saveTelegram(): Promise<void> {
    if (!telegram) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await api.saveTelegram({
        enabled: telegram.enabled,
        // A masked token is what the server sent us; sending it back would
        // overwrite the real one with bullets.
        botToken: telegram.botToken?.includes("•") ? undefined : telegram.botToken,
        chatId: telegram.chatId,
        notifyTradeOpened: telegram.notifyTradeOpened,
        notifyTradeClosed: telegram.notifyTradeClosed,
        notifyDailySummary: telegram.notifyDailySummary,
        notifyErrors: telegram.notifyErrors,
      });
      setNotice("Telegram settings saved.");
    } catch (err) {
      setError((err as ApiError).message);
    } finally {
      setBusy(false);
    }
  }

  async function testConnection(kind: "telegram" | "exchange"): Promise<void> {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      if (kind === "telegram") {
        const { ok } = await api.testTelegram();
        setNotice(ok ? "Test message sent." : "Telegram rejected the request.");
      } else {
        const result = await api.testExchange();
        setNotice(
          result.ok
            ? `Bybit reachable — ${result.latencyMs ?? "?"}ms round trip.`
            : `Bybit check failed${result.reason ? `: ${result.reason}` : ""}.`,
        );
      }
    } catch (err) {
      setError((err as ApiError).message);
    } finally {
      setBusy(false);
    }
  }

  async function toggleHighContrast(next: boolean): Promise<void> {
    document.documentElement.classList.toggle("hc", next);
    setSettings((s) => (s ? { ...s, ui: { highContrast: next } } : s));
    try {
      await api.saveUi({ highContrast: next });
    } catch (err) {
      setError((err as ApiError).message);
    }
  }

  async function emergencyStop(): Promise<void> {
    const confirmed = window.confirm(
      "EMERGENCY STOP will market-close every open position and halt the engine. Continue?",
    );
    if (!confirmed) return;

    setBusy(true);
    try {
      const result = await api.emergencyStop();
      setNotice(`Emergency stop complete — ${result.closed} position(s) closed.`);
    } catch (err) {
      setError((err as ApiError).message);
    } finally {
      setBusy(false);
    }
  }

  const mainnet = settings?.exchange.network === "MAINNET";

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
            <button
              className="btn-outline"
              disabled={busy}
              onClick={() => void testConnection("exchange")}
            >
              Test
            </button>
          }
        >
          <div className="mb-4 flex items-center gap-2">
            <Badge tone={mainnet ? "danger" : "success"}>
              {settings?.exchange.network ?? "…"}
            </Badge>
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
                value={settings?.exchange.hasSecret ? "••••••••••••" : "not configured"}
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

        <Panel
          title="Telegram Bot"
          actions={
            <div className="flex gap-2">
              <button
                className="btn-outline"
                disabled={busy}
                onClick={() => void testConnection("telegram")}
              >
                Test
              </button>
              <button className="btn-primary" disabled={busy} onClick={() => void saveTelegram()}>
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
                    className="field"
                    placeholder="123456:ABC-DEF…"
                    value={telegram.botToken ?? ""}
                    onChange={(e) =>
                      setTelegram((t) => (t ? { ...t, botToken: e.target.value } : t))
                    }
                  />
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
                  onChange={(v) =>
                    setTelegram((t) => (t ? { ...t, notifyTradeOpened: v } : t))
                  }
                />
                <Toggle
                  label="Trade Closed"
                  checked={telegram.notifyTradeClosed}
                  disabled={!telegram.enabled}
                  onChange={(v) =>
                    setTelegram((t) => (t ? { ...t, notifyTradeClosed: v } : t))
                  }
                />
                <Toggle
                  label="Daily Summary"
                  checked={telegram.notifyDailySummary}
                  disabled={!telegram.enabled}
                  onChange={(v) =>
                    setTelegram((t) => (t ? { ...t, notifyDailySummary: v } : t))
                  }
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

        <Panel title="Interface Theme">
          <Toggle
            label="High Contrast Mode"
            description="Increases contrast for better visibility"
            checked={settings?.ui.highContrast ?? false}
            onChange={(v) => void toggleHighContrast(v)}
          />
        </Panel>

        <Panel title="Emergency Kill Switch">
          <p className="font-mono text-[11px] leading-relaxed text-on-surface-variant">
            Market-closes every open position, cancels resting orders and halts the engine.
            Use when something is wrong and you want to be flat immediately.
          </p>
          <button className="btn-danger mt-4 w-full" disabled={busy} onClick={() => void emergencyStop()}>
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
