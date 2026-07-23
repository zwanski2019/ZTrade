import type { OrderBookSnapshot, PriceLevel } from "@ztrade/core";

/**
 * L2 orderbook reconstruction (§4.1).
 *
 * Bybit sends one `snapshot` then a stream of `delta` updates carrying an
 * update id `u` that must increment by exactly one. A gap means we missed a
 * message and our book no longer matches the exchange's.
 *
 * The central design rule, and the one the acceptance test exists to prove:
 *
 *     A BOOK THAT MIGHT BE WRONG SERVES NOTHING.
 *
 * `snapshot()` returns null while stale. Every consumer is therefore forced by
 * the type system to handle the degraded case, rather than silently quoting
 * prices from a book that drifted. A bot that trades a stale book is a bot
 * that discovers the divergence via its P&L.
 */

export type BookHealth = "EMPTY" | "HEALTHY" | "STALE";

export interface ApplyResult {
  applied: boolean;
  /** Set when the update was refused; the caller must re-subscribe. */
  gap?: { expected: number; received: number };
  reason?: string;
}

export interface BookUpdate {
  type: "snapshot" | "delta";
  /** Bybit's cross-sequence / update id. */
  u: number;
  /** Bybit's `seq`, monotonic across the stream. */
  seq?: number;
  bids: Array<[price: string | number, size: string | number]>;
  asks: Array<[price: string | number, size: string | number]>;
  exchangeTs: number;
}

export class OrderBook {
  /** price → size. Kept as maps; sorted only on read. */
  private bidLevels = new Map<number, number>();
  private askLevels = new Map<number, number>();

  private lastU = -1;
  /** Bybit's `seq`; retained for diagnostics and cross-stream ordering. */
  private lastSeq = -1;
  private health: BookHealth = "EMPTY";
  private staleReason: string | null = null;
  private lastUpdateTs = 0;

  /** Counters for the metrics surface (§6). */
  readonly stats = { snapshots: 0, deltas: 0, gaps: 0, crossed: 0, rejected: 0 };

  constructor(readonly symbol: string, private readonly depth = 50) {}

  get status(): BookHealth {
    return this.health;
  }

  get isHealthy(): boolean {
    return this.health === "HEALTHY";
  }

  get reason(): string | null {
    return this.staleReason;
  }

  get updateId(): number {
    return this.lastU;
  }

  get sequence(): number {
    return this.lastSeq;
  }

  get lastUpdatedAt(): number {
    return this.lastUpdateTs;
  }

  /**
   * The only accessor for prices. Returns null unless the book is healthy.
   *
   * This is deliberately the sole read path: there is no `bestBid()` that
   * quietly works while stale, because that is exactly the API shape that
   * leaks bad prices into a strategy.
   */
  snapshot(): OrderBookSnapshot | null {
    if (this.health !== "HEALTHY") return null;

    return {
      bids: sortLevels(this.bidLevels, "desc").slice(0, this.depth),
      asks: sortLevels(this.askLevels, "asc").slice(0, this.depth),
    };
  }

  /** Unconditional read, for diagnostics and the dashboard's "stale" display. */
  unsafeSnapshot(): OrderBookSnapshot {
    return {
      bids: sortLevels(this.bidLevels, "desc").slice(0, this.depth),
      asks: sortLevels(this.askLevels, "asc").slice(0, this.depth),
    };
  }

  apply(update: BookUpdate): ApplyResult {
    if (update.type === "snapshot") return this.applySnapshot(update);
    return this.applyDelta(update);
  }

  private applySnapshot(update: BookUpdate): ApplyResult {
    this.bidLevels.clear();
    this.askLevels.clear();

    for (const [price, size] of update.bids) setLevel(this.bidLevels, price, size);
    for (const [price, size] of update.asks) setLevel(this.askLevels, price, size);

    this.lastU = update.u;
    this.lastSeq = update.seq ?? -1;
    this.lastUpdateTs = update.exchangeTs;
    this.stats.snapshots += 1;

    // A snapshot clears staleness — that is the whole recovery mechanism.
    this.health = "HEALTHY";
    this.staleReason = null;

    return this.validate();
  }

  private applyDelta(update: BookUpdate): ApplyResult {
    // A delta before any snapshot is meaningless; we have no base to apply to.
    if (this.health === "EMPTY") {
      this.stats.rejected += 1;
      return { applied: false, reason: "Delta received before snapshot" };
    }

    // Refuse to compound onto a book we already know is wrong. Applying deltas
    // to a stale book would produce a plausible-looking but incorrect result,
    // which is worse than an obviously broken one.
    if (this.health === "STALE") {
      this.stats.rejected += 1;
      return { applied: false, reason: "Book is stale; awaiting fresh snapshot" };
    }

    const expected = this.lastU + 1;
    if (update.u !== expected) {
      // Exchanges do re-deliver; an already-applied update is not a gap.
      if (update.u <= this.lastU) {
        return { applied: false, reason: `Duplicate or out-of-order update ${update.u}` };
      }

      this.stats.gaps += 1;
      this.markStale(`Sequence gap: expected u=${expected}, received u=${update.u}`);
      return {
        applied: false,
        gap: { expected, received: update.u },
        reason: this.staleReason ?? undefined,
      };
    }

    for (const [price, size] of update.bids) setLevel(this.bidLevels, price, size);
    for (const [price, size] of update.asks) setLevel(this.askLevels, price, size);

    this.lastU = update.u;
    if (update.seq !== undefined) this.lastSeq = update.seq;
    this.lastUpdateTs = update.exchangeTs;
    this.stats.deltas += 1;

    return this.validate();
  }

  /**
   * Internal consistency check.
   *
   * Bybit's v5 linear orderbook stream does not publish a per-message checksum
   * the way some venues do, so a crossed book is the strongest integrity
   * signal actually available: if the best bid is at or above the best ask,
   * our reconstruction is provably wrong regardless of what the sequence
   * numbers claim. Sequence continuity proves we missed nothing; this proves
   * we applied what we got correctly.
   */
  private validate(): ApplyResult {
    const bestBid = maxKey(this.bidLevels);
    const bestAsk = minKey(this.askLevels);

    if (bestBid !== null && bestAsk !== null && bestBid >= bestAsk) {
      this.stats.crossed += 1;
      this.markStale(`Crossed book: bid ${bestBid} >= ask ${bestAsk}`);
      return { applied: false, reason: this.staleReason ?? undefined };
    }

    return { applied: true };
  }

  private markStale(reason: string): void {
    this.health = "STALE";
    this.staleReason = reason;
  }

  /** Forces a resubscribe cycle, e.g. after a socket reconnect. */
  invalidate(reason: string): void {
    if (this.health !== "EMPTY") this.markStale(reason);
  }

  /** Drops everything, as if the book had never been seen. */
  reset(): void {
    this.bidLevels.clear();
    this.askLevels.clear();
    this.lastU = -1;
    this.lastSeq = -1;
    this.health = "EMPTY";
    this.staleReason = null;
  }
}

function setLevel(levels: Map<number, number>, rawPrice: string | number, rawSize: string | number): void {
  const price = Number(rawPrice);
  const size = Number(rawSize);
  if (!Number.isFinite(price) || !Number.isFinite(size)) return;

  // Size 0 is a removal, not a zero-size level.
  if (size === 0) levels.delete(price);
  else levels.set(price, size);
}

function sortLevels(levels: Map<number, number>, direction: "asc" | "desc"): PriceLevel[] {
  const out: PriceLevel[] = [];
  for (const [price, size] of levels) out.push({ price, size });
  out.sort((a, b) => (direction === "asc" ? a.price - b.price : b.price - a.price));
  return out;
}

function maxKey(levels: Map<number, number>): number | null {
  let best: number | null = null;
  for (const price of levels.keys()) if (best === null || price > best) best = price;
  return best;
}

function minKey(levels: Map<number, number>): number | null {
  let best: number | null = null;
  for (const price of levels.keys()) if (best === null || price < best) best = price;
  return best;
}
