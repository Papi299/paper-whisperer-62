import { describe, expect, it } from "vitest";
import { STUDY_LABEL_MAX_LENGTH, validateStudyLabel } from "@/lib/evidence/validation";
import { suggestStudyLabel, surnameOf } from "../labelSuggestion";

describe("surnameOf", () => {
  it.each([
    ["Phillips SM", "Phillips"],
    ["van der Berg A", "van der Berg"],
    ["Smith, John", "Smith"],
    ["  Doe   J  ", "Doe"],
    ["Plato", "Plato"],
    ["Jane Doe", "Doe"],
  ])("%j → %j", (author, surname) => {
    expect(surnameOf(author)).toBe(surname);
  });

  it("has no surname for a blank author", () => {
    expect(surnameOf("   ")).toBeNull();
    expect(surnameOf(", J")).toBeNull();
  });
});

describe("suggestStudyLabel", () => {
  it("suggests ‹first author› ‹year›", () => {
    expect(suggestStudyLabel({ authors: ["Phillips SM", "Doe J"], year: 2021, title: "T" })).toBe("Phillips 2021");
  });

  it("uses what it has: the author alone, or the year alone", () => {
    expect(suggestStudyLabel({ authors: ["Doe J"], year: null, title: "T" })).toBe("Doe");
    expect(suggestStudyLabel({ authors: [], year: 2019, title: "T" })).toBe("2019");
  });

  it("falls back to the title, then to a neutral name", () => {
    expect(suggestStudyLabel({ authors: [], year: null, title: "  A trial of something  " })).toBe("A trial of something");
    expect(suggestStudyLabel({ authors: null, year: null, title: "" })).toBe("Study 1");
    expect(suggestStudyLabel({})).toBe("Study 1");
  });

  it("never suggests a name the study label rules refuse", () => {
    const longTitle = "Word ".repeat(80);
    const suggestion = suggestStudyLabel({ authors: [], year: null, title: longTitle });
    expect(Array.from(suggestion)).toHaveLength(STUDY_LABEL_MAX_LENGTH);
    expect(suggestion.endsWith("…")).toBe(true);
    for (const paper of [{ authors: ["Phillips SM"], year: 2021 }, { title: longTitle }, {}]) {
      expect(validateStudyLabel(suggestStudyLabel(paper)).ok).toBe(true);
    }
  });

  it("ignores a year that is not a whole number", () => {
    expect(suggestStudyLabel({ authors: ["Doe J"], year: 2020.5 })).toBe("Doe");
  });
});
