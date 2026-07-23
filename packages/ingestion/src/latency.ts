/**
 * Latency tracking (§4.1, §6).
 *
 * Every event carries `exchangeTs` and `localRecvTs`; the delta is the number
 * that matters. It is the honest input to the simulator's fill delay, and it
 * is the first thing to look at when live results diverge from a backtest.
 *
 * Percentiles come from a fixed-size ring, not a growing array: this is on the
 * hot path of every single message, and an unbounded buffer would be a slow
 * memory leak on a process meant to run for weeks.
 */
export class LatencyTracker {
  private readonly samples: Float64Array;
  private index = 0;
  private count = 0;

  /** Scratch buffer reused for percentile sorting, to avoid per-call allocation. */
  private readonly scratch: Float64Array;

  constructor(private readonly capacity = 4096) {
    this.samples = new Float64Array(capacity);
    this.scratch = new Float64Array(capacity);
  }

  record(exchangeTs: number, localRecvTs: number): number {
    const delta = localRecvTs - exchangeTs;

    // Negative latency means clock skew between us and the venue, not a
    // message from the future. Recording it would drag the percentiles down
    // and quietly understate real delay.
    if (!Number.isFinite(delta) || delta < 0) return delta;

    this.samples[this.index] = delta;
    this.index = (this.index + 1) % this.capacity;
    if (this.count < this.capacity) this.count += 1;

    return delta;
  }

  get size(): number {
    return this.count;
  }

  /** Nearest-rank percentile. `p` in 0..1. */
  percentile(p: number): number | null {
    if (this.count === 0) return null;

    const view = this.scratch.subarray(0, this.count);
    view.set(this.samples.subarray(0, this.count));
    view.sort();

    const rank = Math.min(this.count - 1, Math.max(0, Math.ceil(p * this.count) - 1));
    return view[rank] ?? null;
  }

  get p50(): number | null {
    return this.percentile(0.5);
  }

  get p99(): number | null {
    return this.percentile(0.99);
  }

  get max(): number | null {
    if (this.count === 0) return null;
    let best = -Infinity;
    for (let i = 0; i < this.count; i++) best = Math.max(best, this.samples[i]!);
    return best;
  }

  snapshot(): { count: number; p50: number | null; p99: number | null; max: number | null } {
    return { count: this.count, p50: this.p50, p99: this.p99, max: this.max };
  }

  reset(): void {
    this.index = 0;
    this.count = 0;
  }
}
