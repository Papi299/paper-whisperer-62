/**
 * The advisory abstract-quote matcher (EVIDENCE-RECORDS-001B).
 *
 * Requirements-001 §I4: a match exists if and only if the normalized quote is a
 * non-empty, contiguous substring of the normalized saved copy. The quote and
 * the copy are each normalized exactly once, from their original text, with
 * match normalization v1 (`normalization.ts`). Then:
 *   * the normalized quote must have 3 to 1,000 characters and contain at least
 *     one letter or digit; the stored quote text itself must have 3 to 1,000
 *     characters (PR-A1 CHECK `evidence_field_anchors_quote_text_check`);
 *   * every occurrence counts, overlapping ones included, in position order;
 *   * an ellipsis is three full stops, never a wildcard; punctuation and case
 *     always count; nothing approximate or "similar" ever matches.
 *
 * OFFSETS. `normalized` offsets are 0-based, half-open code point offsets into
 * the v1-normalized copy — the PostgreSQL character positions the PR-A1
 * columns `match_start`/`match_end` are designed to hold (§I4; `match_end >
 * match_start >= 0`). `exact` offsets are the same span mapped back to the
 * original copy in code points, and `exactUtf16` the JavaScript string indices
 * of that span, for highlighting. A UTF-16 index is never a PostgreSQL offset.
 *
 * TRUST BOUNDARY. Everything here is advisory. It cannot store a reference, set
 * `matched_at`, claim a server match count, mark a value reviewed, or say that
 * the quotation supports the value — a match proves only that the passage
 * occurs in the saved copy (§I6). Every result carries `attestation:
 * "browser_advisory"`. The future PR-A3 save RPC re-matches on the server and
 * decides what is stored; when the two disagree, the server's refusal stands
 * and the user resolves it — the browser never overrides it.
 */

import {
  codePointLength,
  findPostgresTextProblem,
  mapNormalizedRange,
  normalizeEvidenceV1WithMap,
  type CodePointOffset,
  type NormalizationMap,
  type Utf16Offset,
} from "./normalization";

export const QUOTE_MIN_LENGTH = 3;
export const QUOTE_MAX_LENGTH = 1000;
export const DEFAULT_CONTEXT_LENGTH = 40;

/**
 * "A letter or a digit": any Unicode letter (L) or number (N). This is the
 * browser's reading; the server-side definition is a PR-A3 contract still to
 * be pinned, and the server's answer wins.
 */
const LETTER_OR_DIGIT = /[\p{L}\p{N}]/u;
const MARK = /\p{M}/u;

export type QuoteProblem =
  | "malformed_text"
  | "quote_too_short"
  | "quote_too_long"
  | "normalized_too_short"
  | "normalized_too_long"
  | "no_letter_or_digit";

export interface QuoteContext {
  readonly before: string;
  readonly match: string;
  readonly after: string;
  readonly truncatedBefore: boolean;
  readonly truncatedAfter: boolean;
}

export interface QuoteOccurrence {
  /** 1-based, in position order: `match_occurrence` in the PR-A1 column's terms. */
  readonly occurrence: number;
  readonly normalized: { readonly start: CodePointOffset; readonly end: CodePointOffset };
  /** Covers whole original characters; `snapped` when a boundary fell inside one. */
  readonly exact: { readonly start: CodePointOffset; readonly end: CodePointOffset; readonly snapped: boolean };
  readonly exactUtf16: { readonly start: Utf16Offset; readonly end: Utf16Offset };
  readonly context: QuoteContext;
}

interface AdvisoryBase {
  readonly attestation: "browser_advisory";
  readonly normalizationVersion: "v1";
}

export type AdvisoryQuoteMatch =
  | (AdvisoryBase & {
      readonly kind: "invalid";
      readonly problems: readonly QuoteProblem[];
      readonly normalizedQuote: string | null;
    })
  | (AdvisoryBase & { readonly kind: "not_found"; readonly normalizedQuote: string; readonly count: 0 })
  | (AdvisoryBase & {
      readonly kind: "unique";
      readonly normalizedQuote: string;
      readonly count: 1;
      readonly occurrences: readonly [QuoteOccurrence];
    })
  | (AdvisoryBase & {
      readonly kind: "multiple";
      readonly normalizedQuote: string;
      readonly count: number;
      readonly occurrences: readonly QuoteOccurrence[];
    });

const BASE: AdvisoryBase = Object.freeze({ attestation: "browser_advisory", normalizationVersion: "v1" });

/** Every start position of `pattern` in `text`, overlapping ones included (Knuth-Morris-Pratt). */
export function findAllOccurrences(text: readonly number[], pattern: readonly number[]): number[] {
  const m = pattern.length;
  if (m === 0 || m > text.length) return [];
  const failure: number[] = new Array(m).fill(0);
  for (let i = 1, k = 0; i < m; i++) {
    while (k > 0 && pattern[i] !== pattern[k]) k = failure[k - 1];
    if (pattern[i] === pattern[k]) k += 1;
    failure[i] = k;
  }
  const starts: number[] = [];
  for (let i = 0, k = 0; i < text.length; i++) {
    while (k > 0 && text[i] !== pattern[k]) k = failure[k - 1];
    if (text[i] === pattern[k]) k += 1;
    if (k === m) {
      starts.push(i - m + 1);
      k = failure[k - 1];
    }
  }
  return starts;
}

/** The problems that make `quoteText` unusable as an abstract quote, given its v1 form. */
function quoteProblems(quoteText: string, normalized: NormalizationMap): QuoteProblem[] {
  const problems: QuoteProblem[] = [];
  const rawLength = codePointLength(quoteText);
  if (rawLength < QUOTE_MIN_LENGTH) problems.push("quote_too_short");
  if (rawLength > QUOTE_MAX_LENGTH) problems.push("quote_too_long");
  if (normalized.normalizedLength < QUOTE_MIN_LENGTH) problems.push("normalized_too_short");
  if (normalized.normalizedLength > QUOTE_MAX_LENGTH) problems.push("normalized_too_long");
  if (!LETTER_OR_DIGIT.test(normalized.normalized)) problems.push("no_letter_or_digit");
  return problems;
}

function contextAround(
  map: NormalizationMap,
  chars: readonly string[],
  start: number,
  end: number,
  length: number,
): QuoteContext {
  let from = Math.max(0, start - length);
  // Never open the context on a combining mark cut off from its base.
  while (from < start && MARK.test(chars[from])) from += 1;
  let to = Math.min(chars.length, end + length);
  while (to < chars.length && MARK.test(chars[to])) to += 1;
  const u16 = map.originalUtf16Offsets;
  return Object.freeze({
    before: map.original.slice(u16[from], u16[start]),
    match: map.original.slice(u16[start], u16[end]),
    after: map.original.slice(u16[end], u16[to]),
    truncatedBefore: from > 0,
    truncatedAfter: to < chars.length,
  });
}

/**
 * Locate `quoteText` in the saved copy `snapshotText`. Deterministic: the same
 * inputs always give the same result, occurrences in position order.
 */
export function locateQuote(
  quoteText: string,
  snapshotText: string,
  options: { readonly contextLength?: number } = {},
): AdvisoryQuoteMatch {
  if (typeof quoteText !== "string" || findPostgresTextProblem(quoteText) !== null) {
    return Object.freeze({ ...BASE, kind: "invalid", problems: Object.freeze(["malformed_text"] as const), normalizedQuote: null });
  }
  const quote = normalizeEvidenceV1WithMap(quoteText);
  const problems = quoteProblems(quoteText, quote);
  if (problems.length > 0) {
    return Object.freeze({ ...BASE, kind: "invalid", problems: Object.freeze(problems), normalizedQuote: quote.normalized });
  }

  // The saved copy is server text, so it is always storable; text that is not
  // throws EvidenceTextError rather than being matched.
  const copy = normalizeEvidenceV1WithMap(snapshotText);
  const copyChars = Array.from(snapshotText);
  const contextLength = Math.max(0, Math.floor(options.contextLength ?? DEFAULT_CONTEXT_LENGTH));
  const starts = findAllOccurrences(copy.normalizedCodePoints, quote.normalizedCodePoints);
  const occurrences = starts.map((start, index): QuoteOccurrence => {
    const end = start + quote.normalizedLength;
    const exact = mapNormalizedRange(copy, start, end) as NonNullable<ReturnType<typeof mapNormalizedRange>>;
    return Object.freeze({
      occurrence: index + 1,
      normalized: Object.freeze({ start: start as CodePointOffset, end: end as CodePointOffset }),
      exact: Object.freeze(exact),
      exactUtf16: Object.freeze({
        start: copy.originalUtf16Offsets[exact.start],
        end: copy.originalUtf16Offsets[exact.end],
      }),
      context: contextAround(copy, copyChars, exact.start, exact.end, contextLength),
    });
  });

  if (occurrences.length === 0) {
    return Object.freeze({ ...BASE, kind: "not_found", normalizedQuote: quote.normalized, count: 0 });
  }
  if (occurrences.length === 1) {
    return Object.freeze({
      ...BASE,
      kind: "unique",
      normalizedQuote: quote.normalized,
      count: 1,
      occurrences: Object.freeze([occurrences[0]] as [QuoteOccurrence]),
    });
  }
  return Object.freeze({
    ...BASE,
    kind: "multiple",
    normalizedQuote: quote.normalized,
    count: occurrences.length,
    occurrences: Object.freeze(occurrences),
  });
}

/** The occurrence the user chose from the list, by its 1-based number; null when there is no such occurrence. */
export function selectOccurrence(match: AdvisoryQuoteMatch, occurrence: number): QuoteOccurrence | null {
  if (match.kind !== "unique" && match.kind !== "multiple") return null;
  if (!Number.isInteger(occurrence)) return null;
  return match.occurrences[occurrence - 1] ?? null;
}

export type SelectionResolution =
  | { readonly kind: "resolved"; readonly occurrence: QuoteOccurrence }
  | { readonly kind: "unresolved"; readonly reason: "no_occurrences" | "outside_occurrences" | "ambiguous" };

/**
 * Which occurrence a selection in the saved copy (UTF-16 indices, as a browser
 * selection gives them) refers to: the one overlapping it most. A tie is
 * ambiguous, so the user is asked rather than guessed for.
 */
export function resolveSelectedOccurrence(
  match: AdvisoryQuoteMatch,
  selection: { readonly start: number; readonly end: number },
): SelectionResolution {
  if (match.kind !== "unique" && match.kind !== "multiple") return { kind: "unresolved", reason: "no_occurrences" };
  let best: QuoteOccurrence | null = null;
  let bestOverlap = 0;
  let tie = false;
  for (const candidate of match.occurrences) {
    const overlap = Math.min(candidate.exactUtf16.end, selection.end) - Math.max(candidate.exactUtf16.start, selection.start);
    if (overlap > bestOverlap) {
      best = candidate;
      bestOverlap = overlap;
      tie = false;
    } else if (overlap > 0 && overlap === bestOverlap) {
      tie = true;
    }
  }
  if (!best) return { kind: "unresolved", reason: "outside_occurrences" };
  if (tie) return { kind: "unresolved", reason: "ambiguous" };
  return { kind: "resolved", occurrence: best };
}

export type SelectionQuote =
  | { readonly kind: "invalid_selection" }
  | {
      readonly kind: "quote";
      readonly quoteText: string;
      readonly match: AdvisoryQuoteMatch;
      readonly selected: SelectionResolution;
    };

/**
 * A quote taken from a selection in the saved copy: the selected text, where it
 * matches, and which occurrence the selection itself is. A selection that
 * splits a character (inside a surrogate pair) or lies outside the copy is
 * refused.
 */
export function quoteFromSelection(snapshotText: string, selection: { readonly start: number; readonly end: number }): SelectionQuote {
  const { start, end } = selection;
  const valid =
    Number.isInteger(start) &&
    Number.isInteger(end) &&
    start >= 0 &&
    end <= snapshotText.length &&
    start < end &&
    !splitsSurrogatePair(snapshotText, start) &&
    !splitsSurrogatePair(snapshotText, end);
  if (!valid) return { kind: "invalid_selection" };
  const quoteText = snapshotText.slice(start, end);
  const match = locateQuote(quoteText, snapshotText);
  return { kind: "quote", quoteText, match, selected: resolveSelectedOccurrence(match, selection) };
}

function splitsSurrogatePair(text: string, index: number): boolean {
  if (index <= 0 || index >= text.length) return false;
  const before = text.charCodeAt(index - 1);
  const after = text.charCodeAt(index);
  return before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff;
}
