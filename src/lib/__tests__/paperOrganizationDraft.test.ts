/**
 * The two pure draft rules behind the Edit Paper suggestion surface:
 * eligibility (may this draft be sent?) and the semantic fingerprint (is this
 * still the same draft?).
 */

import { describe, it, expect } from "vitest";
import {
  isDraftEligibleForSuggestions,
  organizationDraftFingerprint,
} from "@/lib/paperOrganizationDraft";

const draft = (over: Partial<Parameters<typeof isDraftEligibleForSuggestions>[0]> = {}) => ({
  title: "A trial of resistance training",
  abstract: "",
  keywords: [] as string[],
  studyType: "",
  ...over,
});

describe("isDraftEligibleForSuggestions", () => {
  it("rejects a title-only draft — the server's rule, mirrored", () => {
    expect(isDraftEligibleForSuggestions(draft())).toBe(false);
  });

  it("rejects a draft with no title, whatever else it carries", () => {
    expect(isDraftEligibleForSuggestions(draft({ title: "", abstract: "long abstract" }))).toBe(false);
    expect(isDraftEligibleForSuggestions(draft({ title: "   ", keywords: ["k"] }))).toBe(false);
  });

  it("accepts a title plus an abstract", () => {
    expect(isDraftEligibleForSuggestions(draft({ abstract: "Randomised trial…" }))).toBe(true);
  });

  it("accepts a title plus at least one keyword", () => {
    expect(isDraftEligibleForSuggestions(draft({ keywords: ["sarcopenia"] }))).toBe(true);
  });

  it("accepts a title plus a study type", () => {
    expect(isDraftEligibleForSuggestions(draft({ studyType: "RCT" }))).toBe(true);
  });

  it("does not count whitespace as evidence", () => {
    expect(isDraftEligibleForSuggestions(draft({ abstract: "   ", studyType: "  " }))).toBe(false);
  });
});

describe("organizationDraftFingerprint", () => {
  it("is stable for the same semantic content", () => {
    expect(organizationDraftFingerprint(draft({ abstract: "A" }))).toBe(
      organizationDraftFingerprint(draft({ abstract: "A" })),
    );
  });

  it("ignores leading/trailing whitespace changes", () => {
    expect(organizationDraftFingerprint(draft({ abstract: "A" }))).toBe(
      organizationDraftFingerprint(draft({ abstract: "  A  " })),
    );
  });

  it.each([
    ["title", { title: "Something else" }],
    ["abstract", { abstract: "New abstract" }],
    ["keywords", { keywords: ["new"] }],
    ["studyType", { studyType: "Cohort" }],
  ])("changes when %s changes", (_label, over) => {
    expect(organizationDraftFingerprint(draft(over))).not.toBe(
      organizationDraftFingerprint(draft()),
    );
  });

  it("distinguishes keyword order, because the request sends the list as given", () => {
    expect(organizationDraftFingerprint(draft({ keywords: ["a", "b"] }))).not.toBe(
      organizationDraftFingerprint(draft({ keywords: ["b", "a"] })),
    );
  });
});
