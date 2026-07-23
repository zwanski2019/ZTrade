import type { FastifyInstance } from "fastify";
import type { WebSocket } from "ws";
import type { ServerEvent } from "@ztrade/shared";
import { bus, recentLogs } from "../bus.js";
import { engine } from "../engine/engine.js";

/**
 * Live channel powering the dashboard's heartbeat, signal feed and log stream.
 *
 * Each socket gets a replay of current state on connect, so the UI renders
 * immediately rather than waiting for the first tick.
 */
export async function registerWebsocketRoutes(app: FastifyInstance): Promise<void> {
  app.get("/ws", { websocket: true }, (socket: WebSocket) => {
    const send = (event: ServerEvent): void => {
      if (socket.readyState !== socket.OPEN) return;
      socket.send(JSON.stringify(event));
    };

    send({ type: "status", payload: engine.getStatus() });

    const account = engine.getAccount();
    if (account) send({ type: "account", payload: account });
    send({ type: "position", payload: engine.getPrimaryPosition() });

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
