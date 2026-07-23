/**
 * Circuit breaker state machine (§4.4).
 *
 *     NORMAL → DEGRADED (no new risk) → HALT (flatten + freeze)
 *
 * Three states rather than a boolean, because the middle one is where most
 * real incidents live. "Stop opening new positions but keep managing what we
 * have" is the correct response to a drawdown, a data-quality problem, or a
 * venue acting strangely. A binary on/off forces you to choose between
 * ignoring the problem and liquidating into it.
 *
 * Transitions are explicit and audited — the directive requires that a risk
 * decision is a first-class event, not a silent drop.
 */
export type BreakerState = "NORMAL" | "DEGRADED" | "HALT";

export interface BreakerTransition {
  from: BreakerState;
  to: BreakerState;
  reason: string;
  at: number;
}

/** DEGRADED blocks new exposure; HALT blocks everything and demands a flatten. */
export function blocksNewRisk(state: BreakerState): boolean {
  return state !== "NORMAL";
}

export function requiresFlatten(state: BreakerState): boolean {
  return state === "HALT";
}

/**
 * Severity ordering. Escalation is automatic; de-escalation is not.
 *
 * A breaker that clears itself the moment a metric dips back under its
 * threshold will flap around the boundary, and each flap is a real order. Only
 * an explicit reset returns to NORMAL.
 */
const SEVERITY: Record<BreakerState, number> = { NORMAL: 0, DEGRADED: 1, HALT: 2 };

export class CircuitBreaker {
  private current: BreakerState = "NORMAL";
  private currentReason: string | null = null;
  private readonly history: BreakerTransition[] = [];

  constructor(private readonly onTransition?: (t: BreakerTransition) => void) {}

  get state(): BreakerState {
    return this.current;
  }

  get reason(): string | null {
    return this.currentReason;
  }

  transitions(): readonly BreakerTransition[] {
    return this.history;
  }

  /**
   * Escalates to `to` if it is more severe than the current state.
   * Returns true when a transition actually occurred.
   */
  escalate(to: BreakerState, reason: string, at: number): boolean {
    if (SEVERITY[to] <= SEVERITY[this.current]) return false;
    return this.apply(to, reason, at);
  }

  /** Explicit operator reset. The only path back to NORMAL. */
  reset(reason: string, at: number): boolean {
    if (this.current === "NORMAL") return false;
    return this.apply("NORMAL", reason, at);
  }

  private apply(to: BreakerState, reason: string, at: number): boolean {
    const transition: BreakerTransition = { from: this.current, to, reason, at };
    this.current = to;
    this.currentReason = to === "NORMAL" ? null : reason;
    this.history.push(transition);
    this.onTransition?.(transition);
    return true;
  }
}
