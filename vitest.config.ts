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
    // PaperLume handoff URL builder, its popup behaviour, its manifest
    // permission contract, and its no-network boundary. Still no browser and no
    // network: the classifier and the URL builder are string functions, the
    // manifest and boundary suites read committed source files, and the popup
    // suite drives the committed `popup.html` under jsdom against a stub of the
    // two `chrome.tabs` members the extension is allowed to call. A real
    // unpacked-MV3 harness lives in `e2e-extension/`, driven by its own
    // Playwright config, because it needs a real browser.
    // scripts/lib/**/__tests__ — the Chrome Web Store package contract
    // (`scripts/lib/extension-package.mjs`), exercised against in-memory
    // fixtures. Plain `.mjs` because `scripts/` is Node tooling and
    // `scripts/package-extension.mjs` imports the same module with no loader;
    // the suite builds every package it inspects, so it needs no build output.
    include: [
      "src/**/*.{test,spec}.{ts,tsx}",
      "supabase/functions/**/__tests__/**/*.{test,spec}.ts",
      "e2e/support/**/*.{test,spec}.ts",
      "extension/**/__tests__/**/*.{test,spec}.ts",
      "scripts/lib/**/__tests__/**/*.{test,spec}.mjs",
    ],
  },
  resolve: {
    alias: { "@": path.resolve(__dirname, "./src") },
  },
});
