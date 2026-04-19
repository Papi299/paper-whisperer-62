import { describe, it, expect } from "vitest";
import {
  getMatchedFields,
  tokenizeQuery,
  type MatchablePaper,
} from "../searchMatchFields";

const paper = (overrides: Partial<MatchablePaper> = {}): MatchablePaper => ({
  title: null,
  authors: null,
  journal: null,
  notes: null,
  abstract: null,
  ...overrides,
});

describe("tokenizeQuery", () => {
  it("splits on whitespace and drops empty tokens", () => {
    expect(tokenizeQuery("  randomized   trial  ")).toEqual([
      "randomized",
      "trial",
    ]);
  });

  it("strips the ten tsquery operator/control characters", () => {
    expect(tokenizeQuery("a&b|c!d(e)f:g*h<i>j'k\"l\\m")).toEqual([
      "a",
      "b",
      "c",
      "d",
      "e",
      "f",
      "g",
      "h",
      "i",
      "j",
      "k",
      "l",
      "m",
    ]);
  });

  it("returns no tokens for an all-blacklisted input", () => {
    expect(tokenizeQuery("!!!&&&((()))")).toEqual([]);
  });

  it("preserves Unicode letters (Hebrew, Cyrillic, Greek, CJK, Latin diacritics)", () => {
    expect(tokenizeQuery("רפואה исследование σαφής 研究 β-blocker café")).toEqual(
      ["רפואה", "исследование", "σαφής", "研究", "β-blocker", "café"],
    );
  });
});

describe("getMatchedFields — empty / no-op cases", () => {
  it("returns [] for an empty query", () => {
    expect(getMatchedFields("", paper({ title: "Anything" }))).toEqual([]);
  });

  it("returns [] for whitespace-only", () => {
    expect(getMatchedFields("   ", paper({ title: "Anything" }))).toEqual([]);
  });

  it("returns [] when the FTS query reduces to zero tokens", () => {
    expect(
      getMatchedFields("!!!&&&", paper({ title: "Hypertension guidelines" })),
    ).toEqual([]);
  });

  it("returns [] when no field matches", () => {
    expect(
      getMatchedFields("oncology", paper({ title: "Cardiac arrest review" })),
    ).toEqual([]);
  });
});

describe("getMatchedFields — FTS path (≥3 chars, prefix match)", () => {
  it("matches a partial prefix of a stored word in title", () => {
    expect(
      getMatchedFields("guideli", paper({ title: "Asthma guideline 2024" })),
    ).toEqual(["Title"]);
  });

  it("matches across multiple fields and emits in fixed UI order", () => {
    const p = paper({
      title: "Diabetes outcomes",
      abstract: "A study of diabetes management",
      authors: ["Diabetes Research Group"],
      journal: "Diabetes Care",
      notes: "Re-read for diabetes section",
    });
    expect(getMatchedFields("diab", p)).toEqual([
      "Title",
      "Abstract",
      "Authors",
      "Journal",
      "Notes",
    ]);
  });

  it("requires every multi-token query to find at least one prefix match per token (best-effort)", () => {
    // Both tokens prefix-match somewhere → reported (current behavior is OR over
    // tokens × words; this just confirms a reasonable hit).
    const p = paper({ title: "Randomized clinical trial of metformin" });
    expect(getMatchedFields("rand metf", p)).toEqual(["Title"]);
  });

  it("is case-insensitive for ASCII", () => {
    expect(
      getMatchedFields("CARD", paper({ journal: "Cardiology Today" })),
    ).toEqual(["Journal"]);
  });

  it("matches non-ASCII prefix (Hebrew)", () => {
    expect(
      getMatchedFields("רפו", paper({ notes: "מאמר על רפואה פנימית" })),
    ).toEqual(["Notes"]);
  });

  it("matches non-ASCII prefix (Cyrillic)", () => {
    expect(
      getMatchedFields("исслед", paper({ title: "Новое исследование" })),
    ).toEqual(["Title"]);
  });

  it("matches non-ASCII prefix (CJK)", () => {
    // Each CJK ideograph is its own \p{L}, so word-split treats them as letters.
    // "研究" splits into one word "研究"; query "研" is a prefix of it.
    expect(getMatchedFields("研", paper({ title: "癌症研究進展" }))).toEqual([
      "Title",
    ]);
  });

  it("strips operator characters from the query before matching", () => {
    expect(
      getMatchedFields("guid:*", paper({ title: "Asthma guidelines" })),
    ).toEqual(["Title"]);
  });

  it("treats hyphenated words as separate words after split", () => {
    // Field "covid-19" → words ["covid", "19"]. Query "covi" matches "covid".
    expect(
      getMatchedFields("covi", paper({ title: "covid-19 outcomes" })),
    ).toEqual(["Title"]);
  });

  it("does NOT match a substring inside the middle of a word (prefix-only)", () => {
    // "uideli" appears inside "guideline" but is not a prefix of any word
    // (the only word is "guideline" / "guidelines" / "2024"). FTS path is
    // prefix-only, so this should not match.
    expect(
      getMatchedFields("uideli", paper({ title: "Asthma guidelines 2024" })),
    ).toEqual([]);
  });

  it("checks each author independently (cross-author boundary does not match)", () => {
    // authors joined with a control-char separator that cannot appear in input,
    // so query "hnsm" (would span "John"+"Smith") must NOT match.
    expect(
      getMatchedFields("hnsm", paper({ authors: ["John", "Smith"] })),
    ).toEqual([]);
  });

  it("does match a prefix of a single author name", () => {
    expect(
      getMatchedFields("smi", paper({ authors: ["John", "Smith"] })),
    ).toEqual(["Authors"]);
  });
});

describe("getMatchedFields — short-query path (1–2 chars, ILIKE substring)", () => {
  it("matches a 1-char substring anywhere in the field", () => {
    expect(
      getMatchedFields("a", paper({ title: "Cardiac arrest" })),
    ).toEqual(["Title"]);
  });

  it("matches a 2-char substring inside a word", () => {
    // Substring path — would NOT match in FTS path.
    expect(
      getMatchedFields("ui", paper({ title: "guideline" })),
    ).toEqual(["Title"]);
  });

  it("is case-insensitive on the short path", () => {
    expect(getMatchedFields("CA", paper({ journal: "Cardiology" }))).toEqual([
      "Journal",
    ]);
  });

  it("returns [] on the short path when no field contains the substring", () => {
    expect(getMatchedFields("zz", paper({ title: "Cardiac arrest" }))).toEqual(
      [],
    );
  });
});

describe("getMatchedFields — abstract handling", () => {
  it("emits Abstract chip when abstract is present and matches", () => {
    expect(
      getMatchedFields(
        "metf",
        paper({
          title: "Cardiac outcomes",
          abstract: "We studied metformin in 200 patients",
        }),
      ),
    ).toEqual(["Abstract"]);
  });

  it("does NOT emit Abstract chip when abstract is absent (lazy-loaded)", () => {
    // No `abstract` key on the paper at all (matches list-payload shape).
    expect(
      getMatchedFields(
        "metf",
        paper({ title: "Cardiac outcomes" }),
      ),
    ).toEqual([]);
  });

  it("does NOT emit Abstract chip when abstract is null", () => {
    expect(
      getMatchedFields(
        "metf",
        paper({ title: "Cardiac outcomes", abstract: null }),
      ),
    ).toEqual([]);
  });
});
