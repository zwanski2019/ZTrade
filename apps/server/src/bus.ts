import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import type { LogEntry, LogLevel, ServerEvent } from "@ztrade/shared";

/**
 * Single in-process fan-out point. The engine publishes; the WebSocket route
 * and the Telegram notifier subscribe. Keeping this typed stops the two ends
 * from drifting.
 */
class Bus extends EventEmitter {
  emitEvent(event: ServerEvent): void {
    this.emit("event", event);
  }

  onEvent(listener: (event: ServerEvent) => void): () => void {
    this.on("event", listener);
    return () => this.off("event", listener);
  }
}

export const bus = new Bus();
// The dashboard, the log stream and the notifier all attach; the default cap of
// 10 is a warning we do not need.
bus.setMaxListeners(64);

/**
 * Rolling in-memory log buffer backing the SYSTEM_LOGS_STREAM panel.
 * Deliberately not persisted: logs are diagnostic, and an unbounded log table
 * is the fastest way to bloat the trade database.
 */
const MAX_LOG_ENTRIES = 500;
const buffer: LogEntry[] = [];

export function log(level: LogLevel, message: string): LogEntry {
  const entry: LogEntry = { id: randomUUID(), at: Date.now(), level, message };

  buffer.push(entry);
  if (buffer.length > MAX_LOG_ENTRIES) buffer.shift();

  const line = `[${new Date(entry.at).toISOString()}] ${level}: ${message}`;
  if (level === "ERROR") console.error(line);
  else if (level === "WARN") console.warn(line);
  else console.log(line);

  bus.emitEvent({ type: "log", payload: entry });
  return entry;
}

export const logger = {
  info: (m: string) => log("INFO", m),
  warn: (m: string) => log("WARN", m),
  error: (m: string) => log("ERROR", m),
  trade: (m: string) => log("TRADE", m),
};

export function recentLogs(limit = 200): LogEntry[] {
  return buffer.slice(-limit);
}
