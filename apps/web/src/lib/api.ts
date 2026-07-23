import type {
  AuditEntry,
  BacktestResult,
  CircuitBreakerConfig,
  CircuitBreakerState,
  DashboardSnapshot,
  IntelSettings,
  MarketIntel,
  EngineStatus,
  EquityPoint,
  LogEntry,
  PerformanceStats,
  Position,
  Settings,
  StrategyConfig,
  SymbolStats,
  Trade,
  TradeStatus,
} from "@ztrade/shared";
import { getToken } from "./auth";

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/** Raised on 401 so the UI can prompt for the token instead of showing an error. */
export class UnauthorisedError extends ApiError {
  constructor(message: string) {
    super(message, 401);
    this.name = "UnauthorisedError";
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const token = getToken();

  const res = await fetch(path, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(init?.headers ?? {}),
    },
  });

  if (!res.ok) {
    let message = `${res.status} ${res.statusText}`;
    try {
      const body = (await res.json()) as { error?: string };
      if (body.error) message = body.error;
    } catch {
      // Non-JSON error body; the status line is the best we have.
    }
    if (res.status === 401) throw new UnauthorisedError(message);
    throw new ApiError(message, res.status);
  }

  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export interface TradeQueryParams {
  limit?: number;
  offset?: number;
  status?: TradeStatus | "All";
  search?: string;
  from?: number;
  to?: number;
}

// Takes `object` rather than Record<string, unknown> so plain interfaces (which
// have no index signature) can be passed without a cast.
function query(params: object): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") {
      search.set(key, String(value));
    }
  }
  const qs = search.toString();
  return qs ? `?${qs}` : "";
}

export const api = {
  /** Cheapest authenticated call — used to validate a freshly entered token. */
  verifyToken: () => request<EngineStatus>("/api/status"),

  dashboard: () => request<DashboardSnapshot>("/api/dashboard"),
  status: () => request<EngineStatus>("/api/status"),

  startEngine: () => request<EngineStatus>("/api/engine/start", { method: "POST" }),
  stopEngine: () => request<EngineStatus>("/api/engine/stop", { method: "POST" }),
  emergencyStop: () =>
    request<{ closed: number; status: EngineStatus }>("/api/engine/emergency-stop", {
      method: "POST",
      body: JSON.stringify({ confirm: "CLOSE_ALL" }),
    }),

  positions: () => request<{ exchange: Position[]; open: Trade[] }>("/api/positions"),
  closePosition: (symbol: string) =>
    request<{ ok: boolean }>(`/api/positions/${symbol}/close`, { method: "POST" }),

  circuitBreaker: () =>
    request<{ config: CircuitBreakerConfig; state: CircuitBreakerState }>(
      "/api/circuit-breaker",
    ),
  saveCircuitBreaker: (body: CircuitBreakerConfig) =>
    request<{ ok: boolean }>("/api/circuit-breaker", {
      method: "PUT",
      body: JSON.stringify(body),
    }),
  resetCircuitBreaker: () =>
    request<{ ok: boolean; state: CircuitBreakerState }>("/api/circuit-breaker/reset", {
      method: "POST",
    }),

  intel: () => request<{ intel: MarketIntel; settings: IntelSettings }>("/api/intel"),
  saveIntelSettings: (body: IntelSettings) =>
    request<{ ok: boolean }>("/api/intel/settings", {
      method: "PUT",
      body: JSON.stringify(body),
    }),

  strategies: () => request<StrategyConfig[]>("/api/strategies"),
  saveStrategy: (s: Omit<StrategyConfig, "updatedAt" | "id"> & { id?: string }) =>
    request<StrategyConfig>("/api/strategies", {
      method: "POST",
      body: JSON.stringify(s),
    }),
  activateStrategy: (id: string) =>
    request<{ ok: boolean }>(`/api/strategies/${id}/activate`, { method: "POST" }),
  deleteStrategy: (id: string) =>
    request<{ ok: boolean }>(`/api/strategies/${id}`, { method: "DELETE" }),
  backtest: (id: string, body: { interval?: string; candles?: number } = {}) =>
    request<BacktestResult>(`/api/strategies/${id}/backtest`, {
      method: "POST",
      body: JSON.stringify(body),
    }),

  trades: (params: TradeQueryParams = {}) =>
    request<{ trades: Trade[]; total: number }>(`/api/trades${query({ ...params })}`),
  stats: (params: { from?: number; to?: number } = {}) =>
    request<PerformanceStats>(`/api/stats${query(params)}`),
  symbolStats: (params: { from?: number; to?: number } = {}) =>
    request<SymbolStats[]>(`/api/stats/symbols${query(params)}`),
  equity: (params: { from?: number; to?: number } = {}) =>
    request<EquityPoint[]>(`/api/equity${query(params)}`),

  logs: (limit = 200) => request<LogEntry[]>(`/api/logs${query({ limit })}`),
  audit: (limit = 100) => request<AuditEntry[]>(`/api/audit${query({ limit })}`),
  summaryPreview: (hours = 24) =>
    request<{ text: string }>(`/api/summary/preview${query({ hours })}`),

  settings: () => request<Settings>("/api/settings"),
  saveTelegram: (body: unknown) =>
    request<{ ok: boolean }>("/api/settings/telegram", {
      method: "PUT",
      body: JSON.stringify(body),
    }),
  testTelegram: () =>
    request<{ ok: boolean }>("/api/settings/telegram/test", { method: "POST" }),
  saveUi: (body: { highContrast: boolean }) =>
    request<{ ok: boolean }>("/api/settings/ui", {
      method: "PUT",
      body: JSON.stringify(body),
    }),
  testExchange: () =>
    request<{ ok: boolean; latencyMs: number | null; reason?: string }>(
      "/api/settings/exchange/test",
      { method: "POST" },
    ),
};

/**
 * CSV export is a plain navigation, so it cannot carry an Authorization header.
 * The token rides as a query parameter instead — the same escape hatch the
 * server allows for the WebSocket handshake.
 */
export function exportCsvUrl(params: TradeQueryParams = {}): string {
  return `/api/trades/export.csv${query({ ...params, token: getToken() ?? undefined })}`;
}
