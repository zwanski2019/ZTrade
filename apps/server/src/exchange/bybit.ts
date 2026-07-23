import { RestClientV5, WebsocketClient } from "bybit-api";
import type { AccountSnapshot, OrderSide, Position, Side } from "@ztrade/shared";
import { config } from "../config.js";
import { logger } from "../bus.js";

export interface Candle {
  openTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export class NotConfiguredError extends Error {
  constructor() {
    super(
      "Bybit API credentials are not configured. Set BYBIT_API_KEY and " +
        "BYBIT_API_SECRET in .env (testnet keys unless you know what you are doing).",
    );
    this.name = "NotConfiguredError";
  }
}

/**
 * Thin wrapper over bybit-api's v5 client.
 *
 * Everything that can move money funnels through placeMarketOrder /
 * closePosition, so the paper-mode guard only has to exist in one place.
 * Market data (klines, tickers) works without credentials, which is what lets
 * the engine run strategies before any keys are entered.
 */
export class BybitExchange {
  private rest: RestClientV5;
  private ws: WebsocketClient | null = null;
  private lastLatencyMs: number | null = null;
  private tickerHandlers = new Set<(symbol: string, price: number) => void>();
  private credentialsChecked = false;
  private credentialsOk = false;
  /** Latest price per symbol from the ticker stream. */
  private marks = new Map<string, number>();

  constructor() {
    this.rest = new RestClientV5({
      key: config.bybit.apiKey ?? undefined,
      secret: config.bybit.apiSecret ?? undefined,
      testnet: config.isTestnet,
    });
  }

  get configured(): boolean {
    return config.bybit.configured;
  }

  get latencyMs(): number | null {
    return this.lastLatencyMs;
  }

  /** True only once credentials have been presented AND accepted. */
  get credentialsValid(): boolean {
    return this.credentialsOk;
  }

  /** Live mark prices from the ticker stream, keyed by symbol. */
  get markPrices(): Map<string, number> {
    return new Map(this.marks);
  }

  /** Round-trips the public time endpoint and records latency. */
  async ping(): Promise<number> {
    const start = Date.now();
    await this.rest.getServerTime();
    this.lastLatencyMs = Date.now() - start;
    return this.lastLatencyMs;
  }

  /** Verifies the credentials actually work, not just that they are present. */
  async verifyCredentials(): Promise<boolean> {
    if (!this.configured) {
      this.credentialsChecked = true;
      this.credentialsOk = false;
      return false;
    }

    try {
      const res = await this.rest.getWalletBalance({ accountType: "UNIFIED" });
      this.credentialsChecked = true;
      this.credentialsOk = res.retCode === 0;
      if (!this.credentialsOk) logger.error(`Bybit rejected credentials: ${res.retMsg}`);
      return this.credentialsOk;
    } catch (err) {
      this.credentialsChecked = true;
      this.credentialsOk = false;
      logger.error(`Bybit credential check failed: ${(err as Error).message}`);
      return false;
    }
  }

  get credentialsChecked_(): boolean {
    return this.credentialsChecked;
  }

  /** Raw instrument rules for linear perpetuals. Public endpoint. */
  async getInstruments(): Promise<
    Array<{
      symbol: string;
      priceFilter?: { tickSize?: string };
      lotSizeFilter?: {
        qtyStep?: string;
        minOrderQty?: string;
        maxOrderQty?: string;
        minNotionalValue?: string;
      };
      leverageFilter?: { maxLeverage?: string };
    }>
  > {
    const res = await this.rest.getInstrumentsInfo({ category: "linear", limit: 1000 });
    if (res.retCode !== 0) throw new Error(`getInstrumentsInfo: ${res.retMsg}`);
    return (res.result.list ?? []) as never;
  }

  /**
   * Moves the stop-loss on an existing position — used by the trailing stop.
   * No-op in paper mode, where the stop lives only in our own trade row.
   */
  async setStopLoss(symbol: string, stopLoss: number): Promise<void> {
    if (!config.tradingEnabled || !this.configured) return;

    const res = await this.rest.setTradingStop({
      category: "linear",
      symbol,
      stopLoss: String(stopLoss),
      positionIdx: 0,
    });

    // 34040 = "not modified": the stop is already at this level. Harmless.
    if (res.retCode !== 0 && res.retCode !== 34040) {
      logger.warn(`setTradingStop(${symbol}): ${res.retMsg}`);
    }
  }

  async getAccount(): Promise<AccountSnapshot> {
    if (!this.configured) throw new NotConfiguredError();

    const res = await this.rest.getWalletBalance({ accountType: "UNIFIED" });
    if (res.retCode !== 0) throw new Error(`getWalletBalance: ${res.retMsg}`);

    const account = res.result.list?.[0];
    if (!account) {
      return { equity: 0, availableBalance: 0, pnlPct: 0, unrealisedPnl: 0 };
    }

    const equity = Number(account.totalEquity ?? 0);
    const available = Number(account.totalAvailableBalance ?? 0);
    const unrealised = Number(account.totalPerpUPL ?? 0);

    return {
      equity,
      availableBalance: available,
      // Unrealised P&L relative to equity — the header's "P&L: +2.4%".
      pnlPct: equity > 0 ? unrealised / equity : 0,
      unrealisedPnl: unrealised,
    };
  }

  async getPositions(): Promise<Position[]> {
    if (!this.configured) throw new NotConfiguredError();

    const res = await this.rest.getPositionInfo({
      category: "linear",
      settleCoin: "USDT",
    });
    if (res.retCode !== 0) throw new Error(`getPositionInfo: ${res.retMsg}`);

    return (res.result.list ?? [])
      .filter((p) => Number(p.size) > 0)
      .map((p) => {
        const size = Number(p.size);
        const entryPrice = Number(p.avgPrice);
        const markPrice = Number(p.markPrice);
        const unrealised = Number(p.unrealisedPnl);
        const notional = entryPrice * size;

        return {
          symbol: p.symbol,
          side: (p.side === "Buy" ? "LONG" : "SHORT") as Side,
          size,
          entryPrice,
          markPrice,
          unrealisedPnl: unrealised,
          unrealisedPnlPct: notional > 0 ? unrealised / notional : 0,
          leverage: Number(p.leverage ?? 1),
          liquidationPrice: p.liqPrice ? Number(p.liqPrice) : null,
          stopLoss: p.stopLoss ? Number(p.stopLoss) : null,
          takeProfit: p.takeProfit ? Number(p.takeProfit) : null,
        } satisfies Position;
      });
  }

  /** Historical candles. Public endpoint — works without credentials. */
  async getCandles(symbol: string, interval = "5", limit = 200): Promise<Candle[]> {
    const res = await this.rest.getKline({
      category: "linear",
      symbol,
      interval: interval as "1" | "3" | "5" | "15" | "30" | "60" | "240" | "D",
      limit,
    });
    if (res.retCode !== 0) throw new Error(`getKline: ${res.retMsg}`);

    // Bybit returns newest-first; strategies want oldest-first.
    return (res.result.list ?? [])
      .map((k) => ({
        openTime: Number(k[0]),
        open: Number(k[1]),
        high: Number(k[2]),
        low: Number(k[3]),
        close: Number(k[4]),
        volume: Number(k[5]),
      }))
      .reverse();
  }

  async getLastPrice(symbol: string): Promise<number> {
    const res = await this.rest.getTickers({ category: "linear", symbol });
    if (res.retCode !== 0) throw new Error(`getTickers: ${res.retMsg}`);
    const ticker = res.result.list?.[0];
    if (!ticker) throw new Error(`No ticker for ${symbol}`);
    return Number(ticker.lastPrice);
  }

  /**
   * Places a market order. Returns null in paper mode — callers must treat a
   * null order id as "simulated" and never as a failure.
   */
  async placeMarketOrder(opts: {
    symbol: string;
    side: OrderSide;
    qty: number;
    stopLoss?: number;
    takeProfit?: number;
    reduceOnly?: boolean;
  }): Promise<string | null> {
    if (!config.tradingEnabled) {
      logger.warn(
        `PAPER: would ${opts.side} ${opts.qty} ${opts.symbol} ` +
          `(set ZTRADE_TRADING_ENABLED=true to send real orders)`,
      );
      return null;
    }
    if (!this.configured) throw new NotConfiguredError();

    const res = await this.rest.submitOrder({
      category: "linear",
      symbol: opts.symbol,
      side: opts.side,
      orderType: "Market",
      qty: String(opts.qty),
      ...(opts.stopLoss ? { stopLoss: String(opts.stopLoss) } : {}),
      ...(opts.takeProfit ? { takeProfit: String(opts.takeProfit) } : {}),
      ...(opts.reduceOnly ? { reduceOnly: true } : {}),
    });

    if (res.retCode !== 0) throw new Error(`submitOrder: ${res.retMsg}`);

    logger.trade(
      `${opts.side} ${opts.qty} ${opts.symbol} @ market → order ${res.result.orderId}`,
    );
    return res.result.orderId;
  }

  /** Flattens a single symbol with a reduce-only market order. */
  async closePosition(symbol: string): Promise<void> {
    const positions = await this.getPositions();
    const position = positions.find((p) => p.symbol === symbol);
    if (!position) return;

    await this.placeMarketOrder({
      symbol,
      side: position.side === "LONG" ? "Sell" : "Buy",
      qty: position.size,
      reduceOnly: true,
    });
  }

  /** Emergency stop: flatten everything. Best-effort per symbol. */
  async closeAllPositions(): Promise<number> {
    if (!this.configured) return 0;

    const positions = await this.getPositions();
    let closed = 0;
    for (const p of positions) {
      try {
        await this.closePosition(p.symbol);
        closed += 1;
      } catch (err) {
        logger.error(`Failed to close ${p.symbol}: ${(err as Error).message}`);
      }
    }
    return closed;
  }

  async cancelAllOrders(): Promise<void> {
    if (!config.tradingEnabled || !this.configured) return;
    const res = await this.rest.cancelAllOrders({
      category: "linear",
      settleCoin: "USDT",
    });
    if (res.retCode !== 0) logger.warn(`cancelAllOrders: ${res.retMsg}`);
  }

  onTicker(handler: (symbol: string, price: number) => void): () => void {
    this.tickerHandlers.add(handler);
    return () => this.tickerHandlers.delete(handler);
  }

  /** Opens the public ticker stream for the given symbols. */
  connectWebsocket(symbols: string[]): void {
    if (this.ws) this.disconnectWebsocket();
    if (symbols.length === 0) return;

    this.ws = new WebsocketClient(
      { market: "v5", testnet: config.isTestnet },
      // bybit-api's default logger dumps whole objects on every subscribe and
      // reconnect. Route its noise to our stream and drop the rest.
      {
        silly: () => {},
        debug: () => {},
        notice: () => {},
        info: () => {},
        warning: () => {},
        error: (...params: unknown[]) => {
          logger.error(`Bybit WS: ${String(params[0])}`);
        },
      },
    );

    this.ws.on("update", (data: { topic?: string; data?: Record<string, unknown> }) => {
      if (!data.topic?.startsWith("tickers.")) return;
      const payload = data.data;
      const symbol = payload?.symbol as string | undefined;
      const lastPrice = payload?.lastPrice as string | undefined;
      if (!symbol || !lastPrice) return;

      const price = Number(lastPrice);
      if (!Number.isFinite(price)) return;

      this.marks.set(symbol, price);
      for (const handler of this.tickerHandlers) handler(symbol, price);
    });

    this.ws.on("open", () => logger.info("Connected to Bybit WebSocket (stream: linear)"));
    this.ws.on("error", (err: unknown) =>
      logger.error(`Bybit WebSocket error: ${String(err)}`),
    );
    this.ws.on("close", () => logger.warn("Bybit WebSocket closed"));

    void this.ws.subscribeV5(
      symbols.map((s) => `tickers.${s}`),
      "linear",
    );
  }

  disconnectWebsocket(): void {
    if (!this.ws) return;
    try {
      this.ws.closeAll();
    } catch {
      // Already torn down; nothing useful to do.
    }
    this.ws = null;
  }
}

export const exchange = new BybitExchange();
