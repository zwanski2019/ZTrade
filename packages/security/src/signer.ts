import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Bybit v5 request signing (§8).
 *
 * The signature payload is an exact concatenation:
 *
 *     timestamp + apiKey + recvWindow + queryStringOrBody
 *
 * signed with HMAC-SHA256 over the API secret, hex-encoded. Getting the
 * concatenation order or the body serialisation wrong produces a 10004 that is
 * indistinguishable from a wrong key, which is why this is unit-tested against
 * fixed vectors rather than "it worked when I tried it".
 *
 * GET  → payload is the raw query string, WITHOUT the leading "?"
 * POST → payload is the exact JSON body byte-for-byte as sent. Re-serialising
 *        it after signing will break the signature.
 */
export interface SignInput {
  apiKey: string;
  apiSecret: string;
  /** Epoch millis as a string. */
  timestamp: string;
  /** Milliseconds of tolerance. Keep tight to bound replay (§8). */
  recvWindow: string;
  /** Query string for GET, serialised JSON body for POST. Empty string if none. */
  payload: string;
}

export const DEFAULT_RECV_WINDOW = "5000";

export function signaturePayload(input: SignInput): string {
  return `${input.timestamp}${input.apiKey}${input.recvWindow}${input.payload}`;
}

export function sign(input: SignInput): string {
  return createHmac("sha256", input.apiSecret)
    .update(signaturePayload(input))
    .digest("hex");
}

/** Headers Bybit v5 expects on an authenticated request. */
export function authHeaders(input: SignInput): Record<string, string> {
  return {
    "X-BAPI-API-KEY": input.apiKey,
    "X-BAPI-TIMESTAMP": input.timestamp,
    "X-BAPI-RECV-WINDOW": input.recvWindow,
    "X-BAPI-SIGN": sign(input),
    "X-BAPI-SIGN-TYPE": "2",
  };
}

/**
 * Deterministic query-string builder.
 *
 * Bybit signs the literal string we send, so the order must be stable and the
 * same builder must produce both the signed payload and the URL. Sorting keys
 * removes any dependence on object construction order.
 */
export function buildQuery(params: Record<string, string | number | boolean | undefined>): string {
  return Object.entries(params)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${String(v)}`)
    .join("&");
}

/** Constant-time signature comparison, for verifying inbound webhooks. */
export function verifySignature(expected: string, presented: string): boolean {
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(presented, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * WebSocket private-stream auth.
 *
 * Different scheme from REST: the signed string is literally "GET/realtime"
 * plus the expiry, and getting this wrong is a common source of silent
 * private-stream failures — the socket connects, then simply never delivers
 * order events.
 */
export function wsAuthSignature(apiSecret: string, expiresMs: number): string {
  return createHmac("sha256", apiSecret).update(`GET/realtime${expiresMs}`).digest("hex");
}

export function wsAuthPayload(
  apiKey: string,
  apiSecret: string,
  expiresMs: number,
): { op: "auth"; args: [string, number, string] } {
  return { op: "auth", args: [apiKey, expiresMs, wsAuthSignature(apiSecret, expiresMs)] };
}

/**
 * Dead-man's switch — ship gate #2.
 *
 * `set-dcp` tells Bybit: if this private WS connection drops and does not come
 * back within `timeWindowSeconds`, cancel all my orders automatically. It must
 * be sent AFTER auth and BEFORE any position is opened.
 *
 * This is the control that survives the failure mode nothing else covers: the
 * process crashing, hanging, or being network-partitioned while holding
 * exposure. A kill switch you have to invoke is useless if the thing that
 * would invoke it is the thing that died.
 *
 * Note it cancels resting ORDERS; it does not flatten an existing position.
 * That limit is the exchange's, not ours, and it is why §1 also requires a
 * reachable out-of-band kill switch.
 */
export function deadMansSwitchPayload(timeWindowSeconds: number): {
  op: "set_dcp";
  args: [{ timeWindow: number }];
} {
  // Bybit accepts 10..300 seconds. Clamp rather than let the exchange reject
  // it — a silently-unarmed dead-man switch is worse than a shorter window.
  const clamped = Math.max(10, Math.min(300, Math.round(timeWindowSeconds)));
  return { op: "set_dcp", args: [{ timeWindow: clamped }] };
}
