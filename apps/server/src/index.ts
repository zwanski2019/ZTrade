import Fastify from "fastify";
import cors from "@fastify/cors";
import websocket from "@fastify/websocket";
import { config, describeSafetyPosture } from "./config.js";
import { logger } from "./bus.js";
import { registerApiRoutes } from "./routes/api.js";
import { registerWebsocketRoutes } from "./routes/ws.js";
import { engine } from "./engine/engine.js";
import { seedDefaultStrategy } from "./seed.js";
import { db } from "./db.js";

const app = Fastify({
  logger: false, // We stream our own structured logs to the terminal UI.
  bodyLimit: 1_000_000,
});

await app.register(cors, {
  origin: config.corsOrigins,
  credentials: true,
});
await app.register(websocket);

await registerApiRoutes(app);
await registerWebsocketRoutes(app);

app.setErrorHandler((error: Error & { statusCode?: number }, _req, reply) => {
  logger.error(`Unhandled request error: ${error.message}`);
  reply.code(error.statusCode ?? 500).send({ error: error.message });
});

seedDefaultStrategy();

try {
  await app.listen({ port: config.port, host: config.host });
  logger.info(`ZTrade server listening on http://${config.host}:${config.port}`);
  logger.info(`Safety posture: ${describeSafetyPosture()}`);

  if (config.network === "MAINNET" && config.tradingEnabled) {
    logger.warn("MAINNET + live orders: this bot is trading REAL funds.");
  }
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
