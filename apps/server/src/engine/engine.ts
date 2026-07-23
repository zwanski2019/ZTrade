import type {
  AccountSnapshot,
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
  getActiveStrategy,
  insertSignal,
  insertTrade,
  recordEquity,
} from "../db.js";
import { getStrategyImpl } from "../strategies/index.js";
import { assessRisk, protectivePrices, quantityFor } from "./risk.js";
import { notifier } from "../notify/telegram.js";

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

  getStatus(): EngineStatus {
    // Reflect the armed strategy even while stopped — the operator arms it on
    // the config screen and expects the dashboard to show it before starting.
    const strategy = this.activeStrategy ?? getActiveStrategy();

    return {
      state: this.state,
      network: config.network,
      exchangeConnected: exchange.configured && exchange.latencyMs !== null,
      latencyMs: exchange.latencyMs,
      activeStrategyId: strategy?.id ?? null,
      activeStrategyName: strategy?.name ?? null,
      lastHeartbeat: this.lastHeartbeat,
      startedAt: this.startedAt,
      error: this.lastError,
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

  async start(): Promise<void> {
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
        "No Bybit credentials configured — running on public market data only.",
      );
    }

    exchange.connectWebsocket(strategy.pairs);

    this.startedAt = Date.now();
    this.setState("RUNNING");
    logger.info(
      `Engine RUNNING — strategy "${strategy.name}" (${strategy.kind}) on ` +
        `${strategy.pairs.join(", ")}${config.tradingEnabled ? "" : " [PAPER]"}`,
    );

    this.heartbeatTimer = setInterval(() => void this.heartbeat(), HEARTBEAT_INTERVAL_MS);
    this.tickTimer = setInterval(() => void this.tick(), TICK_INTERVAL_MS);

    // Evaluate immediately rather than waiting a full interval for the first signal.
    void this.tick();
  }

  async stop(): Promise<void> {
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
  }

  /**
   * Emergency stop: flatten everything, cancel resting orders, halt.
   * Deliberately tolerant of failure — a partial close still beats none, and
   * the operator hit this button because something is already wrong.
   */
  async emergencyStop(): Promise<{ closed: number }> {
    logger.warn("EMERGENCY STOP triggered — closing all positions");

    let closed = 0;
    try {
      await exchange.cancelAllOrders();
      closed = await exchange.closeAllPositions();
      logger.warn(`Emergency stop closed ${closed} position(s)`);
    } catch (err) {
      logger.error(`Emergency stop encountered an error: ${(err as Error).message}`);
    }

    await this.stop();
    await notifier.send(`🛑 EMERGENCY STOP — ${closed} position(s) closed.`);
    return { closed };
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
    if (!exchange.configured) return;

    try {
      const [account, positions] = await Promise.all([
        exchange.getAccount(),
        exchange.getPositions(),
      ]);

      this.cachedAccount = account;
      this.cachedPositions = positions;

      bus.emitEvent({ type: "account", payload: account });
      bus.emitEvent({ type: "position", payload: positions[0] ?? null });

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

  /** One evaluation pass over every symbol the armed strategy watches. */
  private async tick(): Promise<void> {
    if (this.state !== "RUNNING" || this.ticking) return;
    this.ticking = true;

    try {
      await this.refreshAccountState();

      const strategy = this.activeStrategy;
      if (!strategy) return;

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
          });

          const acted = await this.actOnSignal(signal, strategy, candles.at(-1)!.close);
          bus.emitEvent({ type: "signal", payload: { ...signal, acted } });
        } catch (err) {
          logger.error(`Evaluation failed for ${symbol}: ${(err as Error).message}`);
        }
      }
    } finally {
      this.ticking = false;
    }
  }

  /** Applies risk checks and, if they pass, opens the position. */
  private async actOnSignal(
    signal: Signal,
    strategy: StrategyConfig,
    price: number,
  ): Promise<boolean> {
    const side = signal.action === "BUY" ? "LONG" : "SHORT";
    const equity = this.cachedAccount?.equity ?? 0;

    const verdict = assessRisk({
      strategy,
      openPositions: this.cachedPositions,
      accountEquity: equity,
      intendedNotional: strategy.risk.maxPositionSize,
      symbol: signal.symbol,
    });

    if (!verdict.allowed) {
      logger.info(`Signal ${signal.action} ${signal.symbol} not actioned: ${verdict.reason}`);
      return false;
    }

    const qty = quantityFor(verdict.notional, price);
    if (qty <= 0) {
      logger.warn(
        `Computed quantity for ${signal.symbol} rounded to zero ` +
          `(notional ${verdict.notional.toFixed(2)} @ ${price}) — skipping`,
      );
      return false;
    }

    const { stopLoss, takeProfit } = protectivePrices(price, side, strategy.risk);

    try {
      const orderId = await exchange.placeMarketOrder({
        symbol: signal.symbol,
        side: signal.action === "BUY" ? "Buy" : "Sell",
        qty,
        stopLoss: Number(stopLoss.toFixed(2)),
        takeProfit: Number(takeProfit.toFixed(2)),
      });

      const trade = insertTrade({
        openedAt: Date.now(),
        closedAt: null,
        symbol: signal.symbol,
        side,
        size: qty,
        entryPrice: price,
        exitPrice: null,
        pnl: 0,
        status: "Open",
        strategyId: strategy.id,
        exchangeOrderId: orderId,
      });

      bus.emitEvent({ type: "trade", payload: trade });
      logger.trade(
        `Position opened ${signal.symbol} ${side} @ ${price} (size ${qty})` +
          `${orderId ? "" : " [PAPER]"}`,
      );
      await notifier.tradeOpened(trade);

      return true;
    } catch (err) {
      logger.error(
        `Order placement failed for ${signal.symbol}: ${(err as Error).message}`,
      );
      return false;
    }
  }

  /** Re-reads the armed strategy; used after the operator saves a config. */
  reloadStrategy(): void {
    const strategy = getActiveStrategy();
    this.activeStrategy = strategy;

    if (this.state === "RUNNING" && strategy) {
      exchange.connectWebsocket(strategy.pairs);
      logger.info(`Reloaded strategy "${strategy.name}"`);
    }
    bus.emitEvent({ type: "status", payload: this.getStatus() });
  }
}

export const engine = new ExecutionEngine();
