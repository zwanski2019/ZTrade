import { Component, type ErrorInfo, type ReactNode } from "react";

/**
 * Catches render errors so a bug in one panel does not white-screen the whole
 * terminal.
 *
 * This matters more here than in a typical app: an operator may have open
 * positions on screen. Losing the entire UI to a formatting error in a table
 * cell means losing the Force Close button too — so the fallback deliberately
 * keeps the emergency path reachable.
 */
interface Props {
  children: ReactNode;
  /** Shown instead of the full-page fallback when a single panel fails. */
  compact?: boolean;
  label?: string;
}

interface State {
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // No telemetry endpoint yet; the console is where an operator will look.
    console.error("[ZTrade] render error", error, info.componentStack);
  }

  private reset = (): void => this.setState({ error: null });

  render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;

    if (this.props.compact) {
      return (
        <div className="panel p-4 font-mono text-xs text-error">
          <div className="font-semibold">
            {this.props.label ?? "This panel"} failed to render
          </div>
          <p className="mt-1 text-[11px] text-on-surface-variant">{error.message}</p>
          <button className="btn-outline mt-3" onClick={this.reset}>
            Retry
          </button>
        </div>
      );
    }

    return (
      <div className="flex min-h-screen items-center justify-center bg-background p-4">
        <div className="panel w-full max-w-lg p-6">
          <div className="font-mono text-lg font-bold text-error">Terminal crashed</div>
          <p className="mt-2 font-mono text-xs text-on-surface-variant">
            The interface hit an unrecoverable render error. Your engine is unaffected —
            it runs server-side and keeps managing open positions.
          </p>

          <pre className="mt-4 max-h-40 overflow-auto border border-outline-variant bg-surface-container-lowest p-3 font-mono text-[11px] text-error">
            {error.message}
          </pre>

          <div className="mt-5 flex flex-wrap gap-2">
            <button className="btn-primary" onClick={() => window.location.reload()}>
              Reload terminal
            </button>
            <button className="btn-outline" onClick={this.reset}>
              Try again
            </button>
          </div>

          <p className="mt-4 border-t border-outline-variant pt-3 font-mono text-[10px] leading-relaxed text-outline">
            If you need to flatten positions and the UI will not load, the kill switch
            runs as a separate process on its own port and is unaffected by this.
          </p>
        </div>
      </div>
    );
  }
}
