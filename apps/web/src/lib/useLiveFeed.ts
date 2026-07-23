import { useEffect, useRef, useState } from "react";
import type {
  AccountSnapshot,
  CircuitBreakerState,
  EngineStatus,
  LogEntry,
  Position,
  ServerEvent,
  Signal,
  Trade,
} from "@ztrade/shared";
import { getToken } from "./auth";

export interface LiveFeed {
  connected: boolean;
  /** True when the socket was closed because the token was rejected. */
  unauthorised: boolean;
  status: EngineStatus | null;
  account: AccountSnapshot | null;
  position: Position | null;
  positions: Position[];
  signals: Signal[];
  trades: Trade[];
  logs: LogEntry[];
  circuitBreaker: CircuitBreakerState | null;
  latencyMs: number | null;
}

const MAX_SIGNALS = 30;
const MAX_TRADES = 20;
const MAX_LOGS = 300;
const RECONNECT_DELAY_MS = 2_000;
/** RFC 6455 policy-violation code; the server uses it for auth/origin refusal. */
const CLOSE_POLICY_VIOLATION = 1008;
/** Matches CLOSE_ORIGIN_REJECTED on the server. */
const CLOSE_ORIGIN_REJECTED = 4403;

/** Newest-first insert that ignores ids already present. */
function prepend<T extends { id: string }>(prev: T[], item: T, max: number): T[] {
  if (prev.some((existing) => existing.id === item.id)) return prev;
  return [item, ...prev].slice(0, max);
}

/**
 * Single WebSocket subscription shared by the whole app.
 *
 * Reconnects on drop with a fixed delay — the server is a local process, so
 * exponential backoff would mostly add latency after a dev restart. An auth
 * rejection is NOT retried: hammering a rejected token would just fill the
 * audit log.
 */
export function useLiveFeed(token: string | null = getToken()): LiveFeed {
  const [connected, setConnected] = useState(false);
  const [unauthorised, setUnauthorised] = useState(false);
  const [status, setStatus] = useState<EngineStatus | null>(null);
  const [account, setAccount] = useState<AccountSnapshot | null>(null);
  const [position, setPosition] = useState<Position | null>(null);
  const [positions, setPositions] = useState<Position[]>([]);
  const [signals, setSignals] = useState<Signal[]>([]);
  const [trades, setTrades] = useState<Trade[]>([]);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [circuitBreaker, setCircuitBreaker] = useState<CircuitBreakerState | null>(null);
  const [latencyMs, setLatencyMs] = useState<number | null>(null);

  const socketRef = useRef<WebSocket | null>(null);
  const reconnectRef = useRef<number | null>(null);
  // Survives StrictMode's double-invoke and prevents a reconnect after unmount.
  const closedByUs = useRef(false);

  useEffect(() => {
    closedByUs.current = false;
    setUnauthorised(false);

    const connect = (): void => {
      const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      const suffix = token ? `?token=${encodeURIComponent(token)}` : "";
      const socket = new WebSocket(`${protocol}//${window.location.host}/ws${suffix}`);
      socketRef.current = socket;

      socket.onopen = () => setConnected(true);

      socket.onclose = (event) => {
        setConnected(false);
        if (closedByUs.current) return;

        if (event.code === CLOSE_POLICY_VIOLATION) {
          setUnauthorised(true);
          return; // Do not retry a rejected token.
        }
        if (event.code === CLOSE_ORIGIN_REJECTED) {
          // A server misconfiguration, not a bad token — say so instead of
          // silently throwing the operator back to the login screen.
          console.error(
            "ZTrade: the server rejected this page's origin. Add " +
              `${window.location.origin} to CORS_ORIGIN and restart the server.`,
          );
          return;
        }
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
          case "positions":
            setPositions(parsed.payload);
            break;
          case "circuitBreaker":
            setCircuitBreaker(parsed.payload);
            break;
          // Every (re)connect replays the server's recent buffer, so appending
          // blindly would duplicate the whole history on each reconnect — and
          // twice on first paint under StrictMode's double-mount.
          case "signal":
            setSignals((prev) => prepend(prev, parsed.payload, MAX_SIGNALS));
            break;
          case "trade":
            // A trade arrives twice: once on open, once on close. Replace the
            // existing row rather than showing the position twice.
            setTrades((prev) => {
              const without = prev.filter((t) => t.id !== parsed.payload.id);
              return [parsed.payload, ...without].slice(0, MAX_TRADES);
            });
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
  }, [token]);

  return {
    connected,
    unauthorised,
    status,
    account,
    position,
    positions,
    signals,
    trades,
    logs,
    circuitBreaker,
    latencyMs,
  };
}
