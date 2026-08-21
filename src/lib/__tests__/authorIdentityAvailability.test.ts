import { describe, it, expect } from "vitest";
import { isAuthorIdentitySchemaMissing } from "../authorIdentityAvailability";

/**
 * The compatibility detector for AUTHOR-IDENTITY-RESOLUTION-001C.
 *
 * Two failure modes matter here and they pull in opposite directions:
 *
 *   * too narrow, and a Preview built against a pre-migration database throws
 *     an error the user can do nothing about, instead of falling back to 001A;
 *   * too broad, and a genuine permission failure, RLS refusal or network fault
 *     is silently reported as "not installed yet" — a blank screen where there
 *     should be an error. That is the worse of the two, so the tests below spend
 *     most of their effort on what must NOT be swallowed.
 */

/** A PostgREST/Postgres error as the SDK surfaces it. */
function pgError(code: string, message: string, extra: Record<string, string> = {}) {
  return { code, message, details: null, hint: null, ...extra };
}

describe("isAuthorIdentitySchemaMissing — the expected condition", () => {
  it.each([
    ["42P01", 'relation "public.author_identities" does not exist'],
    ["42P01", 'relation "public.author_identity_links" does not exist'],
    ["42883", 'function public.merge_author_identities(uuid, uuid) does not exist'],
    ["42704", 'type "author_identity_merges" does not exist'],
  ])("recognises SQLSTATE %s naming a 001C object", (code, message) => {
    expect(isAuthorIdentitySchemaMissing(pgError(code, message))).toBe(true);
  });

  it.each([
    ["PGRST205", "Could not find the table 'public.author_identities' in the schema cache"],
    ["PGRST202", "Could not find the function public.link_author_mention_to_identity in the schema cache"],
  ])("recognises PostgREST code %s naming a 001C object", (code, message) => {
    // These are the codes actually seen in practice: PostgREST resolves the name
    // against its cache before the request ever reaches Postgres.
    expect(isAuthorIdentitySchemaMissing(pgError(code, message))).toBe(true);
  });

  it("finds the object name in details or hint, not only in message", () => {
    expect(
      isAuthorIdentitySchemaMissing(
        pgError("PGRST205", "Could not find the table in the schema cache", {
          details: "Perhaps you meant public.author_identity_aliases",
        }),
      ),
    ).toBe(true);
  });

  it("matches the object name case-insensitively", () => {
    expect(
      isAuthorIdentitySchemaMissing(pgError("42P01", 'relation "PUBLIC.AUTHOR_IDENTITIES" does not exist')),
    ).toBe(true);
  });
});

describe("isAuthorIdentitySchemaMissing — what must never be swallowed", () => {
  it("rejects a permission error on a 001C table", () => {
    // The table exists and the caller may not touch it. That is a real problem
    // and must surface, not degrade into an empty identity manager.
    expect(
      isAuthorIdentitySchemaMissing(
        pgError("42501", "permission denied for table author_identities"),
      ),
    ).toBe(false);
  });

  it("rejects a constraint violation from a 001C table", () => {
    expect(
      isAuthorIdentitySchemaMissing(
        pgError("23505", 'duplicate key value violates unique constraint "author_identity_links_paper_author_index_key"'),
      ),
    ).toBe(false);
  });

  it("rejects a RAISE from one of the RPCs", () => {
    expect(
      isAuthorIdentitySchemaMissing(
        pgError("P0001", "Author mention changed since it was read; expected A, found B"),
      ),
    ).toBe(false);
  });

  it("rejects a missing-table error naming an unrelated relation", () => {
    // A genuine schema problem elsewhere in the product. Reporting it as
    // "identity subsystem not installed" would hide it completely.
    expect(
      isAuthorIdentitySchemaMissing(pgError("42P01", 'relation "public.papers" does not exist')),
    ).toBe(false);
  });

  it("rejects a missing-object code carrying no object name at all", () => {
    expect(isAuthorIdentitySchemaMissing(pgError("42P01", "relation does not exist"))).toBe(false);
  });

  it.each([
    ["null", null],
    ["undefined", undefined],
    ["a string", "author_identities does not exist"],
    ["a plain Error", new Error('relation "public.author_identities" does not exist')],
    ["an empty object", {}],
  ])("rejects %s, which carries no usable code", (_label, value) => {
    expect(isAuthorIdentitySchemaMissing(value)).toBe(false);
  });

  it("rejects a network-shaped failure", () => {
    expect(isAuthorIdentitySchemaMissing({ message: "Failed to fetch" })).toBe(false);
  });
});
