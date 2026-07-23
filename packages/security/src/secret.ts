/**
 * Secret<T> — structural redaction as a TYPE, not developer discipline (§3.2).
 *
 * The entire OSS trading ecosystem leaks keys the same way: someone logs a
 * config object, an error serialises a request, a crash dump stringifies the
 * client. Redaction-by-convention fails because it relies on every developer
 * remembering, forever, on every path.
 *
 * A Secret<T> makes leaking STRUCTURALLY hard. Every serialisation path a
 * logger or error reporter could reach — toString, toJSON, and Node's
 * util.inspect — returns "[REDACTED]". The real value is only reachable through
 * an explicit `.expose()` call, which greps trivially in review and is the one
 * place a human must consciously handle plaintext.
 *
 * This is the foundation of the Security Plane. Property-tested in
 * secret.test.ts: no fuzzed serialisation of a Secret ever emits its value.
 */

const REDACTED = "[REDACTED]";

/** Node's inspect hook, referenced without importing `util` into the type. */
const INSPECT = Symbol.for("nodejs.util.inspect.custom");

export class Secret<T = string> {
  /**
   * Private, non-enumerable so it never appears in Object.keys, a spread, or a
   * structured-clone. `#value` (a true private field) is invisible to
   * JSON.stringify and to any reflection a logger might attempt.
   */
  readonly #value: T;
  readonly #label: string;

  constructor(value: T, label = "secret") {
    this.#value = value;
    this.#label = label;
  }

  /**
   * The ONLY way to read the plaintext. Named to be conspicuous in review — a
   * grep for `.expose(` enumerates every place plaintext is actually handled.
   */
  expose(): T {
    return this.#value;
  }

  /** True when the wrapped value is present and non-empty. */
  get isPresent(): boolean {
    if (this.#value == null) return false;
    if (typeof this.#value === "string") return this.#value.length > 0;
    return true;
  }

  get label(): string {
    return this.#label;
  }

  // --- every serialisation path returns the redaction ---

  toString(): string {
    return REDACTED;
  }

  toJSON(): string {
    return REDACTED;
  }

  [INSPECT](): string {
    return `Secret<${this.#label}>(${REDACTED})`;
  }

  /**
   * Coercion to a primitive (template strings, `+`, ==) also redacts, so
   * `` `key=${secret}` `` cannot leak. The one hole a naive wrapper leaves.
   */
  [Symbol.toPrimitive](): string {
    return REDACTED;
  }
}

/** Convenience constructor. */
export function secret<T>(value: T, label?: string): Secret<T> {
  return new Secret(value, label);
}

/** Type guard. */
export function isSecret(value: unknown): value is Secret<unknown> {
  return value instanceof Secret;
}

/**
 * Wraps an optional env value, or null when absent/blank. The normal way to
 * lift a credential out of the environment without ever holding it bare.
 */
export function secretFromEnv(name: string, env: NodeJS.ProcessEnv = process.env): Secret<string> | null {
  const raw = env[name];
  if (raw == null || raw.trim() === "") return null;
  return new Secret(raw, name);
}

/**
 * Best-effort zeroing on shutdown (§3.2). JavaScript strings are immutable, so
 * we cannot truly wipe the backing memory — this exists to drop the last
 * reference so the value becomes GC-eligible immediately rather than lingering
 * in a long-lived object. Documented as best-effort, not a guarantee: a
 * language with immutable strings cannot promise memory scrubbing, and claiming
 * otherwise would be the kind of security theatre this project exists to avoid.
 */
export class SecretVault {
  private secrets = new Map<string, Secret<unknown>>();

  set<T>(key: string, value: Secret<T>): void {
    this.secrets.set(key, value);
  }

  get<T>(key: string): Secret<T> | null {
    return (this.secrets.get(key) as Secret<T> | undefined) ?? null;
  }

  has(key: string): boolean {
    return this.secrets.has(key);
  }

  /** Drops all references. Call on graceful shutdown. */
  clear(): void {
    this.secrets.clear();
  }

  get size(): number {
    return this.secrets.size;
  }
}
