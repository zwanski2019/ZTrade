import WebSocket from "ws";
import type { SocketLike } from "./bybitWs.ts";

/**
 * Real `ws` transport.
 *
 * Kept deliberately thin and separate from BybitIngestion so the protocol
 * logic — gap recovery, staleness, validation — stays testable without a
 * network. Everything interesting lives on the other side of SocketLike.
 */
export function createWebSocket(url: string): SocketLike {
  const socket = new WebSocket(url);
  let pingTimer: NodeJS.Timeout | null = null;

  const stopPing = (): void => {
    if (pingTimer) clearInterval(pingTimer);
    pingTimer = null;
  };

  return {
    send: (data) => {
      if (socket.readyState === WebSocket.OPEN) socket.send(data);
    },
    close: () => {
      stopPing();
      socket.close();
    },
    onOpen: (handler) =>
      socket.on("open", () => {
        // Bybit closes an idle connection after 20s of silence.
        pingTimer = setInterval(() => {
          if (socket.readyState === WebSocket.OPEN) {
            socket.send(JSON.stringify({ op: "ping" }));
          }
        }, 15_000);
        pingTimer.unref?.();
        handler();
      }),
    onMessage: (handler) => socket.on("message", (data) => handler(data.toString())),
    onClose: (handler) =>
      socket.on("close", () => {
        stopPing();
        handler();
      }),
    onError: (handler) => socket.on("error", (err: Error) => handler(err)),
  };
}

export const BYBIT_WS_PUBLIC_MAINNET = "wss://stream.bybit.com/v5/public/linear";
export const BYBIT_WS_PUBLIC_TESTNET = "wss://stream-testnet.bybit.com/v5/public/linear";
