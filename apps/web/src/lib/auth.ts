/**
 * API token storage.
 *
 * Kept in localStorage so the operator does not re-enter it on every reload.
 * That does expose it to any script running on this origin — acceptable here
 * because the app loads no third-party code and a strict CSP is served, but it
 * is the reason the token is scoped to this one service rather than being an
 * exchange credential.
 */
const STORAGE_KEY = "ztrade.apiToken";

let cached: string | null = null;

export function getToken(): string | null {
  if (cached !== null) return cached;
  try {
    cached = window.localStorage.getItem(STORAGE_KEY);
  } catch {
    // Storage can be blocked (private mode, embedded contexts); fall back to
    // keeping the token in memory for this session only.
    cached = null;
  }
  return cached;
}

export function setToken(token: string | null): void {
  cached = token;
  try {
    if (token) window.localStorage.setItem(STORAGE_KEY, token);
    else window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Non-fatal: the in-memory copy still works for this session.
  }
}

export function hasToken(): boolean {
  return Boolean(getToken());
}
