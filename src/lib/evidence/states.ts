/**
 * Missing-value states and what each one claims (EVIDENCE-RECORDS-001B).
 *
 * Requirements-001 §J1 as corrected by FK-PROOF-001 §J: a value is Reported,
 * Not reported, Unclear, Not applicable or Couldn't check; NO ROW means "Not yet
 * recorded", which is never stored. Which source an absence refers to is not a
 * column: it is the value's `examined` and `unavailable` references, so every
 * absence claim is scoped to the sources named and never to "the study".
 *
 * "Unsupported" is derived, not stored: a Reported value with no supporting
 * source is shown as "No source given", and it cannot be confirmed.
 */

import { deepFreeze } from "./freeze";
import type { RecordedValue, ReferenceSourceKind, StateReason, StoredReference, ValueState } from "./types";

export const NOT_YET_RECORDED_LABEL = "Not yet recorded";
export const NO_SOURCE_GIVEN_LABEL = "No source given";

/** Shown once per record (Requirements-001 §E12). */
export const NOT_REPORTED_EXPLANATION =
  "‘Not reported’ means the source you examined doesn't give this information. It doesn't mean the study didn't collect it.";

type Bound = { readonly min: number; readonly max: number | null };

export interface ValueStateRule {
  readonly value: "required" | "forbidden";
  readonly stateReason: "required" | "forbidden";
  readonly note: "required" | "optional";
  /** char_length(btrim(note)) at least this (PR-A1 `evidence_field_values_state_note_check`). */
  readonly noteMinLength: number;
  readonly supports: Bound;
  readonly examined: Bound;
  readonly unavailable: Bound;
  /** Unclear needs at least one supporting or examined source. */
  readonly supportsOrExaminedMin: number;
}

/**
 * The rule table, one row per state. The value, reason and note columns are
 * PR-A1 CHECKs; the reference columns are FK-PROOF-001 §J, which a PR-A3 RPC
 * will enforce on the server (PR-A1 enforces only the 3-supports cap).
 */
export const VALUE_STATE_RULES: Readonly<Record<ValueState, ValueStateRule>> = deepFreeze({
  reported: {
    value: "required",
    stateReason: "forbidden",
    note: "optional",
    noteMinLength: 0,
    supports: { min: 0, max: 3 },
    examined: { min: 0, max: 0 },
    unavailable: { min: 0, max: 0 },
    supportsOrExaminedMin: 0,
  },
  not_reported: {
    value: "forbidden",
    stateReason: "forbidden",
    note: "optional",
    noteMinLength: 0,
    supports: { min: 0, max: 0 },
    examined: { min: 1, max: null },
    unavailable: { min: 0, max: null },
    supportsOrExaminedMin: 0,
  },
  unclear: {
    value: "forbidden",
    stateReason: "required",
    note: "required",
    noteMinLength: 10,
    supports: { min: 0, max: 3 },
    examined: { min: 0, max: null },
    unavailable: { min: 0, max: null },
    supportsOrExaminedMin: 1,
  },
  not_applicable: {
    value: "forbidden",
    stateReason: "forbidden",
    note: "required",
    noteMinLength: 3,
    supports: { min: 0, max: 0 },
    examined: { min: 0, max: 0 },
    unavailable: { min: 0, max: 0 },
    supportsOrExaminedMin: 0,
  },
  source_unavailable: {
    value: "forbidden",
    stateReason: "forbidden",
    note: "optional",
    noteMinLength: 0,
    supports: { min: 0, max: 0 },
    examined: { min: 0, max: 0 },
    unavailable: { min: 1, max: null },
    supportsOrExaminedMin: 0,
  },
});

/** The state chosen in the editor's radio group (Requirements-001 §E3). */
export const VALUE_STATE_CHOICE_LABELS: Readonly<Record<ValueState, string>> = Object.freeze({
  reported: "Reported",
  not_reported: "Not reported",
  unclear: "Unclear",
  not_applicable: "Not applicable",
  source_unavailable: "Couldn't check",
});

export type DerivedWarning = "no_source_given";

export interface ValueStateDescription {
  readonly label: string;
  readonly warnings: readonly DerivedWarning[];
  /** The source kinds an absence claim was made about, in a fixed order. */
  readonly examinedSourceKinds: readonly ReferenceSourceKind[];
  readonly unavailableSourceKinds: readonly ReferenceSourceKind[];
}

const SOURCE_KIND_ORDER: readonly ReferenceSourceKind[] = ["abstract", "full_text"];

function kindsOf(references: readonly StoredReference[], purpose: StoredReference["purpose"]): ReferenceSourceKind[] {
  const kinds = new Set(references.filter((r) => r.purpose === purpose).map((r) => r.sourceKind));
  return SOURCE_KIND_ORDER.filter((kind) => kinds.has(kind));
}

function notReportedLabel(kinds: readonly ReferenceSourceKind[]): string {
  if (kinds.length === 2) return "Not reported in the abstract or full text";
  if (kinds[0] === "abstract") return "Not reported in the abstract";
  if (kinds[0] === "full_text") return "Not reported in the full text";
  return "Not reported";
}

function unclearLabel(reason: StateReason | null): string {
  return reason === "conflicting" ? "Conflicting in the source" : "Unclear in the source";
}

/** How a value reads (Requirements-001 §E12), or "Not yet recorded" for no value. */
export function describeValueState(
  value: Pick<RecordedValue, "state" | "stateReason" | "references"> | null,
): ValueStateDescription {
  if (!value) {
    return Object.freeze({ label: NOT_YET_RECORDED_LABEL, warnings: [], examinedSourceKinds: [], unavailableSourceKinds: [] });
  }
  const examinedSourceKinds = kindsOf(value.references, "examined");
  const unavailableSourceKinds = kindsOf(value.references, "unavailable");
  const warnings: DerivedWarning[] =
    value.state === "reported" && !value.references.some((r) => r.purpose === "supports") ? ["no_source_given"] : [];
  const label = {
    reported: "Reported",
    not_reported: notReportedLabel(examinedSourceKinds),
    unclear: unclearLabel(value.stateReason),
    not_applicable: "Not applicable to this study",
    source_unavailable: "Couldn't check — source not available",
  }[value.state];
  return Object.freeze({
    label,
    warnings: Object.freeze(warnings),
    examinedSourceKinds: Object.freeze(examinedSourceKinds),
    unavailableSourceKinds: Object.freeze(unavailableSourceKinds),
  });
}

/** Whether the value is Reported with no supporting source — the derived "No source given". */
export function hasNoSourceGiven(value: Pick<RecordedValue, "state" | "references">): boolean {
  return value.state === "reported" && !value.references.some((r) => r.purpose === "supports");
}

/**
 * How a value's support splits between the saved abstract and the user's
 * full-text references. `fromAbstractOnly` is the "From the abstract only"
 * caution (Requirements-001 §F5): abstracts are an unreliable sole source.
 */
export function summarizeSupport(value: Pick<RecordedValue, "references">): {
  readonly abstractQuotes: number;
  readonly fullTextReferences: number;
  readonly fromAbstractOnly: boolean;
} {
  const supports = value.references.filter((r) => r.purpose === "supports");
  const abstractQuotes = supports.filter((r) => r.sourceKind === "abstract").length;
  const fullTextReferences = supports.length - abstractQuotes;
  return Object.freeze({ abstractQuotes, fullTextReferences, fromAbstractOnly: abstractQuotes > 0 && fullTextReferences === 0 });
}
