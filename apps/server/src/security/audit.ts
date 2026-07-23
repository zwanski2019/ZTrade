import type { FastifyRequest } from "fastify";
import { listAudit, recordAudit } from "../db.js";
import { logger } from "../bus.js";

/**
 * Append-only record of money- and security-relevant actions.
 *
 * Separate from the rolling log buffer on purpose: logs are a fixed-size ring
 * held in memory and are meant to be disposable, whereas "who stopped the bot
 * and when" needs to survive a restart.
 */
export const AuditAction = {
  ENGINE_START: "engine.start",
  ENGINE_STOP: "engine.stop",
  EMERGENCY_STOP: "engine.emergency_stop",
  CIRCUIT_BREAKER_TRIP: "engine.circuit_breaker_trip",
  CIRCUIT_BREAKER_RESET: "engine.circuit_breaker_reset",
  STRATEGY_SAVE: "strategy.save",
  STRATEGY_ACTIVATE: "strategy.activate",
  STRATEGY_DELETE: "strategy.delete",
  POSITION_CLOSE: "position.close",
  SETTINGS_UPDATE: "settings.update",
  AUTH_FAILURE: "auth.failure",
} as const;

/** Client IP, honouring the proxy header only when one is actually present. */
export function actorOf(req: FastifyRequest): string {
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded.length > 0) {
    return forwarded.split(",")[0]!.trim();
  }
  return req.ip ?? "unknown";
}

export function audit(action: string, detail: string, actor: string | null = null): void {
  recordAudit(action, detail, actor);
  logger.info(`AUDIT ${action}: ${detail}${actor ? ` (${actor})` : ""}`);
}

export function auditFromRequest(
  req: FastifyRequest,
  action: string,
  detail: string,
): void {
  audit(action, detail, actorOf(req));
}

export { listAudit };
