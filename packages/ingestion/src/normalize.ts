import type { AccountEvent, MarketEvent, OrderBookSnapshot } from "@ztrade/core";
import type { KlineMessage, PublicTradeMessage, TickerMessage } from "./schemas.ts";

/**
 * Bybit → internal event normalisation (§4.1).
 *
 * This is the boundary. Past this function no exchange field name — `S`, `v`,
 * `cumExecQty`, `confirm` — exists anywhere in the system. That is what makes
 * a second venue a new normaliser rather than a rewrite of every strategy and
 * every feature.
 *
 * Every event carries both timestamps so latency is measurable and so a
 * simulator can model fill delay from real numbers rather than a guess.
 */

export interface NormaliseContext {
  /** Local receive time. On a replayed tape this equals the exchange time. */
  localRecvTs: number;
  /** Per-stream monotonic counter, assigned by the ingestion layer. */
  seq: number;
}

export function normaliseBook(
  symbol: string,
  book: OrderBookSnapshot,
  exchangeTs: number,
  ctx: NormaliseContext,
): MarketEvent {
  return {
    type: "book",
    symbol,
    book,
    exchangeTs,
    localRecvTs: ctx.localRecvTs,
    seq: ctx.seq,
  };
}

export function normaliseTrades(
  message: PublicTradeMessage,
  ctx: NormaliseContext,
): MarketEvent[] {
  return message.data.map((trade, i) => ({
    type: "trade" as const,
    symbol: trade.s,
    price: trade.p,
    size: trade.v,
    // Bybit's `S` is the TAKER side. Preserving that meaning matters: it is
    // what makes buy/sell volume imbalance a real signal rather than noise.
    side: trade.S === "Buy" ? ("buy" as const) : ("sell" as const),
    exchangeTs: trade.T,
    localRecvTs: ctx.localRecvTs,
    seq: ctx.seq + i,
  }));
}

/**
 * Tickers arrive as deltas with unchanged fields omitted, so a normalised
 * ticker event needs the last known values merged in. Returns null when we
 * still have no price at all — emitting zeros would be worse than emitting
 * nothing.
 */
export function normaliseTicker(
  message: TickerMessage,
  previous: { lastPrice: number; markPrice: number; indexPrice: number } | null,
  ctx: NormaliseContext,
): MarketEvent | null {
  const d = message.data;
  const lastPrice = d.lastPrice ?? previous?.lastPrice;
  const markPrice = d.markPrice ?? previous?.markPrice ?? lastPrice;
  const indexPrice = d.indexPrice ?? previous?.indexPrice ?? lastPrice;

  if (lastPrice === undefined || markPrice === undefined || indexPrice === undefined) {
    return null;
  }

  return {
    type: "ticker",
    symbol: d.symbol,
    lastPrice,
    markPrice,
    indexPrice,
    exchangeTs: message.ts,
    localRecvTs: ctx.localRecvTs,
    seq: ctx.seq,
  };
}

export function normaliseFunding(
  message: TickerMessage,
  ctx: NormaliseContext,
): MarketEvent | null {
  const d = message.data;
  if (d.fundingRate === undefined) return null;

  return {
    type: "funding",
    symbol: d.symbol,
    rate: d.fundingRate,
    nextFundingTs: Number(d.nextFundingTime ?? 0),
    exchangeTs: message.ts,
    localRecvTs: ctx.localRecvTs,
    seq: ctx.seq,
  };
}

export function normaliseKlines(
  message: KlineMessage,
  symbol: string,
  ctx: NormaliseContext,
): MarketEvent[] {
  return message.data.map((k, i) => ({
    type: "kline" as const,
    symbol,
    interval: k.interval,
    open: k.open,
    high: k.high,
    low: k.low,
    close: k.close,
    volume: k.volume,
    // `confirm` is the exchange telling us the bar is closed. Acting on an
    // unconfirmed bar is a lookahead bug: the close can still move.
    closed: k.confirm,
    exchangeTs: k.end,
    localRecvTs: ctx.localRecvTs,
    seq: ctx.seq + i,
  }));
}

/** Extracts the symbol from a topic like "orderbook.50.BTCUSDT". */
export function symbolFromTopic(topic: string): string | null {
  const parts = topic.split(".");
  return parts.length >= 2 ? (parts.at(-1) ?? null) : null;
}

/** Extracts the interval from "kline.5.BTCUSDT". */
export function intervalFromTopic(topic: string): string | null {
  const parts = topic.split(".");
  return parts.length >= 3 ? (parts[1] ?? null) : null;
}

// ---------------------------------------------------------------------------
// Private streams
// ---------------------------------------------------------------------------

export function normaliseExecution(
  exec: {
    symbol: string;
    orderLinkId: string;
    execQty: number;
    execPrice: number;
    execFee: number;
    isMaker: boolean;
    execTime: string | number;
  },
  ctx: NormaliseContext,
): AccountEvent {
  return {
    type: "execution",
    symbol: exec.symbol,
    orderLinkId: exec.orderLinkId,
    execQty: exec.execQty,
    execPrice: exec.execPrice,
    fee: exec.execFee,
    isMaker: exec.isMaker,
    exchangeTs: Number(exec.execTime),
    localRecvTs: ctx.localRecvTs,
    seq: ctx.seq,
  };
}

export function normalisePosition(
  position: { symbol: string; side: string; size: number; entryPrice: number },
  exchangeTs: number,
  ctx: NormaliseContext,
): AccountEvent {
  // Bybit reports side as "Buy"/"Sell"/"" — an empty side with zero size is a
  // flat position, not a malformed message.
  const side =
    position.size === 0 ? "flat" : position.side === "Buy" ? "long" : "short";

  return {
    type: "position",
    symbol: position.symbol,
    size: position.size,
    side,
    entryPrice: position.entryPrice,
    exchangeTs,
    localRecvTs: ctx.localRecvTs,
    seq: ctx.seq,
  };
}
