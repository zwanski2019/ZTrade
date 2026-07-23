import { evaluateKeyScope, type KeyPermissions } from "./keyScope.ts";

/**
 * `ztrade doctor` diagnostics (§14).
 *
 * A first-run health check that delivers free SECURITY value: it inspects the
 * exact things that get retail bots compromised — key scope, network exposure,
 * clock skew, secrets in the environment, dependency surface — and reports them
 * plainly. This is the "instant differentiation" the directive describes: no
 * other trading framework runs a security self-audit on first launch.
 *
 * The checks are pure functions of injected inputs so the CLI can gather the
 * facts (query the venue, read config, count deps) and this module renders the
 * verdict, keeping it fully testable.
 */
export type Severity = "ok" | "warn" | "fail";

export interface Check {
  name: string;
  severity: Severity;
  message: string;
}

export interface DoctorInputs {
  /** Key permissions, when credentials are configured. */
  keyPermissions?: KeyPermissions | null;
  /** Host:port the control plane is bound to. */
  bindAddress?: string;
  /** Whether the control-plane API requires auth. */
  authEnabled?: boolean;
  /** Local clock vs a trusted time source, in millis (local - trusted). */
  clockSkewMs?: number | null;
  /** Environment variable names that hold secrets in plaintext. */
  plaintextSecretEnvVars?: string[];
  /** Total production dependency count. */
  dependencyCount?: number | null;
  /** Is the process pointed at mainnet with live trading enabled? */
  liveMainnet?: boolean;
  /** Path the trade database / journal lives on. */
  statePath?: string;
}

/** Dependency count above which we flag supply-chain surface. */
const DEP_BUDGET = 150;
/** Clock skew beyond which signed-request replay windows get risky. */
const CLOCK_SKEW_WARN_MS = 1_000;
const CLOCK_SKEW_FAIL_MS = 5_000;

export function runDoctor(inputs: DoctorInputs): Check[] {
  const checks: Check[] = [];

  // --- Key scope: the most important check ---
  if (inputs.keyPermissions) {
    const verdict = evaluateKeyScope(inputs.keyPermissions);
    if (!verdict.safe) {
      checks.push({ name: "api-key-scope", severity: "fail", message: verdict.reason });
    } else if (verdict.warnings.length > 0) {
      for (const w of verdict.warnings) {
        checks.push({ name: "api-key-scope", severity: "warn", message: w });
      }
    } else {
      checks.push({
        name: "api-key-scope",
        severity: "ok",
        message: "API key is trade+read only, no withdrawal, IP-whitelisted.",
      });
    }
  } else {
    checks.push({
      name: "api-key-scope",
      severity: "ok",
      message: "No exchange credentials configured — running on public data only.",
    });
  }

  // --- Network exposure ---
  if (inputs.bindAddress) {
    const host = inputs.bindAddress.split(":")[0] ?? "";
    const isLoopback = host === "127.0.0.1" || host === "localhost" || host === "::1";
    const isWildcard = host === "0.0.0.0" || host === "::" || host === "";

    if (isWildcard) {
      checks.push({
        name: "network-exposure",
        severity: inputs.authEnabled ? "warn" : "fail",
        message: isWildcard && !inputs.authEnabled
          ? "Control plane is bound to a PUBLIC interface WITHOUT auth. Anyone who can " +
            "reach this port can control your bot. Bind to 127.0.0.1 or enable auth."
          : "Control plane is bound to a public interface. Ensure the firewall and auth " +
            "are both in place; loopback-only is safer.",
      });
    } else if (isLoopback) {
      checks.push({
        name: "network-exposure",
        severity: "ok",
        message: "Control plane is bound to loopback — not reachable off this host.",
      });
    } else {
      checks.push({
        name: "network-exposure",
        severity: inputs.authEnabled ? "warn" : "fail",
        message: `Control plane bound to ${inputs.bindAddress}. ${
          inputs.authEnabled ? "Auth is on, but loopback is safer." : "Auth is OFF — enable it."
        }`,
      });
    }
  }

  // --- Auth ---
  if (inputs.authEnabled === false) {
    checks.push({
      name: "control-plane-auth",
      severity: "fail",
      message: "Control-plane authentication is DISABLED. The API can place orders unauthenticated.",
    });
  }

  // --- Clock skew (breaks signed-request replay windows) ---
  if (inputs.clockSkewMs != null) {
    const abs = Math.abs(inputs.clockSkewMs);
    if (abs >= CLOCK_SKEW_FAIL_MS) {
      checks.push({
        name: "clock-skew",
        severity: "fail",
        message: `Clock is ${inputs.clockSkewMs}ms off the exchange. Signed requests will be ` +
          "rejected and replay windows are unreliable. Sync via NTP.",
      });
    } else if (abs >= CLOCK_SKEW_WARN_MS) {
      checks.push({
        name: "clock-skew",
        severity: "warn",
        message: `Clock is ${inputs.clockSkewMs}ms off the exchange. Consider syncing via NTP.`,
      });
    } else {
      checks.push({ name: "clock-skew", severity: "ok", message: "Clock is in sync." });
    }
  }

  // --- Secrets in plaintext env ---
  if (inputs.plaintextSecretEnvVars && inputs.plaintextSecretEnvVars.length > 0) {
    checks.push({
      name: "plaintext-secrets",
      severity: "warn",
      message: `Secrets are in plaintext environment variables: ${inputs.plaintextSecretEnvVars.join(", ")}. ` +
        "Prefer a vault (age/sops) and hold only a reference in the environment.",
    });
  }

  // --- Dependency surface ---
  if (inputs.dependencyCount != null) {
    checks.push({
      name: "dependency-surface",
      severity: inputs.dependencyCount > DEP_BUDGET ? "warn" : "ok",
      message: inputs.dependencyCount > DEP_BUDGET
        ? `${inputs.dependencyCount} production dependencies — above the ${DEP_BUDGET} budget. ` +
          "Every dep is supply-chain surface in a process holding trading keys."
        : `${inputs.dependencyCount} production dependencies — within budget.`,
    });
  }

  // --- Live mainnet reminder ---
  if (inputs.liveMainnet) {
    checks.push({
      name: "trading-mode",
      severity: "warn",
      message: "LIVE MAINNET trading is enabled. Real funds are at risk.",
    });
  }

  return checks;
}

/** Overall verdict: fail if any check failed, warn if any warned, else ok. */
export function overallSeverity(checks: Check[]): Severity {
  if (checks.some((c) => c.severity === "fail")) return "fail";
  if (checks.some((c) => c.severity === "warn")) return "warn";
  return "ok";
}

/** Renders checks as a terminal report. Pure string → testable, no I/O. */
export function renderDoctorReport(checks: Check[]): string {
  const icon: Record<Severity, string> = { ok: "✓", warn: "!", fail: "✗" };
  const lines = checks.map((c) => `  [${icon[c.severity]}] ${c.name}: ${c.message}`);
  const overall = overallSeverity(checks);
  const header = overall === "fail"
    ? "ZTrade doctor — ISSUES FOUND (fix the ✗ before trading)"
    : overall === "warn"
      ? "ZTrade doctor — warnings"
      : "ZTrade doctor — all clear";
  return [header, "", ...lines].join("\n");
}
