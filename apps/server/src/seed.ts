import { randomUUID } from "node:crypto";
import type { StrategyConfig } from "@ztrade/shared";
import { listStrategies, upsertStrategy } from "./db.js";
import { logger } from "./bus.js";

/**
 * Creates a conservative default strategy on first run so the Strategy Config
 * screen is never empty. Deliberately left DISABLED — arming a strategy is the
 * operator's decision, not a side effect of starting the server.
 */
export function seedDefaultStrategy(): void {
  if (listStrategies().length > 0) return;

  const strategy: StrategyConfig = {
    id: randomUUID(),
    name: "Alpha Momentum v1",
    kind: "MOMENTUM",
    enabled: false,
    pairs: ["BTCUSDT", "ETHUSDT"],
    risk: {
      maxPositionSize: 100,
      stopLossPct: 2,
      takeProfitPct: 4,
      maxTradesPerDay: 10,
      globalRiskCap: 500,
    },
    params: {
      interval: "5",
      fastPeriod: 12,
      slowPeriod: 26,
      signalPeriod: 9,
      rsiPeriod: 14,
      rsiUpper: 70,
      rsiLower: 30,
    },
    updatedAt: Date.now(),
  };

  upsertStrategy(strategy);
  logger.info(`Seeded default strategy "${strategy.name}" (disabled)`);
}
