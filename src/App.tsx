import { Toaster } from "@/components/ui/toaster";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Routes, Route } from "react-router";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import Index from "./pages/Index";
import Auth from "./pages/Auth";
import Dashboard from "./pages/Dashboard";
import ExtensionImport from "./pages/ExtensionImport";
import ResetPassword from "./pages/ResetPassword";
import Privacy from "./pages/Privacy";
import NotFound from "./pages/NotFound";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 5 * 60 * 1000,       // 5 minutes — single-user tool, data rarely stale
      gcTime: 30 * 60 * 1000,          // 30 minutes — keep unused data in cache
      retry: 1,                         // 1 retry on failure (Supabase calls are fast)
      refetchOnWindowFocus: false,      // avoid unnecessary refetches for research data
    },
  },
});

const App = () => (
  <QueryClientProvider client={queryClient}>
    <TooltipProvider>
      <Toaster />
      <Sonner />
      <ErrorBoundary>
        <BrowserRouter>
          <Routes>
            <Route path="/" element={<Index />} />
            <Route path="/auth" element={<Auth />} />
            <Route path="/dashboard" element={<Dashboard />} />
            {/* Chrome-extension handoff target. Authenticated, and inert on
                navigation — it imports only after an explicit confirmation. */}
            <Route path="/extension-import" element={<ExtensionImport />} />
            <Route path="/reset-password" element={<ResetPassword />} />
            {/* Public legal surface. Unauthenticated by design — it carries no
                guard and reads no session, so it renders identically signed in
                or out, on direct URL entry and after a refresh. */}
            <Route path="/privacy" element={<Privacy />} />
            {/* ADD ALL CUSTOM ROUTES ABOVE THE CATCH-ALL "*" ROUTE */}
            <Route path="*" element={<NotFound />} />
          </Routes>
        </BrowserRouter>
      </ErrorBoundary>
    </TooltipProvider>
  </QueryClientProvider>
);

export default App;
