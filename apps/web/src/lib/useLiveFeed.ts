import { useEffect, useRef, useState } from "react";
import type {
  AccountSnapshot,
  EngineStatus,
  LogEntry,
  Position,
  ServerEvent,
  Signal,
  Trade,
} from "@ztrade/shared";

export interface LiveFeed {
  connected: boolean;
  status: EngineStatus | null;
  account: AccountSnapshot | null;
  position: Position | null;
  signals: Signal[];
  trades: Trade[];
  logs: LogEntry[];
  latencyMs: number | null;
}

const MAX_SIGNALS = 30;
const MAX_TRADES = 20;
const MAX_LOGS = 300;
const RECONNECT_DELAY_MS = 2_000;

/** Newest-first insert that ignores ids already present. */
function prepend<T extends { id: string }>(prev: T[], item: T, max: number): T[] {
  if (prev.some((existing) => existing.id === item.id)) return prev;
  return [item, ...prev].slice(0, max);
}

/**
 * Single WebSocket subscription shared by the whole app.
 *
 * Reconnects on drop with a fixed delay — the server is a local process, so
 * exponential backoff would mostly add latency after a dev restart.
 */
export function useLiveFeed(): LiveFeed {
  const [connected, setConnected] = useState(false);
  const [status, setStatus] = useState<EngineStatus | null>(null);
  const [account, setAccount] = useState<AccountSnapshot | null>(null);
  const [position, setPosition] = useState<Position | null>(null);
  const [signals, setSignals] = useState<Signal[]>([]);
  const [trades, setTrades] = useState<Trade[]>([]);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [latencyMs, setLatencyMs] = useState<number | null>(null);

  const socketRef = useRef<WebSocket | null>(null);
  const reconnectRef = useRef<number | null>(null);
  // Survives StrictMode's double-invoke and prevents a reconnect after unmount.
  const closedByUs = useRef(false);

  useEffect(() => {
    closedByUs.current = false;

    const connect = (): void => {
      const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      const socket = new WebSocket(`${protocol}//${window.location.host}/ws`);
      socketRef.current = socket;

      socket.onopen = () => setConnected(true);

      socket.onclose = () => {
        setConnected(false);
        if (closedByUs.current) return;
        reconnectRef.current = window.setTimeout(connect, RECONNECT_DELAY_MS);
      };

      socket.onerror = () => socket.close();

      socket.onmessage = (event: MessageEvent<string>) => {
        if (event.data === "pong") return;

        let parsed: ServerEvent;
        try {
          parsed = JSON.parse(event.data) as ServerEvent;
        } catch {
          return;
        }

        switch (parsed.type) {
          case "status":
            setStatus(parsed.payload);
            break;
          case "account":
            setAccount(parsed.payload);
            break;
          case "position":
            setPosition(parsed.payload);
            break;
          // Every (re)connect replays the server's recent buffer, so appending
          // blindly would duplicate the whole history on each reconnect — and
          // twice on first paint under StrictMode's double-mount.
          case "signal":
            setSignals((prev) => prepend(prev, parsed.payload, MAX_SIGNALS));
            break;
          case "trade":
            setTrades((prev) => prepend(prev, parsed.payload, MAX_TRADES));
            break;
          case "log":
            setLogs((prev) =>
              prev.some((l) => l.id === parsed.payload.id)
                ? prev
                : [...prev, parsed.payload].slice(-MAX_LOGS),
            );
            break;
          case "heartbeat":
            setLatencyMs(parsed.payload.latencyMs);
            break;
        }
      };
    };

    connect();

    return () => {
      closedByUs.current = true;
      if (reconnectRef.current) window.clearTimeout(reconnectRef.current);
      socketRef.current?.close();
    };
  }, []);

  return { connected, status, account, position, signals, trades, logs, latencyMs };
}
