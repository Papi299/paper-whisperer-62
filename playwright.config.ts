import { defineConfig, devices } from "@playwright/test";
import { loadEnv } from "vite";
import { readFileSync, existsSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import {
  assertLocalSupabaseUrl,
  assertLoopbackAppUrl,
  assertOriginsMatch,
} from "./e2e/support/backend-guard";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Load .env.test if it exists (avoids shell escaping issues with special chars).
// Values are only applied when not already present in process.env, so the
// in-memory contract injected by scripts/e2e-local.mjs always wins.
const envTestPath = resolve(__dirname, ".env.test");
if (existsSync(envTestPath)) {
  const content = readFileSync(envTestPath, "utf-8");
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx);
    const value = trimmed.slice(eqIdx + 1);
    if (!process.env[key]) {
      process.env[key] = value;
    }
  }
}

const DEFAULT_BASE_URL = "http://localhost:8080";

function guardFail(message: string): never {
  throw new Error(`E2E backend guard: ${message}`);
}

function requireNonBlank(name: string, value: string | undefined): string {
  if (!value || value.trim() === "") {
    guardFail(`${name} is required but missing/blank. Run \`npm run test:e2e:local\`.`);
  }
  return value;
}

/**
 * Layer 1 — Node / pre-server guard.
 *
 * Runs at config load, BEFORE Playwright starts (or reuses) any Vite server and
 * before any test executes. It resolves the Supabase URL that the `vite` dev
 * command will actually use — via Vite's own `loadEnv`, so `process.env` beats
 * the committed `.env` exactly as the real dev server does — and refuses to
 * proceed unless the full local backend contract is present and consistent:
 * declared local mode, all required values non-blank, the effective Vite target
 * loopback (no Production ref, no remote host), and expected === inline ===
 * effective origin. Any failure throws here, so Vite never starts.
 *
 * Returns the validated environment to hand explicitly to the web server so the
 * spawned Vite inherits exactly the vetted values.
 */
function resolveGuardedLocalBackend(): {
  baseURL: string;
  webServerEnv: Record<string, string>;
} {
  const mode = process.env.E2E_BACKEND_MODE;
  if (mode !== "local") {
    guardFail(
      `E2E_BACKEND_MODE must be "local" (got "${mode ?? ""}"). Direct Playwright ` +
        `invocation is disabled; use \`npm run test:e2e:local\`.`,
    );
  }

  const expectedUrl = requireNonBlank("E2E_EXPECTED_SUPABASE_URL", process.env.E2E_EXPECTED_SUPABASE_URL);
  const inlineViteUrl = requireNonBlank("VITE_SUPABASE_URL", process.env.VITE_SUPABASE_URL);
  requireNonBlank("TEST_USER_EMAIL", process.env.TEST_USER_EMAIL);
  requireNonBlank("TEST_USER_PASSWORD", process.env.TEST_USER_PASSWORD);

  // Resolve the target Vite will actually load, using the same precedence as the
  // real dev command (process.env overrides .env files for VITE_-prefixed keys).
  const viteEnv = loadEnv("development", __dirname, "VITE_");
  const effectiveUrl = requireNonBlank("effective Vite VITE_SUPABASE_URL", viteEnv.VITE_SUPABASE_URL);
  const effectiveKey = requireNonBlank(
    "effective Vite VITE_SUPABASE_PUBLISHABLE_KEY",
    viteEnv.VITE_SUPABASE_PUBLISHABLE_KEY,
  );

  // Each target must independently be a safe local loopback Supabase URL…
  assertLocalSupabaseUrl(expectedUrl, "E2E_EXPECTED_SUPABASE_URL");
  assertLocalSupabaseUrl(effectiveUrl, "effective Vite Supabase URL");
  // …and expected === inline env === effective Vite target (exact origin match).
  assertOriginsMatch(expectedUrl, inlineViteUrl, { label: "Supabase target (expected vs inline)" });
  assertOriginsMatch(expectedUrl, effectiveUrl, { label: "Supabase target (expected vs effective Vite)" });

  const baseURL = process.env.BASE_URL || DEFAULT_BASE_URL;
  assertLoopbackAppUrl(baseURL, "BASE_URL");

  // Hand the validated values explicitly to the spawned dev server so the Vite
  // process inherits exactly the vetted backend — never a stale/ambient one.
  const webServerEnv: Record<string, string> = {
    ...(process.env as Record<string, string>),
    VITE_SUPABASE_URL: effectiveUrl,
    VITE_SUPABASE_PUBLISHABLE_KEY: effectiveKey,
  };

  return { baseURL, webServerEnv };
}

const guarded = resolveGuardedLocalBackend();

/**
 * Playwright E2E configuration for Paper Whisperer (local-first, fail-closed).
 *
 * Credentials and the local backend are injected in-memory by
 * scripts/e2e-local.mjs (`npm run test:e2e:local`). Direct invocation fails
 * closed unless the complete explicit backend contract is present.
 */
export default defineConfig({
  testDir: "./e2e",
  // e2e/support holds pure Vitest unit tests (e.g. the backend guard), not
  // Playwright specs — keep them out of the Playwright run.
  testIgnore: ["**/support/**"],
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  reporter: process.env.CI ? "github" : "list",
  timeout: 30_000,

  use: {
    baseURL: guarded.baseURL,
    trace: "on-first-retry",
    screenshot: "only-on-failure",
  },

  projects: [
    {
      name: "setup",
      testMatch: /global-setup\.ts/,
    },
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        storageState: "e2e/.auth/user.json",
      },
      dependencies: ["setup"],
    },
  ],

  webServer: {
    command: "npm run dev",
    port: 8080,
    // Never reuse an ambient dev server: it may point at the committed
    // Production `.env`. Always start a fresh server with the validated env.
    reuseExistingServer: false,
    timeout: 30_000,
    env: guarded.webServerEnv,
  },
});
