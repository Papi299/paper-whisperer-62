import { describe, it, expect } from "vitest";
import {
  isMissingRawPublicationTypesColumn,
  normalizePublicationTypes,
  toEvaluatorPublicationTypes,
} from "../publicationTypes";

describe("normalizePublicationTypes", () => {
  it("preserves a comma-bearing official type and the source order", () => {
    expect(
      normalizePublicationTypes([
        "Clinical Trial, Phase II",
        "Multicenter Study",
        "Journal Article",
      ]),
    ).toEqual(["Clinical Trial, Phase II", "Multicenter Study", "Journal Article"]);
  });

  it("trims entries and drops blank ones", () => {
    expect(normalizePublicationTypes(["  Case Report  ", "", "   "])).toEqual(["Case Report"]);
  });

  it("maps every no-provenance shape to null", () => {
    // NULL / absent / empty all mean the same thing: nothing structured was
    // persisted, so the legacy joined string stays authoritative.
    expect(normalizePublicationTypes(undefined)).toBeNull();
    expect(normalizePublicationTypes(null)).toBeNull();
    expect(normalizePublicationTypes([])).toBeNull();
    expect(normalizePublicationTypes(["", "  "])).toBeNull();
  });

  it("rejects malformed values wholesale rather than salvaging part of them", () => {
    // A value that is not an array of strings is untrustworthy provenance; a
    // partial read would silently invent boundaries the source never stated.
    expect(normalizePublicationTypes({})).toBeNull();
    expect(normalizePublicationTypes("Clinical Trial, Phase II")).toBeNull();
    expect(normalizePublicationTypes([123])).toBeNull();
    expect(normalizePublicationTypes(["Clinical Trial", 7])).toBeNull();
    expect(normalizePublicationTypes([["Clinical Trial"]])).toBeNull();
  });

  it("never manufactures structure from a joined string", () => {
    // The one thing this column exists to prevent.
    expect(normalizePublicationTypes("Clinical Trial, Phase II, Multicenter Study")).toBeNull();
  });
});

describe("toEvaluatorPublicationTypes", () => {
  it("yields undefined for anything unusable, so the evaluator falls back", () => {
    expect(toEvaluatorPublicationTypes(null)).toBeUndefined();
    expect(toEvaluatorPublicationTypes([])).toBeUndefined();
    expect(toEvaluatorPublicationTypes({})).toBeUndefined();
    expect(toEvaluatorPublicationTypes([123])).toBeUndefined();
  });

  it("yields the canonical values when the row carries real provenance", () => {
    expect(toEvaluatorPublicationTypes(["Clinical Trial, Phase II"])).toEqual([
      "Clinical Trial, Phase II",
    ]);
  });
});

describe("isMissingRawPublicationTypesColumn", () => {
  it("recognizes the exact error a pre-migration database returns", () => {
    // Captured verbatim from a local stack with the column dropped:
    //   HTTP 400 + this body.
    expect(
      isMissingRawPublicationTypesColumn({
        code: "42703",
        details: null,
        hint: null,
        message: "column papers.raw_publication_types does not exist",
      }),
    ).toBe(true);
  });

  it("rejects the same SQLSTATE for a different column", () => {
    // The sharp case. 42703 alone would make an unrelated schema problem look
    // like the compatibility condition, and the retry would hide it rather
    // than fix it.
    expect(
      isMissingRawPublicationTypesColumn({
        code: "42703",
        message: "column papers.some_other_column does not exist",
      }),
    ).toBe(false);
  });

  it("rejects the right column name under a different SQLSTATE", () => {
    expect(
      isMissingRawPublicationTypesColumn({
        code: "42501",
        message: "permission denied for column raw_publication_types",
      }),
    ).toBe(false);
  });

  it("rejects every unrelated failure shape", () => {
    expect(isMissingRawPublicationTypesColumn({ code: "42501", message: "permission denied for table papers" })).toBe(false);
    expect(isMissingRawPublicationTypesColumn({ code: "PGRST301", message: "JWT expired" })).toBe(false);
    expect(isMissingRawPublicationTypesColumn({ code: "57014", message: "canceling statement due to statement timeout" })).toBe(false);
    expect(isMissingRawPublicationTypesColumn({ message: "TypeError: Failed to fetch" })).toBe(false);
    expect(isMissingRawPublicationTypesColumn(new Error("column papers.raw_publication_types does not exist"))).toBe(false);
    expect(isMissingRawPublicationTypesColumn(null)).toBe(false);
    expect(isMissingRawPublicationTypesColumn(undefined)).toBe(false);
    expect(isMissingRawPublicationTypesColumn("42703")).toBe(false);
    expect(isMissingRawPublicationTypesColumn({})).toBe(false);
  });
});
