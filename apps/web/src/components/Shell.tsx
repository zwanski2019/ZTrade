import { NavLink, Outlet } from "react-router-dom";
import type { AccountSnapshot, EngineStatus } from "@ztrade/shared";
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

interface ShellProps {
  status: EngineStatus | null;
  account: AccountSnapshot | null;
  connected: boolean;
}

export function Shell({ status, account, connected }: ShellProps) {
  const exchangeOnline = Boolean(status?.exchangeConnected);
  const network = status?.network ?? "TESTNET";

  return (
    <div className="flex min-h-screen bg-background">
      {/* Sidebar — desktop only */}
      <aside className="hidden w-56 shrink-0 flex-col border-r border-outline-variant bg-surface-container-lowest lg:flex">
        <div className="border-b border-outline-variant px-5 py-5">
          <div className="font-mono text-lg font-bold tracking-tight text-primary">
            ZTrade
          </div>
          <div className="mt-1 font-mono text-[10px] uppercase tracking-widest text-outline">
            v0.1.0-dev
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

        <div className="border-t border-outline-variant p-4">
          <NetworkBadge network={network} />
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
                exchangeOnline ? "bg-primary animate-pulse-dot" : "bg-error",
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
            <div className="lg:hidden">
              <NetworkBadge network={network} />
            </div>
          </div>
        </header>

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
      title={
        isMainnet
          ? "Trading against REAL funds"
          : "Testnet — no real funds at risk"
      }
    >
      <Icon name={isMainnet ? "warning" : "science"} className="text-[12px]" />
      {network}
    </span>
  );
}
