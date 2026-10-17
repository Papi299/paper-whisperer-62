// @vitest-environment node
import { describe, expect, it } from "vitest";

import {
  describeValueState,
  hasNoSourceGiven,
  NOT_REPORTED_EXPLANATION,
  NOT_YET_RECORDED_LABEL,
  summarizeSupport,
  VALUE_STATE_CHOICE_LABELS,
  VALUE_STATE_RULES,
} from "../states";
import { VALUE_STATES } from "../types";
import { abstractQuote, examinedAbstract, examinedFullText, fullTextLocator, recordedValue, unavailable } from "./fixtures/records";

/** Value states (Requirements-001 §J1 as corrected by FK-PROOF-001 §J) and their labels (§E12). */

describe("the rule table", () => {
  it("is FK-PROOF-001 §J's matrix and the PR-A1 note rules, exactly", () => {
    const table = Object.fromEntries(
      VALUE_STATES.map((state) => {
        const r = VALUE_STATE_RULES[state];
        return [state, [r.value, r.stateReason, r.noteMinLength, [r.supports.min, r.supports.max], [r.examined.min, r.examined.max], [r.unavailable.min, r.unavailable.max], r.supportsOrExaminedMin]];
      }),
    );
    expect(table).toEqual({
      reported: ["required", "forbidden", 0, [0, 3], [0, 0], [0, 0], 0],
      not_reported: ["forbidden", "forbidden", 0, [0, 0], [1, null], [0, null], 0],
      unclear: ["forbidden", "required", 10, [0, 3], [0, null], [0, null], 1],
      not_applicable: ["forbidden", "forbidden", 3, [0, 0], [0, 0], [0, 0], 0],
      source_unavailable: ["forbidden", "forbidden", 0, [0, 0], [0, 0], [1, null], 0],
    });
  });

  it("is deeply frozen", () => {
    expect(Object.isFrozen(VALUE_STATE_RULES)).toBe(true);
    expect(Object.isFrozen(VALUE_STATE_RULES.reported.supports)).toBe(true);
  });

  it("never lists 'not yet recorded' or 'unsupported' as a state", () => {
    expect(VALUE_STATES).not.toContain("not_yet_recorded");
    expect(VALUE_STATES).not.toContain("unsupported");
    expect(Object.keys(VALUE_STATE_CHOICE_LABELS)).toEqual([...VALUE_STATES]);
  });
});

describe("describeValueState", () => {
  it("reads no value as Not yet recorded", () => {
    expect(describeValueState(null)).toMatchObject({ label: NOT_YET_RECORDED_LABEL, warnings: [] });
  });

  it("derives No source given for a Reported value without a supporting source, and only then", () => {
    expect(describeValueState(recordedValue({ references: [] })).warnings).toEqual(["no_source_given"]);
    expect(describeValueState(recordedValue({ references: [fullTextLocator()] })).warnings).toEqual([]);
    expect(hasNoSourceGiven(recordedValue({ references: [] }))).toBe(true);
    expect(hasNoSourceGiven(recordedValue({ state: "not_reported", content: null, references: [examinedAbstract()] }))).toBe(false);
  });

  it("scopes Not reported to the source kinds examined", () => {
    const notReported = (references: ReturnType<typeof examinedAbstract>[]) => describeValueState(recordedValue({ state: "not_reported", content: null, references })).label;
    expect(notReported([examinedAbstract()])).toBe("Not reported in the abstract");
    expect(notReported([examinedFullText()])).toBe("Not reported in the full text");
    expect(notReported([examinedFullText(), examinedAbstract()])).toBe("Not reported in the abstract or full text");
    expect(NOT_REPORTED_EXPLANATION).toContain("It doesn't mean the study didn't collect it.");
  });

  it("labels the other states as Requirements-001 §E12 does", () => {
    expect(describeValueState(recordedValue({ state: "unclear", content: null, stateReason: "conflicting" })).label).toBe("Conflicting in the source");
    expect(describeValueState(recordedValue({ state: "unclear", content: null, stateReason: "incomplete" })).label).toBe("Unclear in the source");
    expect(describeValueState(recordedValue({ state: "not_applicable", content: null, references: [] })).label).toBe("Not applicable to this study");
    const unavailableValue = recordedValue({ state: "source_unavailable", content: null, references: [unavailable("full_text")] });
    expect(describeValueState(unavailableValue)).toMatchObject({ label: "Couldn't check — source not available", unavailableSourceKinds: ["full_text"] });
  });
});

describe("summarizeSupport", () => {
  it("marks support that comes from the abstract only", () => {
    expect(summarizeSupport(recordedValue({ references: [abstractQuote()] }))).toEqual({ abstractQuotes: 1, fullTextReferences: 0, fromAbstractOnly: true });
    expect(summarizeSupport(recordedValue({ references: [abstractQuote(), fullTextLocator()] })).fromAbstractOnly).toBe(false);
    expect(summarizeSupport(recordedValue({ references: [] })).fromAbstractOnly).toBe(false);
  });
});
