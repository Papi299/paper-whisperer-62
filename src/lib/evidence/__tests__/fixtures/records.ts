/** Builders for domain values in tests. Deterministic ids; synthetic data only. */

import type { FieldKey } from "../../fieldDictionary";
import {
  toAnchorId,
  toPaperId,
  toSnapshotId,
  toStudyId,
  toValueId,
  toValueVersion,
  type AnchorId,
  type PaperId,
  type SnapshotId,
  type ValueVersion,
} from "../../ids";
import type { CodePointOffset } from "../../normalization";
import type { FieldContent, RecordedValue, ReviewState, StoredReference } from "../../types";
import type { LinkSources } from "../../validation";

const uuid = (prefix: string, n: number) => `${prefix}0000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

export const STUDY = toStudyId(uuid("5", 1))!;
export const PAPER_A = toPaperId(uuid("a", 1))!;
export const PAPER_B = toPaperId(uuid("b", 1))!;
export const COPY_A_OLD = toSnapshotId(uuid("c", 1))!;
export const COPY_A = toSnapshotId(uuid("c", 2))!;
export const COPY_B = toSnapshotId(uuid("c", 3))!;

/** Paper A has a current copy and a superseded one; paper B has none. */
export const LINKS: readonly LinkSources[] = [
  { paperId: PAPER_A, currentSnapshotId: COPY_A, snapshotIds: [COPY_A_OLD, COPY_A] },
  { paperId: PAPER_B, currentSnapshotId: null, snapshotIds: [] },
];

let anchorCounter = 0;
const nextAnchor = (): AnchorId => toAnchorId(uuid("d", ++anchorCounter))!;

export const abstractQuote = (snapshotId: SnapshotId = COPY_A, paperId: PaperId = PAPER_A, quoteText = "type 2 diabetes"): StoredReference => ({
  id: nextAnchor(),
  purpose: "supports",
  sourceKind: "abstract",
  paperId,
  snapshotId,
  position: 0,
  quoteText,
  match: {
    attestation: "server",
    normalizedStart: 12 as CodePointOffset,
    normalizedEnd: 27 as CodePointOffset,
    occurrence: 1,
    count: 1,
    normalizationVersion: "v1",
    matchedAt: "2026-10-17T00:00:00Z",
  },
});

export const fullTextLocator = (paperId: PaperId = PAPER_A): StoredReference => ({
  id: nextAnchor(),
  purpose: "supports",
  sourceKind: "full_text",
  paperId,
  position: 0,
  locator: { kind: "page", text: "p. 4" },
});

export const examinedAbstract = (snapshotId: SnapshotId = COPY_A, paperId: PaperId = PAPER_A): StoredReference => ({
  id: nextAnchor(),
  purpose: "examined",
  sourceKind: "abstract",
  paperId,
  snapshotId,
});

export const examinedFullText = (paperId: PaperId = PAPER_A): StoredReference => ({
  id: nextAnchor(),
  purpose: "examined",
  sourceKind: "full_text",
  paperId,
  locator: null,
});

export const unavailable = (sourceKind: "abstract" | "full_text", paperId: PaperId = PAPER_B): StoredReference => ({
  id: nextAnchor(),
  purpose: "unavailable",
  sourceKind,
  paperId,
});

const UNREVIEWED: ReviewState = { status: "unreviewed", reason: null, note: null, reviewedAt: null, reviewedVersion: null };

export function reviewed(version: number): ReviewState {
  return { status: "user_reviewed", reason: null, note: null, reviewedAt: "2026-10-17T01:00:00Z", reviewedVersion: toValueVersion(version)! };
}

export const FLAGGED: ReviewState = { status: "disputed", reason: null, note: "Check the full text", reviewedAt: null, reviewedVersion: null };
export const NEEDS_REREVIEW: ReviewState = { status: "needs_rereview", reason: "source_changed", note: null, reviewedAt: null, reviewedVersion: null };

let valueCounter = 0;

export function recordedValue(overrides: Partial<Omit<RecordedValue, "valueVersion">> & { valueVersion?: number } = {}): RecordedValue {
  const { valueVersion, ...rest } = overrides;
  return {
    id: toValueId(uuid("e", ++valueCounter))!,
    studyId: STUDY,
    target: { scope: "study" },
    fieldKey: "condition" as FieldKey,
    state: "reported",
    stateReason: null,
    content: { shape: "text", text: "Type 2 diabetes" } as FieldContent,
    note: null,
    extractionMethod: "manual",
    review: UNREVIEWED,
    valueVersion: toValueVersion(valueVersion ?? 1) as ValueVersion,
    references: [abstractQuote()],
    ...rest,
  };
}
