import type { Clock } from "./clock.ts";
import type { EngineEvent, Symbol } from "./events.ts";
import type { IntentKey } from "./ids.ts";

/**
 * What a strategy is allowed to ask for.
 *
 * An intent is a REQUEST, not an order. It has no exchange identity, no
 * guarantee of submission, and no side effects. Risk may veto it and execution
 * decides how to work it (post-only, TWAP, slice). This separation is what
 * makes the risk engine independently authoritative — a strategy cannot route
 * around a veto because it has no path to the broker at all.
 */
export type OrderSide = "buy" | "sell";

export type TimeInForce = "GTC" | "IOC" | "FOK" | "PostOnly";

export type ExecutionStyle =
  | { kind: "market" }
  | { kind: "limit"; price: number; timeInForce: TimeInForce }
  /** Work the order passively, re-pegging to stay at the touch. */
  | { kind: "passive"; maxRepegs: number }
  /** Slice evenly across a window, expressed in event-time millis. */
  | { kind: "twap"; windowMs: number; slices: number }
  /** Show only part of the size at a time. */
  | { kind: "iceberg"; displayQty: number };

export interface OrderIntent {
  key: IntentKey;
  symbol: Symbol;
  side: OrderSide;
  /** Base-asset quantity. Execution re-derives exchange-legal size. */
  qty: number;
  style: ExecutionStyle;
  reduceOnly: boolean;
  /** Abort rather than pay more than this in slippage. */
  maxSlippageBps?: number;
  stopLoss?: number;
  takeProfit?: number;
  /** Free-form, for audit and attribution. Never interpreted by the engine. */
  rationale: string;
}

/** Cancel is an intent too, so it flows through the same audit and risk path. */
export interface CancelIntent {
  key: IntentKey;
  symbol: Symbol;
  targetOrderLinkId: string;
  reason: string;
}

export type Intent =
  | { kind: "order"; intent: OrderIntent }
  | { kind: "cancel"; intent: CancelIntent };

/**
 * Read-only context handed to a strategy.
 *
 * Note what is absent: no bus, no broker, no fetch, no Date. A strategy that
 * needs something not on this interface is asking for the wrong thing.
 */
export interface StrategyContext {
  /** Event-time only. See clock.ts for why this matters. */
  readonly clock: Clock;
  readonly strategyId: string;
  /** Next intent sequence number; deterministic across replays. */
  nextIntentSeq(): number;
  /** Current net position in base units; negative is short. */
  positionOf(symbol: Symbol): number;
}

/**
 * A strategy is a pure function of (event, context) → intents.
 *
 * Implementations may hold internal state (rolling features, last signal), but
 * that state must be derived ONLY from events they have been given. Any other
 * input breaks replay determinism and therefore the parity gate.
 */
export interface Strategy {
  readonly id: string;
  readonly symbols: Symbol[];
  onEvent(event: EngineEvent, ctx: StrategyContext): Intent[];
  /** Optional: reset internal state so one instance can be replayed twice. */
  reset?(): void;
}
