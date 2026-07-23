import type { FastifyReply, FastifyRequest } from "fastify";
import { config } from "../config.js";
import { getSetting, setSetting } from "../db.js";
import { generateToken, safeCompare } from "./crypto.js";

const TOKEN_SETTING_KEY = "api_token";

/**
 * Resolves the API token.
 *
 * Precedence: ZTRADE_API_TOKEN, then a token generated on first run and kept in
 * the settings table. Generating one automatically means the API is never
 * accidentally left open just because the operator did not set an env var —
 * the token is printed once at startup so it can be copied into the UI.
 */
let cachedToken: string | null = null;

export function apiToken(): string {
  if (cachedToken) return cachedToken;

  if (config.security.apiToken) {
    cachedToken = config.security.apiToken;
    return cachedToken;
  }

  const stored = getSetting<string | null>(TOKEN_SETTING_KEY, null);
  if (stored) {
    cachedToken = stored;
    return cachedToken;
  }

  const fresh = generateToken();
  setSetting(TOKEN_SETTING_KEY, fresh);
  cachedToken = fresh;
  return fresh;
}

/** True when the token was generated rather than supplied via .env. */
export function tokenWasGenerated(): boolean {
  return !config.security.apiToken;
}

/** Passphrase for encrypting stored secrets; distinct from the API token when set. */
export function secretKey(): string {
  return config.security.secretKey ?? apiToken();
}

function extractToken(req: FastifyRequest): string | null {
  const header = req.headers.authorization;
  if (typeof header === "string" && header.startsWith("Bearer ")) {
    return header.slice("Bearer ".length).trim();
  }

  // The browser cannot set headers on a WebSocket handshake, so the token may
  // also arrive as a query parameter on /ws.
  const query = req.query as Record<string, unknown> | undefined;
  const fromQuery = query?.token;
  return typeof fromQuery === "string" && fromQuery.length > 0 ? fromQuery : null;
}

export function isAuthorised(req: FastifyRequest): boolean {
  if (!config.security.authEnabled) return true;

  const presented = extractToken(req);
  if (!presented) return false;
  return safeCompare(presented, apiToken());
}

/** Paths reachable without a token: liveness, and the auth probe itself. */
const PUBLIC_PATHS = new Set(["/api/health"]);

export async function authHook(
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  if (!config.security.authEnabled) return;

  // Strip the query string before matching so `?token=` cannot smuggle a path.
  const path = req.url.split("?")[0] ?? "";
  if (PUBLIC_PATHS.has(path)) return;

  if (!isAuthorised(req)) {
    await reply.code(401).send({
      error: "Unauthorised. Supply the API token as 'Authorization: Bearer <token>'.",
    });
  }
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

/**
 * Canonicalises loopback origins so that http://localhost:5173 and
 * http://127.0.0.1:5173 are treated as the same place.
 *
 * They genuinely are — but a browser reports whichever the operator typed, so
 * a literal string match rejects the socket for what looks like no reason and
 * bounces them back to the login screen. Only loopback is collapsed this way;
 * every other host still has to match exactly.
 */
function canonicalOrigin(origin: string): string {
  try {
    const url = new URL(origin);
    if (LOOPBACK_HOSTS.has(url.hostname)) {
      return `${url.protocol}//loopback:${url.port}`;
    }
    return `${url.protocol}//${url.host}`;
  } catch {
    return origin;
  }
}

/**
 * Rejects cross-origin WebSocket handshakes.
 *
 * Browsers do not apply CORS to WebSockets, so without this check any website
 * the operator visits could open a socket to a locally-running ZTrade and read
 * the live trade feed.
 */
export function isAllowedOrigin(origin: string | undefined): boolean {
  // Non-browser clients (curl, tests) send no Origin at all.
  if (!origin) return true;

  const wanted = canonicalOrigin(origin);
  return config.corsOrigins.some((allowed) => canonicalOrigin(allowed) === wanted);
}
