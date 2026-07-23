import type { ReactNode } from "react";

export function Panel({
  title,
  actions,
  children,
  className = "",
  bodyClassName = "p-4",
}: {
  title?: string;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  bodyClassName?: string;
}) {
  return (
    <section className={`panel ${className}`}>
      {(title || actions) && (
        <header className="panel-header">
          {title && <h2 className="panel-title">{title}</h2>}
          {actions && <div className="flex items-center gap-2">{actions}</div>}
        </header>
      )}
      <div className={bodyClassName}>{children}</div>
    </section>
  );
}

export function Metric({
  label,
  value,
  hint,
  valueClassName = "text-on-surface",
}: {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  valueClassName?: string;
}) {
  return (
    <div className="panel p-4">
      <div className="font-mono text-[10px] uppercase tracking-widest text-on-surface-variant">
        {label}
      </div>
      <div className={`metric mt-2 text-2xl font-semibold ${valueClassName}`}>{value}</div>
      {hint && <div className="mt-1 font-mono text-[11px] text-outline">{hint}</div>}
    </div>
  );
}

export function Badge({
  children,
  tone = "neutral",
}: {
  children: ReactNode;
  tone?: "neutral" | "success" | "danger" | "warning";
}) {
  const tones: Record<string, string> = {
    neutral: "border-outline-variant text-on-surface-variant",
    success: "border-primary text-primary",
    danger: "border-error text-error",
    warning: "border-secondary-container text-secondary-container",
  };
  return (
    <span
      className={`inline-flex items-center border px-2 py-0.5 font-mono text-[10px] font-medium uppercase tracking-wider ${tones[tone]}`}
    >
      {children}
    </span>
  );
}

export function Toggle({
  checked,
  onChange,
  label,
  description,
  disabled = false,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
  description?: string;
  disabled?: boolean;
}) {
  return (
    <label
      className={`flex items-start justify-between gap-4 py-2.5 ${
        disabled ? "opacity-50" : "cursor-pointer"
      }`}
    >
      <span>
        <span className="block font-mono text-xs uppercase tracking-wider text-on-surface">
          {label}
        </span>
        {description && (
          <span className="mt-0.5 block text-[11px] text-on-surface-variant">
            {description}
          </span>
        )}
      </span>

      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={`relative mt-0.5 h-5 w-10 shrink-0 rounded-full border transition-colors ${
          checked ? "border-primary bg-primary/30" : "border-outline-variant bg-surface-container"
        }`}
      >
        <span
          className={`absolute top-0.5 h-3.5 w-3.5 rounded-full transition-transform ${
            checked ? "translate-x-5 bg-primary" : "translate-x-0.5 bg-outline"
          }`}
        />
      </button>
    </label>
  );
}

export function EmptyState({ icon, message }: { icon: string; message: string }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 py-10 text-center">
      <span className="material-symbols-outlined text-3xl text-outline-variant">{icon}</span>
      <p className="font-mono text-xs text-on-surface-variant">{message}</p>
    </div>
  );
}

export function ErrorBanner({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <div className="border border-error bg-error-container px-4 py-2.5 font-mono text-xs text-on-error-container">
      {message}
    </div>
  );
}
