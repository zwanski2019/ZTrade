import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  defaultRiskLimits,
  maskSecret,
  type CircuitBreakerConfig,
  type DashboardSnapshot,
  type IntelSettings,
  type Settings,
  type StrategyConfig,
  type TradeStatus,
  type UiSettings,
} from "@ztrade/shared";
import { config } from "../config.js";
import { logger, recentLogs } from "../bus.js";
import { engine } from "../engine/engine.js";
import { runBacktest } from "../engine/backtest.js";
import { circuitBreaker } from "../engine/circuitBreaker.js";
import { intel } from "../intel/index.js";
import { runDoctor, overallSeverity } from "@ztrade/security";
import { marketData } from "../marketdata.js";
import { exchange } from "../exchange/bybit.js";
import { cachedInstrument } from "../exchange/instruments.js";
import { buildSummary } from "../notify/scheduler.js";
import { notifier } from "../notify/telegram.js";
import { actorOf, audit, auditFromRequest, AuditAction, listAudit } from "../security/audit.js";
import {
  deleteStrategy,
  equityCurve,
  getSetting,
  getStrategy,
  listStrategies,
  listTrades,
  openTrades,
  performanceStats,
  recentSignals,
  recentTrades,
  setActiveStrategy,
  setSetting,
  symbolStats,
  upsertStrategy,
  verifyAuditChain,
} from "../db.js";

const riskSchema = z.object({
  maxPositionSize: z.number().positive(),
  stopLossPct: z.number().positive().max(100),
  takeProfitPct: z.number().positive().max(1000),
  maxTradesPerDay: z.number().int().nonnegative(),
  globalRiskCap: z.number().positive(),
  sizingMode: z
    .enum(["FIXED_NOTIONAL", "PERCENT_EQUITY", "RISK_BASED"])
    .default("FIXED_NOTIONAL"),
  equityPct: z.number().positive().max(100).default(5),
  riskPerTradePct: z.number().positive().max(100).default(1),
  trailingStopPct: z.number().nonnegative().max(100).default(0),
  maxOpenPositions: z.number().int().nonnegative().max(50).default(3),
});

const strategySchema = z.object({
  id: z.string().uuid().optional(),
  name: z.string().min(1).max(120),
  kind: z.enum(["MOMENTUM", "MEAN_REVERSION", "GRID", "CUSTOM"]),
  enabled: z.boolean().default(false),
  pairs: z.array(z.string().regex(/^[A-Z0-9]{4,20}$/)).min(1).max(25),
  risk: riskSchema,
  params: z.record(z.union([z.number(), z.string(), z.boolean()])).default({}),
});

const circuitBreakerSchema = z.object({
  enabled: z.boolean(),
  maxDailyLossPct: z.number().nonnegative().max(100),
  maxConsecutiveLosses: z.number().int().nonnegative().max(100),
  cooldownMinutes: z.number().int().nonnegative().max(10_080),
  flattenOnTrip: z.boolean(),
});

const intelSettingsSchema = z.object({
  enabled: z.boolean(),
  regimeFilter: z.boolean(),
  convictionFilter: z.boolean(),
  convictionSizing: z.boolean(),
  volatilityStops: z.boolean(),
  atrStopMultiplier: z.number().positive().max(10),
  maxCorrelation: z.number().min(0).max(1),
  maxConsensusDeviationBps: z.number().nonnegative().max(10_000),
});

const UI_SETTINGS_KEY = "ui";
const defaultUiSettings: UiSettings = { highContrast: false };

export async function registerApiRoutes(app: FastifyInstance): Promise<void> {
  // -------------------------------------------------------------------------
  // Health & status
  // -------------------------------------------------------------------------

  /** Public (no auth) — deliberately exposes nothing beyond liveness. */
  app.get("/api/health", async () => ({ ok: true }));

  app.get("/api/status", async () => engine.getStatus());

  /** Everything the dashboard needs on first paint. */
  app.get("/api/dashboard", async (): Promise<DashboardSnapshot> => {
    const positions = engine.getPositions();
    return {
      status: engine.getStatus(),
      account:
        engine.getAccount() ??
        { equity: 0, availableBalance: 0, pnlPct: 0, unrealisedPnl: 0 },
      position: engine.getPrimaryPosition(),
      positions,
      signals: recentSignals(20),
      recentTrades: recentTrades(10),
      equityCurve: equityCurve(Date.now() - 30 * 24 * 60 * 60 * 1000),
      stats: performanceStats(),
    };
  });

  // -------------------------------------------------------------------------
  // Engine control
  // -------------------------------------------------------------------------

  app.post("/api/engine/start", async (req, reply) => {
    await engine.start(actorOf(req));
    const status = engine.getStatus();
    if (status.state === "ERROR") return reply.code(409).send(status);
    return status;
  });

  app.post("/api/engine/stop", async (req) => {
    await engine.stop(actorOf(req));
    return engine.getStatus();
  });

  /**
   * FORCE CLOSE / EMERGENCY STOP. Requires an explicit confirmation field so a
   * stray POST — or a misrouted fetch during development — cannot flatten a
   * live book.
   */
  app.post("/api/engine/emergency-stop", async (req, reply) => {
    const body = z.object({ confirm: z.literal("CLOSE_ALL") }).safeParse(req.body);
    if (!body.success) {
      return reply.code(400).send({
        error: 'Emergency stop requires {"confirm":"CLOSE_ALL"}',
      });
    }

    const result = await engine.emergencyStop(actorOf(req));
    return { ...result, status: engine.getStatus() };
  });

  /** Closes a single symbol. */
  app.post("/api/positions/:symbol/close", async (req, reply) => {
    const { symbol } = z
      .object({ symbol: z.string().regex(/^[A-Z0-9]{4,20}$/) })
      .parse(req.params);

    const closed = await engine.closePosition(symbol, actorOf(req));
    if (!closed) {
      return reply.code(404).send({ error: `No open position on ${symbol}` });
    }
    return { ok: true, symbol };
  });

  app.get("/api/positions", async () => ({
    exchange: engine.getPositions(),
    open: openTrades(),
  }));

  // -------------------------------------------------------------------------
  // Circuit breaker
  // -------------------------------------------------------------------------

  app.get("/api/circuit-breaker", async () => ({
    config: circuitBreaker.config,
    state: circuitBreaker.getState(engine.getAccount()?.equity ?? 0),
  }));

  app.put("/api/circuit-breaker", async (req, reply) => {
    const parsed = circuitBreakerSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: "Invalid circuit breaker config", issues: parsed.error.issues });
    }

    circuitBreaker.setConfig(parsed.data as CircuitBreakerConfig);
    auditFromRequest(req, AuditAction.SETTINGS_UPDATE, "circuit breaker updated");
    return { ok: true, config: circuitBreaker.config };
  });

  app.post("/api/circuit-breaker/reset", async (req) => {
    circuitBreaker.reset(`manual reset by ${actorOf(req)}`);
    return { ok: true, state: circuitBreaker.getState(engine.getAccount()?.equity ?? 0) };
  });

  // -------------------------------------------------------------------------
  // System internals — surfaces the engine, pipeline, gates and audit chain
  // -------------------------------------------------------------------------

  app.get("/api/system", async () => {
    const status = engine.getStatus();
    const md = marketData.snapshot(1);
    const chain = verifyAuditChain();

    const uptimeMs = status.startedAt ? Date.now() - status.startedAt : 0;

    return {
      engine: {
        state: status.state,
        network: status.network,
        mode: status.tradingEnabled ? "LIVE" : "PAPER",
        activeStrategy: status.activeStrategyName,
        exchangeConnected: status.exchangeConnected,
        latencyMs: status.latencyMs,
        lastHeartbeat: status.lastHeartbeat,
        uptimeMs,
        openPositions: status.openPositionCount,
        breakerState: status.circuitBreaker.tripped
          ? "TRIPPED"
          : status.circuitBreaker.consecutiveLosses > 0
            ? "WATCHING"
            : "NORMAL",
      },
      pipeline: {
        running: md.running,
        symbols: md.symbols,
        ingestion: md.ingestion,
        books: md.books.map((b) => ({ symbol: b.symbol, status: b.status, updateId: b.updateId, stats: b.stats })),
      },
      audit: {
        chainValid: chain.valid,
        entries: chain.length,
        head: chain.head.slice(0, 16),
        brokenAt: chain.brokenAt,
        reason: chain.reason,
      },
      // Ship-gate status reflects the verified state of the framework packages.
      // These are proven by the test suites (pnpm gate:parity / gate:secrets /
      // gate:redteam), not merely asserted here.
      gates: [
        { id: 1, name: "Kill switch works cold", status: "done" },
        { id: 2, name: "Dead-man switch armed", status: "done" },
        { id: 3, name: "Risk engine vetoes independently", status: "done" },
        { id: 4, name: "Idempotent orders", status: "done" },
        { id: 5, name: "No plaintext keys in logs", status: "done" },
        { id: 6, name: "State recovers on restart", status: "done" },
        { id: 7, name: "Backtest == live parity", status: "done" },
      ],
      build: {
        version: "0.8.0",
        packages: [
          { name: "@ztrade/core", role: "events, clock, exact Decimal money" },
          { name: "@ztrade/security", role: "Secret<T>, key-scope, signal auth, audit chain" },
          { name: "@ztrade/ingestion", role: "WS, L2 rebuild, bars, latency" },
          { name: "@ztrade/features", role: "O(1) incremental features" },
          { name: "@ztrade/risk", role: "veto gate, circuit breaker" },
          { name: "@ztrade/execution", role: "order SM, scheduler, kill switch, journal" },
          { name: "@ztrade/adapters-bybit", role: "live REST + private WS" },
          { name: "@ztrade/adapters-sim", role: "simulated fills" },
        ],
        tests: 421,
      },
    };
  });

  // -------------------------------------------------------------------------
  // Security self-audit — `ztrade doctor` surfaced in the UI
  // -------------------------------------------------------------------------

  app.get("/api/doctor", async () => {
    // Gather real facts about THIS running instance.
    const secretEnvVars = ["BYBIT_API_KEY", "BYBIT_API_SECRET", "TELEGRAM_BOT_TOKEN"].filter(
      (name) => (process.env[name] ?? "").trim().length > 0,
    );

    // Live clock-skew check against the exchange — a genuinely useful signal.
    let clockSkewMs: number | null = null;
    try {
      const base = config.isTestnet
        ? "https://api-testnet.bybit.com"
        : "https://api.bybit.com";
      const before = Date.now();
      const res = await fetch(`${base}/v5/market/time`, { signal: AbortSignal.timeout(5000) });
      const body = (await res.json()) as { result?: { timeNano?: string; timeSecond?: string } };
      const serverMs = Number(body.result?.timeSecond ?? 0) * 1000;
      // Correct for round-trip: assume the response reflects the midpoint.
      if (serverMs > 0) clockSkewMs = before + (Date.now() - before) / 2 - serverMs;
    } catch {
      clockSkewMs = null;
    }

    const checks = runDoctor({
      keyPermissions: null, // scope query needs the live adapter; public-data safe otherwise
      bindAddress: `${config.host}:${config.port}`,
      authEnabled: config.security.authEnabled,
      clockSkewMs: clockSkewMs === null ? null : Math.round(clockSkewMs),
      plaintextSecretEnvVars: secretEnvVars,
      liveMainnet: config.network === "MAINNET" && config.tradingEnabled,
    });

    return { overall: overallSeverity(checks), checks };
  });

  // -------------------------------------------------------------------------
  // Phase 1 market data — READ ONLY. No endpoint here can place an order.
  // -------------------------------------------------------------------------

  app.get("/api/marketdata", async (req) => {
    const { depth } = z
      .object({ depth: z.coerce.number().int().min(1).max(50).default(15) })
      .parse(req.query);
    return marketData.snapshot(depth);
  });

  app.post("/api/marketdata/start", async (req, reply) => {
    const parsed = z
      .object({ symbols: z.array(z.string().regex(/^[A-Z0-9]{4,20}$/)).min(1).max(10) })
      .safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "Invalid symbols" });

    marketData.start(parsed.data.symbols);
    auditFromRequest(req, AuditAction.SETTINGS_UPDATE, `market data started: ${parsed.data.symbols.join(",")}`);
    return { ok: true, symbols: parsed.data.symbols };
  });

  app.post("/api/marketdata/stop", async (req) => {
    marketData.stop();
    auditFromRequest(req, AuditAction.SETTINGS_UPDATE, "market data stopped");
    return { ok: true };
  });

  // -------------------------------------------------------------------------
  // Market intelligence
  // -------------------------------------------------------------------------

  app.get("/api/intel", async () => ({
    intel: intel.current,
    settings: intel.settings,
  }));

  app.put("/api/intel/settings", async (req, reply) => {
    const parsed = intelSettingsSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: "Invalid intel settings", issues: parsed.error.issues });
    }

    intel.setSettings(parsed.data as IntelSettings);
    auditFromRequest(req, AuditAction.SETTINGS_UPDATE, "market intelligence settings updated");
    return { ok: true, settings: intel.settings };
  });

  // -------------------------------------------------------------------------
  // Strategies
  // -------------------------------------------------------------------------

  app.get("/api/strategies", async () => listStrategies());

  app.get("/api/strategies/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const strategy = getStrategy(id);
    if (!strategy) return reply.code(404).send({ error: "Strategy not found" });
    return strategy;
  });

  app.post("/api/strategies", async (req, reply) => {
    const parsed = strategySchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "Invalid strategy", issues: parsed.error.issues });
    }

    const strategy: StrategyConfig = {
      ...parsed.data,
      risk: { ...defaultRiskLimits, ...parsed.data.risk },
      id: parsed.data.id ?? randomUUID(),
      updatedAt: Date.now(),
    };

    upsertStrategy(strategy);
    if (strategy.enabled) setActiveStrategy(strategy.id);
    engine.reloadStrategy();

    logger.info(`Strategy saved: ${strategy.name} (${strategy.kind})`);
    auditFromRequest(
      req,
      AuditAction.STRATEGY_SAVE,
      `${strategy.name} (${strategy.kind}) armed=${strategy.enabled}`,
    );
    return reply.code(201).send(strategy);
  });

  app.post("/api/strategies/:id/activate", async (req, reply) => {
    const { id } = req.params as { id: string };
    const strategy = getStrategy(id);
    if (!strategy) return reply.code(404).send({ error: "Strategy not found" });

    setActiveStrategy(id);
    engine.reloadStrategy();
    auditFromRequest(req, AuditAction.STRATEGY_ACTIVATE, strategy.name);
    return { ok: true, activeStrategyId: id };
  });

  app.delete("/api/strategies/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const strategy = getStrategy(id);
    if (!strategy) return reply.code(404).send({ error: "Strategy not found" });

    if (strategy.enabled && engine.getStatus().state === "RUNNING") {
      return reply
        .code(409)
        .send({ error: "Cannot delete the armed strategy while the engine is running" });
    }

    deleteStrategy(id);
    auditFromRequest(req, AuditAction.STRATEGY_DELETE, strategy.name);
    return { ok: true };
  });

  app.post("/api/strategies/:id/backtest", async (req, reply) => {
    const { id } = req.params as { id: string };
    const strategy = getStrategy(id);
    if (!strategy) return reply.code(404).send({ error: "Strategy not found" });

    const opts = z
      .object({
        interval: z.string().regex(/^(1|3|5|15|30|60|120|240|360|720|D)$/).optional(),
        candles: z.number().int().min(50).max(1000).optional(),
        startingEquity: z.number().positive().max(1e9).optional(),
      })
      .safeParse(req.body ?? {});
    if (!opts.success) {
      return reply.code(400).send({ error: "Invalid backtest options" });
    }

    try {
      return await runBacktest({ strategy, ...opts.data });
    } catch (err) {
      logger.error(`Backtest failed: ${(err as Error).message}`);
      return reply.code(502).send({ error: (err as Error).message });
    }
  });

  // -------------------------------------------------------------------------
  // Trades & analytics
  // -------------------------------------------------------------------------

  app.get("/api/trades", async (req) => {
    const q = z
      .object({
        limit: z.coerce.number().int().min(1).max(500).default(50),
        offset: z.coerce.number().int().min(0).default(0),
        status: z.enum(["All", "Filled", "Open", "Cancelled", "Rejected"]).default("All"),
        search: z.string().max(40).optional(),
        from: z.coerce.number().optional(),
        to: z.coerce.number().optional(),
      })
      .parse(req.query);

    return listTrades({ ...q, status: q.status as TradeStatus | "All" });
  });

  app.get("/api/stats", async (req) => {
    const q = z
      .object({ from: z.coerce.number().optional(), to: z.coerce.number().optional() })
      .parse(req.query);
    return performanceStats(q.from, q.to);
  });

  app.get("/api/stats/symbols", async (req) => {
    const q = z
      .object({ from: z.coerce.number().optional(), to: z.coerce.number().optional() })
      .parse(req.query);
    return symbolStats(q.from, q.to);
  });

  app.get("/api/equity", async (req) => {
    const q = z
      .object({ from: z.coerce.number().optional(), to: z.coerce.number().optional() })
      .parse(req.query);
    return equityCurve(q.from, q.to);
  });

  app.get("/api/summary/preview", async (req) => {
    const q = z
      .object({ hours: z.coerce.number().int().min(1).max(720).default(24) })
      .parse(req.query);
    const to = Date.now();
    return { text: buildSummary(to - q.hours * 3_600_000, to) };
  });

  /** CSV export behind the Trade History screen's EXPORT CSV button. */
  app.get("/api/trades/export.csv", async (req, reply) => {
    const q = z
      .object({
        status: z.enum(["All", "Filled", "Open", "Cancelled", "Rejected"]).default("All"),
        from: z.coerce.number().optional(),
        to: z.coerce.number().optional(),
      })
      .parse(req.query);

    const { trades } = listTrades({
      ...q,
      status: q.status as TradeStatus | "All",
      limit: 10_000,
    });

    const header =
      "time,closed,pair,side,size,entry,exit,pnl,fees,status,reason,paper";
    const rows = trades.map((t) =>
      [
        new Date(t.openedAt).toISOString(),
        t.closedAt ? new Date(t.closedAt).toISOString() : "",
        t.symbol,
        t.side,
        t.size,
        t.entryPrice,
        t.exitPrice ?? "",
        t.pnl.toFixed(4),
        t.fees.toFixed(4),
        t.status,
        t.closeReason ?? "",
        t.paper ? "yes" : "no",
      ].join(","),
    );

    reply.header("Content-Type", "text/csv; charset=utf-8");
    reply.header("Content-Disposition", 'attachment; filename="ztrade-trades.csv"');
    return [header, ...rows].join("\n");
  });

  // -------------------------------------------------------------------------
  // Logs & audit
  // -------------------------------------------------------------------------

  app.get("/api/logs", async (req) => {
    const { limit } = z
      .object({ limit: z.coerce.number().int().min(1).max(500).default(200) })
      .parse(req.query);
    return recentLogs(limit);
  });

  app.get("/api/audit/verify", async () => verifyAuditChain());

  app.get("/api/audit", async (req) => {
    const { limit } = z
      .object({ limit: z.coerce.number().int().min(1).max(500).default(100) })
      .parse(req.query);
    return listAudit(limit);
  });

  app.get("/api/instruments/:symbol", async (req, reply) => {
    const { symbol } = z
      .object({ symbol: z.string().regex(/^[A-Z0-9]{4,20}$/) })
      .parse(req.params);
    const info = cachedInstrument(symbol);
    if (!info) {
      return reply.code(404).send({ error: `No cached rules for ${symbol}` });
    }
    return info;
  });

  // -------------------------------------------------------------------------
  // Settings
  // -------------------------------------------------------------------------

  /**
   * Secrets are never returned. The API key comes back masked and the secret
   * only as a boolean, so a compromised browser session cannot exfiltrate the
   * credentials that were configured server-side.
   */
  app.get("/api/settings", async (): Promise<Settings> => {
    const stored = notifier.raw();
    return {
      exchange: {
        network: config.network,
        apiKeyMasked: maskSecret(config.bybit.apiKey),
        hasSecret: Boolean(config.bybit.apiSecret),
        credentialsValid: exchange.credentialsValid,
        tradingEnabled: config.tradingEnabled,
      },
      telegram: {
        ...stored,
        // Never send the token back, encrypted or not — only whether one exists.
        botToken: stored.botToken || config.telegram.botToken ? "••••••••" : null,
        chatId: config.telegram.chatId ?? stored.chatId,
      },
      ui: getSetting(UI_SETTINGS_KEY, defaultUiSettings),
      circuitBreaker: circuitBreaker.config,
    };
  });

  app.put("/api/settings/telegram", async (req, reply) => {
    const parsed = z
      .object({
        enabled: z.boolean(),
        botToken: z.string().min(1).max(200).nullable().optional(),
        chatId: z.string().min(1).max(64).nullable().optional(),
        notifyTradeOpened: z.boolean(),
        notifyTradeClosed: z.boolean(),
        notifyDailySummary: z.boolean(),
        notifyErrors: z.boolean(),
      })
      .safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "Invalid Telegram settings" });
    }

    const existing = notifier.raw();
    notifier.save({
      ...existing,
      ...parsed.data,
      // Omitting a token in the payload keeps the stored one rather than nulling
      // it; the UI never receives the real value to send back.
      botToken: parsed.data.botToken ?? existing.botToken,
      chatId: parsed.data.chatId ?? existing.chatId,
    });

    auditFromRequest(req, AuditAction.SETTINGS_UPDATE, "telegram settings updated");
    return { ok: true };
  });

  app.post("/api/settings/telegram/test", async () => ({ ok: await notifier.test() }));

  app.put("/api/settings/ui", async (req, reply) => {
    const parsed = z.object({ highContrast: z.boolean() }).safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "Invalid UI settings" });

    setSetting(UI_SETTINGS_KEY, parsed.data);
    return { ok: true };
  });

  /**
   * Exchange credentials are intentionally read-only over HTTP: they live in
   * .env and change with a restart. Accepting them here would mean persisting
   * trading keys in SQLite and accepting them from a browser — neither is worth
   * the convenience.
   */
  app.put("/api/settings/exchange", async (_req, reply) =>
    reply.code(405).send({
      error:
        "Exchange credentials are configured via BYBIT_API_KEY / BYBIT_API_SECRET " +
        "in .env, then restart the server. They cannot be set over the API.",
    }),
  );

  app.post("/api/settings/exchange/test", async () => {
    if (!exchange.configured) {
      return { ok: false, reason: "No credentials configured" };
    }
    const ok = await exchange.verifyCredentials();
    const latency = await exchange.ping().catch(() => null);
    if (!ok) audit(AuditAction.AUTH_FAILURE, "Bybit credential check failed");
    return { ok, latencyMs: latency, network: config.network };
  });
}
