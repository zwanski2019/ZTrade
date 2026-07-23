import type { OrderIntent } from "@ztrade/core";
import type { OrderEvent } from "./orderState.ts";

/**
 * The seam that makes backtest, paper and live the same code path (§0).
 *
 * Everything above this interface — strategy, features, risk, order state
 * machine, reconciliation — is byte-for-byte identical in all three modes.
 * Only the implementation below it changes: sim-fill for backtest/paper,
 * Bybit REST for live.
 *
 * If a behaviour differs between modes and it is not attributable to a
 * deliberate difference in THIS implementation, that is a P0 parity bug.
 */
export interface SubmitRequest {
  orderLinkId: string;
  intent: OrderIntent;
  /** Event-time millis of the decision. Passed in, never read from a clock. */
  at: number;
}

export interface SubmitAck {
  accepted: boolean;
  exchangeOrderId: string | null;
  /** Populated when accepted is false. */
  reason?: string;
  /** True when the venue rejected this as a duplicate clientOrderId. */
  duplicate?: boolean;
}

export interface Broker {
  readonly mode: "sim" | "live";
  submit(request: SubmitRequest): Promise<SubmitAck>;
  cancel(orderLinkId: string, at: number): Promise<{ accepted: boolean; reason?: string }>;
  /** Cancels everything working. Used by the kill switch (ship gate #1). */
  cancelAll(at: number): Promise<{ cancelled: number }>;
  /**
   * Drains order/execution events produced since the last call.
   *
   * Pull rather than push so a replay can advance deterministically: the
   * engine decides when time moves, not a background socket.
   */
  drainEvents(): Array<{ orderLinkId: string; event: OrderEvent; at: number }>;
}
