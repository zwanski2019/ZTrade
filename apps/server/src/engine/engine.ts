import type {
  AccountSnapshot,
  CloseReason,
  EngineState,
  EngineStatus,
  Position,
  Signal,
  StrategyConfig,
} from "@ztrade/shared";
import { config } from "../config.js";
import { bus, logger } from "../bus.js";
import { exchange, NotConfiguredError } from "../exchange/bybit.js";
import {
  instrumentOrFallback,
  isStale,
  loadInstruments,
} from "../exchange/instruments.js";
import {
  getActiveStrategy,
  insertSignal,
  insertTrade,
  markSignalActed,
  openTradeForSymbol,
  openTrades,
  recordEquity,
} from "../db.js";
import { getStrategyImpl } from "../strategies/index.js";
import { assessRisk, protectivePrices, roundToTick } from "./risk.js";
import { circuitBreaker } from "./circuitBreaker.js";
import { netPnl, reconciler } from "./reconciler.js";
import { notifier } from "../notify/telegram.js";
import { audit, AuditAction } from "../security/audit.js";

const TICK_INTERVAL_MS = 15_000;
const HEARTBEAT_INTERVAL_MS = 5_000;
/**
 * Only warn on a genuine spike. Normal round-trip to Bybit from outside their
 * colo is 150-500ms, so a lower bar (the 100ms the mockup implies) fires on
 * every single beat and turns the log stream into noise.
 */
const LATENCY_WARN_MS = 1_000;
/** Candles fetched per evaluation — enough to warm up the slowest indicator. */
const CANDLE_LOOKBACK = 200;
/** Starting equity assumed for paper mode when there is no real account. */
const PAPER_STARTING_EQUITY = 10_000;

class ExecutionEngine {
  private state: EngineState = "STOPPED";
  private tickTimer: NodeJS.Timeout | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private startedAt: number | null = null;
  private lastHeartbeat: number | null = null;
  private lastError: string | null = null;
  private activeStrategy: StrategyConfig | null = null;
  private cachedAccount: AccountSnapshot | null = null;
  private cachedPositions: Position[] = [];
  /** Guards against a slow tick overlapping the next scheduled one. */
  private ticking = false;
  /** Simulated realised equity for paper mode. */
  private paperEquity = PAPER_STARTING_EQUITY;

  getStatus(): EngineStatus {
    // Reflect the armed strategy even while stopped — the operator arms it on
    // the config screen and expects the dashboard to show it before starting.
    const strategy = this.activeStrategy ?? getActiveStrategy();

    return {
      state: this.state,
      network: config.network,
      // Market data flowing is the honest meaning of "connected": the engine
      // works on public data alone, so this must not require credentials.
      exchangeConnected: exchange.latencyMs !== null,
      credentialsValid: exchange.credentialsValid,
      latencyMs: exchange.latencyMs,
      activeStrategyId: strategy?.id ?? null,
      activeStrategyName: strategy?.name ?? null,
      lastHeartbeat: this.lastHeartbeat,
      startedAt: this.startedAt,
      error: this.lastError,
      tradingEnabled: config.tradingEnabled,
      circuitBreaker: circuitBreaker.getState(this.cachedAccount?.equity ?? 0),
      openPositionCount: openTrades().length,
    };
  }

  getAccount(): AccountSnapshot | null {
    return this.cachedAccount;
  }

  getPositions(): Position[] {
    return this.cachedPositions;
  }

  /** The dashboard shows a single "Current Position" card. */
  getPrimaryPosition(): Position | null {
    return this.cachedPositions[0] ?? null;
  }

  private setState(state: EngineState, error: string | null = null): void {
    this.state = state;
    this.lastError = error;
    bus.emitEvent({ type: "status", payload: this.getStatus() });
  }

  async start(actor: string | null = null): Promise<void> {
    if (this.state === "RUNNING" || this.state === "STARTING") {
      logger.warn("Engine already running — ignoring start request");
      return;
    }

    this.setState("STARTING");
    logger.info(`Starting execution engine (${config.network})`);

    const strategy = getActiveStrategy();
    if (!strategy) {
      const message = "No strategy is armed. Enable one on the Strategy Config screen.";
      logger.error(message);
      this.setState("ERROR", message);
      return;
    }
    this.activeStrategy = strategy;

    try {
      await exchange.ping();
    } catch (err) {
      const message = `Cannot reach Bybit: ${(err as Error).message}`;
      logger.error(message);
      this.setState("ERROR", message);
      return;
    }

    // Trading rules must be loaded BEFORE any sizing happens — quantities based
    // on a guessed step size get rejected by the exchange.
    if (isStale()) {
      await loadInstruments(() => exchange.getInstruments(), strategy.pairs);
    }

    if (exchange.configured) {
      const ok = await exchange.verifyCredentials();
      if (!ok) {
        const message = "Bybit rejected the configured API credentials.";
        this.setState("ERROR", message);
        return;
      }
      await this.refreshAccountState();
    } else {
      logger.warn(
        "No Bybit credentials configured — running on public market data only" +
          (config.tradingEnabled ? "" : " (paper mode)") +
          ".",
      );
    }

    if (circuitBreaker.evaluate(this.cachedAccount?.equity ?? 0)) {
      logger.warn(
        `Circuit breaker is tripped (${circuitBreaker.trippedReason}). ` +
          "The engine will run but will not open new positions until it resets.",
      );
    }

    exchange.connectWebsocket(strategy.pairs);

    this.startedAt = Date.now();
    this.setState("RUNNING");
    logger.info(
      `Engine RUNNING — strategy "${strategy.name}" (${strategy.kind}) on ` +
        `${strategy.pairs.join(", ")}${config.tradingEnabled ? "" : " [PAPER]"}`,
    );
    audit(AuditAction.ENGINE_START, `strategy=${strategy.name} network=${config.network}`, actor);

    this.heartbeatTimer = setInterval(() => void this.heartbeat(), HEARTBEAT_INTERVAL_MS);
    this.tickTimer = setInterval(() => void this.tick(), TICK_INTERVAL_MS);

    // Evaluate immediately rather than waiting a full interval for the first signal.
    void this.tick();
  }

  async stop(actor: string | null = null): Promise<void> {
    if (this.state === "STOPPED") return;

    this.setState("STOPPING");
    logger.info("Stopping execution engine");

    if (this.tickTimer) clearInterval(this.tickTimer);
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.tickTimer = null;
    this.heartbeatTimer = null;

    exchange.disconnectWebsocket();
    this.startedAt = null;
    this.setState("STOPPED");
    logger.info("Engine STOPPED — open positions were left untouched");
    audit(AuditAction.ENGINE_STOP, "engine stopped", actor);
  }

  /**
   * Emergency stop: flatten everything, cancel resting orders, halt.
   * Deliberately tolerant of failure — a partial close still beats none, and
   * the operator hit this button because something is already wrong.
   */
  async emergencyStop(actor: string | null = null): Promise<{ closed: number }> {
    logger.warn("EMERGENCY STOP triggered — closing all positions");
    audit(AuditAction.EMERGENCY_STOP, "close all positions requested", actor);

    let closed = 0;
    try {
      await exchange.cancelAllOrders();
      closed = await exchange.closeAllPositions();
    } catch (err) {
      logger.error(`Emergency stop encountered an error: ${(err as Error).message}`);
    }

    // Settle our own rows too, live or paper — otherwise the trade log keeps
    // showing positions as Open after the book has been flattened.
    closed += await this.settleAllOpenTrades("EMERGENCY");

    logger.warn(`Emergency stop closed ${closed} position(s)`);
    await this.stop(actor);
    await notifier.send(`🛑 EMERGENCY STOP — ${closed} position(s) closed.`);
    return { closed };
  }

  /** Closes every open trade row at the best price we can get. */
  private async settleAllOpenTrades(reason: CloseReason): Promise<number> {
    const marks = exchange.markPrices;
    let settled = 0;

    for (const trade of openTrades()) {
      let exitPrice = marks.get(trade.symbol) ?? null;
      if (exitPrice === null) {
        exitPrice = await exchange.getLastPrice(trade.symbol).catch(() => null);
      }
      if (exitPrice === null) continue;

      if (reconciler.settle(trade, exitPrice, reason)) {
        this.applyPaperPnl(trade, exitPrice);
        settled += 1;
      }
    }

    return settled;
  }

  /** Manually closes one symbol. */
  async closePosition(symbol: string, actor: string | null = null): Promise<boolean> {
    const trade = openTradeForSymbol(symbol);
    if (!trade) return false;

    if (!trade.paper) {
      await exchange.closePosition(symbol).catch((err: Error) => {
        logger.error(`Failed to close ${symbol} on the exchange: ${err.message}`);
      });
    }

    const price =
      exchange.markPrices.get(symbol) ??
      (await exchange.getLastPrice(symbol).catch(() => null));
    if (price === null) return false;

    const closed = reconciler.settle(trade, price, "MANUAL");
    if (closed) {
      this.applyPaperPnl(trade, price);
      audit(AuditAction.POSITION_CLOSE, `${symbol} closed manually`, actor);
      circuitBreaker.evaluate(this.cachedAccount?.equity ?? 0);
    }
    return Boolean(closed);
  }

  private async heartbeat(): Promise<void> {
    try {
      const latency = await exchange.ping();
      this.lastHeartbeat = Date.now();

      if (latency > LATENCY_WARN_MS) {
        logger.warn(`Latency spike detected: ${latency}ms. Re-centering synchronization.`);
      }

      bus.emitEvent({
        type: "heartbeat",
        payload: { at: this.lastHeartbeat, latencyMs: latency },
      });
    } catch (err) {
      logger.error(`Heartbeat failed: ${(err as Error).message}`);
    }
  }

  private async refreshAccountState(): Promise<void> {
    if (!exchange.configured) {
      // Paper mode still needs an equity series, or the chart stays empty and
      // the circuit breaker has no denominator for the daily loss percentage.
      this.cachedAccount = {
        equity: this.paperEquity,
        availableBalance: this.paperEquity,
        pnlPct: 0,
        unrealisedPnl: 0,
      };
      bus.emitEvent({ type: "account", payload: this.cachedAccount });
      recordEquity({ at: Date.now(), equity: this.paperEquity, pnl: 0 });
      return;
    }

    try {
      const [account, positions] = await Promise.all([
        exchange.getAccount(),
        exchange.getPositions(),
      ]);

      this.cachedAccount = account;
      this.cachedPositions = positions;

      bus.emitEvent({ type: "account", payload: account });
      bus.emitEvent({ type: "position", payload: positions[0] ?? null });
      bus.emitEvent({ type: "positions", payload: positions });

      recordEquity({
        at: Date.now(),
        equity: account.equity,
        pnl: account.unrealisedPnl,
      });
    } catch (err) {
      if (err instanceof NotConfiguredError) return;
      logger.error(`Failed to refresh account state: ${(err as Error).message}`);
    }
  }

  /** Credits simulated P&L so the paper equity curve actually moves. */
  private applyPaperPnl(
    trade: { side: "LONG" | "SHORT"; size: number; entryPrice: number; paper: boolean },
    exitPrice: number,
  ): void {
    if (!trade.paper) return;
    this.paperEquity += netPnl(trade, exitPrice);
  }

  /** One evaluation pass over every symbol the armed strategy watches. */
  private async tick(): Promise<void> {
    if (this.state !== "RUNNING" || this.ticking) return;
    this.ticking = true;

    try {
      await this.refreshAccountState();

      const strategy = this.activeStrategy;
      if (!strategy) return;

      await this.reconcile(strategy);

      // Re-check after reconciliation: a trade that just closed at a loss may
      // be the one that trips the breaker.
      const halted = circuitBreaker.evaluate(this.cachedAccount?.equity ?? 0);
      if (halted) {
        await this.handleTrippedBreaker();
        return;
      }

      const impl = getStrategyImpl(strategy.kind);
      const interval = String(strategy.params.interval ?? "5");

      for (const symbol of strategy.pairs) {
        try {
          const candles = await exchange.getCandles(symbol, interval, CANDLE_LOOKBACK);
          if (candles.length < impl.warmup) continue;

          const decision = impl.evaluate(candles, strategy);
          if (decision.action === "HOLD") continue;

          const signal = insertSignal({
            at: Date.now(),
            symbol,
            action: decision.action,
            reason: decision.reason,
            confidence: decision.confidence,
            acted: false,
            skippedReason: null,
          });

          const outcome = await this.actOnSignal(
            signal,
            strategy,
            candles.at(-1)!.close,
          );
          markSignalActed(signal.id, outcome.acted, outcome.reason);
          bus.emitEvent({
            type: "signal",
            payload: { ...signal, acted: outcome.acted, skippedReason: outcome.reason },
          });
        } catch (err) {
          logger.error(`Evaluation failed for ${symbol}: ${(err as Error).message}`);
        }
      }
    } finally {
      this.ticking = false;
    }
  }

  /** Settles closed positions and ratchets trailing stops. */
  private async reconcile(strategy: StrategyConfig): Promise<void> {
    const marks = exchange.markPrices;

    // Fall back to REST when the ticker stream has not delivered a price yet.
    for (const symbol of strategy.pairs) {
      if (marks.has(symbol)) continue;
      const price = await exchange.getLastPrice(symbol).catch(() => null);
      if (price !== null) marks.set(symbol, price);
    }

    if (config.tradingEnabled && exchange.configured) {
      const settled = await reconciler.reconcileLive(this.cachedPositions, async (symbol) =>
        marks.get(symbol) ?? (await exchange.getLastPrice(symbol).catch(() => null)),
      );
      if (settled.length > 0) await this.refreshAccountState();
    } else {
      const settled = await reconciler.reconcilePaper(marks);
      for (const trade of settled) {
        this.applyPaperPnl(trade, trade.exitPrice ?? trade.entryPrice);
      }
      if (settled.length > 0) await this.refreshAccountState();
    }

    const moved = reconciler.applyTrailingStops(marks, strategy.risk.trailingStopPct);
    for (const { trade, stopLoss } of moved) {
      if (trade.paper) continue;
      const tick = instrumentOrFallback(trade.symbol).tickSize;
      await exchange
        .setStopLoss(trade.symbol, roundToTick(stopLoss, tick))
        .catch((err: Error) =>
          logger.warn(`Could not push trailing stop for ${trade.symbol}: ${err.message}`),
        );
    }
  }

  private async handleTrippedBreaker(): Promise<void> {
    const cfg = circuitBreaker.config;
    if (!cfg.flattenOnTrip) return;

    const open = openTrades();
    if (open.length === 0) return;

    logger.warn("Circuit breaker set to flatten — closing open positions");
    if (config.tradingEnabled) await exchange.closeAllPositions().catch(() => 0);
    await this.settleAllOpenTrades("EMERGENCY");
  }

  /** Applies risk checks and, if they pass, opens the position. */
  private async actOnSignal(
    signal: Signal,
    strategy: StrategyConfig,
    price: number,
  ): Promise<{ acted: boolean; reason: string | null }> {
    const side = signal.action === "BUY" ? "LONG" : "SHORT";
    const equity = this.cachedAccount?.equity ?? 0;
    const instrument = instrumentOrFallback(signal.symbol);

    const verdict = assessRisk({
      strategy,
      openPositions: this.cachedPositions,
      accountEquity: equity,
      symbol: signal.symbol,
      price,
      instrument,
    });

    if (!verdict.allowed) {
      logger.info(`Signal ${signal.action} ${signal.symbol} not actioned: ${verdict.reason}`);
      return { acted: false, reason: verdict.reason };
    }

    const raw = protectivePrices(price, side, strategy.risk);
    const stopLoss = roundToTick(raw.stopLoss, instrument.tickSize);
    const takeProfit = roundToTick(raw.takeProfit, instrument.tickSize);

    try {
      const orderId = await exchange.placeMarketOrder({
        symbol: signal.symbol,
        side: signal.action === "BUY" ? "Buy" : "Sell",
        qty: verdict.quantity,
        stopLoss,
        takeProfit,
      });

      const trade = insertTrade({
        openedAt: Date.now(),
        closedAt: null,
        symbol: signal.symbol,
        side,
        size: verdict.quantity,
        entryPrice: price,
        exitPrice: null,
        pnl: 0,
        fees: 0,
        status: "Open",
        closeReason: null,
        strategyId: strategy.id,
        exchangeOrderId: orderId,
        stopLoss,
        takeProfit,
        paper: orderId === null,
      });

      bus.emitEvent({ type: "trade", payload: trade });
      logger.trade(
        `Position opened ${signal.symbol} ${side} @ ${price} (size ${verdict.quantity})` +
          `${orderId ? "" : " [PAPER]"}`,
      );
      await notifier.tradeOpened(trade);

      return { acted: true, reason: null };
    } catch (err) {
      const message = (err as Error).message;
      logger.error(`Order placement failed for ${signal.symbol}: ${message}`);
      return { acted: false, reason: `Order failed: ${message}` };
    }
  }

  /** Re-reads the armed strategy; used after the operator saves a config. */
  reloadStrategy(): void {
    const strategy = getActiveStrategy();
    this.activeStrategy = strategy;

    if (this.state === "RUNNING" && strategy) {
      exchange.connectWebsocket(strategy.pairs);
      void loadInstruments(() => exchange.getInstruments(), strategy.pairs);
      logger.info(`Reloaded strategy "${strategy.name}"`);
    }
    bus.emitEvent({ type: "status", payload: this.getStatus() });
  }
}

export const engine = new ExecutionEngine();
