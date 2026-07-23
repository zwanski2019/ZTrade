import type {
  BacktestResult,
  DashboardSnapshot,
  EngineStatus,
  EquityPoint,
  LogEntry,
  PerformanceStats,
  Settings,
  StrategyConfig,
  Trade,
  TradeStatus,
} from "@ztrade/shared";

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
    ...init,
  });

  if (!res.ok) {
    let message = `${res.status} ${res.statusText}`;
    try {
      const body = (await res.json()) as { error?: string };
      if (body.error) message = body.error;
    } catch {
      // Non-JSON error body; the status line is the best we have.
    }
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
  dashboard: () => request<DashboardSnapshot>("/api/dashboard"),
  status: () => request<EngineStatus>("/api/status"),

  startEngine: () => request<EngineStatus>("/api/engine/start", { method: "POST" }),
  stopEngine: () => request<EngineStatus>("/api/engine/stop", { method: "POST" }),
  emergencyStop: () =>
    request<{ closed: number; status: EngineStatus }>("/api/engine/emergency-stop", {
      method: "POST",
      body: JSON.stringify({ confirm: "CLOSE_ALL" }),
    }),

  strategies: () => request<StrategyConfig[]>("/api/strategies"),
  saveStrategy: (s: Omit<StrategyConfig, "updatedAt">) =>
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
  equity: (params: { from?: number; to?: number } = {}) =>
    request<EquityPoint[]>(`/api/equity${query(params)}`),
  exportCsvUrl: (params: TradeQueryParams = {}) => `/api/trades/export.csv${query(params)}`,

  logs: (limit = 200) => request<LogEntry[]>(`/api/logs${query({ limit })}`),

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
