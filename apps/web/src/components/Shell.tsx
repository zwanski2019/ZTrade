import { NavLink, Outlet } from "react-router-dom";
import type { LiveFeed } from "../lib/useLiveFeed";
import { pct, usd } from "../lib/format";

interface NavItem {
  to: string;
  icon: string;
  label: string;
}

const PRIMARY_NAV: NavItem[] = [
  { to: "/", icon: "dashboard", label: "Dashboard" },
  { to: "/strategy", icon: "psychology", label: "Strategies" },
  { to: "/history", icon: "history", label: "History" },
  { to: "/settings", icon: "settings", label: "Settings" },
  { to: "/system", icon: "monitoring", label: "System" },
];

/** Bottom bar on mobile, mirroring the mobile design variants. */
const MOBILE_NAV: NavItem[] = [
  { to: "/", icon: "home", label: "Home" },
  { to: "/history", icon: "query_stats", label: "Trade" },
  { to: "/settings", icon: "code", label: "Logs" },
  { to: "/strategy", icon: "tune", label: "Config" },
];

export function Icon({ name, className = "" }: { name: string; className?: string }) {
  return (
    <span aria-hidden="true" className={`material-symbols-outlined ${className}`}>
      {name}
    </span>
  );
}

export function Shell({ feed }: { feed: LiveFeed }) {
  const { status, account, connected, circuitBreaker } = feed;
  const exchangeOnline = Boolean(status?.exchangeConnected);
  const network = status?.network ?? "TESTNET";
  const paper = status ? !status.tradingEnabled : true;
  const breaker = circuitBreaker ?? status?.circuitBreaker ?? null;

  return (
    <div className="flex min-h-screen bg-background">
      {/* Sidebar — desktop only */}
      <aside className="hidden w-56 shrink-0 flex-col border-r border-outline-variant bg-surface-container-lowest lg:flex">
        <div className="border-b border-outline-variant px-5 py-5">
          <div className="font-mono text-lg font-bold tracking-tight text-primary">
            ZTrade
          </div>
          <div className="mt-1 font-mono text-[10px] uppercase tracking-widest text-outline">
            v0.2.0-dev
          </div>
        </div>

        <nav className="flex flex-1 flex-col gap-1 p-3">
          {PRIMARY_NAV.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.to === "/"}
              className={({ isActive }) =>
                [
                  "flex items-center gap-3 px-3 py-2.5 font-mono text-xs uppercase tracking-wider transition-colors",
                  isActive
                    ? "border-l-2 border-primary bg-surface-container text-primary"
                    : "border-l-2 border-transparent text-on-surface-variant hover:bg-surface-container-low hover:text-on-surface",
                ].join(" ")
              }
            >
              <Icon name={item.icon} className="text-[18px]" />
              {item.label}
            </NavLink>
          ))}
        </nav>

        <div className="flex flex-col gap-2 border-t border-outline-variant p-4">
          <NetworkBadge network={network} />
          <ModeBadge paper={paper} />
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        {/* Status header */}
        <header className="sticky top-0 z-20 flex flex-wrap items-center gap-x-5 gap-y-2 border-b border-outline-variant bg-surface-container-lowest px-4 py-3">
          <div className="flex items-center gap-2 font-mono text-lg font-bold text-primary lg:hidden">
            ZTrade
          </div>

          <div className="flex items-center gap-2">
            <span
              className={[
                "h-2 w-2 rounded-full",
                exchangeOnline ? "animate-pulse-dot bg-primary" : "bg-error",
              ].join(" ")}
            />
            <span className="font-mono text-xs text-on-surface-variant">
              Bybit:{" "}
              <span className={exchangeOnline ? "text-primary" : "text-error"}>
                {exchangeOnline ? "Connected" : "Offline"}
              </span>
            </span>
          </div>

          <div className="font-mono text-xs text-on-surface-variant">
            Balance:{" "}
            <span className="metric text-on-surface">
              {account ? usd(account.equity) : "—"}
            </span>
          </div>

          <div className="font-mono text-xs text-on-surface-variant">
            P&amp;L:{" "}
            <span
              className={[
                "metric",
                (account?.pnlPct ?? 0) >= 0 ? "text-primary" : "text-error",
              ].join(" ")}
            >
              {account ? pct(account.pnlPct) : "—"}
            </span>
          </div>

          <div className="ml-auto flex items-center gap-3">
            <span
              className="font-mono text-[10px] uppercase tracking-widest text-outline"
              title={connected ? "Live feed connected" : "Live feed disconnected"}
            >
              {connected ? "● LIVE" : "○ OFFLINE"}
            </span>
            <div className="flex items-center gap-2 lg:hidden">
              <ModeBadge paper={paper} />
              <NetworkBadge network={network} />
            </div>
          </div>
        </header>

        {/* Halting the bot is important enough to sit above every screen. */}
        {breaker?.tripped && (
          <div className="flex flex-wrap items-center gap-2 border-b border-error bg-error-container px-4 py-2.5 font-mono text-xs text-on-error-container">
            <Icon name="block" className="text-[16px]" />
            <span className="font-semibold">CIRCUIT BREAKER TRIPPED</span>
            <span>— {breaker.reason}</span>
            {breaker.resumeAt && (
              <span className="text-[11px] opacity-80">
                resumes {new Date(breaker.resumeAt).toLocaleTimeString("en-GB", { hour12: false })}
              </span>
            )}
          </div>
        )}

        <main className="flex-1 p-4 pb-24 lg:p-6 lg:pb-6">
          <Outlet />
        </main>
      </div>

      {/* Bottom nav — mobile only */}
      <nav className="fixed inset-x-0 bottom-0 z-30 grid grid-cols-4 border-t border-outline-variant bg-surface-container-lowest lg:hidden">
        {MOBILE_NAV.map((item) => (
          <NavLink
            key={item.label}
            to={item.to}
            end={item.to === "/"}
            className={({ isActive }) =>
              [
                "flex flex-col items-center gap-1 py-2.5 font-mono text-[10px] uppercase tracking-wider transition-colors",
                isActive ? "text-primary" : "text-on-surface-variant",
              ].join(" ")
            }
          >
            <Icon name={item.icon} className="text-[20px]" />
            {item.label}
          </NavLink>
        ))}
      </nav>
    </div>
  );
}

function NetworkBadge({ network }: { network: string }) {
  const isMainnet = network === "MAINNET";
  return (
    <span
      className={[
        "inline-flex items-center gap-1.5 border px-2 py-1 font-mono text-[10px] font-bold uppercase tracking-widest",
        isMainnet
          ? "border-error bg-error-container text-on-error-container"
          : "border-outline-variant text-on-surface-variant",
      ].join(" ")}
      title={isMainnet ? "Trading against REAL funds" : "Testnet — no real funds at risk"}
    >
      <Icon name={isMainnet ? "warning" : "science"} className="text-[12px]" />
      {network}
    </span>
  );
}

/**
 * Paper vs live is the single most important thing to get wrong, so it is
 * always on screen rather than buried in Settings.
 */
function ModeBadge({ paper }: { paper: boolean }) {
  return (
    <span
      className={[
        "inline-flex items-center gap-1.5 border px-2 py-1 font-mono text-[10px] font-bold uppercase tracking-widest",
        paper
          ? "border-outline-variant text-on-surface-variant"
          : "border-secondary-container text-secondary-container",
      ].join(" ")}
      title={
        paper
          ? "Paper mode — fills are simulated, no orders are sent"
          : "Live orders are being sent to the exchange"
      }
    >
      <Icon name={paper ? "draw" : "bolt"} className="text-[12px]" />
      {paper ? "Paper" : "Live"}
    </span>
  );
}
