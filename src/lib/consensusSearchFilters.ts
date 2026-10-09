/**
 * CONSENSUS-ADVANCED-FILTERS-001A — the owner's Consensus search filters, on
 * the browser side: the study-design vocabulary, the publication-year bounds,
 * the draft the panel edits, the immutable snapshot one Search commits, and the
 * summary shown beside that search's results.
 *
 * The `search-consensus` Edge Function owns the authoritative contract
 * (`supabase/functions/_shared/consensusSearch.ts`) and re-validates every
 * request. This module mirrors it so the panel can explain a problem before
 * Search is pressed, and so a request the server would refuse — at no cost, but
 * still a refusal — is never sent. The deployed function and the bundled
 * application are separate deployment domains, so the vocabulary exists twice;
 * `consensusSearchFilters.parity.test.ts` pins the copies to each other.
 *
 * Nothing here filters results. Consensus applies the filters upstream; the
 * dialog never hides, re-orders or re-labels any of the records a search
 * returns.
 */

/**
 * The study designs a search may be restricted to, as Consensus spells them for
 * `GET /v1/search`, in the order they are sent. The curated V1 allowlist: only
 * values whose exact REST spelling official Consensus sources agree on (see
 * `CONSENSUS_STUDY_TYPES` in the Edge module for the evidence).
 */
export const CONSENSUS_STUDY_TYPES = Object.freeze(["rct", "meta-analysis", "systematic review", "cohort study"] as const);

export type ConsensusStudyType = (typeof CONSENSUS_STUDY_TYPES)[number];

/** Readable labels for each provider value. The value itself is never rewritten. */
const STUDY_TYPE_LABELS: Readonly<Record<ConsensusStudyType, { label: string; shortLabel: string }>> = {
  rct: { label: "Randomized controlled trial (RCT)", shortLabel: "RCT" },
  "meta-analysis": { label: "Meta-analysis", shortLabel: "Meta-analysis" },
  "systematic review": { label: "Systematic review", shortLabel: "Systematic review" },
  "cohort study": { label: "Cohort study", shortLabel: "Cohort study" },
};

export interface ConsensusStudyTypeOption {
  /** The exact Consensus `study_types` value. */
  value: ConsensusStudyType;
  /** What the filter control says. */
  label: string;
  /** What the applied-filter summary says. */
  shortLabel: string;
}

/** The study-design choices, in the order they are offered, summarized and sent. */
export const CONSENSUS_STUDY_TYPE_OPTIONS: readonly ConsensusStudyTypeOption[] = Object.freeze(
  CONSENSUS_STUDY_TYPES.map((value) => Object.freeze({ value, ...STUDY_TYPE_LABELS[value] })),
);

/** The earliest year a filter may name. PaperLume's own floor; mirrors the Edge Function. */
export const CONSENSUS_FILTER_MIN_YEAR = 1900;

/**
 * The latest year a filter may name: the current UTC year plus one — the same
 * clock and rule the Edge Function applies.
 */
export function consensusFilterMaxYear(now: Date = new Date()): number {
  return now.getUTCFullYear() + 1;
}

export function isConsensusStudyType(value: unknown): value is ConsensusStudyType {
  return typeof value === "string" && (CONSENSUS_STUDY_TYPES as readonly string[]).includes(value);
}

/**
 * The allowlisted designs among `values`, once each, in allowlist order. An
 * unknown value is dropped, never repaired — `"RCT"` is not `"rct"`.
 */
export function canonicalStudyTypes(values: readonly unknown[]): ConsensusStudyType[] {
  return CONSENSUS_STUDY_TYPES.filter((type) => values.includes(type));
}

// ── The draft ─────────────────────────────────────────────────────────────

/**
 * The advanced filters as the owner is editing them. Editing a draft never
 * searches; only an explicit Search turns it into {@link ConsensusAppliedFilters}.
 */
export interface ConsensusFilterDraft {
  /** Exactly what is typed in "From year" — validated, never coerced, at Search. */
  yearMin: string;
  /** Exactly what is typed in "To year". */
  yearMax: string;
  /** Selected designs: allowlisted, unique, in allowlist order. */
  studyTypes: readonly ConsensusStudyType[];
  human: boolean;
  excludePreprints: boolean;
}

/** Every filter unset — the default for each new Add Papers session. */
export const EMPTY_CONSENSUS_FILTER_DRAFT: Readonly<ConsensusFilterDraft> = Object.freeze({
  yearMin: "",
  yearMax: "",
  studyTypes: Object.freeze([]) as readonly ConsensusStudyType[],
  human: false,
  excludePreprints: false,
});

/**
 * How many filter categories the draft sets — publication year, study design,
 * human studies, preprints — so a collapsed filter section can still say that
 * something is set. A half-typed year counts: it is not "unset".
 */
export function countDraftFilters(draft: ConsensusFilterDraft): number {
  return (
    (draft.yearMin.trim() !== "" || draft.yearMax.trim() !== "" ? 1 : 0) +
    (draft.studyTypes.length > 0 ? 1 : 0) +
    (draft.human ? 1 : 0) +
    (draft.excludePreprints ? 1 : 0)
  );
}

// ── The applied snapshot ──────────────────────────────────────────────────

/**
 * The restrictions one Search applied — frozen when Search is pressed, and the
 * only thing the results it produced may be described with. Only a set
 * restriction is present, so an unfiltered search applies `{}`.
 */
export interface ConsensusAppliedFilters {
  readonly yearMin?: number;
  readonly yearMax?: number;
  readonly studyTypes?: readonly ConsensusStudyType[];
  readonly human?: true;
  readonly excludePreprints?: true;
}

export interface ConsensusFilterDraftErrors {
  yearMin?: string;
  yearMax?: string;
  /** Both years are valid on their own, but From is later than To. */
  range?: string;
}

export type ConsensusFilterDraftValidation =
  | { ok: true; filters: ConsensusAppliedFilters }
  | { ok: false; errors: ConsensusFilterDraftErrors };

/** Exactly four ASCII digits. `\d` without the `u` flag matches 0–9 only. */
const FOUR_DIGIT_YEAR = /^\d{4}$/;

export const CONSENSUS_FILTER_RANGE_MESSAGE = "The From year must be the same as or earlier than the To year.";

export function consensusFilterYearMessage(maxYear: number = consensusFilterMaxYear()): string {
  return `Enter a four-digit year from ${CONSENSUS_FILTER_MIN_YEAR} to ${maxYear}.`;
}

/** `null` for an empty field, the year for a valid one, `"invalid"` otherwise. */
function parseDraftYear(text: string, maxYear: number): number | null | "invalid" {
  const trimmed = text.trim();
  if (trimmed === "") return null;
  if (!FOUR_DIGIT_YEAR.test(trimmed)) return "invalid";
  const year = Number(trimmed);
  return year >= CONSENSUS_FILTER_MIN_YEAR && year <= maxYear ? year : "invalid";
}

/**
 * Turn a draft into the frozen filters a Search would apply, or explain what
 * stops it. The same rules the Edge Function enforces: whole four-digit years
 * from {@link CONSENSUS_FILTER_MIN_YEAR} to {@link consensusFilterMaxYear},
 * either one alone, From no later than To. Unset fields, an empty design list
 * and unchecked booleans apply no restriction and are left out entirely.
 */
export function validateConsensusFilterDraft(
  draft: ConsensusFilterDraft,
  maxYear: number = consensusFilterMaxYear(),
): ConsensusFilterDraftValidation {
  const yearMin = parseDraftYear(draft.yearMin, maxYear);
  const yearMax = parseDraftYear(draft.yearMax, maxYear);

  const errors: ConsensusFilterDraftErrors = {};
  if (yearMin === "invalid") errors.yearMin = consensusFilterYearMessage(maxYear);
  if (yearMax === "invalid") errors.yearMax = consensusFilterYearMessage(maxYear);
  if (typeof yearMin === "number" && typeof yearMax === "number" && yearMin > yearMax) {
    errors.range = CONSENSUS_FILTER_RANGE_MESSAGE;
  }
  if (errors.yearMin || errors.yearMax || errors.range) return { ok: false, errors };

  const filters: { -readonly [K in keyof ConsensusAppliedFilters]: ConsensusAppliedFilters[K] } = {};
  if (typeof yearMin === "number") filters.yearMin = yearMin;
  if (typeof yearMax === "number") filters.yearMax = yearMax;
  const studyTypes = canonicalStudyTypes(draft.studyTypes);
  if (studyTypes.length > 0) filters.studyTypes = Object.freeze(studyTypes);
  if (draft.human === true) filters.human = true;
  if (draft.excludePreprints === true) filters.excludePreprints = true;
  return { ok: true, filters: Object.freeze(filters) };
}

/**
 * Whether two applied filter sets are the same search restriction. Part of a
 * search's identity: the same question under different filters is a different
 * search.
 */
export function sameAppliedFilters(a: ConsensusAppliedFilters | null, b: ConsensusAppliedFilters | null): boolean {
  if (a === null || b === null) return a === b;
  const aTypes = a.studyTypes ?? [];
  const bTypes = b.studyTypes ?? [];
  return (
    a.yearMin === b.yearMin &&
    a.yearMax === b.yearMax &&
    a.human === b.human &&
    a.excludePreprints === b.excludePreprints &&
    aTypes.length === bTypes.length &&
    aTypes.every((type, index) => type === bTypes[index])
  );
}

/**
 * The compact, text-only description of what a search applied —
 * `2020–2026 · RCT + Meta-analysis · Human only · No preprints` — or `null`
 * when it applied nothing, so unfiltered results are never labelled as
 * filtered.
 */
export function describeAppliedFilters(filters: ConsensusAppliedFilters | null): string | null {
  if (filters === null) return null;
  const parts: string[] = [];
  const { yearMin, yearMax } = filters;
  if (yearMin !== undefined && yearMax !== undefined) {
    parts.push(yearMin === yearMax ? `${yearMin} only` : `${yearMin}–${yearMax}`);
  } else if (yearMin !== undefined) {
    parts.push(`From ${yearMin}`);
  } else if (yearMax !== undefined) {
    parts.push(`Up to ${yearMax}`);
  }
  if (filters.studyTypes && filters.studyTypes.length > 0) {
    parts.push(filters.studyTypes.map((type) => STUDY_TYPE_LABELS[type].shortLabel).join(" + "));
  }
  if (filters.human) parts.push("Human only");
  if (filters.excludePreprints) parts.push("No preprints");
  return parts.length > 0 ? parts.join(" · ") : null;
}
