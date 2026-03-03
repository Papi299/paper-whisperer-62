import { Component, ReactNode } from "react";
import { Button } from "@/components/ui/button";

interface ErrorBoundaryProps {
  children: ReactNode;
}

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error };
  }

  handleReset = () => {
    this.setState({ hasError: false, error: null });
  };

  render() {
    if (this.state.hasError) {
      return (
        <div className="flex min-h-screen flex-col items-center justify-center gap-4 p-8 bg-background text-foreground">
          <h1 className="text-2xl font-bold">Something went wrong</h1>
          <p className="text-muted-foreground max-w-md text-center">
            An unexpected error occurred. You can try reloading the page or going back to the dashboard.
          </p>
          {this.state.error && (
            <pre className="mt-2 max-w-lg overflow-auto rounded-md bg-muted p-4 text-xs">
              {this.state.error.message}
            </pre>
          )}
          <div className="flex gap-2">
            <Button variant="outline" onClick={this.handleReset}>
              Try Again
            </Button>
            <Button onClick={() => window.location.assign("/dashboard")}>
              Go to Dashboard
            </Button>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
