/**
 * Tiny fail-fast validator for required Vite-client environment variables.
 *
 * Used at the top of `src/integrations/supabase/client.ts` (and any future
 * client-side module that consumes a required `VITE_` variable) so a
 * missing / empty value crashes at module load with an **actionable**
 * project-specific error message instead of an opaque upstream error from
 * `@supabase/supabase-js` (`supabaseUrl is required.` etc.).
 *
 * Scope: client only. This module does NOT read `process.env` and is NOT
 * used by Edge Functions — those read secrets via `Deno.env.get` and have
 * their own validation pattern (see `supabase/functions/<name>/index.ts`).
 *
 * The error message intentionally names the variable, points at the
 * `.env.example` → `.env.local` copy step, and references the README so a
 * fresh contributor knows exactly what to do without reading source.
 *
 * Split into two exports so the pure value-checking logic
 * (`requireClientEnvValue`) can be unit-tested without mutating
 * `import.meta.env` — which is awkward to stub in Vitest. The
 * `requireClientEnv` wrapper is the production entry point and reads the
 * Vite env one-shot at module load.
 */

/**
 * Pure value-checker. Throws an actionable error if `value` is not a
 * non-empty string (after `.trim()`). Exported solely so the test file
 * can exercise the validation logic without touching `import.meta.env`.
 */
export function requireClientEnvValue(name: string, value: unknown): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(
      `Missing required environment variable: ${name}. ` +
        `Copy .env.example to .env.local and set ${name}. ` +
        `See README.md → Local development.`,
    );
  }
  return value;
}

/**
 * Production entry point. Reads `import.meta.env[name]` once and routes
 * the value through `requireClientEnvValue`. Call at module top-level
 * (not lazily inside a function) so the fail-fast happens as early as
 * possible — ideally before the React tree mounts.
 */
export function requireClientEnv(name: string): string {
  // `import.meta.env` is the Vite build-time / dev-server env. Vite
  // inlines `VITE_`-prefixed values at build; anything else is undefined
  // in the client bundle by design.
  const env = import.meta.env as Record<string, unknown>;
  return requireClientEnvValue(name, env[name]);
}
