import { config as loadEnv } from "dotenv";
import { z } from "zod";
import type { Network } from "@ztrade/shared";

loadEnv();

/**
 * Safety posture, in order of strictness:
 *
 *   1. The network defaults to TESTNET. You have to ask for MAINNET.
 *   2. Asking for MAINNET is not enough — ZTRADE_ALLOW_MAINNET must ALSO be
 *      "true". Two independent switches, so a single typo or a copied .env
 *      cannot point the bot at real money.
 *   3. Live order placement is gated separately by ZTRADE_TRADING_ENABLED.
 *      With it off the engine runs, evaluates strategies and records signals,
 *      but never sends an order (paper mode).
 */
/**
 * An unset key in .env (`BYBIT_API_KEY=`) reaches us as "", which is *present*
 * as far as zod is concerned — so `.min(1).optional()` would reject it rather
 * than treat it as absent. Normalise blanks to undefined first.
 */
const optionalSecret = () =>
  z.preprocess(
    (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
    z.string().min(1).optional(),
  );

const schema = z.object({
  PORT: z.coerce.number().int().positive().default(8788),
  HOST: z.string().default("127.0.0.1"),

  ZTRADE_NETWORK: z.enum(["TESTNET", "MAINNET"]).default("TESTNET"),
  ZTRADE_ALLOW_MAINNET: z.enum(["true", "false"]).default("false"),
  ZTRADE_TRADING_ENABLED: z.enum(["true", "false"]).default("false"),

  BYBIT_API_KEY: optionalSecret(),
  BYBIT_API_SECRET: optionalSecret(),

  TELEGRAM_BOT_TOKEN: optionalSecret(),
  TELEGRAM_CHAT_ID: optionalSecret(),

  DATABASE_PATH: z.string().default("./data/ztrade.db"),
  /** Comma-separated origins allowed to call the API. */
  CORS_ORIGIN: z.string().default("http://localhost:5173"),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  const issues = parsed.error.issues
    .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
    .join("\n");
  throw new Error(`Invalid environment configuration:\n${issues}`);
}

const env = parsed.data;

const requestedNetwork = env.ZTRADE_NETWORK;
const mainnetAllowed = env.ZTRADE_ALLOW_MAINNET === "true";

if (requestedNetwork === "MAINNET" && !mainnetAllowed) {
  throw new Error(
    "ZTRADE_NETWORK=MAINNET requires ZTRADE_ALLOW_MAINNET=true. " +
      "Refusing to trade against real funds without both switches set.",
  );
}

export const config = {
  port: env.PORT,
  host: env.HOST,

  network: requestedNetwork as Network,
  isTestnet: requestedNetwork === "TESTNET",
  /** When false the engine is in paper mode: signals only, no orders sent. */
  tradingEnabled: env.ZTRADE_TRADING_ENABLED === "true",

  bybit: {
    apiKey: env.BYBIT_API_KEY ?? null,
    apiSecret: env.BYBIT_API_SECRET ?? null,
    get configured(): boolean {
      return Boolean(env.BYBIT_API_KEY && env.BYBIT_API_SECRET);
    },
  },

  telegram: {
    botToken: env.TELEGRAM_BOT_TOKEN ?? null,
    chatId: env.TELEGRAM_CHAT_ID ?? null,
    get configured(): boolean {
      return Boolean(env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID);
    },
  },

  databasePath: env.DATABASE_PATH,
  corsOrigins: env.CORS_ORIGIN.split(",").map((s) => s.trim()).filter(Boolean),
} as const;

/** One-line banner so the operator always knows what they just started. */
export function describeSafetyPosture(): string {
  const mode = config.tradingEnabled ? "LIVE ORDERS" : "PAPER (no orders sent)";
  return `network=${config.network} mode=${mode} keys=${
    config.bybit.configured ? "present" : "absent"
  }`;
}
