// @vitest-environment node
import { describe, expect, it } from "vitest";

import { toAnchorId, toPaperId, toSnapshotId, type PaperId, type SnapshotId } from "../ids";
import { VALUE_STATE_RULES } from "../states";
import { VALUE_STATES, type FieldContent, type ValueState } from "../types";
import {
  btrimSpaces,
  checkStateReferences,
  countReferencePurposes,
  MAX_SUPPORTING_REFERENCES,
  trimListEntries,
  validateStudyLabel,
  validateStudyNotes,
  validateValueDraft,
  VALIDATION_MESSAGES,
  type ReferenceDraft,
  type ValidationResult,
  type ValueContext,
  type ValueDraft,
} from "../validation";
import { SECTION_J_ALLOWS } from "./fixtures/sectionJ";
import { cp } from "./fixtures/vectors";

/**
 * Advisory validation: the PR-A1 single-row CHECKs, the FK-PROOF-001 §J
 * state-reference matrix, the locator-only full-text policy, and the design-
 * family and group-role rules — without ever rewriting what the user wrote.
 */

const PAPER_A = toPaperId("a0000000-0000-4000-8000-0000000000a1") as PaperId;
const PAPER_B = toPaperId("b0000000-0000-4000-8000-0000000000b1") as PaperId;
const PAPER_X = toPaperId("c0000000-0000-4000-8000-0000000000c1") as PaperId;
const COPY_A_OLD = toSnapshotId("a0000000-0000-4000-8000-00000000c0a1") as SnapshotId;
const COPY_A = toSnapshotId("a0000000-0000-4000-8000-00000000c0a2") as SnapshotId;
const ABSTRACT = "Adults with type 2 diabetes (n = 1,204) were randomized; 1,204 completed the trial.";

const CONTEXT: ValueContext = {
  designProfile: "rct_parallel",
  target: { scope: "study" },
  links: [
    { paperId: PAPER_A, currentSnapshotId: COPY_A, snapshotIds: [COPY_A_OLD, COPY_A] },
    { paperId: PAPER_B, currentSnapshotId: null, snapshotIds: [] },
  ],
  copyTexts: new Map([
    [COPY_A, ABSTRACT],
    [COPY_A_OLD, "Adults with diabetes were randomized."],
  ]),
};

const codes = (result: ValidationResult) => result.issues.map((i) => i.code);
const errorCodes = (result: ValidationResult) => result.issues.filter((i) => i.severity === "error").map((i) => i.code);

const quote = (quoteText: string, extra: Partial<ReferenceDraft> = {}): ReferenceDraft =>
  ({ purpose: "supports", sourceKind: "abstract", paperId: PAPER_A, snapshotId: COPY_A, quoteText, ...extra }) as ReferenceDraft;
const locator = (kind = "page", text = "p. 4, Table 2"): ReferenceDraft =>
  ({ purpose: "supports", sourceKind: "full_text", paperId: PAPER_A, locator: { kind, text } }) as ReferenceDraft;
const examinedAbstract: ReferenceDraft = { purpose: "examined", sourceKind: "abstract", paperId: PAPER_A, snapshotId: COPY_A };
const examinedFullText: ReferenceDraft = { purpose: "examined", sourceKind: "full_text", paperId: PAPER_A };
const unavailableAbstractB: ReferenceDraft = { purpose: "unavailable", sourceKind: "abstract", paperId: PAPER_B };
const unavailableFullText: ReferenceDraft = { purpose: "unavailable", sourceKind: "full_text", paperId: PAPER_A };

const text = (t: string): FieldContent => ({ shape: "text", text: t });
const count = (reportedText: string, value: number): FieldContent => ({ shape: "integer_with_reported_text", reportedText, value });
const list = (...entries: string[]): FieldContent => ({ shape: "text_list", entries });

const draft = (overrides: Partial<ValueDraft>): ValueDraft => ({ fieldKey: "condition", state: "reported", content: text("Type 2 diabetes"), references: [quote("type 2 diabetes")], ...overrides });

describe("a well-formed value passes in each state", () => {
  it.each<[ValueState, Partial<ValueDraft>]>([
    ["reported", {}],
    ["not_reported", { content: null, references: [examinedAbstract] }],
    ["unclear", { content: null, stateReason: "conflicting", note: "abstract gives 120 and 118 randomized", references: [quote("type 2 diabetes")] }],
    ["not_applicable", { content: null, note: "Not a trial", references: [] }],
    ["source_unavailable", { content: null, references: [unavailableAbstractB] }],
  ])("%s", (state, overrides) => {
    const result = validateValueDraft(draft({ state, ...overrides }), CONTEXT);
    expect(result.issues).toEqual([]);
    expect(result.ok).toBe(true);
  });
});

describe("required and forbidden inputs per state (PR-A1 CHECKs)", () => {
  it("requires a value exactly when Reported, as the rule table says", () => {
    for (const state of VALUE_STATES) {
      const rule = VALUE_STATE_RULES[state];
      const withValue = validateValueDraft(draft({ state, stateReason: state === "unclear" ? "ambiguous" : null, note: "a sufficiently long note", references: [] }), CONTEXT);
      const withoutValue = validateValueDraft(draft({ state, content: null, stateReason: state === "unclear" ? "ambiguous" : null, note: "a sufficiently long note", references: [] }), CONTEXT);
      expect(codes(withValue).includes("value.not_allowed"), state).toBe(rule.value === "forbidden");
      expect(codes(withoutValue).includes("value.required"), state).toBe(rule.value === "required");
    }
  });

  it("tells absent from empty: no row is not a value, and an empty value is not a value either", () => {
    expect(codes(validateValueDraft(draft({ content: undefined }), CONTEXT))).toContain("value.required");
    expect(codes(validateValueDraft(draft({ content: text("") }), CONTEXT))).toContain("text.blank");
    expect(codes(validateValueDraft(draft({ content: text(`${cp(0x00a0)}${cp(0x200b)}`) }), CONTEXT))).toContain("text.blank");
    expect(VALIDATION_MESSAGES["value.required"]).toBe("Enter the value, or choose another state.");
  });

  it("requires a reason exactly when Unclear, from the closed list", () => {
    const unclear = draft({ state: "unclear", content: null, note: "abstract gives 120 and 118", references: [examinedAbstract] });
    expect(codes(validateValueDraft({ ...unclear, stateReason: null }, CONTEXT))).toContain("state_reason.required");
    expect(codes(validateValueDraft({ ...unclear, stateReason: "vague" as never }, CONTEXT))).toContain("state_reason.unknown");
    expect(codes(validateValueDraft(draft({ stateReason: "ambiguous" }), CONTEXT))).toContain("state_reason.not_allowed");
  });

  it("measures the Unclear and Not applicable notes as the CHECK does: code points after trimming spaces", () => {
    const unclear = (note: string | null) =>
      codes(validateValueDraft(draft({ state: "unclear", content: null, stateReason: "ambiguous", note, references: [examinedAbstract] }), CONTEXT));
    expect(unclear(null)).toContain("note.required_for_unclear");
    expect(unclear("too short")).toContain("note.required_for_unclear");
    expect(unclear("   exactly10!   ".replace("exactly10!", "0123456789"))).not.toContain("note.required_for_unclear");
    expect(unclear(`${cp(0x1f600)}`.repeat(9))).toContain("note.required_for_unclear");
    expect(unclear(`${cp(0x1f600)}`.repeat(10))).not.toContain("note.required_for_unclear");
    const na = (note: string | null) => codes(validateValueDraft(draft({ state: "not_applicable", content: null, note, references: [] }), CONTEXT));
    expect(na("no")).toContain("note.required_for_not_applicable");
    expect(na(" no ")).toContain("note.required_for_not_applicable");
    expect(na("n/a")).not.toContain("note.required_for_not_applicable");
  });

  it("bounds every note and refuses an empty one", () => {
    expect(codes(validateValueDraft(draft({ note: "x".repeat(2001) }), CONTEXT))).toContain("note.too_long");
    expect(codes(validateValueDraft(draft({ note: "x".repeat(2000) }), CONTEXT))).toEqual([]);
    expect(codes(validateValueDraft(draft({ note: "" }), CONTEXT))).toContain("note.blank");
    expect(codes(validateValueDraft(draft({ note: 7 as never }), CONTEXT))).toContain("note.not_text");
  });
});

describe("value shapes and bounds", () => {
  it("checks text against its own field's bound, in code points", () => {
    expect(codes(validateValueDraft(draft({ content: text("x".repeat(500)) }), CONTEXT))).toEqual([]);
    expect(codes(validateValueDraft(draft({ content: text("x".repeat(501)) }), CONTEXT))).toContain("text.too_long");
    expect(codes(validateValueDraft(draft({ content: text(cp(0x1f600).repeat(500)) }), CONTEXT))).toEqual([]);
    const eligibility = draft({ fieldKey: "eligibility_criteria", content: text("x".repeat(4000)), references: [] });
    expect(errorCodes(validateValueDraft(eligibility, CONTEXT))).toEqual([]);
    const result = validateValueDraft(draft({ content: text("x".repeat(501)) }), CONTEXT);
    expect(result.issues[0].message).toContain("500");
  });

  it("refuses the wrong shape and malformed content instead of coercing it", () => {
    expect(codes(validateValueDraft(draft({ content: { shape: "code", code: "x" } }), CONTEXT))).toContain("value.wrong_shape");
    expect(codes(validateValueDraft(draft({ content: "Type 2 diabetes" as never }), CONTEXT))).toContain("value.wrong_shape");
    expect(codes(validateValueDraft(draft({ content: { shape: "text", text: 42 } as never }), CONTEXT))).toContain("text.not_text");
    expect(codes(validateValueDraft(draft({ content: text(`a${String.fromCharCode(0xd800)}`) }), CONTEXT))).toContain("text.malformed");
  });

  it("accepts only a code from the field's closed list", () => {
    const classification = (code: string) =>
      codes(validateValueDraft(draft({ fieldKey: "design_classification", content: { shape: "code", code }, references: [] }), CONTEXT));
    expect(classification("rct_crossover")).not.toContain("code.not_in_list");
    expect(classification("RCT_crossover")).toContain("code.not_in_list");
    expect(classification("placebo")).toContain("code.not_in_list");
  });

  it("requires the reported text AND the confirmed integer of a number, 0 to 10,000,000", () => {
    const n = (content: unknown) =>
      codes(validateValueDraft(draft({ fieldKey: "n_randomized", content: content as FieldContent, references: [] }), CONTEXT));
    expect(n(count("n = 120", 120))).not.toContain("count.out_of_range");
    expect(n(count("none", 0))).toEqual(["value.no_source_given"]);
    expect(n(count("10,000,000", 10_000_000))).toEqual(["value.no_source_given"]);
    expect(n(count("10,000,001", 10_000_001))).toContain("count.out_of_range");
    expect(n(count("minus five", -5))).toContain("count.out_of_range");
    expect(n(count("12.5", 12.5))).toContain("count.not_integer");
    expect(n({ shape: "integer_with_reported_text", reportedText: "120", value: "120" })).toContain("count.not_integer");
    expect(n({ shape: "integer_with_reported_text", reportedText: "n = 120" })).toContain("count.value_required");
    expect(n({ shape: "integer_with_reported_text", value: 120 })).toContain("count.reported_text_required");
    expect(n(count("x".repeat(201), 1))).toContain("text.too_long");
  });

  it("checks registration numbers: 1-5 entries of 3-50 characters with no white space", () => {
    const ids = (...entries: string[]) => codes(validateValueDraft(draft({ fieldKey: "registration_ids", content: list(...entries), references: [] }), CONTEXT));
    expect(ids("NCT01234567")).toEqual(["value.no_source_given"]);
    expect(ids()).toContain("list.empty");
    expect(ids("NCT1", "NCT2", "NCT3", "NCT4", "NCT5", "NCT6")).toContain("list.too_many");
    expect(ids("NC")).toContain("list.entry_too_short");
    expect(ids("N".repeat(51))).toContain("list.entry_too_long");
    expect(ids("NCT 0123")).toContain("list.entry_contains_whitespace");
    expect(ids(`NCT${cp(0x00a0)}0123`)).toContain("list.entry_contains_whitespace");
    expect(ids("NCT0123", "NCT0123")).toContain("list.entry_duplicate");
    expect(ids("NCT0123", "")).toContain("list.entry_blank");
    expect(ids(`NCT${cp(0x1f)}0123`)).toContain("list.entry_forbidden_character");
  });

  it("checks time points: 1-10 entries of 1-100 characters, inner white space only", () => {
    const tp = (...entries: string[]) =>
      codes(validateValueDraft(draft({ fieldKey: "time_points", content: list(...entries), references: [] }), { ...CONTEXT, target: { scope: "outcome" } }));
    expect(tp("12 weeks", "6 months after randomization")).toEqual(["value.no_source_given"]);
    expect(tp("x")).toEqual(["value.no_source_given"]);
    expect(tp(" 12 weeks")).toContain("list.entry_untrimmed");
    expect(tp(`12 weeks${cp(0x3000)}`)).toContain("list.entry_untrimmed");
    expect(tp("x".repeat(101))).toContain("list.entry_too_long");
    expect(tp(...Array.from({ length: 11 }, (_, i) => `week ${i}`))).toContain("list.too_many");
    expect(tp("12 weeks", "12 weeks ")).toContain("list.entry_duplicate");
    expect(tp("   ")).toContain("list.entry_blank");
    expect(tp(cp(0x00ad))).toContain("list.entry_blank");
  });

  it("never rewrites an entry; trimming is an explicit, reported step", () => {
    const entries = [" 12 weeks", "6 months", `24 weeks${cp(0x00a0)}`];
    const trimmed = trimListEntries(entries);
    expect(trimmed.entries).toEqual(["12 weeks", "6 months", "24 weeks"]);
    expect(trimmed.changed).toEqual([0, 2]);
    expect(entries[0]).toBe(" 12 weeks");
  });
});

describe("design family, scope and group role", () => {
  it("refuses a field from another part of the record", () => {
    expect(codes(validateValueDraft(draft({ fieldKey: "duration" }), CONTEXT))).toContain("field.wrong_scope");
    expect(codes(validateValueDraft(draft({ fieldKey: "condition" }), { ...CONTEXT, target: { scope: "outcome" } }))).toContain("field.wrong_scope");
  });

  it("refuses group fields and the number randomized in a non-intervention study", () => {
    const nonIntervention = { ...CONTEXT, designProfile: "non_intervention" as const };
    expect(codes(validateValueDraft(draft({ fieldKey: "duration", content: text("12 weeks"), references: [] }), { ...nonIntervention, target: { scope: "arm", armRole: "intervention" } }))).toContain("field.not_allowed_for_design");
    expect(codes(validateValueDraft(draft({ fieldKey: "n_randomized", content: count("120", 120), references: [] }), nonIntervention))).toContain("field.not_allowed_for_design");
    expect(errorCodes(validateValueDraft(draft({ fieldKey: "n_enrolled", content: count("120", 120), references: [] }), nonIntervention))).toEqual([]);
  });

  it("applies comparator type to comparator groups only", () => {
    const comparator = draft({ fieldKey: "comparator_type", content: { shape: "code", code: "placebo" }, references: [] });
    expect(codes(validateValueDraft(comparator, { ...CONTEXT, target: { scope: "arm", armRole: "intervention" } }))).toContain("field.not_allowed_for_arm_role");
    expect(errorCodes(validateValueDraft(comparator, { ...CONTEXT, target: { scope: "arm", armRole: "comparator" } }))).toEqual([]);
  });

  it("refuses an unknown field, an unknown state, and an unusable context", () => {
    expect(codes(validateValueDraft(draft({ fieldKey: "n_randomized_arm" as never }), CONTEXT))).toContain("field.unknown");
    expect(codes(validateValueDraft(draft({ state: "unsupported" as never }), CONTEXT))).toEqual(["state.unknown"]);
    expect(codes(validateValueDraft(draft({}), { ...CONTEXT, designProfile: "rct" as never }))).toEqual(["context.invalid"]);
  });
});

describe("which sources each state takes (FK-PROOF-001 §J)", () => {
  const state = (s: ValueState, references: ReferenceDraft[], extra: Partial<ValueDraft> = {}) =>
    errorCodes(
      validateValueDraft(
        draft({ state: s, content: s === "reported" ? text("Type 2 diabetes") : null, stateReason: s === "unclear" ? "incomplete" : null, note: "long enough note", references, ...extra }),
        CONTEXT,
      ),
    );

  it("Reported: up to 3 supporting sources, nothing examined or unavailable", () => {
    expect(state("reported", [quote("type 2 diabetes"), locator(), quote("randomized")])).toEqual([]);
    expect(state("reported", [quote("type 2 diabetes"), locator(), quote("randomized"), quote("completed")])).toContain("references.too_many_supporting");
    expect(state("reported", [examinedAbstract])).toContain("references.examined_not_allowed");
    expect(state("reported", [unavailableFullText])).toContain("references.unavailable_not_allowed");
  });

  it("Not reported: at least one examined source, no supporting one", () => {
    expect(state("not_reported", [examinedAbstract, unavailableAbstractB])).toEqual([]);
    expect(state("not_reported", [])).toContain("references.examined_required");
    expect(state("not_reported", [examinedFullText, quote("type 2 diabetes")])).toContain("references.supporting_not_allowed");
  });

  it("Unclear: a supporting or an examined source", () => {
    expect(state("unclear", [examinedFullText])).toEqual([]);
    expect(state("unclear", [unavailableAbstractB])).toContain("references.basis_required");
  });

  it("Couldn't check: at least one unavailable source, nothing else", () => {
    expect(state("source_unavailable", [unavailableFullText])).toEqual([]);
    expect(state("source_unavailable", [])).toContain("references.unavailable_required");
    expect(state("source_unavailable", [unavailableFullText, examinedAbstract])).toContain("references.examined_not_allowed");
    expect(state("source_unavailable", [unavailableFullText, locator()])).toContain("references.supporting_not_allowed");
  });

  it("Not applicable: no source at all", () => {
    expect(state("not_applicable", [examinedAbstract])).toContain("references.not_allowed");
  });

  it("agrees with the rule table for every state and purpose", () => {
    const baseline: Record<ValueState, ReferenceDraft[]> = {
      reported: [],
      not_reported: [examinedAbstract],
      unclear: [examinedAbstract],
      not_applicable: [],
      source_unavailable: [unavailableAbstractB],
    };
    const addition = { supports: quote("type 2 diabetes"), examined: examinedFullText, unavailable: unavailableFullText };
    const refErrors = (s: ValueState, references: ReferenceDraft[]) => state(s, references).filter((c) => c.startsWith("references."));
    for (const s of VALUE_STATES) {
      const rule = VALUE_STATE_RULES[s];
      expect(refErrors(s, baseline[s]), `${s} baseline`).toEqual([]);
      for (const purpose of ["supports", "examined", "unavailable"] as const) {
        const added = refErrors(s, [...baseline[s], addition[purpose]]);
        expect(added.length > 0, `${s} + one ${purpose}`).toBe(rule[purpose].max === 0);
        if (rule[purpose].min > 0) expect(refErrors(s, baseline[s].filter((r) => r.purpose !== purpose)).length, `${s} without ${purpose}`).toBeGreaterThan(0);
      }
      if (rule.supportsOrExaminedMin > 0) expect(refErrors(s, []), `${s} without basis`).toContain("references.basis_required");
    }
  });

  it("allows one assessment per report and source kind", () => {
    const twice: ReferenceDraft[] = [examinedFullText, { purpose: "unavailable", sourceKind: "full_text", paperId: PAPER_A }];
    expect(state("not_reported", twice)).toContain("references.duplicate_assessment");
  });
});

describe("the shared state-reference rule (checkStateReferences)", () => {
  it("refuses exactly what FK-PROOF-001 §J refuses, for every count of every purpose", () => {
    let cells = 0;
    for (const s of VALUE_STATES) {
      for (let supports = 0; supports <= 5; supports++) {
        for (let examined = 0; examined <= 3; examined++) {
          for (let unavailable = 0; unavailable <= 3; unavailable++) {
            const counts = { supports, examined, unavailable };
            const broken = checkStateReferences(s, counts);
            expect(broken.length === 0, `${s} with ${supports}/${examined}/${unavailable}: ${broken.join(", ")}`).toBe(SECTION_J_ALLOWS[s](counts));
            cells += 1;
          }
        }
      }
    }
    expect(cells).toBe(VALUE_STATES.length * 6 * 4 * 4);
  });

  it("is what validateValueDraft reports for a draft's sources", () => {
    const state = (s: ValueState, references: ReferenceDraft[]) =>
      errorCodes(
        validateValueDraft(
          draft({ state: s, content: s === "reported" ? text("Type 2 diabetes") : null, stateReason: s === "unclear" ? "incomplete" : null, note: "long enough note", references }),
          CONTEXT,
        ),
      );
    const drafts: [ValueState, ReferenceDraft[]][] = [
      ["reported", [examinedAbstract, unavailableFullText]],
      ["not_reported", [quote("type 2 diabetes")]],
      ["unclear", [unavailableAbstractB]],
      ["source_unavailable", [locator(), examinedAbstract]],
      ["not_applicable", [examinedAbstract, unavailableAbstractB]],
    ];
    for (const [s, references] of drafts) {
      const reported = state(s, references).filter((c) => c.startsWith("references.") && c !== "references.duplicate_assessment");
      expect(reported, s).toEqual([...checkStateReferences(s, countReferencePurposes(references))]);
      expect(reported.length, s).toBeGreaterThan(0);
    }
  });

  it("names a purpose the state forbids, one it requires, and the Unclear minimum, in a fixed order", () => {
    expect(checkStateReferences("source_unavailable", { supports: 4, examined: 1, unavailable: 0 })).toEqual([
      "references.too_many_supporting",
      "references.supporting_not_allowed",
      "references.examined_not_allowed",
      "references.unavailable_required",
    ]);
    expect(checkStateReferences("not_applicable", { supports: 1, examined: 1, unavailable: 1 })).toEqual(["references.not_allowed"]);
    expect(checkStateReferences("unclear", { supports: 0, examined: 0, unavailable: 2 })).toEqual(["references.basis_required"]);
    expect(Object.isFrozen(checkStateReferences("reported", { supports: 0, examined: 0, unavailable: 0 }))).toBe(true);
  });

  it("reads a rule table whose only bounds are none, at least one, and PR-A1's cap of three supporting", () => {
    for (const s of VALUE_STATES) {
      const rule = VALUE_STATE_RULES[s];
      expect([0, MAX_SUPPORTING_REFERENCES], s).toContain(rule.supports.max);
      expect(rule.supports.min, s).toBe(0);
      for (const purpose of ["examined", "unavailable"] as const) {
        expect([0, null], `${s} ${purpose}`).toContain(rule[purpose].max);
        expect([0, 1], `${s} ${purpose}`).toContain(rule[purpose].min);
      }
    }
  });

  it("counts references by purpose", () => {
    expect(countReferencePurposes([quote("a b c"), locator(), examinedAbstract, unavailableAbstractB, unavailableFullText])).toEqual({
      supports: 2,
      examined: 1,
      unavailable: 2,
    });
    expect(countReferencePurposes([])).toEqual({ supports: 0, examined: 0, unavailable: 0 });
    expect(countReferencePurposes([{ purpose: "cites" } as never])).toEqual({ supports: 0, examined: 0, unavailable: 0 });
  });
});

describe("one source reference (the PR-A1 reference matrix)", () => {
  const refCodes = (reference: unknown, s: ValueState = "reported") =>
    errorCodes(validateValueDraft(draft({ state: s, content: s === "reported" ? text("Type 2 diabetes") : null, references: [reference as ReferenceDraft] }), CONTEXT));

  it("keeps full-text references locator-only: no full-text quote can be stored", () => {
    expect(refCodes(locator())).toEqual([]);
    expect(refCodes({ ...locator(), quoteText: "A passage from the publisher's PDF" })).toContain("reference.quote_not_allowed");
    expect(refCodes({ purpose: "supports", sourceKind: "full_text", paperId: PAPER_A })).toContain("reference.locator_required");
    expect(refCodes(locator("chapter"))).toContain("reference.locator_kind_unknown");
    expect(refCodes(locator("page", "x".repeat(201)))).toContain("reference.locator_text_invalid");
    expect(refCodes(locator("page", "   "))).toContain("reference.locator_text_invalid");
  });

  it("defers every non-library source", () => {
    expect(refCodes({ purpose: "supports", sourceKind: "other_source", paperId: PAPER_A })).toEqual(["reference.other_source_deferred"]);
    expect(refCodes({ purpose: "supports", sourceKind: "registry", paperId: PAPER_A })).toContain("reference.source_kind_unknown");
    expect(refCodes({ purpose: "cites", sourceKind: "abstract", paperId: PAPER_A })).toContain("reference.purpose_unknown");
  });

  it("lets the browser send no server-attested match field", () => {
    expect(refCodes(quote("type 2 diabetes", { matchStart: 12, matchCount: 1 } as never))).toContain("reference.server_fields_not_allowed");
    expect(refCodes(quote("type 2 diabetes", { matchedAt: "2026-10-17T00:00:00Z" } as never))).toContain("reference.server_fields_not_allowed");
  });

  it("names only a report linked to the study, and its own copy", () => {
    expect(refCodes(quote("type 2 diabetes", { paperId: PAPER_X }))).toContain("reference.paper_not_linked");
    expect(refCodes(quote("type 2 diabetes", { paperId: "not-a-uuid" as never }))).toContain("reference.paper_invalid");
    expect(refCodes(quote("type 2 diabetes", { snapshotId: undefined as never }))).toContain("reference.snapshot_required");
    expect(refCodes(quote("type 2 diabetes", { paperId: PAPER_B }))).toContain("reference.snapshot_not_of_link");
    expect(refCodes({ ...locator(), snapshotId: COPY_A })).toContain("reference.snapshot_not_allowed");
  });

  it("puts a NEW quote on the link's current copy; an existing one may stay on a superseded copy", () => {
    expect(refCodes(quote("Adults with diabetes", { snapshotId: COPY_A_OLD }))).toContain("reference.snapshot_not_current");
    const carried = quote("Adults with diabetes", { snapshotId: COPY_A_OLD, anchorId: toAnchorId("d0000000-0000-4000-8000-0000000000d1")! });
    expect(refCodes(carried)).toEqual([]);
    expect(refCodes({ ...examinedAbstract, snapshotId: COPY_A_OLD }, "not_reported")).toContain("reference.snapshot_not_current");
  });

  it("refuses an unavailable abstract for a link that has a copy", () => {
    expect(refCodes({ purpose: "unavailable", sourceKind: "abstract", paperId: PAPER_A }, "source_unavailable")).toContain("reference.unavailable_abstract_has_copy");
    expect(refCodes(unavailableAbstractB, "source_unavailable")).toEqual([]);
  });

  it("matches abstract quotes against the saved copy, in the browser too", () => {
    expect(refCodes(quote("type 1 diabetes"))).toContain("reference.quote_not_found");
    expect(refCodes(quote("1,204"))).toContain("reference.quote_ambiguous");
    expect(refCodes(quote("1,204", { occurrence: 2 }))).toEqual([]);
    expect(refCodes(quote("1,204", { occurrence: 3 }))).toContain("reference.occurrence_out_of_range");
    expect(refCodes(quote("1,204", { occurrence: 0 }))).toContain("reference.occurrence_out_of_range");
    expect(refCodes(quote("..."))).toContain("reference.quote_invalid");
    expect(refCodes(quote("ab"))).toContain("reference.quote_invalid");
    expect(refCodes(quote("x".repeat(1001)))).toContain("reference.quote_too_long");
    expect(refCodes({ ...examinedFullText, occurrence: 1 }, "not_reported")).toContain("reference.occurrence_not_allowed");
    // Without the copy's text, only the quote's own rules can be checked.
    const noTexts = { ...CONTEXT, copyTexts: undefined };
    expect(errorCodes(validateValueDraft(draft({ references: [quote("type 1 diabetes")] }), noTexts))).toEqual([]);
    expect(validateValueDraft(draft({ references: [quote("1,204")] }), noTexts).ok).toBe(true);
  });

  it("refuses a reference that is not an object", () => {
    expect(refCodes(null)).toContain("reference.not_object");
    expect(errorCodes(validateValueDraft(draft({ references: "quote" as never }), CONTEXT))).toContain("references.not_list");
  });
});

describe("derived warnings never block", () => {
  it("says No source given for a Reported value without a supporting source", () => {
    const result = validateValueDraft(draft({ references: [] }), CONTEXT);
    expect(result.ok).toBe(true);
    expect(result.issues).toEqual([
      { code: "value.no_source_given", path: ["references"], severity: "warning", message: "No source given" },
    ]);
  });

  it("warns when a confirmed number's digits are absent from every quote", () => {
    const n = (value: number, quotes: string[]) =>
      validateValueDraft(draft({ fieldKey: "n_randomized", content: count(`n = ${value}`, value), references: quotes.map((q) => quote(q, { occurrence: 1 })) }), CONTEXT);
    expect(n(1204, ["(n = 1,204)"]).issues).toEqual([]);
    const absent = n(1250, ["(n = 1,204)"]);
    expect(absent.ok).toBe(true);
    expect(absent.issues).toEqual([
      expect.objectContaining({ code: "count.digits_absent_from_quote", severity: "warning", message: "The number 1250 doesn't appear in your quote. Check the value or the quote." }),
    ]);
  });
});

describe("study header (PR-A2 arguments)", () => {
  it("requires a label of 1-120 characters, not empty after v1", () => {
    expect(validateStudyLabel("Smith 2021").ok).toBe(true);
    expect(validateStudyLabel("x".repeat(120)).ok).toBe(true);
    expect(codes(validateStudyLabel("x".repeat(121)))).toEqual(["study.label_too_long"]);
    expect(codes(validateStudyLabel(` ${cp(0x200b)}${cp(0x00a0)}`))).toEqual(["study.label_required"]);
    expect(codes(validateStudyLabel(null))).toEqual(["study.label_required"]);
    expect(VALIDATION_MESSAGES["study.label_required"]).toBe("Give the study a short name.");
  });

  it("takes null for no notes, never an empty string", () => {
    expect(validateStudyNotes(null).ok).toBe(true);
    expect(validateStudyNotes("Recruited in two waves.").ok).toBe(true);
    expect(codes(validateStudyNotes(""))).toEqual(["study.notes_blank"]);
    expect(codes(validateStudyNotes(cp(0xfeff)))).toEqual(["study.notes_blank"]);
    expect(codes(validateStudyNotes("x".repeat(10_001)))).toEqual(["study.notes_too_long"]);
  });

  it("trims only spaces when measuring as btrim does", () => {
    expect(btrimSpaces("  a b  ")).toBe("a b");
    expect(btrimSpaces(`\ta\t`)).toBe("\ta\t");
  });
});

describe("determinism", () => {
  it("returns the same issues, in the same order, every time, and freezes them", () => {
    const messy = draft({ fieldKey: "duration", state: "reported", content: text(""), stateReason: "ambiguous", note: "", references: [examinedAbstract, quote("type 1 diabetes")] });
    const a = validateValueDraft(messy, CONTEXT);
    const b = validateValueDraft(messy, CONTEXT);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(codes(a)).toEqual([
      "field.wrong_scope",
      "text.blank",
      "state_reason.not_allowed",
      "note.blank",
      "reference.quote_not_found",
      "references.examined_not_allowed",
    ]);
    expect(Object.isFrozen(a.issues)).toBe(true);
    expect(Object.isFrozen(a.issues[0].path)).toBe(true);
  });
});
