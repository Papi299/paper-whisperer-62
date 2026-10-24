/**
 * The Source pane's pure parts (EVIDENCE-RECORDS-001C1): which fields a quote
 * can be used for, and how the saved abstract is split around the passages
 * already quoted. Kept out of `SourcePane.tsx` so that file exports only its
 * component.
 */

import { EVIDENCE_FIELDS, fieldKeysFor } from "@/lib/evidence/fieldDictionary";
import { mapNormalizedRange, type NormalizationMap } from "@/lib/evidence/normalization";
import type { RecordedValue, ServerAttestedMatch } from "@/lib/evidence/types";
import { armTarget, outcomeTarget, STUDY_TARGET, valueKey, type StudyRecordDraft } from "@/lib/studyRecord/draft";
import { STUDY_RECORD_COPY } from "./studyRecordCopy";

export interface TextRange {
  readonly start: number;
  readonly end: number;
}

/**
 * Where a STORED quote lies in the copy it names, as string indices of that
 * copy: the server's normalized offsets mapped back through the copy's v1 map
 * (`map`). Null when the offsets do not fit the copy.
 */
export function storedQuoteRange(map: NormalizationMap, match: Pick<ServerAttestedMatch, "normalizedStart" | "normalizedEnd">): TextRange | null {
  const exact = mapNormalizedRange(map, match.normalizedStart, match.normalizedEnd);
  return exact ? { start: map.originalUtf16Offsets[exact.start], end: map.originalUtf16Offsets[exact.end] } : null;
}

/**
 * The passages one SAVED value quotes in the copy `copyId` (EVIDENCE-RECORDS-
 * 001C2A): its persisted supporting quotes on that copy, located by their
 * stored offsets. A draft's quotes are never read here.
 */
export function savedQuoteRanges(value: Pick<RecordedValue, "references">, copyId: string, map: NormalizationMap): TextRange[] {
  const ranges: TextRange[] = [];
  for (const reference of value.references) {
    if (reference.purpose !== "supports" || reference.sourceKind !== "abstract" || reference.snapshotId !== copyId) continue;
    const range = storedQuoteRange(map, reference.match);
    if (range) ranges.push(range);
  }
  return ranges;
}

/** The fields "Use as quote" can target, grouped as the record shows them. */
export function quoteFieldGroups(draft: StudyRecordDraft): { readonly label: string; readonly options: { readonly key: string; readonly label: string }[] }[] {
  const profile = draft.header.designProfile;
  const studyKeys = fieldKeysFor("study", profile);
  const bySection = (section: string) =>
    studyKeys.filter((key) => EVIDENCE_FIELDS[key].section === section).map((key) => ({ key: valueKey(STUDY_TARGET, key), label: EVIDENCE_FIELDS[key].label }));
  const groups = [
    { label: STUDY_RECORD_COPY.sections.study_design, options: bySection("study_design") },
    { label: STUDY_RECORD_COPY.sections.participants, options: bySection("participants") },
    ...draft.arms.map((arm) => ({
      label: `${STUDY_RECORD_COPY.groupRole[arm.role]}: ${arm.displayLabel}`,
      options: fieldKeysFor("arm", profile, arm.role).map((key) => ({ key: valueKey(armTarget(arm.key), key), label: EVIDENCE_FIELDS[key].label })),
    })),
    ...draft.outcomes.map((outcome) => ({
      label: `Outcome: ${outcome.displayLabel}`,
      options: fieldKeysFor("outcome", profile).map((key) => ({ key: valueKey(outcomeTarget(outcome.key), key), label: EVIDENCE_FIELDS[key].label })),
    })),
  ];
  return groups.filter((group) => group.options.length > 0);
}

/** Split `text` at the highlighted ranges (merged), for rendering as text nodes only. */
export function highlightSegments(text: string, ranges: readonly TextRange[]): { readonly text: string; readonly highlighted: boolean }[] {
  const sorted = ranges.filter((range) => range.end > range.start).sort((a, b) => a.start - b.start);
  const merged: TextRange[] = [];
  for (const range of sorted) {
    const last = merged[merged.length - 1];
    if (last && range.start <= last.end) merged[merged.length - 1] = { start: last.start, end: Math.max(last.end, range.end) };
    else merged.push(range);
  }
  const segments: { text: string; highlighted: boolean }[] = [];
  let at = 0;
  for (const range of merged) {
    if (range.start > at) segments.push({ text: text.slice(at, range.start), highlighted: false });
    segments.push({ text: text.slice(range.start, range.end), highlighted: true });
    at = range.end;
  }
  if (at < text.length) segments.push({ text: text.slice(at), highlighted: false });
  return segments;
}
