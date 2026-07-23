import { useCallback, useEffect, useState } from "react";
import { BrowserRouter, Route, Routes } from "react-router-dom";
import { Shell } from "./components/Shell";
import { TokenGate } from "./components/TokenGate";
import { Dashboard } from "./pages/Dashboard";
import { StrategyConfigPage } from "./pages/StrategyConfig";
import { TradeHistory } from "./pages/TradeHistory";
import { SettingsPage } from "./pages/SettingsPage";
import { System } from "./pages/System";
import { useLiveFeed } from "./lib/useLiveFeed";
import { getToken } from "./lib/auth";
import { api, UnauthorisedError } from "./lib/api";

type AuthState = "checking" | "authenticated" | "required";

export function App() {
  const [auth, setAuth] = useState<AuthState>("checking");
  const [token, setTokenState] = useState<string | null>(getToken());

  // Probe once on load: the server may have auth disabled entirely, in which
  // case we should never show the gate.
  useEffect(() => {
    let cancelled = false;

    api
      .verifyToken()
      .then(() => !cancelled && setAuth("authenticated"))
      .catch((err) => {
        if (cancelled) return;
        setAuth(err instanceof UnauthorisedError ? "required" : "authenticated");
      });

    return () => {
      cancelled = true;
    };
  }, []);

  const onAuthenticated = useCallback(() => {
    setTokenState(getToken());
    setAuth("authenticated");
  }, []);

  if (auth === "checking") {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background font-mono text-xs text-on-surface-variant">
        Connecting to terminal…
      </div>
    );
  }

  if (auth === "required") return <TokenGate onAuthenticated={onAuthenticated} />;

  return <AuthenticatedApp token={token} onUnauthorised={() => setAuth("required")} />;
}

function AuthenticatedApp({
  token,
  onUnauthorised,
}: {
  token: string | null;
  onUnauthorised: () => void;
}) {
  // One socket for the whole app; every screen reads from this feed.
  const feed = useLiveFeed(token);

  // The token can be revoked while the app is open (server restart with a new
  // generated token, for instance) — fall back to the gate rather than sitting
  // on a dead socket.
  useEffect(() => {
    if (feed.unauthorised) onUnauthorised();
  }, [feed.unauthorised, onUnauthorised]);

  return (
    <BrowserRouter>
      <Routes>
        <Route element={<Shell feed={feed} />}>
          <Route index element={<Dashboard feed={feed} />} />
          <Route path="strategy" element={<StrategyConfigPage />} />
          <Route path="history" element={<TradeHistory />} />
          <Route path="settings" element={<SettingsPage feed={feed} />} />
          <Route path="system" element={<System />} />
          <Route
            path="*"
            element={
              <div className="panel p-8 text-center font-mono text-sm text-on-surface-variant">
                Screen not found.
              </div>
            }
          />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}
