import type { OrderEvent } from "@ztrade/execution";
import type { SocketLike, SocketFactory } from "@ztrade/ingestion";
import {
  executionMessageSchema,
  orderMessageSchema,
  positionMessageSchema,
  walletMessageSchema,
  parseWith,
} from "@ztrade/ingestion";
import { deadMansSwitchPayload, wsAuthPayload } from "@ztrade/security";
import { executionToEvent, orderUpdateToEvent } from "./accountEvents.ts";

/**
 * Bybit v5 PRIVATE WebSocket — the account stream (§4.1, gate #2).
 *
 * This is where order truth actually enters the system. The REST adapter only
 * ever tells us "the venue accepted the request"; the fills, cancels and
 * rejections all arrive here.
 *
 * The connect sequence is strict and its ORDER matters for safety:
 *
 *   1. authenticate
 *   2. arm the dead-man's switch (set_dcp) — BEFORE anything can be traded, so
 *      that from the very first order onward, a dropped connection auto-cancels
 *      our exposure at the venue (gate #2)
 *   3. subscribe to order / execution / position / wallet
 *
 * On every reconnect the whole sequence repeats, because a re-established
 * socket has NOT inherited the previous connection's dead-man arming — the
 * venue tied it to the connection that dropped.
 */
export type ConnectionState = "DISCONNECTED" | "CONNECTING" | "AUTHENTICATING" | "READY" | "ERROR";

export interface PrivateWsConfig {
  url: string;
  apiKey: string;
  apiSecret: string;
  socketFactory: SocketFactory;
  /** Feeds translated order/execution events to the broker. */
  onAccountEvent: (orderLinkId: string, event: OrderEvent, at: number) => void;
  /** Latest net position per symbol, from the position stream. */
  onPosition?: (symbol: string, size: number, side: string) => void;
  onWallet?: (equity: number, available: number) => void;
  onLog?: (level: "info" | "warn" | "error", message: string) => void;
  now?: () => number;
  /** Dead-man window in seconds. Bybit accepts 10..300; clamped by the builder. */
  deadMansWindowSec?: number;
  reconnectDelayMs?: number;
  /** Auth signature validity window. */
  authWindowMs?: number;
}

export const BYBIT_WS_PRIVATE = {
  MAINNET: "wss://stream.bybit.com/v5/private",
  TESTNET: "wss://stream-testnet.bybit.com/v5/private",
} as const;

export class BybitPrivateWs {
  private socket: SocketLike | null = null;
  private state: ConnectionState = "DISCONNECTED";
  private stopped = false;
  /** Set when the venue rejects auth — the same credentials will just fail again. */
  private authRejected = false;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private readonly now: () => number;

  readonly stats = {
    reconnects: 0,
    authFailures: 0,
    deadMansArmed: 0,
    orderEvents: 0,
    executions: 0,
    invalid: 0,
  };

  constructor(private readonly config: PrivateWsConfig) {
    this.now = config.now ?? (() => Date.now());
  }

  get connectionState(): ConnectionState {
    return this.state;
  }

  get isReady(): boolean {
    return this.state === "READY";
  }

  start(): void {
    this.stopped = false;
    this.authRejected = false;
    this.open();
  }

  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.socket?.close();
    this.socket = null;
    this.state = "DISCONNECTED";
  }

  private log(level: "info" | "warn" | "error", message: string): void {
    this.config.onLog?.(level, message);
  }

  private open(): void {
    this.state = "CONNECTING";
    const socket = this.config.socketFactory(this.config.url);
    this.socket = socket;

    socket.onOpen(() => this.authenticate());
    socket.onMessage((data) => this.handleMessage(data));
    socket.onClose(() => {
      // A rejected auth stays ERROR and does NOT reconnect: retrying the same
      // credentials would spin, hammer the venue and fill the audit log. An
      // operator fixing the key restarts the process.
      if (this.authRejected) {
        this.state = "ERROR";
        return;
      }
      // A dropped private connection means the dead-man arming is gone with it —
      // which is the whole point of the dead-man switch. The venue will auto
      // cancel; we reconnect and re-arm.
      this.state = "DISCONNECTED";
      this.log("warn", "Private WS closed");
      this.scheduleReconnect();
    });
    socket.onError((err) => {
      this.state = "ERROR";
      this.log("error", `Private WS error: ${err.message}`);
      socket.close();
    });
  }

  private authenticate(): void {
    this.state = "AUTHENTICATING";
    const expires = this.now() + (this.config.authWindowMs ?? 10_000);
    const payload = wsAuthPayload(this.config.apiKey, this.config.apiSecret, expires);
    this.send(payload);
    this.log("info", "Private WS authenticating");
  }

  private armDeadMansSwitch(): void {
    // Sent BEFORE the subscribe, so it is in place before any fill can occur.
    const payload = deadMansSwitchPayload(this.config.deadMansWindowSec ?? 15);
    this.send(payload);
    this.stats.deadMansArmed += 1;
    this.log("info", `Dead-man's switch armed (window ${payload.args[0].timeWindow}s)`);
  }

  private subscribe(): void {
    this.send({ op: "subscribe", args: ["order", "execution", "position", "wallet"] });
    this.state = "READY";
    this.log("info", "Private WS ready — subscribed to order/execution/position/wallet");
  }

  private send(payload: unknown): void {
    if (!this.socket) return;
    this.socket.send(JSON.stringify(payload));
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.stats.reconnects += 1;
      this.open();
    }, this.config.reconnectDelayMs ?? 2_000);
    this.reconnectTimer.unref?.();
  }

  private handleMessage(raw: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      this.stats.invalid += 1;
      return;
    }

    const msg = parsed as { op?: string; success?: boolean; topic?: string; ret_msg?: string };

    // --- control frames ---
    if (msg.op === "auth") {
      if (msg.success) {
        // Auth succeeded: arm the dead-man switch, THEN subscribe. Order matters.
        this.armDeadMansSwitch();
        this.subscribe();
      } else {
        this.stats.authFailures += 1;
        this.authRejected = true;
        this.state = "ERROR";
        this.log("error", `Private WS auth rejected: ${msg.ret_msg ?? "unknown"}`);
        // Not retryable on the same credentials. Marking authRejected stops the
        // close handler below from scheduling a reconnect.
        this.socket?.close();
      }
      return;
    }
    if (msg.op === "subscribe" || msg.op === "set_dcp" || msg.op === "pong" || msg.op === "ping") {
      return;
    }

    // --- data frames ---
    if (msg.topic === "order") return this.handleOrder(parsed);
    if (msg.topic === "execution") return this.handleExecution(parsed);
    if (msg.topic === "position") return this.handlePosition(parsed);
    if (msg.topic === "wallet") return this.handleWallet(parsed);
  }

  private handleOrder(raw: unknown): void {
    const parsed = parseWith(orderMessageSchema, raw);
    if (!parsed.ok) {
      this.stats.invalid += 1;
      return;
    }
    for (const o of parsed.value.data) {
      const translated = orderUpdateToEvent({
        orderLinkId: o.orderLinkId,
        orderId: o.orderId,
        orderStatus: o.orderStatus,
        updatedTime: Number(o.updatedTime ?? this.now()),
      });
      if (translated) {
        this.stats.orderEvents += 1;
        this.config.onAccountEvent(translated.orderLinkId, translated.event, translated.at);
      }
    }
  }

  private handleExecution(raw: unknown): void {
    const parsed = parseWith(executionMessageSchema, raw);
    if (!parsed.ok) {
      this.stats.invalid += 1;
      return;
    }
    for (const e of parsed.value.data) {
      const translated = executionToEvent({
        orderLinkId: e.orderLinkId,
        execQty: e.execQty,
        execPrice: e.execPrice,
        execFee: e.execFee,
        isMaker: e.isMaker,
        execTime: Number(e.execTime),
      });
      this.stats.executions += 1;
      this.config.onAccountEvent(translated.orderLinkId, translated.event, translated.at);
    }
  }

  private handlePosition(raw: unknown): void {
    const parsed = parseWith(positionMessageSchema, raw);
    if (!parsed.ok) {
      this.stats.invalid += 1;
      return;
    }
    for (const p of parsed.value.data) {
      this.config.onPosition?.(p.symbol, p.size, p.side);
    }
  }

  private handleWallet(raw: unknown): void {
    const parsed = parseWith(walletMessageSchema, raw);
    if (!parsed.ok) {
      this.stats.invalid += 1;
      return;
    }
    const account = parsed.value.data[0];
    if (account) {
      this.config.onWallet?.(account.totalEquity ?? 0, account.totalAvailableBalance ?? 0);
    }
  }
}
