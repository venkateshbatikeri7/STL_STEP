import { Component, type ErrorInfo, type ReactNode } from "react";

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

/**
 * Last line of defence against the blank page.
 *
 * React unmounts the entire tree when a render throws and nothing above it
 * catches — so a single failure in the Three.js preview, a failed lazy chunk,
 * or a bad WebGL context takes the whole app with it, leaving an empty
 * document and no way back except a reload.
 *
 * The converter itself does not depend on any of that, so the message below
 * makes clear that picking another file still works.
 */
export class ErrorBoundary extends Component<Props, State> {
  override state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error("Unhandled UI error:", error, info.componentStack);
  }

  override render(): ReactNode {
    const { error } = this.state;
    if (error === null) return this.props.children;

    return (
      <div className="crash" role="alert">
        <div className="crash__card">
          <h1 className="crash__title">Something went wrong</h1>
          <p className="crash__message">{error.message}</p>
          <p className="crash__hint">
            Your file was never uploaded, and nothing left your device. Try again —
            and if it keeps happening, converting a smaller mesh or a different
            browser usually helps.
          </p>
          <div className="crash__actions">
            <button
              type="button"
              className="button button--primary"
              onClick={() => this.setState({ error: null })}
            >
              Try again
            </button>
            <button
              type="button"
              className="button button--ghost"
              onClick={() => window.location.reload()}
            >
              Reload the page
            </button>
          </div>
        </div>
      </div>
    );
  }
}