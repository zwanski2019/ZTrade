import { BrowserRouter, Route, Routes } from "react-router-dom";
import { Shell } from "./components/Shell";
import { Dashboard } from "./pages/Dashboard";
import { StrategyConfigPage } from "./pages/StrategyConfig";
import { TradeHistory } from "./pages/TradeHistory";
import { SettingsPage } from "./pages/SettingsPage";
import { useLiveFeed } from "./lib/useLiveFeed";

export function App() {
  // One socket for the whole app; every screen reads from this feed.
  const feed = useLiveFeed();

  return (
    <BrowserRouter>
      <Routes>
        <Route
          element={
            <Shell status={feed.status} account={feed.account} connected={feed.connected} />
          }
        >
          <Route index element={<Dashboard feed={feed} />} />
          <Route path="strategy" element={<StrategyConfigPage />} />
          <Route path="history" element={<TradeHistory />} />
          <Route path="settings" element={<SettingsPage feed={feed} />} />
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
