import { useEffect, useState } from "react";
import { api } from "../lib/api";
import { Panel } from "./Ui";
import { Icon } from "./Shell";

type Severity = "ok" | "warn" | "fail";
interface Check { name: string; severity: Severity; message: string }

/**
 * `ztrade doctor` surfaced in the UI — a live security self-audit of the running
 * instance. This is the Security Plane made visible: key scope, network
 * exposure, clock skew, plaintext secrets, live-mainnet. No other trading
 * framework runs a security self-audit you can watch.
 */
const ICON: Record<Severity, string> = { ok: "check_circle", warn: "warning", fail: "error" };
const TONE: Record<Severity, string> = {
  ok: "text-primary",
  warn: "text-secondary-container",
  fail: "text-error",
};

export function SecurityDoctor() {
  const [checks, setChecks] = useState<Check[] | null>(null);
  const [overall, setOverall] = useState<Severity>("ok");
  const [loading, setLoading] = useState(false);

  const run = (): void => {
    setLoading(true);
    api
      .doctor()
      .then((r) => {
        setChecks(r.checks);
        setOverall(r.overall);
      })
      .catch(() => setChecks([]))
      .finally(() => setLoading(false));
  };

  useEffect(run, []);

  return (
    <Panel
      title="Security Doctor"
      actions={
        <div className="flex items-center gap-3">
          {checks && (
            <span
              className={`font-mono text-[10px] uppercase tracking-widest ${TONE[overall]}`}
            >
              {overall === "ok" ? "all clear" : overall === "warn" ? "warnings" : "issues found"}
            </span>
          )}
          <button className="btn-outline" disabled={loading} onClick={run}>
            <Icon name="refresh" className="text-[14px]" />
            {loading ? "Scanning…" : "Re-scan"}
          </button>
        </div>
      }
    >
      <p className="mb-3 font-mono text-[11px] leading-relaxed text-on-surface-variant">
        A live self-audit of this running instance — key scope, network exposure, clock
        skew, plaintext secrets. Free security value most trading tools never offer.
      </p>

      {!checks ? (
        <p className="font-mono text-xs text-outline">Scanning…</p>
      ) : (
        <ul className="divide-y divide-outline-variant">
          {checks.map((c, i) => (
            <li key={`${c.name}-${i}`} className="flex items-start gap-3 py-2.5">
              <Icon name={ICON[c.severity]} className={`mt-0.5 text-[16px] ${TONE[c.severity]}`} />
              <div className="min-w-0">
                <div className="font-mono text-xs uppercase tracking-wider text-on-surface">
                  {c.name}
                </div>
                <p className="mt-0.5 text-[11px] text-on-surface-variant">{c.message}</p>
              </div>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}
