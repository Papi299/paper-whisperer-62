import { describe, it, expect } from "vitest";
import { isAiModelPreferenceSchemaMissing } from "../aiModelPreferenceAvailability";
import { isAuthorIdentitySchemaMissing } from "../authorIdentityAvailability";

/**
 * The compatibility detector for AI-MODEL-SELECTION-001A's `user_ai_preferences`.
 *
 * The stakes here are higher than for a UI fallback, because the only consumer
 * is the **full account export**. Too narrow, and an export run against a
 * pre-migration Preview fails for a table the user has never used. Too broad,
 * and a genuine read failure is reported as "this user has no preference" — an
 * archive that silently omits a choice they made, indistinguishable from a
 * correct one. The second is far worse, so most of these tests are about what
 * must NOT be swallowed.
 */

/** A PostgREST/Postgres error as the SDK surfaces it. */
function pgError(code: string, message: string, extra: Record<string, unknown> = {}) {
  return { code, message, details: null, hint: null, ...extra };
}

describe("isAiModelPreferenceSchemaMissing — the expected condition", () => {
  it.each([
    ["42P01", 'relation "public.user_ai_preferences" does not exist'],
    ["42704", 'type "user_ai_preferences" does not exist'],
    ["PGRST205", "Could not find the table 'public.user_ai_preferences' in the schema cache"],
  ])("recognises %s naming user_ai_preferences", (code, message) => {
    expect(isAiModelPreferenceSchemaMissing(pgError(code, message))).toBe(true);
  });

  it("finds the object name in details or hint, not only the message", () => {
    expect(
      isAiModelPreferenceSchemaMissing(
        pgError("PGRST205", "Not found", { details: "public.user_ai_preferences is absent" }),
      ),
    ).toBe(true);
    expect(
      isAiModelPreferenceSchemaMissing(
        pgError("42P01", "undefined table", { hint: "Did you mean user_ai_preferences?" }),
      ),
    ).toBe(true);
  });

  it("matches case-insensitively", () => {
    expect(
      isAiModelPreferenceSchemaMissing(
        pgError("42P01", 'relation "PUBLIC.USER_AI_PREFERENCES" does not exist'),
      ),
    ).toBe(true);
  });
});

describe("isAiModelPreferenceSchemaMissing — what must never be swallowed", () => {
  it.each([
    [
      "permission denied",
      pgError("42501", "permission denied for table user_ai_preferences"),
    ],
    [
      "an RLS refusal",
      pgError("42501", 'new row violates row-level security policy for table "user_ai_preferences"'),
    ],
    [
      "an authentication failure",
      pgError("PGRST301", "JWT expired"),
    ],
    [
      "a malformed query",
      pgError("42703", "column user_ai_preferences.nope does not exist"),
    ],
    [
      "a statement timeout",
      pgError("57014", "canceling statement due to statement timeout"),
    ],
    ["a generic server error", pgError("500", "Internal Server Error")],
  ])("does not treat %s as a missing table", (_label, error) => {
    expect(isAiModelPreferenceSchemaMissing(error)).toBe(false);
  });

  it("does not treat a missing UNRELATED table as the compatibility case", () => {
    // Right code family, wrong object. Swallowing this would hide a genuine
    // schema problem somewhere else in the product.
    expect(
      isAiModelPreferenceSchemaMissing(pgError("42P01", 'relation "public.papers" does not exist')),
    ).toBe(false);
    expect(
      isAiModelPreferenceSchemaMissing(pgError("42P01", 'relation "public.ai_model_catalog" does not exist')),
    ).toBe(false);
  });

  it("requires an object name, not merely a missing-object code", () => {
    expect(isAiModelPreferenceSchemaMissing(pgError("42P01", "relation does not exist"))).toBe(false);
  });

  it.each([[null], [undefined], ["a string"], [42], [new Error("boom")]])(
    "rejects the non-PostgREST value %p",
    (value) => {
      expect(isAiModelPreferenceSchemaMissing(value)).toBe(false);
    },
  );

  it("does not treat a network failure as a missing table", () => {
    expect(isAiModelPreferenceSchemaMissing({ message: "Failed to fetch" })).toBe(false);
    expect(isAiModelPreferenceSchemaMissing(new TypeError("Failed to fetch"))).toBe(false);
  });
});

describe("the two classifiers stay independent", () => {
  /*
   * They share the code/text matching mechanism but not the object list. That
   * separation is what stops either from absorbing the other's failures: a
   * pre-migration environment for one feature says nothing about the other, and
   * a single classifier naming both would let a missing identity table be
   * reported as "no saved preference".
   */
  it("a missing identity table is not a missing preference table", () => {
    const error = pgError("PGRST205", "Could not find the table 'public.author_identities' in the schema cache");
    expect(isAuthorIdentitySchemaMissing(error)).toBe(true);
    expect(isAiModelPreferenceSchemaMissing(error)).toBe(false);
  });

  it("a missing preference table is not a missing identity schema", () => {
    const error = pgError("PGRST205", "Could not find the table 'public.user_ai_preferences' in the schema cache");
    expect(isAiModelPreferenceSchemaMissing(error)).toBe(true);
    expect(isAuthorIdentitySchemaMissing(error)).toBe(false);
  });
});
