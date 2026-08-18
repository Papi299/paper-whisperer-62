/**
 * ORCID provenance canonicalization — Edge Function copy.
 *
 * ## Why this is a copy
 *
 * The application's copy lives at `src/lib/orcid.ts`. The two runtimes have
 * separate module graphs: the Vite build resolves `@/…` inside `src/` and never
 * reaches into `supabase/`, and the Deno bundle produced by
 * `supabase functions deploy` resolves relative `.ts` specifiers under
 * `supabase/functions/` and never reaches into `src/`. Importing across that
 * line would either break the Edge deploy or drag Deno-shaped modules into the
 * browser bundle, so `_shared/` carries its own minimal implementation — the
 * same arrangement `publicationTypes.ts` and `identifierDetection.ts` already
 * use.
 *
 * The boundary is a packaging fact, not permission to disagree. Both copies are
 * asserted against ONE locked vector table
 * (`src/lib/__tests__/fixtures/orcidVectors.ts`) from their respective Vitest
 * suites, so a change to either that the table does not sanction fails.
 *
 * Semantics, identical to the application copy: an ORCID iD is 16 digits in
 * four hyphen-separated groups whose final character is an ISO/IEC 7064:2003
 * MOD 11-2 check character — `0`–`9` or a capital `X` for the value 10. No
 * registry lookup happens; validity here is a purely offline format question.
 * A canonical ORCID is provenance about what a source stated, never a decision
 * that two authorship mentions are the same person.
 */

/** Four groups of four; hyphens required. A bare run of 16 digits is not an ORCID. */
const CANONICAL_ORCID = /^(\d{4})-(\d{4})-(\d{4})-(\d{3})([\dX])$/;

/** ORCID's canonical `https://orcid.org/` URI, plus the historical forms providers still emit. */
const ORCID_URI_PREFIX = /^https?:\/\/(?:www\.)?orcid\.org\//i;

/** ISO/IEC 7064 MOD 11-2 check character for the first 15 digits. */
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
 * checksum-valid ORCID iD. Tolerates surrounding whitespace, the documented
 * `orcid.org` URI forms, and a lowercase `x` check character; fails closed on
 * everything else.
 */
export function normalizeOrcid(raw: unknown): string | null {
  if (typeof raw !== "string") return null;

  const withoutPrefix = raw.trim().replace(ORCID_URI_PREFIX, "");
  const candidate = withoutPrefix.toUpperCase();

  const match = CANONICAL_ORCID.exec(candidate);
  if (!match) return null;

  const digits = candidate.replace(/-/g, "");
  if (mod11_2CheckCharacter(digits.slice(0, 15)) !== digits[15]) return null;

  return candidate;
}

/** Whether an identifier scheme/authority explicitly names ORCID. */
export function isOrcidScheme(scheme: unknown): boolean {
  return typeof scheme === "string" && scheme.trim().toUpperCase() === "ORCID";
}

/**
 * The single canonical ORCID for one authorship mention, or `null`.
 *
 * Fails closed: no ORCID-labelled candidate, any malformed or checksum-invalid
 * candidate, or two distinct valid iDs all yield `null`. Duplicate spellings of
 * the same iD (bare plus URI form) collapse to one. Raw values are never
 * discarded — the caller keeps them in `identifiers`.
 */
export function deriveCanonicalOrcid(
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
