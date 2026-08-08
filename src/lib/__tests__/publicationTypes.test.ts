import { describe, it, expect } from "vitest";
import {
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
