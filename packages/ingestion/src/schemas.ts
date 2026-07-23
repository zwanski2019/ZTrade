import { z } from "zod";

/**
 * Wire-format validation for every inbound Bybit payload (§3, fail-closed).
 *
 * The venue is untrusted input. A malformed or unexpected message must be
 * dropped with a counter incremented, never coerced into a number that ends up
 * sizing an order. `Number(undefined)` is NaN, and NaN propagates silently
 * through arithmetic until it becomes a rejected order or a wrong position.
 *
 * Bybit encodes all numerics as strings. `numeric` parses and rejects
 * non-finite results in one step, so nothing downstream needs to re-check.
 */
export const numeric = z
  .union([z.string(), z.number()])
  .transform((v, ctx) => {
    const n = Number(v);
    if (!Number.isFinite(n)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `Not a finite number: ${String(v)}` });
      return z.NEVER;
    }
    return n;
  });

/** [price, size] pair as sent on the orderbook topic. */
export const levelSchema = z.tuple([z.string(), z.string()]);

export const orderbookMessageSchema = z.object({
  topic: z.string(),
  type: z.enum(["snapshot", "delta"]),
  ts: z.number(),
  data: z.object({
    s: z.string(),
    b: z.array(levelSchema),
    a: z.array(levelSchema),
    u: z.number(),
    seq: z.number().optional(),
  }),
  cts: z.number().optional(),
});

export const publicTradeMessageSchema = z.object({
  topic: z.string(),
  type: z.string().optional(),
  ts: z.number(),
  data: z.array(
    z.object({
      T: z.number(), // trade time
      s: z.string(), // symbol
      S: z.enum(["Buy", "Sell"]), // taker side
      v: numeric, // size
      p: numeric, // price
      i: z.string().optional(), // trade id
      BT: z.boolean().optional(), // block trade
    }),
  ),
});

export const tickerMessageSchema = z.object({
  topic: z.string(),
  type: z.enum(["snapshot", "delta"]).optional(),
  ts: z.number(),
  data: z.object({
    symbol: z.string(),
    // Ticker deltas omit unchanged fields, so everything is optional.
    lastPrice: numeric.optional(),
    markPrice: numeric.optional(),
    indexPrice: numeric.optional(),
    fundingRate: numeric.optional(),
    nextFundingTime: z.union([z.string(), z.number()]).optional(),
    openInterest: numeric.optional(),
  }),
});

export const klineMessageSchema = z.object({
  topic: z.string(),
  ts: z.number(),
  data: z.array(
    z.object({
      start: z.number(),
      end: z.number(),
      interval: z.string(),
      open: numeric,
      high: numeric,
      low: numeric,
      close: numeric,
      volume: numeric,
      confirm: z.boolean(),
    }),
  ),
});

// --- Private streams --------------------------------------------------------

export const orderMessageSchema = z.object({
  topic: z.literal("order"),
  creationTime: z.number().optional(),
  data: z.array(
    z.object({
      symbol: z.string(),
      orderId: z.string(),
      orderLinkId: z.string(),
      orderStatus: z.string(),
      side: z.enum(["Buy", "Sell"]),
      qty: numeric,
      cumExecQty: numeric,
      avgPrice: z.union([numeric, z.literal("")]).optional(),
      updatedTime: z.union([z.string(), z.number()]).optional(),
    }),
  ),
});

export const executionMessageSchema = z.object({
  topic: z.literal("execution"),
  creationTime: z.number().optional(),
  data: z.array(
    z.object({
      symbol: z.string(),
      orderLinkId: z.string(),
      execId: z.string(),
      execQty: numeric,
      execPrice: numeric,
      execFee: numeric,
      isMaker: z.boolean(),
      execTime: z.union([z.string(), z.number()]),
    }),
  ),
});

export const positionMessageSchema = z.object({
  topic: z.literal("position"),
  creationTime: z.number().optional(),
  data: z.array(
    z.object({
      symbol: z.string(),
      side: z.string(),
      size: numeric,
      entryPrice: numeric,
      unrealisedPnl: numeric.optional(),
    }),
  ),
});

export const walletMessageSchema = z.object({
  topic: z.literal("wallet"),
  creationTime: z.number().optional(),
  data: z.array(
    z.object({
      totalEquity: numeric.optional(),
      totalAvailableBalance: numeric.optional(),
    }),
  ),
});

/** Control frames: subscribe acks, auth results, pongs. */
export const controlMessageSchema = z.object({
  op: z.string().optional(),
  success: z.boolean().optional(),
  ret_msg: z.string().optional(),
  conn_id: z.string().optional(),
});

export type OrderbookMessage = z.infer<typeof orderbookMessageSchema>;
export type PublicTradeMessage = z.infer<typeof publicTradeMessageSchema>;
export type TickerMessage = z.infer<typeof tickerMessageSchema>;
export type KlineMessage = z.infer<typeof klineMessageSchema>;

export type ParseOutcome<T> =
  | { ok: true; value: T }
  | { ok: false; error: string };

/**
 * Parses fail-closed: an invalid payload is dropped, never coerced.
 *
 * Generic over the schema rather than over a bare `T` so the OUTPUT type of a
 * transforming schema is preserved — otherwise `numeric`'s string→number
 * transform is lost and callers receive `string | number`.
 */
export function parseWith<S extends z.ZodTypeAny>(
  schema: S,
  raw: unknown,
): ParseOutcome<z.infer<S>> {
  const result = schema.safeParse(raw);
  if (result.success) return { ok: true, value: result.data };

  const first = result.error.issues[0];
  return {
    ok: false,
    error: first ? `${first.path.join(".")}: ${first.message}` : "invalid payload",
  };
}
