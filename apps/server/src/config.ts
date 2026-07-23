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
 *      With it off the engine runs, evaluates strategies and simulates fills,
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

const bool = (fallback: "true" | "false") =>
  z.enum(["true", "false"]).default(fallback);

const schema = z.object({
  PORT: z.coerce.number().int().positive().default(8788),
  HOST: z.string().default("127.0.0.1"),

  ZTRADE_NETWORK: z.enum(["TESTNET", "MAINNET"]).default("TESTNET"),
  ZTRADE_ALLOW_MAINNET: bool("false"),
  ZTRADE_TRADING_ENABLED: bool("false"),

  BYBIT_API_KEY: optionalSecret(),
  BYBIT_API_SECRET: optionalSecret(),

  TELEGRAM_BOT_TOKEN: optionalSecret(),
  TELEGRAM_CHAT_ID: optionalSecret(),

  // --- Security -----------------------------------------------------------
  /** Bearer token required by the API. Auto-generated on first run if unset. */
  ZTRADE_API_TOKEN: optionalSecret(),
  /** Set to "false" only for local development you fully control. */
  ZTRADE_AUTH_ENABLED: bool("true"),
  /** Passphrase used to encrypt secrets at rest. Falls back to the API token. */
  ZTRADE_SECRET_KEY: optionalSecret(),
  /** Requests per minute per IP. */
  ZTRADE_RATE_LIMIT: z.coerce.number().int().positive().default(240),

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
const authEnabled = env.ZTRADE_AUTH_ENABLED === "true";
const tradingEnabled = env.ZTRADE_TRADING_ENABLED === "true";

if (requestedNetwork === "MAINNET" && !mainnetAllowed) {
  throw new Error(
    "ZTRADE_NETWORK=MAINNET requires ZTRADE_ALLOW_MAINNET=true. " +
      "Refusing to trade against real funds without both switches set.",
  );
}

/**
 * Disabling auth while pointed at real money is never a deliberate choice, so
 * it is a startup failure rather than a warning.
 */
if (!authEnabled && requestedNetwork === "MAINNET" && tradingEnabled) {
  throw new Error(
    "Refusing to start: ZTRADE_AUTH_ENABLED=false with live MAINNET trading. " +
      "An unauthenticated API that can place real orders is not a supported configuration.",
  );
}

export const config = {
  port: env.PORT,
  host: env.HOST,

  network: requestedNetwork as Network,
  isTestnet: requestedNetwork === "TESTNET",
  /** When false the engine is in paper mode: simulated fills, no orders sent. */
  tradingEnabled,

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

  security: {
    authEnabled,
    apiToken: env.ZTRADE_API_TOKEN ?? null,
    secretKey: env.ZTRADE_SECRET_KEY ?? null,
    rateLimitPerMinute: env.ZTRADE_RATE_LIMIT,
  },

  databasePath: env.DATABASE_PATH,
  corsOrigins: env.CORS_ORIGIN.split(",").map((s) => s.trim()).filter(Boolean),
} as const;

/** One-line banner so the operator always knows what they just started. */
export function describeSafetyPosture(): string {
  const mode = config.tradingEnabled ? "LIVE ORDERS" : "PAPER (simulated fills)";
  return (
    `network=${config.network} mode=${mode} ` +
    `keys=${config.bybit.configured ? "present" : "absent"} ` +
    `auth=${config.security.authEnabled ? "on" : "OFF"}`
  );
}
