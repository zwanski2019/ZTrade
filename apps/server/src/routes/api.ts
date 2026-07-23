import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  maskSecret,
  type DashboardSnapshot,
  type Settings,
  type StrategyConfig,
  type TradeStatus,
  type UiSettings,
} from "@ztrade/shared";
import { config } from "../config.js";
import { logger, recentLogs } from "../bus.js";
import { engine } from "../engine/engine.js";
import { runBacktest } from "../engine/backtest.js";
import { exchange } from "../exchange/bybit.js";
import {
  defaultTelegramSettings,
  notifier,
  TELEGRAM_SETTINGS_KEY,
} from "../notify/telegram.js";
import {
  deleteStrategy,
  equityCurve,
  getSetting,
  getStrategy,
  listStrategies,
  listTrades,
  performanceStats,
  recentSignals,
  recentTrades,
  setActiveStrategy,
  setSetting,
  upsertStrategy,
} from "../db.js";

const riskSchema = z.object({
  maxPositionSize: z.number().positive(),
  stopLossPct: z.number().positive().max(100),
  takeProfitPct: z.number().positive().max(1000),
  maxTradesPerDay: z.number().int().nonnegative(),
  globalRiskCap: z.number().positive(),
});

const strategySchema = z.object({
  id: z.string().optional(),
  name: z.string().min(1).max(120),
  kind: z.enum(["MOMENTUM", "MEAN_REVERSION", "GRID", "CUSTOM"]),
  enabled: z.boolean().default(false),
  pairs: z.array(z.string().regex(/^[A-Z0-9]{4,20}$/)).min(1),
  risk: riskSchema,
  params: z.record(z.union([z.number(), z.string(), z.boolean()])).default({}),
});

const UI_SETTINGS_KEY = "ui";
const defaultUiSettings: UiSettings = { highContrast: false };

export async function registerApiRoutes(app: FastifyInstance): Promise<void> {
  // -------------------------------------------------------------------------
  // Health & status
  // -------------------------------------------------------------------------

  app.get("/api/health", async () => ({
    ok: true,
    network: config.network,
    tradingEnabled: config.tradingEnabled,
  }));

  app.get("/api/status", async () => engine.getStatus());

  /** Everything the dashboard needs on first paint. */
  app.get("/api/dashboard", async (): Promise<DashboardSnapshot> => {
    const stats = performanceStats();
    return {
      status: engine.getStatus(),
      account:
        engine.getAccount() ??
        { equity: 0, availableBalance: 0, pnlPct: 0, unrealisedPnl: 0 },
      position: engine.getPrimaryPosition(),
      signals: recentSignals(20),
      recentTrades: recentTrades(10),
      equityCurve: equityCurve(Date.now() - 30 * 24 * 60 * 60 * 1000),
      stats,
    };
  });

  // -------------------------------------------------------------------------
  // Engine control
  // -------------------------------------------------------------------------

  app.post("/api/engine/start", async (_req, reply) => {
    await engine.start();
    const status = engine.getStatus();
    if (status.state === "ERROR") return reply.code(409).send(status);
    return status;
  });

  app.post("/api/engine/stop", async () => {
    await engine.stop();
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

    const result = await engine.emergencyStop();
    return { ...result, status: engine.getStatus() };
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
      id: parsed.data.id ?? randomUUID(),
      updatedAt: Date.now(),
    };

    upsertStrategy(strategy);
    if (strategy.enabled) setActiveStrategy(strategy.id);
    engine.reloadStrategy();

    logger.info(`Strategy saved: ${strategy.name} (${strategy.kind})`);
    return reply.code(201).send(strategy);
  });

  app.post("/api/strategies/:id/activate", async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!getStrategy(id)) return reply.code(404).send({ error: "Strategy not found" });

    setActiveStrategy(id);
    engine.reloadStrategy();
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
    return { ok: true };
  });

  app.post("/api/strategies/:id/backtest", async (req, reply) => {
    const { id } = req.params as { id: string };
    const strategy = getStrategy(id);
    if (!strategy) return reply.code(404).send({ error: "Strategy not found" });

    const opts = z
      .object({
        interval: z.string().optional(),
        candles: z.number().int().min(50).max(1000).optional(),
        startingEquity: z.number().positive().optional(),
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

  app.get("/api/equity", async (req) => {
    const q = z
      .object({ from: z.coerce.number().optional(), to: z.coerce.number().optional() })
      .parse(req.query);
    return equityCurve(q.from, q.to);
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

    const header = "time,pair,side,size,entry,exit,pnl,status";
    const rows = trades.map((t) =>
      [
        new Date(t.openedAt).toISOString(),
        t.symbol,
        t.side,
        t.size,
        t.entryPrice,
        t.exitPrice ?? "",
        t.pnl,
        t.status,
      ].join(","),
    );

    reply.header("Content-Type", "text/csv; charset=utf-8");
    reply.header("Content-Disposition", 'attachment; filename="ztrade-trades.csv"');
    return [header, ...rows].join("\n");
  });

  // -------------------------------------------------------------------------
  // Logs
  // -------------------------------------------------------------------------

  app.get("/api/logs", async (req) => {
    const { limit } = z
      .object({ limit: z.coerce.number().int().min(1).max(500).default(200) })
      .parse(req.query);
    return recentLogs(limit);
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
    const telegram = getSetting(TELEGRAM_SETTINGS_KEY, defaultTelegramSettings);
    return {
      exchange: {
        network: config.network,
        apiKeyMasked: maskSecret(config.bybit.apiKey),
        hasSecret: Boolean(config.bybit.apiSecret),
      },
      telegram: {
        ...telegram,
        botToken: maskSecret(config.telegram.botToken ?? telegram.botToken),
        chatId: config.telegram.chatId ?? telegram.chatId,
      },
      ui: getSetting(UI_SETTINGS_KEY, defaultUiSettings),
    };
  });

  app.put("/api/settings/telegram", async (req, reply) => {
    const parsed = z
      .object({
        enabled: z.boolean(),
        botToken: z.string().min(1).nullable().optional(),
        chatId: z.string().min(1).nullable().optional(),
        notifyTradeOpened: z.boolean(),
        notifyTradeClosed: z.boolean(),
        notifyDailySummary: z.boolean(),
        notifyErrors: z.boolean(),
      })
      .safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "Invalid Telegram settings" });
    }

    const existing = getSetting(TELEGRAM_SETTINGS_KEY, defaultTelegramSettings);
    setSetting(TELEGRAM_SETTINGS_KEY, {
      ...existing,
      ...parsed.data,
      // Omitting a token in the payload keeps the stored one rather than nulling it.
      botToken: parsed.data.botToken ?? existing.botToken,
      chatId: parsed.data.chatId ?? existing.chatId,
    });

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
    return { ok, latencyMs: latency, network: config.network };
  });
}
