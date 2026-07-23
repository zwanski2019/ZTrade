import type { MarketEvent } from "@ztrade/core";
import { OrderBook } from "./orderbook.ts";
import { LatencyTracker } from "./latency.ts";
import {
  klineMessageSchema,
  orderbookMessageSchema,
  parseWith,
  publicTradeMessageSchema,
  tickerMessageSchema,
} from "./schemas.ts";
import {
  intervalFromTopic,
  normaliseBook,
  normaliseFunding,
  normaliseKlines,
  normaliseTicker,
  normaliseTrades,
  symbolFromTopic,
} from "./normalize.ts";

/**
 * Minimal socket contract.
 *
 * The transport is injected so the reconnect, gap-recovery and staleness paths
 * can be driven deterministically in tests. Those are exactly the paths that
 * only ever execute when something is going wrong, which is precisely when you
 * cannot afford them to be untested.
 */
export interface SocketLike {
  send(data: string): void;
  close(): void;
  onOpen(handler: () => void): void;
  onMessage(handler: (data: string) => void): void;
  onClose(handler: () => void): void;
  onError(handler: (err: Error) => void): void;
}

export type SocketFactory = (url: string) => SocketLike;

export interface IngestionOptions {
  url: string;
  symbols: string[];
  /** Kline intervals to subscribe, e.g. ["1", "5"]. */
  intervals?: string[];
  socketFactory: SocketFactory;
  /** Emits normalised events. Never receives data from a stale book. */
  onEvent: (event: MarketEvent) => void;
  onLog?: (level: "info" | "warn" | "error", message: string) => void;
  /** Injected so replays and tests control time. */
  now?: () => number;
  reconnectDelayMs?: number;
}

export interface IngestionStats {
  connected: boolean;
  reconnects: number;
  messages: number;
  invalid: number;
  gaps: number;
  staleBooks: number;
  latency: { count: number; p50: number | null; p99: number | null; max: number | null };
}

/**
 * Bybit v5 public stream ingestion (§4.1).
 *
 * Guarantees it upholds:
 *   - a payload that fails validation is dropped and counted, never coerced
 *   - a book event is emitted ONLY from a healthy book
 *   - a sequence gap triggers resubscribe, which forces a fresh snapshot
 *   - a disconnect invalidates every book before reconnecting
 */
export class BybitIngestion {
  private socket: SocketLike | null = null;
  private readonly books = new Map<string, OrderBook>();
  private readonly latency = new LatencyTracker();
  private readonly tickerState = new Map<
    string,
    { lastPrice: number; markPrice: number; indexPrice: number }
  >();

  private seq = 0;
  private connected = false;
  private stopped = false;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private readonly now: () => number;

  readonly stats = { reconnects: 0, messages: 0, invalid: 0, gaps: 0, staleBooks: 0 };

  constructor(private readonly options: IngestionOptions) {
    this.now = options.now ?? (() => Date.now());
    for (const symbol of options.symbols) {
      this.books.set(symbol, new OrderBook(symbol));
    }
  }

  book(symbol: string): OrderBook | undefined {
    return this.books.get(symbol);
  }

  snapshot(): IngestionStats {
    return {
      connected: this.connected,
      reconnects: this.stats.reconnects,
      messages: this.stats.messages,
      invalid: this.stats.invalid,
      gaps: this.stats.gaps,
      staleBooks: [...this.books.values()].filter((b) => !b.isHealthy).length,
      latency: this.latency.snapshot(),
    };
  }

  start(): void {
    this.stopped = false;
    this.open();
  }

  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.socket?.close();
    this.socket = null;
    this.connected = false;
  }

  private log(level: "info" | "warn" | "error", message: string): void {
    this.options.onLog?.(level, message);
  }

  private open(): void {
    const socket = this.options.socketFactory(this.options.url);
    this.socket = socket;

    socket.onOpen(() => {
      this.connected = true;
      this.log("info", "WS connected; subscribing");
      this.subscribeAll();
    });

    socket.onMessage((data) => this.handleMessage(data));

    socket.onClose(() => {
      this.connected = false;
      // Every book is suspect the moment the stream breaks: updates that
      // occurred while we were away are simply gone. Invalidating here is what
      // guarantees no stale price survives a disconnect.
      this.invalidateAllBooks("socket closed");
      this.log("warn", "WS closed");
      this.scheduleReconnect();
    });

    socket.onError((err) => {
      this.log("error", `WS error: ${err.message}`);
      socket.close();
    });
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return;

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.stats.reconnects += 1;
      this.log("info", `Reconnecting (attempt ${this.stats.reconnects})`);
      this.open();
    }, this.options.reconnectDelayMs ?? 2_000);
    this.reconnectTimer.unref?.();
  }

  private invalidateAllBooks(reason: string): void {
    for (const book of this.books.values()) book.invalidate(reason);
  }

  private topics(): string[] {
    const topics: string[] = [];
    for (const symbol of this.options.symbols) {
      topics.push(`orderbook.50.${symbol}`, `publicTrade.${symbol}`, `tickers.${symbol}`);
      for (const interval of this.options.intervals ?? []) {
        topics.push(`kline.${interval}.${symbol}`);
      }
    }
    return topics;
  }

  private subscribeAll(): void {
    this.send({ op: "subscribe", args: this.topics() });
  }

  /**
   * Forces a fresh snapshot for one symbol after a gap.
   *
   * Unsubscribe then resubscribe is the only reliable way to make the venue
   * re-send a snapshot; there is no "give me the book again" request.
   */
  private resubscribeBook(symbol: string): void {
    const topic = `orderbook.50.${symbol}`;
    this.send({ op: "unsubscribe", args: [topic] });
    this.send({ op: "subscribe", args: [topic] });
    this.log("warn", `Resubscribed ${topic} to rebuild the book`);
  }

  private send(payload: unknown): void {
    if (!this.socket || !this.connected) return;
    this.socket.send(JSON.stringify(payload));
  }

  private handleMessage(raw: string): void {
    this.stats.messages += 1;

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      this.stats.invalid += 1;
      return;
    }

    const topic = (parsed as { topic?: unknown }).topic;
    if (typeof topic !== "string") return; // Control frame: sub ack, pong.

    const localRecvTs = this.now();

    if (topic.startsWith("orderbook.")) return this.handleBook(parsed, localRecvTs);
    if (topic.startsWith("publicTrade.")) return this.handleTrades(parsed, localRecvTs);
    if (topic.startsWith("tickers.")) return this.handleTicker(parsed, localRecvTs);
    if (topic.startsWith("kline.")) return this.handleKline(parsed, topic, localRecvTs);
  }

  private handleBook(raw: unknown, localRecvTs: number): void {
    const parsed = parseWith(orderbookMessageSchema, raw);
    if (!parsed.ok) {
      this.stats.invalid += 1;
      this.log("warn", `Invalid orderbook payload: ${parsed.error}`);
      return;
    }

    const message = parsed.value;
    const symbol = message.data.s;
    const book = this.books.get(symbol);
    if (!book) return;

    this.latency.record(message.ts, localRecvTs);

    const result = book.apply({
      type: message.type,
      u: message.data.u,
      seq: message.data.seq,
      bids: message.data.b,
      asks: message.data.a,
      exchangeTs: message.ts,
    });

    if (result.gap) {
      this.stats.gaps += 1;
      this.log("warn", `${symbol} ${result.reason}; rebuilding`);
      this.resubscribeBook(symbol);
      return;
    }

    if (!result.applied) {
      // Stale, duplicate, or crossed. Emitting nothing is the point.
      if (result.reason) this.log("warn", `${symbol} book update refused: ${result.reason}`);
      return;
    }

    // Only a healthy book yields a snapshot, so this is the single place where
    // "no stale prices escape" is enforced.
    const snapshot = book.snapshot();
    if (!snapshot) return;

    this.options.onEvent(
      normaliseBook(symbol, snapshot, message.ts, { localRecvTs, seq: this.seq++ }),
    );
  }

  private handleTrades(raw: unknown, localRecvTs: number): void {
    const parsed = parseWith(publicTradeMessageSchema, raw);
    if (!parsed.ok) {
      this.stats.invalid += 1;
      return;
    }

    this.latency.record(parsed.value.ts, localRecvTs);
    const events = normaliseTrades(parsed.value, { localRecvTs, seq: this.seq });
    this.seq += events.length;
    for (const event of events) this.options.onEvent(event);
  }

  private handleTicker(raw: unknown, localRecvTs: number): void {
    const parsed = parseWith(tickerMessageSchema, raw);
    if (!parsed.ok) {
      this.stats.invalid += 1;
      return;
    }

    const message = parsed.value;
    this.latency.record(message.ts, localRecvTs);

    const previous = this.tickerState.get(message.data.symbol) ?? null;
    const event = normaliseTicker(message, previous, { localRecvTs, seq: this.seq++ });

    if (event && event.type === "ticker") {
      this.tickerState.set(message.data.symbol, {
        lastPrice: event.lastPrice,
        markPrice: event.markPrice,
        indexPrice: event.indexPrice,
      });
      this.options.onEvent(event);
    }

    const funding = normaliseFunding(message, { localRecvTs, seq: this.seq++ });
    if (funding) this.options.onEvent(funding);
  }

  private handleKline(raw: unknown, topic: string, localRecvTs: number): void {
    const parsed = parseWith(klineMessageSchema, raw);
    if (!parsed.ok) {
      this.stats.invalid += 1;
      return;
    }

    const symbol = symbolFromTopic(topic);
    if (!symbol) return;

    this.latency.record(parsed.value.ts, localRecvTs);
    const events = normaliseKlines(parsed.value, symbol, { localRecvTs, seq: this.seq });
    this.seq += events.length;
    for (const event of events) this.options.onEvent(event);
  }
}

/** Ensures a topic-derived interval is present, for callers that need it. */
export { intervalFromTopic };
