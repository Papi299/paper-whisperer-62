/**
 * "Use current abstract", as the browser decides it before anything is sent
 * (EVIDENCE-RECORDS-001C2C-B; the installed `evidence_rebase_source`,
 * 20261017155445).
 *
 * The comparison shows a link's saved copy beside the abstract in the library
 * now. The user may make that library abstract the link's new saved copy — or
 * its first one. This module says whether that is possible, what it will do to
 * the reviews of the values that cite the abstract, and computes the SHA-256
 * the server checks the abstract against. It decides only what is OFFERED and
 * what is said; the rebase RPC re-checks everything and its answer stands.
 *
 *   * ELIGIBILITY mirrors the server's order of refusal: a changed
 *     (`content_change`), typography-only (`typography_only_change`) or newly
 *     available (`abstract_now_available`) library abstract, of at most 50,000
 *     code points and not empty after normalization v1, for a link with fewer
 *     than 20 copies. `current`, `abstract_removed` and `no_copy_no_abstract`
 *     never are. A typography-only difference keeps the saved copy by default:
 *     only an explicit choice replaces it.
 *   * THE CANDIDATE is the exact text the comparison displayed, frozen when the
 *     user asks to use it, with the study version and current copy it was
 *     shown against and when the library read it came from finished. A
 *     candidate taken from another record state is stale, and is never sent.
 *   * REVIEW IMPACT is `deriveSourceChangeTransitions` — the server's rule,
 *     exactly: every value with an abstract reference on the link (a quote on
 *     any copy, an examined copy, or "couldn't check") that is reviewed or
 *     flagged needs re-review, even when every quote is found again; one that
 *     already needs re-review stays so; one not reviewed stays not reviewed.
 *     Which quotes will be found again is NOT forecast: only the server knows,
 *     and only its answer is reported.
 *   * THE DIGEST is SHA-256 over the UTF-8 bytes of the candidate text exactly
 *     as displayed — not trimmed, normalized or otherwise changed — through the
 *     browser's Web Crypto, as lowercase hex. Without Web Crypto, or when the
 *     digest fails, nothing is sent. The evidence domain library uses no
 *     crypto API; this application layer does.
 */

import { EVIDENCE_FIELD_LIMITS } from "@/lib/evidence/fieldRequests";
import type { PaperId, SnapshotId } from "@/lib/evidence/ids";
import { codePointLength, findPostgresTextProblem } from "@/lib/evidence/normalization";
import { deriveSourceChangeTransitions } from "@/lib/evidence/review";
import { deriveSourceState } from "@/lib/evidence/sources";
import type { StudyRecordData, StudyRecordLink } from "./read";
import type { ReviewItem } from "./reviewModel";

/** The source states a new copy may come from. */
export type UpdatableSourceState = "content_change" | "typography_only_change" | "abstract_now_available";

export type SourceUpdateIneligibility =
  /** The library abstract is the saved copy, character for character: there is nothing to save. */
  | "current"
  /** The library abstract is gone, or empty after normalization v1. */
  | "abstract_removed"
  | "no_copy_no_abstract"
  /** Longer than 50,000 code points: a copy can't hold it. */
  | "too_long"
  /** The link already has 20 copies. */
  | "copy_limit"
  /** Text no PostgreSQL value can hold: not an abstract from the database. */
  | "malformed";

export type SourceUpdateEligibility =
  | { readonly kind: "eligible"; readonly state: UpdatableSourceState }
  | { readonly kind: "ineligible"; readonly reason: SourceUpdateIneligibility };

const ineligible = (reason: SourceUpdateIneligibility): SourceUpdateEligibility => ({ kind: "ineligible", reason });

/**
 * Whether `libraryAbstract` could become the link's new current copy, as the
 * rebase decides it: empty or removed, too long, then the copy limit.
 */
export function sourceUpdateEligibility(link: StudyRecordLink, libraryAbstract: string | null): SourceUpdateEligibility {
  if (libraryAbstract !== null && (typeof libraryAbstract !== "string" || findPostgresTextProblem(libraryAbstract) !== null)) return ineligible("malformed");
  const state = deriveSourceState(link.currentCopy?.exactText ?? null, libraryAbstract);
  if (state.kind === "current" || state.kind === "abstract_removed" || state.kind === "no_copy_no_abstract") return ineligible(state.kind);
  if (state.capture === "refused_too_long") return ineligible("too_long");
  if (link.snapshots.length >= EVIDENCE_FIELD_LIMITS.copiesPerLink) return ineligible("copy_limit");
  return { kind: "eligible", state: state.kind };
}

/** What the user asked to save: the library abstract exactly as the comparison displayed it, and what it was shown against. */
export interface SourceUpdateCandidate {
  readonly paperId: PaperId;
  /** The library abstract as displayed — never trimmed, normalized or re-read from another cache. */
  readonly text: string;
  /** The study version the comparison was shown at. */
  readonly studyVersion: number;
  /** The link's current copy then; null when it had none (a first capture). */
  readonly currentCopyId: SnapshotId | null;
  /** When the library read the text came from finished (ms since the epoch). */
  readonly readAt: number;
}

export type SourceUpdateCheck =
  | { readonly kind: "ready"; readonly state: UpdatableSourceState; readonly link: StudyRecordLink }
  /** The record, the link or its current copy is no longer the one the candidate was taken from. */
  | { readonly kind: "stale" }
  | { readonly kind: "ineligible"; readonly reason: SourceUpdateIneligibility };

/**
 * Whether `candidate` may be sent now: taken from the record as loaded, at the
 * version this editor writes against, for one of its links and that link's
 * current copy — and still eligible.
 */
export function checkSourceUpdateCandidate(base: StudyRecordData, knownVersion: number, candidate: SourceUpdateCandidate): SourceUpdateCheck {
  const link = base.links.find((candidateLink) => candidateLink.link.paperId === candidate.paperId);
  if (!link || candidate.studyVersion !== knownVersion || base.header.version !== knownVersion || (link.currentCopy?.id ?? null) !== candidate.currentCopyId) {
    return { kind: "stale" };
  }
  const eligibility = sourceUpdateEligibility(link, candidate.text);
  return eligibility.kind === "eligible" ? { kind: "ready", state: eligibility.state, link } : eligibility;
}

/** What saving a new copy of one link's abstract does, from the record as loaded — never a forecast of quote matching. */
export interface SourceUpdateImpact {
  readonly paperId: PaperId;
  /** The paper's title in the library; null when it couldn't be read. */
  readonly paperTitle: string | null;
  /** The link's current copy now; null for a first capture. */
  readonly currentCopy: { readonly id: SnapshotId; readonly seq: number; readonly capturedAt: string } | null;
  /** How many copies the link has now; the new one is `copies + 1`. */
  readonly copies: number;
  /** Abstract quotes on the current copy: the ones the server will look for in the new copy. */
  readonly quotesToRecheck: number;
  /** Abstract quotes on earlier copies: never rechecked, they stay where they are. */
  readonly quotesOnEarlierCopies: number;
  /** Reviewed by you or flagged now: they will need re-review. */
  readonly needsRereview: readonly ReviewItem[];
  /** They already need re-review, and stay so. */
  readonly staysNeedsRereview: readonly ReviewItem[];
  /** Not reviewed, and stay so. */
  readonly staysUnreviewed: readonly ReviewItem[];
  /** Values that say this paper had no abstract to check: once a copy exists, they can't be confirmed until edited. */
  readonly unavailableAbstract: readonly ReviewItem[];
  /** Values affected that keep a review note (the rebase never clears one). */
  readonly withReviewNote: number;
}

/**
 * What saving a new copy of the abstract of `paperId` will do, as far as the
 * record says: the copies kept, the quotes the server will recheck, and every
 * value that cites the abstract, by what happens to its review. `items` are the
 * editor's review items for `base` (one per saved value), so each value is
 * named as Review names it.
 */
export function describeSourceUpdate(base: StudyRecordData, items: readonly ReviewItem[], paperId: PaperId): SourceUpdateImpact | null {
  const link = base.links.find((candidate) => candidate.link.paperId === paperId);
  if (!link) return null;
  const current = link.currentCopy;
  const currentInfo = current ? link.snapshots.find((snapshot) => snapshot.id === current.id) ?? null : null;
  let quotesToRecheck = 0;
  let quotesOnEarlierCopies = 0;
  for (const value of base.values) {
    for (const reference of value.references) {
      if (reference.purpose !== "supports" || reference.sourceKind !== "abstract" || reference.paperId !== paperId) continue;
      if (current && reference.snapshotId === current.id) quotesToRecheck += 1;
      else quotesOnEarlierCopies += 1;
    }
  }
  const byValue = new Map(items.map((item) => [item.value.id as string, item]));
  const transitions = deriveSourceChangeTransitions(base.values, { paperId, kind: current ? "rebase" : "first_capture" });
  const needsRereview: ReviewItem[] = [];
  const staysNeedsRereview: ReviewItem[] = [];
  const staysUnreviewed: ReviewItem[] = [];
  const affected: ReviewItem[] = [];
  for (const transition of transitions) {
    const item = byValue.get(transition.valueId);
    if (!item) continue;
    affected.push(item);
    if (transition.changed) needsRereview.push(item);
    else if (transition.to === "needs_rereview") staysNeedsRereview.push(item);
    else staysUnreviewed.push(item);
  }
  return Object.freeze({
    paperId,
    paperTitle: link.paperTitle,
    currentCopy: current && currentInfo ? Object.freeze({ id: current.id, seq: currentInfo.seq, capturedAt: currentInfo.capturedAt }) : null,
    copies: link.snapshots.length,
    quotesToRecheck,
    quotesOnEarlierCopies,
    needsRereview: Object.freeze(needsRereview),
    staysNeedsRereview: Object.freeze(staysNeedsRereview),
    staysUnreviewed: Object.freeze(staysUnreviewed),
    unavailableAbstract: Object.freeze(
      affected.filter((item) => item.value.references.some((r) => r.purpose === "unavailable" && r.sourceKind === "abstract" && r.paperId === paperId)),
    ),
    withReviewNote: affected.filter((item) => item.value.review.note !== null).length,
  });
}

/** The candidate's length, as the server measures a copy (`char_length`: code points). */
export function candidateLength(candidate: Pick<SourceUpdateCandidate, "text">): number {
  return codePointLength(candidate.text);
}

export type AbstractDigest =
  | { readonly ok: true; readonly sha256: string }
  /** `unavailable`: this browser has no Web Crypto digest (an insecure context, an old browser); `failed`: it refused. */
  | { readonly ok: false; readonly reason: "unavailable" | "failed" };

function subtleCrypto(): SubtleCrypto | null {
  const subtle = (globalThis as { crypto?: { subtle?: SubtleCrypto } }).crypto?.subtle;
  return subtle && typeof subtle.digest === "function" ? subtle : null;
}

/** Whether this browser can compute the digest at all: Web Crypto's `subtle.digest`. */
export function canDigestAbstract(): boolean {
  return subtleCrypto() !== null;
}

/**
 * The lowercase hex SHA-256 of the UTF-8 bytes of `text`, exactly as given —
 * what `evidence_rebase_source` compares with the abstract it reads. A text
 * with a lone surrogate or NUL has no faithful UTF-8 form (an encoder would
 * replace it), so it is not hashed; no abstract from the database is one.
 */
export async function abstractSha256(text: string): Promise<AbstractDigest> {
  const subtle = subtleCrypto();
  if (!subtle) return { ok: false, reason: "unavailable" };
  if (typeof text !== "string" || findPostgresTextProblem(text) !== null) return { ok: false, reason: "failed" };
  try {
    const bytes = new Uint8Array(await subtle.digest("SHA-256", new TextEncoder().encode(text)));
    if (bytes.length !== 32) return { ok: false, reason: "failed" };
    return { ok: true, sha256: Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("") };
  } catch {
    return { ok: false, reason: "failed" };
  }
}
