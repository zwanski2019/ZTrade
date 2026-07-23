import { authHeaders, buildQuery, DEFAULT_RECV_WINDOW } from "@ztrade/security";

/**
 * Bybit v5 REST client — the authenticated side of the live adapter.
 *
 * Deliberately small: it signs, sends, parses `retCode`, and returns typed
 * results. Everything clever (idempotency, order-state tracking, reconciliation)
 * lives above it, so this layer can be reasoned about as "did the HTTP call
 * succeed and what did the venue say".
 *
 * The signing is the part that bites: a wrong concatenation order produces a
 * 10004 indistinguishable from a bad key, which is why the signer is
 * fixed-vector tested in @ztrade/security rather than trusted here.
 */
export interface RestConfig {
  baseUrl: string;
  apiKey: string;
  apiSecret: string;
  recvWindow?: string;
  /** Injected so tests can stub the network without a real venue. */
  fetchImpl?: typeof fetch;
  /** Injected so signing timestamps are reproducible in tests. */
  now?: () => number;
  timeoutMs?: number;
}

export const BYBIT_REST = {
  MAINNET: "https://api.bybit.com",
  TESTNET: "https://api-testnet.bybit.com",
} as const;

export interface BybitResponse<T> {
  retCode: number;
  retMsg: string;
  result: T;
  time?: number;
}

export class BybitRestError extends Error {
  constructor(
    readonly retCode: number,
    readonly retMsg: string,
    readonly endpoint: string,
  ) {
    super(`Bybit ${endpoint} failed: ${retCode} ${retMsg}`);
    this.name = "BybitRestError";
  }
}

/** Retryable venue conditions: rate limits and transient server errors. */
export function isRetryable(retCode: number): boolean {
  return retCode === 10006 || retCode === 10018 || retCode === 10016;
}

export class BybitRest {
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly recvWindow: string;
  private readonly timeoutMs: number;

  constructor(private readonly config: RestConfig) {
    this.fetchImpl = config.fetchImpl ?? fetch;
    this.now = config.now ?? (() => Date.now());
    this.recvWindow = config.recvWindow ?? DEFAULT_RECV_WINDOW;
    this.timeoutMs = config.timeoutMs ?? 10_000;
  }

  /** Signed GET. The query string is what gets signed, so it must be built once. */
  async get<T>(path: string, params: Record<string, string | number | boolean | undefined> = {}): Promise<T> {
    const query = buildQuery(params);
    const timestamp = String(this.now());

    const headers = authHeaders({
      apiKey: this.config.apiKey,
      apiSecret: this.config.apiSecret,
      timestamp,
      recvWindow: this.recvWindow,
      payload: query,
    });

    const url = query ? `${this.config.baseUrl}${path}?${query}` : `${this.config.baseUrl}${path}`;
    return this.send<T>(path, url, { method: "GET", headers });
  }

  /**
   * Signed POST. The signature covers the EXACT JSON body bytes, so the body
   * must be serialised once and both signed and sent — re-serialising after
   * signing silently breaks the signature.
   */
  async post<T>(path: string, body: Record<string, unknown>): Promise<T> {
    const payload = JSON.stringify(body);
    const timestamp = String(this.now());

    const headers = {
      "Content-Type": "application/json",
      ...authHeaders({
        apiKey: this.config.apiKey,
        apiSecret: this.config.apiSecret,
        timestamp,
        recvWindow: this.recvWindow,
        payload,
      }),
    };

    return this.send<T>(path, `${this.config.baseUrl}${path}`, {
      method: "POST",
      headers,
      body: payload,
    });
  }

  private async send<T>(path: string, url: string, init: RequestInit): Promise<T> {
    const controller = AbortSignal.timeout(this.timeoutMs);
    const res = await this.fetchImpl(url, { ...init, signal: controller });

    let parsed: BybitResponse<T>;
    try {
      parsed = (await res.json()) as BybitResponse<T>;
    } catch {
      throw new BybitRestError(-1, `Non-JSON response (HTTP ${res.status})`, path);
    }

    if (parsed.retCode !== 0) {
      throw new BybitRestError(parsed.retCode, parsed.retMsg, path);
    }
    return parsed.result;
  }
}
