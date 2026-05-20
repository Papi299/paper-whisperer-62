/// <reference types="https://esm.sh/@supabase/functions-js/src/edge-runtime.d.ts" />

/**
 * Tiny fail-fast validator for required Supabase Edge Function environment
 * variables. Sibling of the client-side `src/lib/clientEnv.ts` helper
 * introduced by PR #138, but runs in Deno and reads `Deno.env.get`.
 *
 * Used at the top of each Edge Function (`analyze-paper`,
 * `fetch-paper-metadata`) so a missing / empty required value crashes
 * with an **actionable** project-specific message instead of an empty-
 * string falling through into a broken `createClient("", "")` downstream.
 *
 * Required env vars per function (current inventory):
 * - Both functions: `SUPABASE_URL`, `SUPABASE_ANON_KEY` — auto-injected
 *   by the Supabase Edge runtime in production. The helper guards
 *   against the (theoretical) runtime-broken case AND against a future
 *   local-development scenario where these need to be set explicitly.
 * - `analyze-paper`: `GEMINI_API_KEY` — set via `supabase secrets set`.
 *   Already validated in-source with its own bespoke message ("not
 *   configured in Supabase secrets"); intentionally NOT routed through
 *   this helper so its single-cause wording stays sharper than the
 *   helper's dual-cause phrasing below.
 *
 * Never logs the value. Caller decides where in the function body to
 * invoke this — inside the request handler is preferred so a runtime
 * config issue surfaces as a 500 response, not a module-load crash that
 * makes the function unreachable.
 */
export function requireEdgeEnv(name: string): string {
  const value = Deno.env.get(name);
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(
      `Missing required Edge Function environment variable: ${name}. ` +
        `Set it in Supabase secrets or confirm it is auto-injected by the Supabase Edge runtime.`,
    );
  }
  return value;
}
