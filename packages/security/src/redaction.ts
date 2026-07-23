/**
 * Secret redaction (§8, ship gate #5).
 *
 * Two layers, because either alone is insufficient:
 *
 *   1. PATH redaction — structural, for known fields (Pino's `redact` paths).
 *      Cheap and exact, but only catches secrets you remembered to name.
 *   2. VALUE scrubbing — pattern-based, catches a key pasted into a free-text
 *      error message, a URL query string, or a nested payload nobody modelled.
 *
 * The second layer is what actually saves you. Keys leak through the paths you
 * did not anticipate, which is precisely why the CI log-scan test exists.
 */

/** Pino `redact.paths`. Wildcards match one level. */
export const REDACT_PATHS = [
  "apiKey",
  "api_key",
  "apiSecret",
  "api_secret",
  "secret",
  "sign",
  "signature",
  "password",
  "token",
  "botToken",
  "authorization",
  "Authorization",
  "headers.authorization",
  "headers['X-BAPI-SIGN']",
  "headers['X-BAPI-API-KEY']",
  "*.apiKey",
  "*.apiSecret",
  "*.sign",
  "*.token",
  "req.headers.authorization",
] as const;

export const REDACTED = "[REDACTED]";

/**
 * Patterns for secrets that escaped structural redaction.
 *
 * Deliberately conservative on length: over-redacting a log line is a cosmetic
 * problem, leaking a trading key is an account-drain.
 */
const VALUE_PATTERNS: Array<{ name: string; re: RegExp }> = [
  // Bybit v5 keys are ~18+ chars of base62; secrets are longer.
  { name: "bybit-key", re: /\b[A-Za-z0-9]{18,64}\b(?=.{0,40}(secret|apikey|api_key|sign))/gi },
  // Explicit key=value forms in query strings and free text.
  {
    name: "kv-secret",
    re: /\b(api[_-]?key|api[_-]?secret|secret|token|sign|signature|password|passwd|pwd)\b\s*[=:]\s*["']?([A-Za-z0-9._\-+/]{8,})["']?/gi,
  },
  // Bearer tokens.
  { name: "bearer", re: /\bBearer\s+[A-Za-z0-9._\-+/=]{8,}/gi },
  // Telegram bot tokens: <digits>:<35 chars>.
  { name: "telegram", re: /\b\d{6,12}:[A-Za-z0-9_-]{30,}\b/g },
  // Our own encrypted-blob format should never be logged either.
  { name: "ztrade-cipher", re: /\bv1:[A-Za-z0-9_-]{10,}:[A-Za-z0-9_-]+:[A-Za-z0-9_-]+:[A-Za-z0-9_-]+/g },
];

/** Scrubs secret-looking values out of an arbitrary string. */
export function scrubString(input: string): string {
  let out = input;

  for (const { re } of VALUE_PATTERNS) {
    // Reset lastIndex: these are module-level /g regexes reused across calls.
    re.lastIndex = 0;
    out = out.replace(re, (_match, ...groups) => {
      // For key=value forms keep the key name so the log stays useful.
      const label = typeof groups[0] === "string" ? groups[0] : null;
      return label ? `${label}=${REDACTED}` : REDACTED;
    });
  }

  return out;
}

const SENSITIVE_KEY = /(secret|apikey|api_key|api-key|password|passwd|token|sign|signature|authorization|credential)/i;

/**
 * Deep-scrubs an object for logging.
 *
 * Returns a copy; the input is never mutated, because redacting the live
 * config object in place would break the very requests we are trying to log.
 */
export function scrub(value: unknown, seen = new WeakSet<object>()): unknown {
  if (typeof value === "string") return scrubString(value);
  if (value === null || typeof value !== "object") return value;

  // Cycles are common in error/request objects.
  if (seen.has(value)) return "[Circular]";
  seen.add(value);

  if (Array.isArray(value)) return value.map((v) => scrub(v, seen));

  if (value instanceof Error) {
    return { name: value.name, message: scrubString(value.message) };
  }

  const out: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(value)) {
    out[key] = SENSITIVE_KEY.test(key) ? REDACTED : scrub(val, seen);
  }
  return out;
}

/**
 * Ship-gate helper: does this text contain anything that looks like a secret?
 * Used by the CI log-scan test to fail the build on a leak.
 */
export function containsSecret(text: string): { leaked: boolean; pattern?: string } {
  for (const { name, re } of VALUE_PATTERNS) {
    re.lastIndex = 0;
    if (re.test(text)) return { leaked: true, pattern: name };
  }
  return { leaked: false };
}

/**
 * Detects a specific known secret verbatim — the strongest form of the gate,
 * used when the test knows the actual key that must never appear.
 */
export function containsLiteral(text: string, secret: string): boolean {
  if (secret.length < 8) return false; // Too short to assert on meaningfully.
  return text.includes(secret);
}
