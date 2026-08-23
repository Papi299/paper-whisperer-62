/**
 * `matchTaxonomyName` — the reconciliation that decides whether a proposed
 * "new" Project/Tag is actually new, at the moment the user clicks.
 *
 * The case that matters most is `ambiguous`. The normalized key trims as well
 * as lower-casing, which is deliberately broader than the database's
 * `(user_id, lower(name))` unique index — so one key legitimately matches
 * several rows, and no rule here may pick one of them.
 */

import { describe, it, expect } from "vitest";
import { matchTaxonomyName, normalizeTaxonomyName } from "@/lib/taxonomyNameMatch";

const P = (id: string, name: string) => ({ id, name });

describe("normalizeTaxonomyName", () => {
  it("trims and lower-cases", () => {
    expect(normalizeTaxonomyName("  Diabetes  ")).toBe("diabetes");
    expect(normalizeTaxonomyName("DIABETES")).toBe("diabetes");
  });

  it("is broader than the database key: padded and unpadded collapse together", () => {
    // The DB would hold " diabetes " and "diabetes" as two distinct rows.
    expect(normalizeTaxonomyName(" Diabetes ")).toBe(normalizeTaxonomyName("diabetes"));
  });
});

describe("matchTaxonomyName", () => {
  it("reports 'none' for a name nothing matches", () => {
    const result = matchTaxonomyName("Sarcopenia", [P("a", "Diabetes"), P("b", "Cardiology")]);
    expect(result.kind).toBe("none");
  });

  it("reports 'none' for an empty taxonomy", () => {
    expect(matchTaxonomyName("Anything", []).kind).toBe("none");
  });

  it("reports 'unique' and returns the row for exactly one case-insensitive match", () => {
    const result = matchTaxonomyName("diabetes", [P("a", "Diabetes"), P("b", "Cardiology")]);
    expect(result.kind).toBe("unique");
    if (result.kind !== "unique") throw new Error("unreachable");
    expect(result.entity.id).toBe("a");
  });

  it("matches across differing whitespace", () => {
    const result = matchTaxonomyName("Diabetes", [P("a", "  diabetes  ")]);
    expect(result.kind).toBe("unique");
  });

  it("reports 'ambiguous' when several rows share the normalized name", () => {
    const result = matchTaxonomyName("Diabetes", [
      P("a", "Diabetes"),
      P("b", " diabetes "),
      P("c", "Cardiology"),
    ]);
    expect(result.kind).toBe("ambiguous");
    if (result.kind !== "ambiguous") throw new Error("unreachable");
    expect(result.matches.map((m) => m.id).sort()).toEqual(["a", "b"]);
  });

  it("never resolves an ambiguous set to a single row by any tie-break", () => {
    // First, last, shortest name and lowest id are all deliberately absent as
    // rules — a caller must not be able to read one out of the result.
    const result = matchTaxonomyName("X", [P("zzz", "x"), P("aaa", "X "), P("mmm", " x")]);
    expect(result.kind).toBe("ambiguous");
    expect(result).not.toHaveProperty("entity");
  });

  it("treats a blank proposal as matching nothing, not as matching blank rows", () => {
    expect(matchTaxonomyName("   ", [P("a", ""), P("b", "  ")]).kind).toBe("none");
  });
});
