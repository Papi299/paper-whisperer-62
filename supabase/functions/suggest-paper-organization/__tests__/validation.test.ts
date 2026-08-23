// @vitest-environment node
//
// The module under test is pure, but the sibling handler suite runs in `node`
// for its `AbortSignal.timeout` usage; keeping the whole function's suite on one
// environment avoids a surprising split.
import { describe, it, expect } from "vitest";
import {
  MAX_ABSTRACT_LENGTH,
  MAX_CURRENT_PROJECT_IDS,
  MAX_CURRENT_TAG_IDS,
  MAX_KEYWORD_LENGTH,
  MAX_KEYWORDS,
  MAX_STUDY_TYPE_LENGTH,
  MAX_TITLE_LENGTH,
} from "../contract.ts";
import { validateSuggestRequest } from "../validation.ts";

/**
 * AI-PROJECT-TAG-SUGGESTIONS-001A — request validation.
 *
 * Everything here runs before a quota unit can be spent, so each rejection below
 * is also an assertion that the user is not charged for a malformed request. The
 * bounds are asserted at the boundary (max passes, max+1 fails) so a future edit
 * that loosens a constant fails a test rather than silently widening the
 * provider payload.
 */

const PAPER_ID = "6f1a2b3c-4d5e-4f60-8a91-b2c3d4e5f607";

function body(overrides: Record<string, unknown> = {}) {
  return {
    paperId: PAPER_ID,
    draft: { title: "Protein timing and hypertrophy", abstract: "A randomized trial." },
    ...overrides,
  };
}

function expectRejected(result: ReturnType<typeof validateSuggestRequest>, reason: string) {
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("expected rejection");
  expect(result.reason).toBe(reason);
}

describe("validateSuggestRequest — identity and shape", () => {
  it("accepts a well-formed request", () => {
    const result = validateSuggestRequest(body());
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.message);
    expect(result.request.paperId).toBe(PAPER_ID);
    expect(result.request.draft.title).toBe("Protein timing and hypertrophy");
  });

  it.each([
    ["a non-object body", "not an object"],
    ["null", null],
    ["an array", []],
  ])("rejects %s", (_label, value) => {
    expectRejected(validateSuggestRequest(value), "invalid_body");
  });

  it("rejects a missing paperId", () => {
    const { paperId: _omitted, ...rest } = body();
    expectRejected(validateSuggestRequest(rest), "invalid_paper_id");
  });

  it.each([
    ["a non-UUID string", "not-a-uuid"],
    ["a numeric id", 42],
    ["a UUID-ish string with a bad version nibble", "6f1a2b3c-4d5e-9f60-8a91-b2c3d4e5f607"],
    ["a SQL fragment", "' OR 1=1 --"],
  ])("rejects %s as paperId", (_label, paperId) => {
    expectRejected(validateSuggestRequest(body({ paperId })), "invalid_paper_id");
  });

  it("rejects a missing draft", () => {
    expectRejected(validateSuggestRequest({ paperId: PAPER_ID }), "invalid_draft");
  });

  /**
   * The load-bearing property behind "no arbitrary user_id can influence
   * identity": the validated request is built by naming fields, so anything else
   * in the body is simply not carried forward.
   */
  it("ignores every field it was not asked to read", () => {
    const result = validateSuggestRequest(
      body({
        user_id: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
        userId: "attacker",
        notes: "private notes",
        authors: [{ name: "Someone" }],
        pmid: "12345678",
        doi: "10.1000/xyz",
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.message);
    expect(Object.keys(result.request).sort()).toEqual([
      "currentProjectIds",
      "currentTagIds",
      "draft",
      "paperId",
    ]);
    expect(Object.keys(result.request.draft).sort()).toEqual([
      "abstract",
      "keywords",
      "studyType",
      "title",
    ]);
    expect(JSON.stringify(result.request)).not.toContain("private notes");
    expect(JSON.stringify(result.request)).not.toContain("attacker");
  });
});

describe("validateSuggestRequest — title", () => {
  it("rejects a missing title", () => {
    expectRejected(validateSuggestRequest(body({ draft: { abstract: "x" } })), "invalid_type");
  });

  it("rejects a non-string title", () => {
    expectRejected(validateSuggestRequest(body({ draft: { title: 7 } })), "invalid_type");
  });

  it.each([
    ["an empty title", ""],
    ["a whitespace-only title", "   \n\t "],
  ])("rejects %s", (_label, title) => {
    expectRejected(validateSuggestRequest(body({ draft: { title, abstract: "x" } })), "missing_title");
  });

  it("accepts a title at exactly the bound and rejects one character more", () => {
    const atBound = "a".repeat(MAX_TITLE_LENGTH);
    expect(validateSuggestRequest(body({ draft: { title: atBound, abstract: "x" } })).ok).toBe(true);
    expectRejected(
      validateSuggestRequest(body({ draft: { title: atBound + "a", abstract: "x" } })),
      "bounds_exceeded",
    );
  });
});

describe("validateSuggestRequest — eligibility", () => {
  it("rejects a title-only request before any quota or provider work", () => {
    expectRejected(
      validateSuggestRequest(body({ draft: { title: "A title and nothing else" } })),
      "insufficient_evidence",
    );
  });

  it("rejects a title with only blank supporting fields", () => {
    expectRejected(
      validateSuggestRequest(
        body({ draft: { title: "T", abstract: "   ", keywords: ["", "  "], studyType: "" } }),
      ),
      "insufficient_evidence",
    );
  });

  it.each([
    ["an abstract", { abstract: "A randomized controlled trial of two diets." }],
    ["a keyword", { keywords: ["nutrition"] }],
    ["a study type", { studyType: "Randomized Controlled Trial" }],
  ])("accepts a title plus %s", (_label, extra) => {
    const result = validateSuggestRequest(body({ draft: { title: "Valid title", ...extra } }));
    expect(result.ok).toBe(true);
  });
});

describe("validateSuggestRequest — bounds", () => {
  it("accepts an abstract at the bound and rejects one character more", () => {
    const atBound = "a".repeat(MAX_ABSTRACT_LENGTH);
    expect(validateSuggestRequest(body({ draft: { title: "T", abstract: atBound } })).ok).toBe(true);
    expectRejected(
      validateSuggestRequest(body({ draft: { title: "T", abstract: atBound + "a" } })),
      "bounds_exceeded",
    );
  });

  it("accepts a study type at the bound and rejects one character more", () => {
    const atBound = "s".repeat(MAX_STUDY_TYPE_LENGTH);
    expect(validateSuggestRequest(body({ draft: { title: "T", studyType: atBound } })).ok).toBe(true);
    expectRejected(
      validateSuggestRequest(body({ draft: { title: "T", studyType: atBound + "s" } })),
      "bounds_exceeded",
    );
  });

  it("accepts the maximum keyword count and rejects one more", () => {
    const atBound = Array.from({ length: MAX_KEYWORDS }, (_, i) => `k${i}`);
    expect(validateSuggestRequest(body({ draft: { title: "T", keywords: atBound } })).ok).toBe(true);
    expectRejected(
      validateSuggestRequest(body({ draft: { title: "T", keywords: [...atBound, "extra"] } })),
      "bounds_exceeded",
    );
  });

  it("accepts a keyword at the bound and rejects one character more", () => {
    const atBound = "k".repeat(MAX_KEYWORD_LENGTH);
    expect(validateSuggestRequest(body({ draft: { title: "T", keywords: [atBound] } })).ok).toBe(true);
    expectRejected(
      validateSuggestRequest(body({ draft: { title: "T", keywords: [atBound + "k"] } })),
      "bounds_exceeded",
    );
  });

  it("caps currentProjectIds and currentTagIds", () => {
    const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
    const projects = Array.from({ length: MAX_CURRENT_PROJECT_IDS }, (_, i) => uuid(i));
    const tags = Array.from({ length: MAX_CURRENT_TAG_IDS }, (_, i) => uuid(i + 1000));
    expect(validateSuggestRequest(body({ currentProjectIds: projects, currentTagIds: tags })).ok).toBe(
      true,
    );
    expectRejected(
      validateSuggestRequest(body({ currentProjectIds: [...projects, uuid(9999)] })),
      "bounds_exceeded",
    );
    expectRejected(
      validateSuggestRequest(body({ currentTagIds: [...tags, uuid(9999)] })),
      "bounds_exceeded",
    );
  });
});

describe("validateSuggestRequest — types", () => {
  it.each([
    ["abstract", { abstract: 12 }],
    ["studyType", { studyType: {} }],
    ["keywords", { keywords: "nutrition" }],
  ])("rejects a wrongly-typed %s", (_label, extra) => {
    expectRejected(
      validateSuggestRequest(body({ draft: { title: "T", abstract: "a", ...extra } })),
      "invalid_type",
    );
  });

  it("rejects a non-string keyword entry", () => {
    expectRejected(
      validateSuggestRequest(body({ draft: { title: "T", keywords: ["ok", 5] } })),
      "invalid_type",
    );
  });

  it("rejects non-array currentProjectIds", () => {
    expectRejected(validateSuggestRequest(body({ currentProjectIds: "abc" })), "invalid_type");
  });

  it("rejects a non-UUID entry in currentTagIds", () => {
    expectRejected(validateSuggestRequest(body({ currentTagIds: ["nope"] })), "invalid_id");
  });
});

describe("validateSuggestRequest — normalization", () => {
  it("trims values, drops blank keywords and de-duplicates", () => {
    const result = validateSuggestRequest(
      body({
        draft: {
          title: "  Spaced title  ",
          abstract: "  padded  ",
          studyType: "  Cohort  ",
          keywords: [" diet ", "diet", "  ", "exercise"],
        },
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.message);
    expect(result.request.draft.title).toBe("Spaced title");
    expect(result.request.draft.abstract).toBe("padded");
    expect(result.request.draft.studyType).toBe("Cohort");
    expect(result.request.draft.keywords).toEqual(["diet", "exercise"]);
  });

  it("normalizes an absent optional field to null rather than undefined", () => {
    const result = validateSuggestRequest(body({ draft: { title: "T", keywords: ["x"] } }));
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.message);
    expect(result.request.draft.abstract).toBeNull();
    expect(result.request.draft.studyType).toBeNull();
  });

  it("de-duplicates repeated ids so a repeat cannot inflate the selection shown to the model", () => {
    const id = "11111111-2222-4333-8444-555555555555";
    const result = validateSuggestRequest(body({ currentProjectIds: [id, id, id] }));
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.message);
    expect(result.request.currentProjectIds).toEqual([id]);
  });
});
