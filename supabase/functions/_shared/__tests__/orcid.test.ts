import { describe, it, expect } from "vitest";
import { deriveCanonicalOrcid, isOrcidScheme, normalizeOrcid } from "../orcid";
import {
  ORCID_DERIVATION_VECTORS,
  ORCID_NORMALIZATION_VECTORS,
  VALID_ORCID,
} from "../../../../src/lib/__tests__/fixtures/orcidVectors";

/**
 * The Edge Function's ORCID contract, asserted against the SAME locked vector
 * table the application copy uses (`src/lib/__tests__/orcid.test.ts`).
 *
 * The two implementations are deliberately separate files: the Vite build never
 * reaches into `supabase/` and the Deno bundle never reaches into `src/`, so a
 * shared import would break one runtime or the other. That packaging boundary
 * is not permission to disagree — importing the vectors across it (which only
 * this Vitest process ever does, never the deployed bundle) is what makes a
 * silent divergence impossible: any behavioural drift fails here or in the
 * application suite, in the same assertion.
 */

describe("normalizeOrcid (Edge copy)", () => {
  for (const vector of ORCID_NORMALIZATION_VECTORS) {
    it(vector.name, () => {
      expect(normalizeOrcid(vector.input)).toBe(vector.expected);
    });
  }

  it("rejects non-string input rather than coercing it", () => {
    expect(normalizeOrcid(null)).toBeNull();
    expect(normalizeOrcid(undefined)).toBeNull();
    expect(normalizeOrcid(1825)).toBeNull();
    expect(normalizeOrcid({ value: VALID_ORCID })).toBeNull();
  });
});

describe("isOrcidScheme (Edge copy)", () => {
  it("matches the ORCID authority case-insensitively, after trimming", () => {
    expect(isOrcidScheme("ORCID")).toBe(true);
    expect(isOrcidScheme("orcid")).toBe(true);
    expect(isOrcidScheme("  ORCID  ")).toBe(true);
  });

  it("does not match an authority that merely mentions ORCID", () => {
    expect(isOrcidScheme("ORCID-like")).toBe(false);
    expect(isOrcidScheme("ISNI")).toBe(false);
    expect(isOrcidScheme(null)).toBe(false);
  });
});

describe("deriveCanonicalOrcid (Edge copy)", () => {
  for (const vector of ORCID_DERIVATION_VECTORS) {
    it(vector.name, () => {
      expect(deriveCanonicalOrcid(vector.identifiers)).toBe(vector.expected);
    });
  }
});
