import { describe, it, expect } from "vitest";

import { requireClientEnvValue } from "../clientEnv";

/**
 * Tests for the pure value-checking core of the client-env fail-fast
 * helper. `requireClientEnvValue` is exported specifically to support
 * these focused tests without mutating `import.meta.env` (which is
 * awkward in Vitest). The thin `requireClientEnv` wrapper just reads
 * `import.meta.env[name]` and delegates here, so coverage on the pure
 * function is sufficient.
 *
 * The error message contract is deliberately asserted piece-by-piece —
 * the message MUST mention the variable name, the `.env.example` →
 * `.env.local` copy step, and the README pointer so a fresh contributor
 * can act on it without reading source. If the message is reworded, the
 * pieces below must remain present.
 */
describe("requireClientEnvValue", () => {
  it("returns the value when a non-empty string is provided", () => {
    expect(requireClientEnvValue("VITE_SUPABASE_URL", "https://example.supabase.co")).toBe(
      "https://example.supabase.co",
    );
  });

  it("throws an actionable error when the value is undefined", () => {
    expect(() =>
      requireClientEnvValue("VITE_SUPABASE_URL", undefined),
    ).toThrowError(/VITE_SUPABASE_URL/);

    // The full message contract — all four pieces must be present.
    try {
      requireClientEnvValue("VITE_SUPABASE_URL", undefined);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      expect(message).toContain("VITE_SUPABASE_URL");
      expect(message).toContain(".env.example");
      expect(message).toContain(".env.local");
      expect(message).toContain("Local development");
    }
  });

  it("throws an actionable error when the value is an empty string", () => {
    expect(() => requireClientEnvValue("VITE_SUPABASE_PUBLISHABLE_KEY", "")).toThrowError(
      /VITE_SUPABASE_PUBLISHABLE_KEY/,
    );
  });

  it("throws when the value is whitespace-only (treated as empty)", () => {
    expect(() => requireClientEnvValue("VITE_SUPABASE_URL", "   ")).toThrowError(
      /VITE_SUPABASE_URL/,
    );
  });
});
