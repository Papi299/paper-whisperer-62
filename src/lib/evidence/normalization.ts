/**
 * Match normalization v1 in TypeScript (EVIDENCE-RECORDS-001B).
 *
 * A pure twin of the deployed `public.evidence_normalize_v1(text)`
 * (`20261016104232`), which is the authority. Applied in exactly its order:
 *
 *   1. Unicode NFC — never NFKC or NFKD, which would read 10⁵ as 105;
 *   2. remove U+00AD, U+200B, U+2060 and U+FEFF;
 *   3. map each of the 25 Unicode White_Space code points to U+0020, collapse
 *      runs of spaces into one, and trim both ends;
 *   4. map U+2018 U+2019 U+201A U+201B to U+0027 and U+201C U+201D U+201E
 *      U+201F to U+0022;
 *   5. map U+2010-U+2015 and U+2212 to U+002D;
 *   6. map U+2026 to three U+002E, and U+00B5 to U+03BC.
 *
 * Nothing else: no case folding, stemming, accent stripping, punctuation
 * removal, tokenization, symbol substitution or wildcard.
 *
 * NORMALIZE EACH ORIGINAL INPUT EXACTLY ONCE. v1 is not idempotent: NFC runs
 * before step 2, so "e", U+00AD, U+0301 becomes "e" + U+0301 — the soft hyphen
 * blocked the composition — and a second pass would compose it to U+00E9.
 * Re-normalizing a normalized string therefore changes the semantics, and no
 * function here does it. The shared golden fixture pins this edge for both
 * implementations.
 *
 * WHAT A "CHARACTER" IS. PostgreSQL counts text in Unicode code points
 * (char_length, position, substr); JavaScript strings index UTF-16 code units,
 * which split every character above U+FFFF in two. Every offset this module
 * returns is a code point offset unless its name says `utf16`, and the two are
 * distinct branded types so one cannot be passed for the other by accident.
 *
 * WHAT IT CANNOT PROMISE. Both NFC implementations follow their own Unicode
 * tables: PostgreSQL 17 its built-in Unicode 15.1 data, a browser or Node its
 * ICU version. They agree on every character both versions assign; text using
 * characters assigned after the server's version can normalize differently.
 * The browser result is advisory, and the server decides.
 *
 * Text PostgreSQL cannot store — a lone UTF-16 surrogate, or U+0000 — is
 * refused with `EvidenceTextError` rather than normalized into something the
 * server could never produce.
 */

declare const unit: unique symbol;

/** An offset in Unicode code points: PostgreSQL's notion of a character position. */
export type CodePointOffset = number & { readonly [unit]: "code_point" };

/** An offset in UTF-16 code units: a JavaScript string index. */
export type Utf16Offset = number & { readonly [unit]: "utf16" };

export const NORMALIZATION_VERSION = "v1" as const;

/** Step 2: removed outright. */
export const REMOVED_CODE_POINTS: readonly number[] = Object.freeze([0x00ad, 0x200b, 0x2060, 0xfeff]);

/** Step 3: exactly the 25 code points the SQL function translates to a space. */
export const WHITE_SPACE_CODE_POINTS: readonly number[] = Object.freeze([
  0x0009, 0x000a, 0x000b, 0x000c, 0x000d, 0x0020, 0x0085, 0x00a0, 0x1680, 0x2000, 0x2001, 0x2002, 0x2003, 0x2004,
  0x2005, 0x2006, 0x2007, 0x2008, 0x2009, 0x200a, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000,
]);

const REMOVED = new Set(REMOVED_CODE_POINTS);
const WHITE_SPACE = new Set(WHITE_SPACE_CODE_POINTS);
const SINGLE_QUOTES = new Set([0x2018, 0x2019, 0x201a, 0x201b]);
const DOUBLE_QUOTES = new Set([0x201c, 0x201d, 0x201e, 0x201f]);
const DASHES = new Set([0x2010, 0x2011, 0x2012, 0x2013, 0x2014, 0x2015, 0x2212]);
const ELLIPSIS = 0x2026;
const MICRO_SIGN = 0x00b5;
const GREEK_SMALL_MU = 0x03bc;
const SPACE = 0x20;
const APOSTROPHE = 0x27;
const QUOTATION_MARK = 0x22;
const HYPHEN_MINUS = 0x2d;
const FULL_STOP = 0x2e;

export type EvidenceTextProblem = "lone_surrogate" | "nul_character";

/** Raised for text no PostgreSQL text value can hold. */
export class EvidenceTextError extends Error {
  readonly kind = "malformed_text" as const;
  readonly reason: EvidenceTextProblem;

  constructor(reason: EvidenceTextProblem) {
    super(`Text cannot be stored by PostgreSQL: ${reason}`);
    this.name = "EvidenceTextError";
    this.reason = reason;
  }
}

/** Why PostgreSQL could not store `text`, or null when it could. */
export function findPostgresTextProblem(text: string): EvidenceTextProblem | null {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code === 0) return "nul_character";
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = i + 1 < text.length ? text.charCodeAt(i + 1) : -1;
      if (next >= 0xdc00 && next <= 0xdfff) {
        i += 1;
        continue;
      }
      return "lone_surrogate";
    }
    if (code >= 0xdc00 && code <= 0xdfff) return "lone_surrogate";
  }
  return null;
}

function assertPostgresText(text: string): void {
  if (typeof text !== "string") throw new TypeError("normalizeEvidenceV1 expects a string");
  const problem = findPostgresTextProblem(text);
  if (problem) throw new EvidenceTextError(problem);
}

/** Steps 4-6 for one non-space code point: the code points it becomes. */
function mapCodePoint(cp: number): number[] | null {
  if (SINGLE_QUOTES.has(cp)) return [APOSTROPHE];
  if (DOUBLE_QUOTES.has(cp)) return [QUOTATION_MARK];
  if (DASHES.has(cp)) return [HYPHEN_MINUS];
  if (cp === ELLIPSIS) return [FULL_STOP, FULL_STOP, FULL_STOP];
  if (cp === MICRO_SIGN) return [GREEK_SMALL_MU];
  return null;
}

/** Match normalization v1. Pure; throws `EvidenceTextError` for text PostgreSQL cannot hold. */
export function normalizeEvidenceV1(text: string): string {
  assertPostgresText(text);
  const out: string[] = [];
  let pendingSpace = false;
  let started = false;
  for (const ch of text.normalize("NFC")) {
    const cp = ch.codePointAt(0) as number;
    if (REMOVED.has(cp)) continue;
    if (WHITE_SPACE.has(cp)) {
      if (started) pendingSpace = true;
      continue;
    }
    if (pendingSpace) {
      out.push(" ");
      pendingSpace = false;
    }
    started = true;
    const mapped = mapCodePoint(cp);
    out.push(mapped ? String.fromCodePoint(...mapped) : ch);
  }
  return out.join("");
}

/**
 * Whether `text` is empty after v1 — white space and invisible format
 * characters only. PR-A2 refuses such a label or notes, and saves no copy of
 * such an abstract (accepted decision 9).
 */
export function isNormalizationEmpty(text: string): boolean {
  return normalizeEvidenceV1(text) === "";
}

/** The number of code points in `text` — PostgreSQL's char_length for the same text. */
export function codePointLength(text: string): number {
  let count = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length) {
      const next = text.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) i += 1;
    }
    count += 1;
  }
  return count;
}

/** The UTF-16 index of each code point boundary of `text` (length = code points + 1). */
export function utf16BoundaryOffsets(text: string): readonly Utf16Offset[] {
  const offsets: number[] = [0];
  let index = 0;
  for (const ch of text) {
    index += ch.length;
    offsets.push(index);
  }
  return Object.freeze(offsets) as readonly Utf16Offset[];
}

/** The code point offset of a UTF-16 index, or null when it falls inside a surrogate pair or out of range. */
export function toCodePointOffset(text: string, offset: number): CodePointOffset | null {
  if (!Number.isInteger(offset) || offset < 0 || offset > text.length) return null;
  const boundaries = utf16BoundaryOffsets(text);
  const position = boundaries.indexOf(offset as Utf16Offset);
  return position === -1 ? null : (position as CodePointOffset);
}

/** The UTF-16 index of a code point offset, or null when out of range. */
export function toUtf16Offset(text: string, offset: number): Utf16Offset | null {
  const boundaries = utf16BoundaryOffsets(text);
  return Number.isInteger(offset) && offset >= 0 && offset < boundaries.length ? boundaries[offset] : null;
}

// ── The index map ────────────────────────────────────────────────────────────

/**
 * v1 output together with where each output code point came from.
 *
 * `sourceStart[i]` and `sourceEnd[i]` give the half-open range of ORIGINAL code
 * points that produced normalized code point `i`. Ranges never decrease, so a
 * normalized range [s, e) maps to the original range
 * [sourceStart[s], sourceEnd[e - 1]). One original character can produce
 * several output characters (U+2026 becomes three full stops, NFC can expand a
 * composition exclusion), and several original characters can produce one
 * (NFC composition, a collapsed white-space run); in both cases every output
 * character maps to the whole original range, so a mapped range always covers
 * whole original characters.
 */
export interface NormalizationMap {
  readonly original: string;
  readonly normalized: string;
  /** The normalized text as code points. */
  readonly normalizedCodePoints: readonly number[];
  readonly originalLength: number;
  readonly normalizedLength: number;
  readonly sourceStart: readonly CodePointOffset[];
  readonly sourceEnd: readonly CodePointOffset[];
  /** UTF-16 index of each original code point boundary (length = originalLength + 1). */
  readonly originalUtf16Offsets: readonly Utf16Offset[];
}

/** One NFC output code point and the original code point range it came from. */
export interface NfcUnit {
  cp: number;
  start: number;
  end: number;
}

interface Chunk {
  start: number;
  end: number;
  nfc: string;
}

const MARK = /\p{M}/u;

/**
 * Whether a chunk boundary may sit right before code point `cp`: NFC can only
 * combine a character with what precedes it when it is a mark or a Hangul
 * medial vowel or final consonant. A wrong guess here cannot change the output:
 * `nfcUnits` checks the chunks against whole-string NFC and merges any that
 * disagree.
 */
export function isLikelyNfcBoundary(cp: number): boolean {
  if (cp < 0x80) return true;
  if ((cp >= 0x1161 && cp <= 0x1175) || (cp >= 0x11a8 && cp <= 0x11c2)) return false;
  return !MARK.test(String.fromCodePoint(cp));
}

/**
 * NFC with provenance. Exported for its tests only: `boundaryBefore` lets a
 * test force wrong chunk boundaries and prove the reconciliation repairs them.
 */
export function nfcUnits(codePoints: readonly string[], boundaryBefore: (cp: number) => boolean = isLikelyNfcBoundary): NfcUnit[] {
  const text = codePoints.join("");
  const whole = text.normalize("NFC");
  if (whole === text) {
    return codePoints.map((ch, i) => ({ cp: ch.codePointAt(0) as number, start: i, end: i + 1 }));
  }

  const chunkText = (start: number, end: number) => codePoints.slice(start, end).join("");
  let chunks: Chunk[] = [];
  let start = 0;
  for (let i = 1; i <= codePoints.length; i++) {
    if (i === codePoints.length || boundaryBefore(codePoints[i].codePointAt(0) as number)) {
      chunks.push({ start, end: i, nfc: chunkText(start, i).normalize("NFC") });
      start = i;
    }
  }

  const joined = (list: Chunk[]) => list.map((c) => c.nfc).join("");
  let merged = true;
  while (merged && joined(chunks) !== whole) {
    merged = false;
    const next: Chunk[] = [chunks[0]];
    for (let k = 1; k < chunks.length; k++) {
      const previous = next[next.length - 1];
      const current = chunks[k];
      const pair = chunkText(previous.start, current.end).normalize("NFC");
      if (pair !== previous.nfc + current.nfc) {
        next[next.length - 1] = { start: previous.start, end: current.end, nfc: pair };
        merged = true;
      } else {
        next.push(current);
      }
    }
    chunks = next;
  }
  if (joined(chunks) !== whole) chunks = [{ start: 0, end: codePoints.length, nfc: whole }];

  const units: NfcUnit[] = [];
  for (const chunk of chunks) {
    const source = chunkText(chunk.start, chunk.end);
    if (chunk.nfc === source) {
      for (let i = chunk.start; i < chunk.end; i++) {
        units.push({ cp: codePoints[i].codePointAt(0) as number, start: i, end: i + 1 });
      }
    } else {
      for (const ch of chunk.nfc) units.push({ cp: ch.codePointAt(0) as number, start: chunk.start, end: chunk.end });
    }
  }
  return units;
}

/** Match normalization v1 with its index map. Same output as `normalizeEvidenceV1`. */
export function normalizeEvidenceV1WithMap(text: string): NormalizationMap {
  assertPostgresText(text);
  const codePoints = Array.from(text);
  const out: NfcUnit[] = [];
  let pending: NfcUnit | null = null;
  let started = false;

  for (const u of nfcUnits(codePoints)) {
    if (REMOVED.has(u.cp)) continue;
    if (WHITE_SPACE.has(u.cp)) {
      if (!started) continue;
      if (pending) pending.end = u.end;
      else pending = { cp: SPACE, start: u.start, end: u.end };
      continue;
    }
    if (pending) {
      out.push(pending);
      pending = null;
    }
    started = true;
    const mapped = mapCodePoint(u.cp);
    if (mapped) for (const cp of mapped) out.push({ cp, start: u.start, end: u.end });
    else out.push(u);
  }

  const normalizedCodePoints = out.map((u) => u.cp);
  return Object.freeze({
    original: text,
    // One call per code point: spreading a 50,000-character abstract into a
    // single fromCodePoint call can exceed the engine's argument limit.
    normalized: normalizedCodePoints.map((cp) => String.fromCodePoint(cp)).join(""),
    normalizedCodePoints: Object.freeze(normalizedCodePoints),
    originalLength: codePoints.length,
    normalizedLength: out.length,
    sourceStart: Object.freeze(out.map((u) => u.start)) as readonly CodePointOffset[],
    sourceEnd: Object.freeze(out.map((u) => u.end)) as readonly CodePointOffset[],
    originalUtf16Offsets: utf16BoundaryOffsets(text),
  });
}

/**
 * The original code point range a normalized range [start, end) came from.
 * The result covers whole original characters; `snapped` is true when the
 * normalized range began or ended inside the output of one original character
 * (inside an expanded ellipsis, or inside a composed sequence).
 */
export function mapNormalizedRange(
  map: NormalizationMap,
  start: number,
  end: number,
): { start: CodePointOffset; end: CodePointOffset; snapped: boolean } | null {
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end > map.normalizedLength || end <= start) {
    return null;
  }
  const originalStart = map.sourceStart[start];
  const originalEnd = map.sourceEnd[end - 1];
  const startsInside = start > 0 && map.sourceStart[start - 1] === originalStart && map.sourceEnd[start - 1] === map.sourceEnd[start];
  const endsInside = end < map.normalizedLength && map.sourceStart[end] === map.sourceStart[end - 1] && map.sourceEnd[end] === originalEnd;
  return { start: originalStart, end: originalEnd, snapped: startsInside || endsInside };
}
