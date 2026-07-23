/**
 * Time abstraction.
 *
 * The single most important boundary in the system. A strategy that calls
 * Date.now() cannot be replayed: the same input tape produces different
 * decisions on every run, which silently destroys backtest/live parity and
 * makes every backtest result a fiction.
 *
 * Strategies never construct a clock. They receive time on the event, and any
 * scheduling they need is expressed as an intent for the engine to act on.
 */
export interface Clock {
  /** Epoch millis. In replay this is the timestamp of the event being processed. */
  now(): number;
}

/** Wall-clock. Live ingestion and the execution engine only. */
export class SystemClock implements Clock {
  now(): number {
    return Date.now();
  }
}

/**
 * Deterministic clock driven by the event tape.
 *
 * Time only advances when the engine feeds it an event timestamp, so replaying
 * the same tape twice produces byte-identical decisions.
 */
export class ReplayClock implements Clock {
  private current: number;

  constructor(startMs = 0) {
    this.current = startMs;
  }

  now(): number {
    return this.current;
  }

  /**
   * Advances to an event's timestamp.
   *
   * Refuses to go backwards. Out-of-order events are a real condition on a
   * multi-stream tape, but letting time run backwards would make windowed
   * features non-deterministic depending on arrival order.
   */
  advanceTo(ms: number): void {
    if (ms > this.current) this.current = ms;
  }
}

/** Manual clock for tests that need to step time explicitly. */
export class ManualClock implements Clock {
  constructor(private current = 0) {}

  now(): number {
    return this.current;
  }

  set(ms: number): void {
    this.current = ms;
  }

  advance(deltaMs: number): void {
    this.current += deltaMs;
  }
}
