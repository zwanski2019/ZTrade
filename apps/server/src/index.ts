import Fastify from "fastify";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import websocket from "@fastify/websocket";
import { config, describeSafetyPosture } from "./config.js";
import { logger } from "./bus.js";
import { registerApiRoutes } from "./routes/api.js";
import { registerWebsocketRoutes } from "./routes/ws.js";
import { engine } from "./engine/engine.js";
import { seedDefaultStrategy } from "./seed.js";
import { db } from "./db.js";
import { apiToken, authHook, tokenWasGenerated } from "./security/auth.js";
import { audit, actorOf, AuditAction } from "./security/audit.js";
import { startScheduler, stopScheduler } from "./notify/scheduler.js";

const app = Fastify({
  logger: false, // We stream our own structured logs to the terminal UI.
  bodyLimit: 256_000,
  // Trust the proxy header only for loopback; otherwise any client could spoof
  // its IP and evade the rate limiter.
  trustProxy: "127.0.0.1",
});

/**
 * Security headers. The API serves JSON and a WebSocket, never HTML, so the
 * CSP can be maximally restrictive — nothing should ever be rendered from here.
 */
await app.register(helmet, {
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'none'"],
      frameAncestors: ["'none'"],
      baseUri: ["'none'"],
      formAction: ["'none'"],
    },
  },
  crossOriginResourcePolicy: { policy: "same-site" },
  referrerPolicy: { policy: "no-referrer" },
  // HSTS is pointless (and misleading) on a loopback HTTP service.
  hsts: false,
});

await app.register(cors, {
  origin: config.corsOrigins,
  credentials: true,
  methods: ["GET", "POST", "PUT", "DELETE"],
});

await app.register(rateLimit, {
  max: config.security.rateLimitPerMinute,
  timeWindow: "1 minute",
  // The trading UI polls; a shared cap across every client would throttle the
  // operator's own dashboard, so limit per IP.
  keyGenerator: (req) => req.ip,
  errorResponseBuilder: () => ({
    error: "Rate limit exceeded. Slow down.",
  }),
});

await app.register(websocket);

// Auth runs before every route; /api/health is the only exemption.
app.addHook("onRequest", authHook);

await app.register(registerApiRoutes);
await registerWebsocketRoutes(app);

app.setErrorHandler((error: Error & { statusCode?: number }, req, reply) => {
  const status = error.statusCode ?? 500;

  logger.error(`Unhandled request error: ${error.message}`);
  if (status === 401) audit(AuditAction.AUTH_FAILURE, req.url, actorOf(req));

  // Never leak internals to the client on a 500; the detail is in our log.
  reply
    .code(status)
    .send({ error: status >= 500 ? "Internal server error" : error.message });
});

seedDefaultStrategy();

try {
  await app.listen({ port: config.port, host: config.host });

  logger.info(`ZTrade server listening on http://${config.host}:${config.port}`);
  logger.info(`Safety posture: ${describeSafetyPosture()}`);

  if (config.security.authEnabled) {
    const token = apiToken();
    if (tokenWasGenerated()) {
      // Printed directly rather than through the log bus: the token must not
      // end up in the buffer that the browser log stream replays.
      console.log(
        "\n  ZTrade API token (generated — set ZTRADE_API_TOKEN to pin it):\n" +
          `    ${token}\n`,
      );
    }
  } else {
    logger.warn("AUTH IS DISABLED — the API is open to anyone who can reach this port.");
  }

  if (config.network === "MAINNET" && config.tradingEnabled) {
    logger.warn("MAINNET + live orders: this bot is trading REAL funds.");
  }

  startScheduler();
} catch (err) {
  logger.error(`Failed to start server: ${(err as Error).message}`);
  process.exit(1);
}

/**
 * Stop the engine before exiting. Positions are intentionally left open: an
 * unattended restart should not liquidate a book. Use the emergency stop
 * endpoint when you actually want everything flattened.
 */
async function shutdown(signal: string): Promise<void> {
  logger.warn(`Received ${signal} — shutting down`);
  try {
    stopScheduler();
    await engine.stop();
    await app.close();
    db.close();
  } catch (err) {
    logger.error(`Error during shutdown: ${(err as Error).message}`);
  }
  process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
