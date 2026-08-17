import { describe, it, expect } from "vitest";
import { deriveCanonicalOrcid, isOrcidScheme, normalizeOrcid } from "../orcid";
import {
  ORCID_DERIVATION_VECTORS,
  ORCID_NORMALIZATION_VECTORS,
  VALID_ORCID,
} from "./fixtures/orcidVectors";

/**
 * The application-side half of the ORCID contract. The Edge Function's copy is
 * asserted against the *same* vector table in
 * `supabase/functions/_shared/__tests__/orcid.test.ts`, so the two runtimes
 * cannot drift apart without one of the two suites failing.
 */

describe("normalizeOrcid", () => {
  for (const vector of ORCID_NORMALIZATION_VECTORS) {
    it(vector.name, () => {
      expect(normalizeOrcid(vector.input)).toBe(vector.expected);
    });
  }

  it("rejects non-string input rather than coercing it", () => {
    // A JSON source can hand us a number, and `0` is falsy — an implementation
    // that stringified first could turn a numeric field into a bogus candidate.
    expect(normalizeOrcid(null)).toBeNull();
    expect(normalizeOrcid(undefined)).toBeNull();
    expect(normalizeOrcid(1825)).toBeNull();
    expect(normalizeOrcid({ value: VALID_ORCID })).toBeNull();
    expect(normalizeOrcid([VALID_ORCID])).toBeNull();
  });

  it("is idempotent on its own output", () => {
    // Canonical form must be a fixed point, or a re-import of exported
    // provenance could drift.
    for (const vector of ORCID_NORMALIZATION_VECTORS) {
      if (vector.expected === null) continue;
      expect(normalizeOrcid(vector.expected)).toBe(vector.expected);
    }
  });
});

describe("isOrcidScheme", () => {
  it("matches the ORCID authority case-insensitively, after trimming", () => {
    expect(isOrcidScheme("ORCID")).toBe(true);
    expect(isOrcidScheme("orcid")).toBe(true);
    expect(isOrcidScheme("Orcid")).toBe(true);
    expect(isOrcidScheme("  ORCID  ")).toBe(true);
  });

  it("does not match an authority that merely mentions ORCID", () => {
    expect(isOrcidScheme("ORCID-like")).toBe(false);
    expect(isOrcidScheme("not ORCID")).toBe(false);
    expect(isOrcidScheme("ISNI")).toBe(false);
    expect(isOrcidScheme("")).toBe(false);
    expect(isOrcidScheme(null)).toBe(false);
  });
});

describe("deriveCanonicalOrcid", () => {
  for (const vector of ORCID_DERIVATION_VECTORS) {
    it(vector.name, () => {
      expect(deriveCanonicalOrcid(vector.identifiers)).toBe(vector.expected);
    });
  }
});
