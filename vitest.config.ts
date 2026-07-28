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
    include: [
      "src/**/*.{test,spec}.{ts,tsx}",
      "supabase/functions/**/__tests__/**/*.{test,spec}.ts",
    ],
  },
  resolve: {
    alias: { "@": path.resolve(__dirname, "./src") },
  },
});
