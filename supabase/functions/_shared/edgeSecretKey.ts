// The Edge runtime's elevated Supabase key, chosen from what the platform
// injects — shared by every function that needs one.
//
// Moved here from `accountDeletion.ts` by AI-MULTI-PROVIDER-001D, which gave it
// a second caller (the AI usage-telemetry writer). A provider-neutral home keeps
// the AI functions from importing the account-deletion module to reach one
// pure function. `accountDeletion.ts` re-exports it, so `delete-account` is
// unchanged.
//
// Pure: takes the two raw values, never reads the environment, and never logs.
// No Deno APIs, no remote imports.

/**
 * Choose the elevated server-only key from the Edge runtime's auto-provided
 * environment, preferring the current secret-key mechanism.
 *
 * `SUPABASE_SECRET_KEYS` is a JSON dictionary keyed by key name (`default` for
 * the key Supabase creates first); `SUPABASE_SERVICE_ROLE_KEY` is the legacy
 * plain string. Both are injected by the platform, so neither requires a
 * manually managed Production secret. Returns `null` when neither is usable —
 * the caller turns that into a safe refusal rather than proceeding unprivileged.
 */
export function selectEdgeSecretKey(
  secretKeysJson: string | null | undefined,
  serviceRoleKey: string | null | undefined,
): string | null {
  if (typeof secretKeysJson === "string" && secretKeysJson.trim() !== "") {
    try {
      const parsed = JSON.parse(secretKeysJson);
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
        const preferred = (parsed as Record<string, unknown>).default;
        if (typeof preferred === "string" && preferred.trim() !== "") return preferred;
      }
    } catch {
      // Unparseable value: fall through to the legacy key rather than throwing
      // an error whose message could quote the raw (secret-bearing) string.
    }
  }
  if (typeof serviceRoleKey === "string" && serviceRoleKey.trim() !== "") return serviceRoleKey;
  return null;
}
