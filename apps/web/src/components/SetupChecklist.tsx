import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import type { Settings, StrategyConfig } from "@ztrade/shared";
import { api } from "../lib/api";
import type { LiveFeed } from "../lib/useLiveFeed";
import { Icon } from "./Shell";
import { Panel } from "./Ui";

/**
 * First-run guidance.
 *
 * A self-hosted trading bot has a genuinely confusing cold start: the engine
 * can be running, connected and completely idle because nothing is armed, and
 * nothing on screen says so. This turns "why isn't it doing anything?" into a
 * checklist.
 *
 * It hides itself once everything required is done, so it never becomes
 * permanent furniture on an experienced operator's dashboard.
 */
type StepState = "done" | "todo" | "optional";

interface Step {
  key: string;
  state: StepState;
  title: string;
  detail: string;
  action?: { label: string; to: string };
}

export function SetupChecklist({ feed }: { feed: LiveFeed }) {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [strategies, setStrategies] = useState<StrategyConfig[] | null>(null);
  const [dismissed, setDismissed] = useState(
    () => window.localStorage.getItem("ztrade.setupDismissed") === "1",
  );

  useEffect(() => {
    let cancelled = false;
    Promise.all([api.settings(), api.strategies()])
      .then(([s, list]) => {
        if (cancelled) return;
        setSettings(s);
        setStrategies(list);
      })
      .catch(() => {
        /* The checklist is guidance; a failure just hides it. */
      });
    return () => {
      cancelled = true;
    };
  }, [feed.status?.activeStrategyId, feed.status?.state]);

  if (dismissed || !settings || !strategies) return null;

  const armed = strategies.find((s) => s.enabled) ?? null;
  const status = feed.status;

  const steps: Step[] = [
    {
      key: "connected",
      state: status?.exchangeConnected ? "done" : "todo",
      title: "Market data connected",
      detail: status?.exchangeConnected
        ? "Public Bybit data is flowing. No credentials needed for this."
        : "The server cannot reach Bybit. Check your network.",
    },
    {
      key: "strategy",
      state: armed ? "done" : "todo",
      title: "A strategy is armed",
      detail: armed
        ? `"${armed.name}" is armed and will trade when the engine starts.`
        : "Arming is deliberately explicit — nothing trades until you enable one.",
      action: armed ? undefined : { label: "Configure", to: "/strategy" },
    },
    {
      key: "engine",
      state: status?.state === "RUNNING" ? "done" : "todo",
      title: "Engine running",
      detail:
        status?.state === "RUNNING"
          ? "The engine is evaluating your strategy on every tick."
          : "Start the bot to begin evaluating signals.",
    },
    {
      key: "keys",
      state: settings.exchange.hasSecret ? "done" : "optional",
      title: "Bybit API keys",
      detail: settings.exchange.hasSecret
        ? `Configured and ${settings.exchange.credentialsValid ? "verified" : "not yet verified"}.`
        : "Optional. Without keys the engine runs on public data and simulates fills.",
      action: settings.exchange.hasSecret ? undefined : { label: "Settings", to: "/settings" },
    },
    {
      key: "breaker",
      state: settings.circuitBreaker.enabled ? "done" : "todo",
      title: "Circuit breaker armed",
      detail: settings.circuitBreaker.enabled
        ? `Halts at ${settings.circuitBreaker.maxDailyLossPct}% daily loss or ${settings.circuitBreaker.maxConsecutiveLosses} consecutive losses.`
        : "Strongly recommended. Per-trade limits cap one bad trade; this caps a bad day.",
      action: settings.circuitBreaker.enabled ? undefined : { label: "Enable", to: "/settings" },
    },
  ];

  const required = steps.filter((s) => s.state !== "optional");
  const outstanding = required.filter((s) => s.state === "todo").length;

  // Nothing left to do — get out of the way permanently.
  if (outstanding === 0) return null;

  const done = required.length - outstanding;

  return (
    <Panel
      title="Setup"
      actions={
        <div className="flex items-center gap-3">
          <span className="font-mono text-[10px] uppercase tracking-wider text-on-surface-variant">
            {done}/{required.length} complete
          </span>
          <button
            className="btn-outline"
            onClick={() => {
              window.localStorage.setItem("ztrade.setupDismissed", "1");
              setDismissed(true);
            }}
          >
            Dismiss
          </button>
        </div>
      }
    >
      <div
        className="mb-4 h-1 w-full bg-surface-container"
        role="progressbar"
        aria-valuenow={done}
        aria-valuemin={0}
        aria-valuemax={required.length}
        aria-label="Setup progress"
      >
        <div
          className="h-full bg-primary transition-all"
          style={{ width: `${(done / required.length) * 100}%` }}
        />
      </div>

      <ul className="divide-y divide-outline-variant">
        {steps.map((step) => (
          <li key={step.key} className="flex items-start gap-3 py-2.5">
            <Icon
              name={
                step.state === "done"
                  ? "check_circle"
                  : step.state === "optional"
                    ? "radio_button_unchecked"
                    : "pending"
              }
              className={`mt-0.5 text-[16px] ${
                step.state === "done"
                  ? "text-primary"
                  : step.state === "optional"
                    ? "text-outline"
                    : "text-secondary-container"
              }`}
            />

            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2 font-mono text-xs text-on-surface">
                {step.title}
                {step.state === "optional" && (
                  <span className="text-[10px] uppercase tracking-wider text-outline">
                    optional
                  </span>
                )}
              </div>
              <p className="mt-0.5 text-[11px] text-on-surface-variant">{step.detail}</p>
            </div>

            {step.action && (
              <Link to={step.action.to} className="btn-outline shrink-0 px-2.5 py-1">
                {step.action.label}
              </Link>
            )}
          </li>
        ))}
      </ul>

      <p className="mt-3 border-t border-outline-variant pt-3 font-mono text-[10px] leading-relaxed text-outline">
        Everything defaults to testnet and paper mode. Nothing reaches a real exchange
        until you change two separate switches in <code>.env</code>.
      </p>
    </Panel>
  );
}
