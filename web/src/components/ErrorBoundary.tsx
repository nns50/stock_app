import { Component, ErrorInfo, ReactNode } from 'react';

// Catches render-time crashes in a page subtree and shows a recoverable fallback
// instead of a blank white screen. The header/nav live outside it, so the rest of
// the app keeps working; switching tabs remounts this (it's keyed by route in the
// Layout) and clears the error.

interface Props {
  children: ReactNode;
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
    // Console only — this app does no external logging.
    console.error('Page crashed:', error, info.componentStack);
  }

  private reset = () => this.setState({ error: null });

  render(): ReactNode {
    if (this.state.error) {
      return (
        <div className="card p-6 text-center max-w-lg mx-auto mt-8">
          <div className="text-bear font-semibold">Something went wrong on this page</div>
          <p className="text-slate-400 text-sm mt-1 break-words">{this.state.error.message}</p>
          <div className="flex justify-center gap-2 mt-4">
            <button className="btn-ghost" onClick={this.reset}>
              Try again
            </button>
            <button className="btn-primary" onClick={() => window.location.reload()}>
              Reload app
            </button>
          </div>
          <p className="text-[11px] text-slate-600 mt-3">
            The rest of the app is unaffected — switch tabs to keep working.
          </p>
        </div>
      );
    }
    return this.props.children;
  }
}
