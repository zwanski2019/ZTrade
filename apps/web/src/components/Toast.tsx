import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Icon } from "./Shell";

/**
 * Toast notifications.
 *
 * Replaces the inline "notice" strips that were scattered across every screen.
 * Two behaviours are deliberate:
 *
 *   - Errors do NOT auto-dismiss. On a trading screen an error you missed is an
 *     error you will rediscover through your P&L.
 *   - Toasts are announced to screen readers via an aria-live region, because
 *     "your order was rejected" is not decorative.
 */
export type ToastKind = "success" | "error" | "info" | "warning";

export interface Toast {
  id: string;
  kind: ToastKind;
  message: string;
  detail?: string;
}

interface ToastApi {
  push(kind: ToastKind, message: string, detail?: string): void;
  success(message: string, detail?: string): void;
  error(message: string, detail?: string): void;
  info(message: string, detail?: string): void;
  warning(message: string, detail?: string): void;
  dismiss(id: string): void;
}

const ToastContext = createContext<ToastApi | null>(null);

const AUTO_DISMISS_MS: Record<ToastKind, number | null> = {
  success: 4_000,
  info: 5_000,
  warning: 8_000,
  error: null, // sticky — see above
};

const MAX_VISIBLE = 4;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const timers = useRef(new Map<string, number>());
  const counter = useRef(0);

  const dismiss = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
    const timer = timers.current.get(id);
    if (timer) {
      window.clearTimeout(timer);
      timers.current.delete(id);
    }
  }, []);

  const push = useCallback(
    (kind: ToastKind, message: string, detail?: string) => {
      // Deterministic id rather than Math.random, so React keys are stable.
      const id = `t${counter.current++}`;
      setToasts((prev) => [...prev, { id, kind, message, detail }].slice(-MAX_VISIBLE));

      const ttl = AUTO_DISMISS_MS[kind];
      if (ttl !== null) {
        timers.current.set(id, window.setTimeout(() => dismiss(id), ttl));
      }
    },
    [dismiss],
  );

  // Clear pending timers on unmount so a dismissed toast cannot fire late.
  useEffect(() => {
    const pending = timers.current;
    return () => {
      for (const timer of pending.values()) window.clearTimeout(timer);
      pending.clear();
    };
  }, []);

  const api = useMemo<ToastApi>(
    () => ({
      push,
      dismiss,
      success: (m, d) => push("success", m, d),
      error: (m, d) => push("error", m, d),
      info: (m, d) => push("info", m, d),
      warning: (m, d) => push("warning", m, d),
    }),
    [push, dismiss],
  );

  return (
    <ToastContext.Provider value={api}>
      {children}
      <ToastViewport toasts={toasts} onDismiss={dismiss} />
    </ToastContext.Provider>
  );
}

export function useToast(): ToastApi {
  const context = useContext(ToastContext);
  if (!context) throw new Error("useToast must be used inside a ToastProvider");
  return context;
}

const STYLES: Record<ToastKind, { border: string; icon: string; tone: string }> = {
  success: { border: "border-primary", icon: "check_circle", tone: "text-primary" },
  error: { border: "border-error", icon: "error", tone: "text-error" },
  warning: {
    border: "border-secondary-container",
    icon: "warning",
    tone: "text-secondary-container",
  },
  info: { border: "border-outline", icon: "info", tone: "text-on-surface-variant" },
};

function ToastViewport({
  toasts,
  onDismiss,
}: {
  toasts: Toast[];
  onDismiss: (id: string) => void;
}) {
  return (
    <div
      // Above the mobile bottom nav, below nothing else.
      className="pointer-events-none fixed inset-x-0 bottom-20 z-50 flex flex-col items-center gap-2 px-4 lg:bottom-6 lg:right-6 lg:left-auto lg:items-end"
      role="region"
      aria-label="Notifications"
    >
      <div aria-live="polite" aria-atomic="false" className="contents">
        {toasts.map((toast) => {
          const style = STYLES[toast.kind];
          return (
            <div
              key={toast.id}
              role={toast.kind === "error" ? "alert" : "status"}
              className={`pointer-events-auto w-full max-w-sm border ${style.border} bg-surface-container-lowest px-4 py-3 shadow-lg`}
            >
              <div className="flex items-start gap-3">
                <Icon name={style.icon} className={`mt-0.5 text-[16px] ${style.tone}`} />
                <div className="min-w-0 flex-1">
                  <p className="font-mono text-xs text-on-surface">{toast.message}</p>
                  {toast.detail && (
                    <p className="mt-1 break-words font-mono text-[11px] text-on-surface-variant">
                      {toast.detail}
                    </p>
                  )}
                </div>
                <button
                  onClick={() => onDismiss(toast.id)}
                  aria-label="Dismiss notification"
                  className="shrink-0 text-outline transition-colors hover:text-on-surface"
                >
                  <Icon name="close" className="text-[16px]" />
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
