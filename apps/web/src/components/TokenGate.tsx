import { useState } from "react";
import { api, UnauthorisedError } from "../lib/api";
import { setToken } from "../lib/auth";
import { Icon } from "./Shell";

/**
 * Token prompt shown when the API rejects us.
 *
 * The token is validated against the server before being stored, so a typo is
 * caught here rather than surfacing as a wall of failed requests behind the
 * dashboard.
 */
export function TokenGate({ onAuthenticated }: { onAuthenticated: () => void }) {
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);

  async function submit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    const token = value.trim();
    if (!token) return;

    setChecking(true);
    setError(null);
    setToken(token);

    try {
      await api.verifyToken();
      onAuthenticated();
    } catch (err) {
      setToken(null);
      setError(
        err instanceof UnauthorisedError
          ? "That token was rejected."
          : `Could not reach the server: ${(err as Error).message}`,
      );
    } finally {
      setChecking(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-4">
      <form onSubmit={submit} className="panel w-full max-w-md p-6">
        <div className="mb-1 font-mono text-lg font-bold text-primary">ZTrade</div>
        <p className="mb-5 font-mono text-[11px] uppercase tracking-widest text-on-surface-variant">
          Terminal access
        </p>

        <label className="field-label" htmlFor="api-token">
          API Token
        </label>
        <input
          id="api-token"
          type="password"
          autoFocus
          autoComplete="off"
          className="field"
          placeholder="paste the token printed by the server"
          value={value}
          onChange={(e) => setValue(e.target.value)}
        />

        {error && (
          <p className="mt-3 border border-error bg-error-container px-3 py-2 font-mono text-[11px] text-on-error-container">
            {error}
          </p>
        )}

        <button type="submit" className="btn-primary mt-5 w-full" disabled={checking}>
          <Icon name="key" className="text-[14px]" />
          {checking ? "Verifying…" : "Unlock"}
        </button>

        <p className="mt-4 font-mono text-[10px] leading-relaxed text-outline">
          The server prints this token on first start. Pin it by setting
          <code className="mx-1 text-on-surface-variant">ZTRADE_API_TOKEN</code>
          in <code className="text-on-surface-variant">.env</code>.
        </p>
      </form>
    </div>
  );
}
