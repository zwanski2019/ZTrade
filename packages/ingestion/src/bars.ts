import type { MarketEvent } from "@ztrade/core";

/**
 * Tick-to-bar aggregation (§4.1).
 *
 * Bars are BUILT from the trade stream, never fetched from the venue's kline
 * endpoint. That is not a performance choice, it is a correctness one: a
 * fetched bar and a locally-aggregated bar disagree at the edges (which trade
 * belongs to which bucket, how an empty interval is represented), and any such
 * disagreement is a backtest/live divergence waiting to happen.
 *
 * Building them the same way in both modes means bars are identical by
 * construction rather than by luck.
 */
export interface Bar {
  symbol: string;
  interval: string;
  /** Bucket start, epoch millis. */
  openTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  /** Number of trades in the bucket — useful as a liquidity feature. */
  trades: number;
  /** Taker buy volume, for order-flow imbalance. */
  buyVolume: number;
  closed: boolean;
}

export type BarListener = (bar: Bar) => void;

/**
 * Aggregates trades into fixed-width time buckets.
 *
 * A bar is emitted as CLOSED only when a trade arrives in a later bucket, or
 * when the caller explicitly closes it on a timer. Emitting on the last trade
 * of a bucket would be lookahead — you cannot know it was the last one until
 * the next bucket starts.
 */
export class BarAggregator {
  private current = new Map<string, Bar>();

  constructor(
    private readonly intervalMs: number,
    private readonly intervalLabel: string,
    private readonly onBar: BarListener,
  ) {}

  /** Bucket start for a timestamp. */
  bucketOf(ts: number): number {
    return Math.floor(ts / this.intervalMs) * this.intervalMs;
  }

  onTrade(symbol: string, price: number, size: number, side: "buy" | "sell", ts: number): void {
    const bucket = this.bucketOf(ts);
    const existing = this.current.get(symbol);

    if (existing && existing.openTime !== bucket) {
      // A trade in a later bucket is the proof that the previous one is done.
      if (bucket > existing.openTime) {
        this.emitClosed(existing);
        this.current.set(symbol, this.startBar(symbol, bucket, price, size, side));
      }
      // A trade for an OLDER bucket is late data. Dropping it is deliberate:
      // reopening a closed bar would mutate history a strategy already acted on.
      return;
    }

    if (!existing) {
      this.current.set(symbol, this.startBar(symbol, bucket, price, size, side));
      return;
    }

    existing.high = Math.max(existing.high, price);
    existing.low = Math.min(existing.low, price);
    existing.close = price;
    existing.volume += size;
    existing.trades += 1;
    if (side === "buy") existing.buyVolume += size;
  }

  /** Feeds a normalised event; ignores anything that is not a trade. */
  onEvent(event: MarketEvent): void {
    if (event.type !== "trade") return;
    this.onTrade(event.symbol, event.price, event.size, event.side, event.exchangeTs);
  }

  /**
   * Closes any bucket that ended before `now`.
   *
   * Needed because an illiquid symbol may produce no trade for several
   * intervals, and those empty buckets would otherwise keep the last bar open
   * indefinitely.
   */
  closeExpired(now: number): void {
    const currentBucket = this.bucketOf(now);
    for (const [symbol, bar] of [...this.current]) {
      if (bar.openTime < currentBucket) {
        this.emitClosed(bar);
        this.current.delete(symbol);
      }
    }
  }

  /** The still-forming bar. Never treat this as closed. */
  pending(symbol: string): Bar | null {
    return this.current.get(symbol) ?? null;
  }

  private startBar(
    symbol: string,
    openTime: number,
    price: number,
    size: number,
    side: "buy" | "sell",
  ): Bar {
    return {
      symbol,
      interval: this.intervalLabel,
      openTime,
      open: price,
      high: price,
      low: price,
      close: price,
      volume: size,
      trades: 1,
      buyVolume: side === "buy" ? size : 0,
      closed: false,
    };
  }

  private emitClosed(bar: Bar): void {
    this.onBar({ ...bar, closed: true });
  }
}

/** Bar → normalised kline event, so downstream sees one event type. */
export function barToEvent(bar: Bar, localRecvTs: number, seq: number): MarketEvent {
  return {
    type: "kline",
    symbol: bar.symbol,
    interval: bar.interval,
    open: bar.open,
    high: bar.high,
    low: bar.low,
    close: bar.close,
    volume: bar.volume,
    closed: bar.closed,
    exchangeTs: bar.openTime,
    localRecvTs,
    seq,
  };
}
