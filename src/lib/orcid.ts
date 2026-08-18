/**
 * ORCID provenance canonicalization.
 *
 * An ORCID iD is 16 digits written as four hyphen-separated groups of four,
 * whose final character is an ISO/IEC 7064:2003 MOD 11-2 check character —
 * `0`–`9`, or a capital `X` standing for the value 10. ORCID states the `X`
 * must be capitalized for the iD to be valid, so canonical output always
 * carries the capital form.
 *
 * What this module is for, and what it is emphatically not for:
 *
 *  • It answers "is this string a well-formed, checksum-valid ORCID iD, and
 *    what is its canonical spelling?". That is a *format* question, decided
 *    entirely offline — no ORCID registry lookup happens or is needed.
 *  • It says nothing about people. A canonical ORCID here is provenance: the
 *    value some bibliographic source attached to one authorship mention. Two
 *    mentions carrying the same ORCID are still two mentions. Deciding they
 *    are one researcher is identity resolution and does not live here.
 *
 * Deliberately strict. A source-labelled ORCID that fails validation yields
 * `null` rather than a repaired guess, because the caller keeps the raw value
 * in its identifier provenance either way — a wrong canonical ORCID would be
 * worse than an absent one.
 *
 * The Edge Function keeps its own copy at
 * `supabase/functions/_shared/orcid.ts`: the two runtimes have separate module
 * graphs and the app build does not reach into `supabase/`. Both are pinned to
 * the same locked vector table (`src/lib/__tests__/fixtures/orcidVectors.ts`)
 * so they cannot silently diverge.
 */

/**
 * A bare canonical iD: four groups of four, the last character a digit or `X`.
 * Anchored, and hyphens are required — a run of 16 digits is *not* accepted.
 * "Contains 16 digits somewhere" is the reasoning that turns an arbitrary
 * accession number into a fake ORCID, so the separators are load-bearing.
 */
const CANONICAL_ORCID = /^(\d{4})-(\d{4})-(\d{4})-(\d{3})([\dX])$/;

/**
 * The documented ORCID URI prefix. ORCID's canonical URI is
 * `https://orcid.org/<id>`; `http://` and a `www.` host are the historical
 * forms still present in provider metadata (Crossref emits `http://orcid.org/`
 * to this day), so both are accepted and normalized away.
 */
const ORCID_URI_PREFIX = /^https?:\/\/(?:www\.)?orcid\.org\//i;

/**
 * The ISO/IEC 7064 MOD 11-2 check character for the first 15 digits.
 *
 * Running total doubles after each digit is added; the check value is
 * `(12 - total mod 11) mod 11`, with 10 written as `X`.
 */
function mod11_2CheckCharacter(first15Digits: string): string {
  let total = 0;
  for (const digit of first15Digits) {
    total = (total + Number(digit)) * 2;
  }
  const result = (12 - (total % 11)) % 11;
  return result === 10 ? "X" : String(result);
}

/**
 * Canonicalize a source-supplied ORCID value, or `null` when it is not a
 * checksum-valid ORCID iD.
 *
 * Accepted input, in exactly these tolerances:
 *   • surrounding whitespace;
 *   • the `https://orcid.org/` / `http://orcid.org/` / `www.` URI forms;
 *   • a lowercase `x` check character, which canonicalizes to `X` — the check
 *     *value* is 10 either way, and ORCID's canonical spelling is the capital.
 *
 * Everything else fails closed: no digit regrouping, no hyphen insertion, no
 * extraction of an ORCID-looking substring out of a larger string.
 */
export function normalizeOrcid(raw: unknown): string | null {
  if (typeof raw !== "string") return null;

  const withoutPrefix = raw.trim().replace(ORCID_URI_PREFIX, "");
  // Only the check character may be lowercase, and only as `x`. Upper-casing
  // the whole string is safe because every other position is a digit.
  const candidate = withoutPrefix.toUpperCase();

  const match = CANONICAL_ORCID.exec(candidate);
  if (!match) return null;

  const digits = candidate.replace(/-/g, "");
  if (mod11_2CheckCharacter(digits.slice(0, 15)) !== digits[15]) return null;

  return candidate;
}

/**
 * Whether an identifier scheme/authority explicitly names ORCID.
 *
 * Matched case-insensitively and after trimming, because the authority arrives
 * as `ORCID` from PubMed XML, `ORCID` from a MEDLINE `AUID` prefix, and
 * `orcid` from assorted exports. Nothing fuzzy: a scheme that merely *mentions*
 * ORCID inside a longer authority string is not ORCID.
 */
export function isOrcidScheme(scheme: unknown): boolean {
  return typeof scheme === "string" && scheme.trim().toUpperCase() === "ORCID";
}

/**
 * The single canonical ORCID for one authorship mention, or `null`.
 *
 * Only identifiers whose scheme explicitly states ORCID are considered, and
 * the rule fails closed in both directions the task cares about:
 *
 *   • no ORCID-labelled candidate            → `null`
 *   • every candidate valid, one distinct iD → that iD (duplicate spellings of
 *                                              the same iD — bare plus URI form
 *                                              — collapse to one)
 *   • any candidate malformed or checksum-invalid → `null`
 *   • two or more distinct valid iDs         → `null`
 *
 * A malformed candidate poisons the derived field rather than being skipped:
 * the source labelled it ORCID and got it wrong, so nothing else it labelled
 * ORCID for the same mention is trustworthy enough to promote. The raw values
 * are never discarded — they stay in the caller's `identifiers` array, where
 * they remain useful for diagnosis.
 */
export function deriveCanonicalOrcid(
  // Structural, not the named provenance interface: this module stays free of
  // any dependency on the authorship contract that consumes it.
  identifiers: readonly { readonly scheme: string; readonly value: string }[],
): string | null {
  const distinct = new Set<string>();

  for (const identifier of identifiers) {
    if (!isOrcidScheme(identifier.scheme)) continue;
    const canonical = normalizeOrcid(identifier.value);
    if (canonical === null) return null;
    distinct.add(canonical);
  }

  return distinct.size === 1 ? [...distinct][0] : null;
}
