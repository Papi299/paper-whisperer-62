import { describe, it, expect } from "vitest";
import { normalizeStatisticalMethodsForDomain } from "../statisticalMethods";

describe("normalizeStatisticalMethodsForDomain", () => {
  it("maps null to null", () => {
    expect(normalizeStatisticalMethodsForDomain(null)).toBeNull();
  });

  it("maps undefined to null", () => {
    expect(normalizeStatisticalMethodsForDomain(undefined)).toBeNull();
  });

  it("returns strings unchanged", () => {
    expect(normalizeStatisticalMethodsForDomain("ANOVA, linear regression")).toBe(
      "ANOVA, linear regression",
    );
  });

  it("returns the empty string unchanged", () => {
    expect(normalizeStatisticalMethodsForDomain("")).toBe("");
  });

  it('preserves "Not specified" verbatim (no NULL conversion)', () => {
    expect(normalizeStatisticalMethodsForDomain("Not specified")).toBe("Not specified");
  });

  it("keeps strings containing JSON syntax as literal text", () => {
    expect(normalizeStatisticalMethodsForDomain('["ANOVA"]')).toBe('["ANOVA"]');
    expect(normalizeStatisticalMethodsForDomain("null")).toBe("null");
    expect(normalizeStatisticalMethodsForDomain("{}")).toBe("{}");
    expect(normalizeStatisticalMethodsForDomain("true")).toBe("true");
  });

  it('joins string arrays with ", "', () => {
    expect(normalizeStatisticalMethodsForDomain(["ANOVA", "t-test"])).toBe("ANOVA, t-test");
  });

  it("maps the empty array to the empty string", () => {
    expect(normalizeStatisticalMethodsForDomain([])).toBe("");
  });

  it("preserves array element order", () => {
    expect(normalizeStatisticalMethodsForDomain(["c", "a", "b"])).toBe("c, a, b");
  });

  it("omits null array elements, matching PostgreSQL string_agg", () => {
    expect(normalizeStatisticalMethodsForDomain(["ANOVA", null, "t-test"])).toBe("ANOVA, t-test");
    expect(normalizeStatisticalMethodsForDomain([null, null])).toBe("");
  });

  it("renders non-string array elements via their JSON text representation", () => {
    expect(normalizeStatisticalMethodsForDomain([3.14, true, "chi-square"])).toBe(
      "3.14, true, chi-square",
    );
    expect(normalizeStatisticalMethodsForDomain([["nested"]])).toBe('["nested"]');
  });

  it("throws TypeError for a top-level object", () => {
    expect(() => normalizeStatisticalMethodsForDomain({ method: "ANOVA" })).toThrow(TypeError);
  });

  it("throws TypeError for a top-level number", () => {
    expect(() => normalizeStatisticalMethodsForDomain(42)).toThrow(TypeError);
  });

  it("throws TypeError for a top-level boolean", () => {
    expect(() => normalizeStatisticalMethodsForDomain(false)).toThrow(TypeError);
  });
});
