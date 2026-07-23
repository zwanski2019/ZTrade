/**
 * Rate-limit-aware scheduler (§4.5).
 *
 * Bybit meters per endpoint category, not globally, so one bucket for the
 * whole client either throttles you far below what the venue allows or lets a
 * burst on one category starve another.
 *
 * The rule is: never blindly fire. Queue and pace. A 403/10006 during a
 * volatile moment is exactly when you most need the order to land, and the
 * back-off it forces is longer than the wait you avoided.
 *
 * Time is injected. A scheduler that reads the wall clock cannot be replayed,
 * and would silently break the parity gate.
 */
export type Category = "order" | "position" | "account" | "market";

export interface BucketConfig {
  /** Sustained rate. */
  refillPerSecond: number;
  /** Burst allowance. */
  capacity: number;
}

/** Conservative defaults; the venue's published limits are higher. */
export const DEFAULT_BUCKETS: Record<Category, BucketConfig> = {
  order: { refillPerSecond: 10, capacity: 20 },
  position: { refillPerSecond: 10, capacity: 20 },
  account: { refillPerSecond: 5, capacity: 10 },
  market: { refillPerSecond: 20, capacity: 40 },
};

/** Bybit rate-limit error codes worth backing off on. */
export const RATE_LIMIT_CODES = new Set([10006, 10018]);

class TokenBucket {
  private tokens: number;
  private lastRefill: number;

  constructor(
    private readonly config: BucketConfig,
    now: number,
  ) {
    this.tokens = config.capacity;
    this.lastRefill = now;
  }

  private refill(now: number): void {
    const elapsed = Math.max(0, now - this.lastRefill);
    this.tokens = Math.min(
      this.config.capacity,
      this.tokens + (elapsed / 1000) * this.config.refillPerSecond,
    );
    this.lastRefill = now;
  }

  tryTake(now: number, count = 1): boolean {
    this.refill(now);
    if (this.tokens < count) return false;
    this.tokens -= count;
    return true;
  }

  /** Millis until `count` tokens are available. Zero when ready now. */
  waitMs(now: number, count = 1): number {
    this.refill(now);
    if (this.tokens >= count) return 0;
    const deficit = count - this.tokens;
    return Math.ceil((deficit / this.config.refillPerSecond) * 1000);
  }

  get available(): number {
    return this.tokens;
  }

  /** Applies a venue-reported remaining count, which is authoritative. */
  syncFromHeader(remaining: number): void {
    // Only ever lower our estimate. The venue counts requests we may not have
    // accounted for — retries inside an SDK, another process on the same key.
    this.tokens = Math.min(this.tokens, Math.max(0, remaining));
  }
}

export class RateScheduler {
  private readonly buckets = new Map<Category, TokenBucket>();
  /** Event time until which a category is in forced back-off. */
  private readonly backoffUntil = new Map<Category, number>();
  private consecutiveLimitHits = 0;

  constructor(
    now: number,
    configs: Record<Category, BucketConfig> = DEFAULT_BUCKETS,
  ) {
    for (const [category, config] of Object.entries(configs)) {
      this.buckets.set(category as Category, new TokenBucket(config, now));
    }
  }

  /** True when a request may be sent right now. */
  canSend(category: Category, now: number): boolean {
    const until = this.backoffUntil.get(category) ?? 0;
    if (now < until) return false;
    return this.bucket(category).waitMs(now) === 0;
  }

  /** Consumes a token. Returns false when the caller must wait. */
  take(category: Category, now: number): boolean {
    const until = this.backoffUntil.get(category) ?? 0;
    if (now < until) return false;
    return this.bucket(category).tryTake(now);
  }

  /** Millis the caller should wait before retrying. */
  waitMs(category: Category, now: number): number {
    const until = this.backoffUntil.get(category) ?? 0;
    const backoff = Math.max(0, until - now);
    return Math.max(backoff, this.bucket(category).waitMs(now));
  }

  /**
   * Applies the venue's own accounting from response headers.
   * `X-Bapi-Limit-Status` is the remaining allowance.
   */
  observeHeaders(category: Category, headers: Record<string, string | undefined>): void {
    const remaining = Number(
      headers["x-bapi-limit-status"] ?? headers["X-Bapi-Limit-Status"],
    );
    if (Number.isFinite(remaining)) this.bucket(category).syncFromHeader(remaining);
  }

  /**
   * Records a rate-limit rejection and backs off exponentially.
   *
   * Exponential specifically because a linear retry into a rate limit is how a
   * client turns a transient throttle into a sustained ban.
   */
  observeRejection(category: Category, code: number, now: number): boolean {
    if (!RATE_LIMIT_CODES.has(code)) return false;

    this.consecutiveLimitHits += 1;
    const delay = Math.min(30_000, 500 * 2 ** (this.consecutiveLimitHits - 1));
    this.backoffUntil.set(category, now + delay);
    return true;
  }

  /** Clears the escalating back-off after a successful request. */
  observeSuccess(): void {
    this.consecutiveLimitHits = 0;
  }

  availableTokens(category: Category): number {
    return this.bucket(category).available;
  }

  get backoffLevel(): number {
    return this.consecutiveLimitHits;
  }

  private bucket(category: Category): TokenBucket {
    const bucket = this.buckets.get(category);
    if (!bucket) throw new Error(`Unknown rate-limit category: ${category}`);
    return bucket;
  }
}
