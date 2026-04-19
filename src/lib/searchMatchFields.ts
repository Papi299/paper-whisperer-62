/**
 * Client-side derivation of "which fields matched the search query" for a paper.
 *
 * Mirrors the two server-side search paths so the badges shown in the UI line up
 * with what the database actually filtered on:
 *
 *   - Length 1–2 chars  → server uses ILIKE substring across (title, journal,
 *                          abstract, notes, authors). We approximate with a
 *                          case-insensitive substring check on each field.
 *   - Length ≥3 chars   → server uses prefix-aware FTS (tsquery `<token>:*`).
 *                          We approximate with: tokenize the query the same way
 *                          the SQL RPC does (whitespace split + tsquery-operator
 *                          blacklist), then check whether any token is a
 *                          case-insensitive prefix of any whitespace/punctuation-
 *                          delimited word in each field.
 *
 * Constraints honoured:
 *   - The blacklist matches the SQL exactly: & | ! ( ) : * < > ' " \
 *   - Word-splitting uses the Unicode property `\p{L}\p{N}` so non-ASCII letters
 *     (Cyrillic, Hebrew, Arabic, CJK, Latin diacritics) participate correctly,
 *     matching the Unicode-preserving stance of migration 20260417030000.
 *   - Returned field labels are emitted in the fixed UI order:
 *       Title, Abstract, Authors, Journal, Notes
 *   - Abstract is checked only when present on the paper object (it is
 *     lazy-loaded). When absent, no Abstract chip is emitted; this is the
 *     documented MVP trade-off.
 */

/** Length below which the server falls back to ILIKE substring search. */
export const SERVER_SEARCH_MIN_LENGTH = 3;

/** Closed set of match-source labels shown in the UI. */
export type MatchField = "Title" | "Abstract" | "Authors" | "Journal" | "Notes";

/**
 * tsquery operator/control characters that the SQL RPC strips from user input
 * before tokenizing. Must be kept in sync with migration 20260417030000.
 */
const TSQUERY_OPERATORS = /[&|!():*<>'"\\]/g;

/**
 * Word separator for in-field tokenization. Matches anything that is NOT a
 * Unicode letter or digit. With the `u` flag, `\p{L}` and `\p{N}` cover all
 * scripts (Latin, Cyrillic, Greek, Hebrew, Arabic, CJK, Devanagari, etc.).
 */
const WORD_SEP = /[^\p{L}\p{N}]+/u;

/** Subset of paper fields the matcher needs. Abstract is optional (lazy-loaded). */
export interface MatchablePaper {
  title: string | null | undefined;
  authors: string[] | null | undefined;
  journal: string | null | undefined;
  notes: string | null | undefined;
  abstract?: string | null;
}

/**
 * Tokenize a raw user query the same way `search_papers` does server-side:
 * strip tsquery operator characters, split on whitespace, drop empties.
 * Returned tokens are NOT lowercased — caller normalizes.
 */
export function tokenizeQuery(query: string): string[] {
  return query
    .replace(TSQUERY_OPERATORS, " ")
    .split(/\s+/)
    .filter((t) => t.length > 0);
}

function fieldHasPrefixMatch(fieldText: string, lowerTokens: string[]): boolean {
  if (lowerTokens.length === 0) return false;
  const words = fieldText.toLowerCase().split(WORD_SEP).filter(Boolean);
  for (const word of words) {
    for (const tok of lowerTokens) {
      if (word.startsWith(tok)) return true;
    }
  }
  return false;
}

function fieldHasSubstringMatch(fieldText: string, lowerQuery: string): boolean {
  return fieldText.toLowerCase().includes(lowerQuery);
}

/**
 * Compute the ordered list of fields where the active search query matches.
 *
 * Returns an empty array when:
 *   - the query is empty / whitespace-only,
 *   - the query reduces to zero tokens after sanitization (FTS path),
 *   - or no field on the paper contains a match.
 *
 * Caller uses an empty result to mean "do not render the Matched-in sub-line".
 */
export function getMatchedFields(
  query: string,
  paper: MatchablePaper,
): MatchField[] {
  const trimmed = query.trim();
  if (!trimmed) return [];

  const useFts = trimmed.length >= SERVER_SEARCH_MIN_LENGTH;
  const lowerTokens = useFts
    ? tokenizeQuery(trimmed).map((t) => t.toLowerCase())
    : [];

  // FTS path: if the query was 100% blacklisted operators, there are no tokens
  // to match against (mirrors the server guard that returns zero rows).
  if (useFts && lowerTokens.length === 0) return [];

  const lowerQuery = trimmed.toLowerCase();
  const matches = (text: string): boolean =>
    useFts
      ? fieldHasPrefixMatch(text, lowerTokens)
      : fieldHasSubstringMatch(text, lowerQuery);

  const out: MatchField[] = [];
  if (paper.title && matches(paper.title)) out.push("Title");
  if (paper.abstract && matches(paper.abstract)) out.push("Abstract");
  if (paper.authors && paper.authors.length > 0) {
    // Join with a separator so a query token cannot accidentally span two authors.
    if (matches(paper.authors.join(" \u0001 "))) out.push("Authors");
  }
  if (paper.journal && matches(paper.journal)) out.push("Journal");
  if (paper.notes && matches(paper.notes)) out.push("Notes");

  return out;
}
