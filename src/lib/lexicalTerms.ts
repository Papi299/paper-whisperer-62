/**
 * Keyword Pool lexical term matching — the single authoritative answer to
 * "does this pool term actually occur in this text, as a term?".
 *
 * Both consumers depend on this module so they cannot drift apart:
 *   - `extractContextualKeywords` (textUtils) layers negation semantics on top;
 *   - `HighlightedAbstract` renders the returned source ranges as <mark>.
 *
 * This module is deliberately free of negation semantics. It answers the purely
 * lexical question; deciding whether an occurrence *counts* belongs to callers.
 *
 * Matching runs against a normalized copy of the text (same folds as
 * `normalizeText`), but every match carries offsets back into the ORIGINAL
 * string, so callers highlight the user's exact spelling, casing and spacing.
 */

/**
 * Characters that continue a lexical token. Unicode-aware on purpose: ASCII
 * `\b` treats `α` and `é` as non-word, so `/\bCT\b/` happily matches the middle
 * of `αCTβ`, and a pool term like `β` could never match at all.
 *
 * Letters and numbers are the obvious token characters. Combining marks are
 * included so `e` does not match the `e` of a decomposed `é`, and connector
 * punctuation so `CT` does not match inside `CT_value`.
 */
const TOKEN_CHAR = /[\p{L}\p{N}\p{M}\p{Pc}]/u;

/** Mirrors the `\s+` class used by `normalizeText`. */
const WHITESPACE_CHAR = /\s/;

/** Folded to `'` by `normalizeText` — left/right single quote, prime. */
const APOSTROPHES = new Set(["‘", "’", "′"]);
/** Folded to `"` by `normalizeText` — left/right double quote. */
const DOUBLE_QUOTES = new Set(["“", "”"]);
/** Folded to `-` by `normalizeText` — hyphen, en dash, em dash. */
const DASHES = new Set(["-", "–", "—"]);

export interface LexicalTermMatch {
  /** Index into the `terms` array that produced this match. */
  termIndex: number;
  /** The term exactly as the caller supplied it. */
  term: string;
  /** Inclusive start offset in the original source text. */
  start: number;
  /** Exclusive end offset in the original source text. */
  end: number;
  /** `text.slice(start, end)` — original casing and spacing preserved. */
  matchedText: string;
  /** Inclusive start offset in `normalizedText`, for context inspection. */
  normalizedStart: number;
}

export interface LexicalScan {
  /**
   * The normalized comparison text. Equivalent to `normalizeText(text)`, and
   * exposed so callers that reason about surrounding context (negation windows)
   * do not have to normalize a second time and risk diverging.
   */
  normalizedText: string;
  /**
   * Every lexical occurrence of every term, including occurrences that overlap
   * each other. Sorted by start offset ascending, then longer match first, then
   * term order. Overlap-free rendering is a separate concern — see
   * `resolveOverlappingMatches`.
   */
  matches: LexicalTermMatch[];
}

interface NormalizedIndex {
  normalized: string;
  /** For normalized offset i, the inclusive source offset it came from. */
  sourceStart: number[];
  /** For normalized offset i, the exclusive source offset it came from. */
  sourceEnd: number[];
}

/** Returns the code point ending at `index` (exclusive), or null at the start. */
function codePointBefore(text: string, index: number): number | null {
  if (index <= 0) return null;
  const code = text.charCodeAt(index - 1);
  // Low surrogate preceded by a high surrogate: step back over the whole pair.
  if (code >= 0xdc00 && code <= 0xdfff && index >= 2) {
    const high = text.charCodeAt(index - 2);
    if (high >= 0xd800 && high <= 0xdbff) return text.codePointAt(index - 2)!;
  }
  return code;
}

/** True when the code point continues a lexical token. */
function isTokenCodePoint(codePoint: number | null): boolean {
  if (codePoint === null) return false;
  return TOKEN_CHAR.test(String.fromCodePoint(codePoint));
}

/**
 * Folds a single source character the way `normalizeText` folds the whole
 * string. Lowercasing can expand one character into several (U+0130 → "i̇"),
 * so this returns a string rather than a character.
 */
function foldCharacter(source: string): string {
  const lowered = source.toLowerCase();
  if (APOSTROPHES.has(lowered)) return "'";
  if (DOUBLE_QUOTES.has(lowered)) return '"';
  if (DASHES.has(lowered)) return "-";
  return lowered;
}

/**
 * Builds the normalized comparison text together with a per-character map back
 * into the source. The map is what lets us fold case, quotes, dashes and
 * whitespace runs for matching while still highlighting untouched source text.
 */
function buildNormalizedIndex(text: string): NormalizedIndex {
  let normalized = "";
  const sourceStart: number[] = [];
  const sourceEnd: number[] = [];

  let cursor = 0;
  while (cursor < text.length) {
    if (WHITESPACE_CHAR.test(text[cursor])) {
      const runStart = cursor;
      while (cursor < text.length && WHITESPACE_CHAR.test(text[cursor])) cursor++;
      // A whitespace run collapses to one space that spans the whole run.
      // Dropping it when the output is still empty reproduces the leading half
      // of `normalizeText`'s trim.
      if (normalized.length > 0) {
        normalized += " ";
        sourceStart.push(runStart);
        sourceEnd.push(cursor);
      }
      continue;
    }

    const codePoint = text.codePointAt(cursor)!;
    const source = String.fromCodePoint(codePoint);
    const folded = foldCharacter(source);
    for (let i = 0; i < folded.length; i++) {
      normalized += folded[i];
      sourceStart.push(cursor);
      sourceEnd.push(cursor + source.length);
    }
    cursor += source.length;
  }

  // Trailing half of the trim. Runs are already collapsed, so at most one.
  if (normalized.endsWith(" ")) {
    normalized = normalized.slice(0, -1);
    sourceStart.pop();
    sourceEnd.pop();
  }

  return { normalized, sourceStart, sourceEnd };
}

/**
 * Normalizes a pool term for comparison against normalized text: same folds,
 * whitespace runs collapsed, trimmed. Returns "" for terms that carry no
 * matchable content.
 */
export function normalizeLexicalTerm(term: string): string {
  return buildNormalizedIndex(term).normalized;
}

/**
 * True when `[start, end)` in `normalized` stands as its own lexical token
 * rather than sitting inside a bigger one.
 *
 * The rule is a Unicode-aware relaxation of `\b`: an end is only rejected when
 * the match character there AND the neighbouring text character are both token
 * characters, i.e. when the occurrence continues an unbroken token run. That
 * keeps `effects` from matching `CT` while still allowing `C++.`, `(β)` and
 * `CT/MRI`, where a strict word/non-word transition test would fail.
 */
function isStandaloneToken(normalized: string, start: number, end: number): boolean {
  const firstOfMatch = normalized.codePointAt(start)!;
  if (isTokenCodePoint(firstOfMatch) && isTokenCodePoint(codePointBefore(normalized, start))) {
    return false;
  }
  const lastOfMatch = codePointBefore(normalized, end)!;
  const next = end < normalized.length ? normalized.codePointAt(end)! : null;
  if (isTokenCodePoint(lastOfMatch) && isTokenCodePoint(next)) {
    return false;
  }
  return true;
}

/**
 * Finds every lexical occurrence of every term in `text`.
 *
 * Terms are treated as literal text, never as patterns — matching is done with
 * `indexOf`, so regex metacharacters (`C++`, `(test)`) are inherently safe.
 * Empty and whitespace-only terms are skipped, which also rules out any
 * zero-length scan loop.
 */
export function scanLexicalTerms(text: string, terms: string[]): LexicalScan {
  const { normalized, sourceStart, sourceEnd } = buildNormalizedIndex(text);
  const matches: LexicalTermMatch[] = [];

  if (normalized.length > 0) {
    for (let termIndex = 0; termIndex < terms.length; termIndex++) {
      const term = terms[termIndex];
      const needle = normalizeLexicalTerm(term ?? "");
      if (needle.length === 0) continue;

      let from = 0;
      let at = normalized.indexOf(needle, from);
      while (at !== -1) {
        // Advance by one so overlapping occurrences of the same term are still
        // reachable, and so progress is guaranteed.
        from = at + 1;
        const end = at + needle.length;
        if (isStandaloneToken(normalized, at, end)) {
          const start = sourceStart[at];
          const stop = sourceEnd[end - 1];
          matches.push({
            termIndex,
            term,
            start,
            end: stop,
            matchedText: text.slice(start, stop),
            normalizedStart: at,
          });
        }
        at = normalized.indexOf(needle, from);
      }
    }
  }

  matches.sort(
    (a, b) =>
      a.start - b.start ||
      b.end - b.start - (a.end - a.start) ||
      a.termIndex - b.termIndex,
  );

  return { normalizedText: normalized, matches };
}

/**
 * Reduces overlapping matches to a non-overlapping set suitable for rendering,
 * so no source span is ever wrapped twice or nested.
 *
 * Deterministic greedy rule over the scan order (start ascending, longest
 * first, then term order): keep a match when it starts at or after the end of
 * the last kept one. So `CT scan` wins over `CT` at the same start, and
 * duplicate or case-equivalent pool entries collapse to a single span.
 */
export function resolveOverlappingMatches(matches: LexicalTermMatch[]): LexicalTermMatch[] {
  const resolved: LexicalTermMatch[] = [];
  let lastEnd = -1;
  for (const match of matches) {
    if (match.start < lastEnd) continue;
    resolved.push(match);
    lastEnd = match.end;
  }
  return resolved;
}
