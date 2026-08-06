import { Component, ReactNode } from "react";
import "./index.css";

interface Props {
  children: ReactNode;
  fallback?: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

/**
 * Error boundary component that catches React render errors
 * and displays a fallback UI instead of crashing the whole app.
 */
export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    console.error("React error boundary caught an error:", error, errorInfo);
    // start.tsx's `window.addEventListener("error"|"unhandledrejection")`
    // beacons don't fire for boundary-caught errors — React swallows the
    // exception before it bubbles to window. Post the same shape here so
    // /api/client-error can alarm on render-time throws too. sendBeacon
    // is fire-and-forget; a failure here must not itself throw and take
    // down the fallback UI.
    try {
      const body = JSON.stringify({
        message: error.message,
        stack: error.stack ?? "",
        url: window.location.href,
      });
      navigator.sendBeacon("/api/client-error", new Blob([body], { type: "application/json" }));
    } catch (beaconError) {
      console.error("ErrorBoundary sendBeacon failed:", beaconError);
    }
  }

  handleReload = () => {
    window.location.reload();
  };

  handleReset = () => {
    this.setState({ hasError: false, error: null });
  };

  render() {
    if (this.state.hasError) {
      if (this.props.fallback) {
        return this.props.fallback;
      }

      return (
        <div className="error-boundary">
          <div className="error-boundary-content">
            <h2>Something went wrong</h2>
            <p>An unexpected error occurred. You can try:</p>
            <div className="error-boundary-actions">
              <button onClick={this.handleReset} className="error-boundary-btn">
                Try Again
              </button>
              <button onClick={this.handleReload} className="error-boundary-btn primary">
                Reload Page
              </button>
            </div>
            {import.meta.env.DEV && this.state.error && (
              <details className="error-boundary-details">
                <summary>Error Details</summary>
                <pre>{this.state.error.message}</pre>
                <pre>{this.state.error.stack}</pre>
              </details>
            )}
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}

export default ErrorBoundary;
