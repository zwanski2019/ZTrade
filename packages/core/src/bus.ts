/**
 * Message bus abstraction.
 *
 * Deliberately shaped like NATS (subject strings, async publish, unsubscribe
 * handle) so JetStream drops in behind it without touching a single
 * subscriber. v1 runs in-process on a single node; the interface is the whole
 * point of writing it now rather than later.
 */
export type Subject = string;

export type Handler<T> = (message: T, subject: Subject) => void | Promise<void>;

export interface Subscription {
  unsubscribe(): void;
}

export interface Bus {
  publish<T>(subject: Subject, message: T): Promise<void>;
  subscribe<T>(pattern: Subject, handler: Handler<T>): Subscription;
  /** Flush and release resources. */
  close(): Promise<void>;
}

/**
 * NATS-style subject matching: `*` matches one token, `>` matches the rest.
 * e.g. "md.*.book" matches "md.BTCUSDT.book"; "md.>" matches all of it.
 */
export function subjectMatches(pattern: Subject, subject: Subject): boolean {
  const p = pattern.split(".");
  const s = subject.split(".");

  for (let i = 0; i < p.length; i++) {
    const token = p[i]!;
    if (token === ">") return true; // Tail wildcard consumes everything left.
    if (i >= s.length) return false;
    if (token === "*") continue;
    if (token !== s[i]) return false;
  }

  return p.length === s.length;
}

/**
 * Single-node in-process bus.
 *
 * Handlers are invoked sequentially in subscription order and awaited, which
 * preserves the single-writer guarantee: no two handlers mutate state for the
 * same symbol concurrently. Throwing in a handler must not stop delivery to
 * the others, so errors are captured and reported rather than propagated.
 */
export class InProcessBus implements Bus {
  private subscriptions: Array<{ pattern: Subject; handler: Handler<unknown> }> = [];
  private closed = false;

  constructor(private readonly onHandlerError?: (err: Error, subject: Subject) => void) {}

  async publish<T>(subject: Subject, message: T): Promise<void> {
    if (this.closed) return;

    // Snapshot first: a handler may subscribe or unsubscribe while we iterate.
    const targets = this.subscriptions.filter((s) => subjectMatches(s.pattern, subject));

    for (const target of targets) {
      try {
        await target.handler(message, subject);
      } catch (err) {
        this.onHandlerError?.(err as Error, subject);
      }
    }
  }

  subscribe<T>(pattern: Subject, handler: Handler<T>): Subscription {
    const entry = { pattern, handler: handler as Handler<unknown> };
    this.subscriptions.push(entry);

    return {
      unsubscribe: () => {
        const index = this.subscriptions.indexOf(entry);
        if (index >= 0) this.subscriptions.splice(index, 1);
      },
    };
  }

  async close(): Promise<void> {
    this.closed = true;
    this.subscriptions = [];
  }
}

/** Canonical subject names. Keeping them in one place stops typo-driven silence. */
export const Subjects = {
  marketData: (symbol: string, kind: string): Subject => `md.${symbol}.${kind}`,
  account: (kind: string): Subject => `acct.${kind}`,
  intent: (strategyId: string): Subject => `intent.${strategyId}`,
  riskDecision: (): Subject => "risk.decision",
  orderTransition: (): Subject => "order.transition",
  audit: (): Subject => "audit.append",
} as const;
