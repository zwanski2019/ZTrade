import type { FastifyInstance, FastifyRequest } from "fastify";
import type { WebSocket } from "ws";
import type { ServerEvent } from "@ztrade/shared";
import { config } from "../config.js";
import { bus, logger, recentLogs } from "../bus.js";
import { engine } from "../engine/engine.js";
import { circuitBreaker } from "../engine/circuitBreaker.js";
import { isAllowedOrigin, isAuthorised } from "../security/auth.js";
import { audit, actorOf, AuditAction } from "../security/audit.js";

/**
 * Live channel powering the dashboard's heartbeat, signal feed and log stream.
 *
 * Each socket gets a replay of current state on connect, so the UI renders
 * immediately rather than waiting for the first tick.
 */
/** Application-specific close code for a rejected Origin (4000-4999 is ours). */
const CLOSE_ORIGIN_REJECTED = 4403;

export async function registerWebsocketRoutes(app: FastifyInstance): Promise<void> {
  app.get("/ws", { websocket: true }, (socket: WebSocket, req: FastifyRequest) => {
    // Browsers do not apply CORS to WebSockets, so both checks happen here:
    // a hostile page could otherwise open a socket to a local ZTrade and watch
    // the operator's live trading feed.
    // Distinct close code from the auth rejection below: an origin problem is a
    // misconfiguration, and the client must not respond by discarding a token
    // that is perfectly valid.
    if (!isAllowedOrigin(req.headers.origin)) {
      logger.warn(
        `Rejected WebSocket from disallowed origin: ${req.headers.origin}. ` +
          `Add it to CORS_ORIGIN (currently: ${config.corsOrigins.join(", ")}).`,
      );
      socket.close(CLOSE_ORIGIN_REJECTED, "Origin not allowed");
      return;
    }

    if (!isAuthorised(req)) {
      audit(AuditAction.AUTH_FAILURE, "websocket auth rejected", actorOf(req));
      socket.close(1008, "Unauthorised");
      return;
    }

    const send = (event: ServerEvent): void => {
      if (socket.readyState !== socket.OPEN) return;
      socket.send(JSON.stringify(event));
    };

    send({ type: "status", payload: engine.getStatus() });
    send({
      type: "circuitBreaker",
      payload: circuitBreaker.getState(engine.getAccount()?.equity ?? 0),
    });

    const account = engine.getAccount();
    if (account) send({ type: "account", payload: account });
    send({ type: "position", payload: engine.getPrimaryPosition() });
    send({ type: "positions", payload: engine.getPositions() });

    for (const entry of recentLogs(50)) send({ type: "log", payload: entry });

    const unsubscribe = bus.onEvent(send);

    socket.on("close", unsubscribe);
    socket.on("error", unsubscribe);

    // The client sends "ping"; anything else is ignored rather than trusted.
    socket.on("message", (raw: Buffer) => {
      if (raw.toString() === "ping" && socket.readyState === socket.OPEN) {
        socket.send("pong");
      }
    });
  });
}
