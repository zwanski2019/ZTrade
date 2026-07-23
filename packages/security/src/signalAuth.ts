import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Signal source authentication (§3.2, §3.3).
 *
 * External signal inputs — TradingView-style webhooks, a REST endpoint, a
 * message queue — are UNTRUSTED INPUT and an order-injection path. In the
 * retail ecosystem a webhook URL is frequently an unauthenticated "place this
 * trade" endpoint; anyone who learns the URL can move the account.
 *
 * Every external signal must be:
 *   1. HMAC-SIGNED with a shared secret — proves it came from the configured
 *      source, not an attacker who guessed the URL.
 *   2. REPLAY-PROTECTED — a nonce that cannot be reused, inside a timestamp
 *      window, so a captured valid signal cannot be resent to re-fire a trade.
 *
 * Unsigned or stale = dropped, logged, alerted. Never acted on.
 */
export interface SignedSignal {
  /** The raw signal payload, exactly as signed. */
  body: string;
  /** Hex HMAC-SHA256 of `${timestamp}.${nonce}.${body}`. */
  signature: string;
  /** Epoch millis the signal was produced. */
  timestamp: number;
  /** Unique per signal; must never repeat within the window. */
  nonce: string;
}

export type SignalVerifyResult =
  | { valid: true }
  | { valid: false; reason: "bad_signature" | "expired" | "future" | "replay" | "malformed" };

/** What gets signed. Fixed order so signer and verifier agree byte-for-byte. */
export function signalSigningPayload(timestamp: number, nonce: string, body: string): string {
  return `${timestamp}.${nonce}.${body}`;
}

export function signSignal(
  secret: string,
  body: string,
  timestamp: number,
  nonce: string,
): string {
  return createHmac("sha256", secret)
    .update(signalSigningPayload(timestamp, nonce, body))
    .digest("hex");
}

/**
 * Verifies an external signal. Fail-closed: any doubt returns invalid.
 *
 * Nonce tracking is delegated to a NonceStore so the caller controls its
 * lifetime and persistence. The window bounds how long a nonce must be
 * remembered, which keeps the store bounded.
 */
export class SignalVerifier {
  constructor(
    private readonly secret: string,
    private readonly nonces: NonceStore,
    /** How far in the past a signal may be, millis. */
    private readonly windowMs = 60_000,
    /** Tolerance for a signal timestamped slightly ahead, millis (clock skew). */
    private readonly futureToleranceMs = 5_000,
    private readonly now: () => number = () => Date.now(),
  ) {}

  verify(signal: SignedSignal): SignalVerifyResult {
    if (
      typeof signal.body !== "string" ||
      typeof signal.signature !== "string" ||
      !Number.isFinite(signal.timestamp) ||
      typeof signal.nonce !== "string" ||
      signal.nonce.length === 0
    ) {
      return { valid: false, reason: "malformed" };
    }

    const now = this.now();

    // A signal from the future beyond skew tolerance is a clock-skew attack or a
    // broken source — reject loudly rather than trust it.
    if (signal.timestamp > now + this.futureToleranceMs) {
      return { valid: false, reason: "future" };
    }
    // Too old: a captured signal being replayed after the window, or a delayed
    // one we can no longer safely accept.
    if (signal.timestamp < now - this.windowMs) {
      return { valid: false, reason: "expired" };
    }

    // Signature check BEFORE nonce burn: never consume a nonce for a forged
    // signal, or an attacker could burn legitimate nonces by guessing.
    const expected = signSignal(this.secret, signal.body, signal.timestamp, signal.nonce);
    if (!safeEqual(expected, signal.signature)) {
      return { valid: false, reason: "bad_signature" };
    }

    // Replay: the nonce has been seen. This is the check that stops a captured,
    // still-in-window, correctly-signed signal from firing a second trade.
    if (this.nonces.seen(signal.nonce)) {
      return { valid: false, reason: "replay" };
    }
    this.nonces.remember(signal.nonce, signal.timestamp + this.windowMs);

    return { valid: true };
  }
}

/** Constant-time hex comparison, length-safe. */
function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/**
 * Remembers nonces until they expire out of the window.
 *
 * Interface so it can be backed by Redis in a multi-instance deployment; the
 * in-memory implementation is correct for a single node and self-pruning.
 */
export interface NonceStore {
  seen(nonce: string): boolean;
  remember(nonce: string, expiresAt: number): void;
}

export class MemoryNonceStore implements NonceStore {
  private readonly nonces = new Map<string, number>();

  constructor(private readonly now: () => number = () => Date.now()) {}

  seen(nonce: string): boolean {
    const expiry = this.nonces.get(nonce);
    if (expiry === undefined) return false;
    if (expiry < this.now()) {
      this.nonces.delete(nonce);
      return false;
    }
    return true;
  }

  remember(nonce: string, expiresAt: number): void {
    this.prune();
    this.nonces.set(nonce, expiresAt);
  }

  /** Drops expired nonces so the store stays bounded by the window, not time. */
  private prune(): void {
    const now = this.now();
    for (const [nonce, expiry] of this.nonces) {
      if (expiry < now) this.nonces.delete(nonce);
    }
  }

  get size(): number {
    return this.nonces.size;
  }
}
