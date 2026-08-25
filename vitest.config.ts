import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react-swc";
import path from "path";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/test/setup.ts"],
    // src/** — the application suite.
    // supabase/functions/**/__tests__ — pure Edge helpers (no Deno APIs / no
    // remote imports) are Node-importable, so their logic (Monitoring
    // normalization, provider-error classification, model resolution) is covered
    // by Vitest WITHOUT adding a Deno runtime to CI.
    // e2e/support/**/*.{test,spec}.ts — pure helpers for the local Playwright
    // lifecycle (e.g. the fail-closed backend-target guard). These are pure
    // unit tests with no Docker/Supabase/browser/network; the Playwright specs
    // themselves live in e2e/*.spec.ts and are excluded from Vitest.
    // extension/**/__tests__ — the Chrome extension's URL classifier, its
    // manifest permission contract, and its no-network boundary. All pure: the
    // classifier is a string function, and the other two read committed source
    // files. No browser, no `chrome` runtime, no network — the extension is
    // exercised in a real browser by a later phase, not here.
    include: [
      "src/**/*.{test,spec}.{ts,tsx}",
      "supabase/functions/**/__tests__/**/*.{test,spec}.ts",
      "e2e/support/**/*.{test,spec}.ts",
      "extension/**/__tests__/**/*.{test,spec}.ts",
    ],
  },
  resolve: {
    alias: { "@": path.resolve(__dirname, "./src") },
  },
});
