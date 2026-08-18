/**
 * Locked ORCID validation vectors — the single table both runtimes are pinned
 * to.
 *
 * The browser application (`src/lib/orcid.ts`) and the Supabase Edge Function
 * (`supabase/functions/_shared/orcid.ts`) each carry their own copy of the
 * normalizer, because they have separate module graphs: the Vite app build does
 * not reach into `supabase/`, and the Deno bundle does not reach into `src/`.
 * That boundary is a packaging fact, not a licence for the two to disagree —
 * so both test suites import *these* vectors and assert identical results. A
 * change to one implementation that this table does not sanction fails in both
 * places at once.
 *
 * Every expectation here is derived from ORCID's published structure: 16 digits
 * in four hyphen-separated groups, with an ISO/IEC 7064:2003 MOD 11-2 check
 * character that is `0`–`9` or a capital `X` for the value 10.
 *
 * Provenance of the two valid iDs: `0000-0002-1825-0097` is ORCID's own
 * long-standing documentation example, and `0000-0002-1694-233X` is the
 * standard capital-`X` example. Both check characters are verified by hand
 * against the MOD 11-2 algorithm, not copied from an implementation.
 */

/** A checksum-valid ORCID whose check character is an ordinary digit. */
export const VALID_ORCID = "0000-0002-1825-0097";

/** A checksum-valid ORCID whose check character is the capital `X` (value 10). */
export const VALID_ORCID_X = "0000-0002-1694-233X";

/** `VALID_ORCID` with its final digit altered — well-formed, checksum-invalid. */
export const INVALID_CHECKSUM_ORCID = "0000-0002-1825-0098";

/** A second distinct checksum-valid ORCID, for conflict cases. */
export const OTHER_VALID_ORCID = "0000-0001-5109-3700";

export interface OrcidVector {
  /** What the case proves, used as the test name. */
  readonly name: string;
  /** The raw source-supplied value. */
  readonly input: string;
  /** Canonical output, or `null` when the value must fail closed. */
  readonly expected: string | null;
}

/**
 * `normalizeOrcid` cases. Ordered by theme: canonical forms, the documented
 * tolerances, then every way a value must fail closed.
 */
export const ORCID_NORMALIZATION_VECTORS: readonly OrcidVector[] = [
  // ── Valid canonical ──
  {
    name: "accepts a checksum-valid ORCID with a numeric check digit",
    input: VALID_ORCID,
    expected: VALID_ORCID,
  },
  {
    name: "accepts a checksum-valid ORCID whose check character is X",
    input: VALID_ORCID_X,
    expected: VALID_ORCID_X,
  },

  // ── Documented provider forms ──
  {
    name: "strips the canonical https://orcid.org/ URI prefix",
    input: `https://orcid.org/${VALID_ORCID}`,
    expected: VALID_ORCID,
  },
  {
    name: "strips the historical http://orcid.org/ prefix Crossref still emits",
    input: `http://orcid.org/${VALID_ORCID_X}`,
    expected: VALID_ORCID_X,
  },
  {
    name: "strips a www. host",
    input: `https://www.orcid.org/${VALID_ORCID}`,
    expected: VALID_ORCID,
  },
  {
    name: "removes surrounding whitespace",
    input: `\t  ${VALID_ORCID}\n `,
    expected: VALID_ORCID,
  },
  {
    name: "removes surrounding whitespace around a URI form",
    input: `  https://orcid.org/${VALID_ORCID_X}  `,
    expected: VALID_ORCID_X,
  },
  {
    name: "canonicalizes a lowercase x check character to uppercase X",
    input: "0000-0002-1694-233x",
    expected: VALID_ORCID_X,
  },

  // ── Invalid checksum ──
  {
    name: "rejects a well-formed ORCID whose checksum does not verify",
    input: INVALID_CHECKSUM_ORCID,
    expected: null,
  },
  {
    name: "rejects a checksum-invalid value even in canonical URI form",
    input: `https://orcid.org/${INVALID_CHECKSUM_ORCID}`,
    expected: null,
  },
  {
    name: "rejects an X check character where the checksum requires a digit",
    input: "0000-0002-1825-009X",
    expected: null,
  },

  // ── Invalid shape ──
  {
    name: "rejects a value with too few groups",
    input: "0000-0002-1825",
    expected: null,
  },
  {
    name: "rejects 16 unseparated digits — digit count is not an ORCID",
    input: "0000000218250097",
    expected: null,
  },
  {
    name: "rejects a value with a letter outside the check position",
    input: "0000-0002-18X5-0097",
    expected: null,
  },
  {
    name: "rejects an ORCID embedded in surrounding text",
    input: `ORCID: ${VALID_ORCID}`,
    expected: null,
  },
  {
    name: "rejects a trailing-character variant of a valid ORCID",
    input: `${VALID_ORCID}9`,
    expected: null,
  },
  {
    name: "rejects a non-ORCID host that ends in orcid.org-like text",
    input: `https://notorcid.org/${VALID_ORCID}`,
    expected: null,
  },
  {
    name: "rejects an empty string",
    input: "",
    expected: null,
  },
  {
    name: "rejects whitespace only",
    input: "   ",
    expected: null,
  },
  {
    name: "rejects arbitrary text",
    input: "not-an-orcid",
    expected: null,
  },
];

export interface OrcidDerivationVector {
  readonly name: string;
  readonly identifiers: ReadonlyArray<{ scheme: string; value: string }>;
  readonly expected: string | null;
}

/**
 * `deriveCanonicalOrcid` cases — the rule that turns raw identifier provenance
 * for ONE authorship mention into at most one canonical ORCID.
 */
export const ORCID_DERIVATION_VECTORS: readonly OrcidDerivationVector[] = [
  {
    name: "no identifiers at all yields null",
    identifiers: [],
    expected: null,
  },
  {
    name: "a single valid ORCID-labelled identifier is adopted",
    identifiers: [{ scheme: "ORCID", value: VALID_ORCID }],
    expected: VALID_ORCID,
  },
  {
    name: "the ORCID scheme is matched case-insensitively",
    identifiers: [{ scheme: "orcid", value: VALID_ORCID }],
    expected: VALID_ORCID,
  },
  {
    name: "a surrounding-whitespace scheme still matches",
    identifiers: [{ scheme: "  ORCID  ", value: VALID_ORCID_X }],
    expected: VALID_ORCID_X,
  },
  {
    name: "bare and URI spellings of the SAME iD collapse to one canonical value",
    identifiers: [
      { scheme: "ORCID", value: VALID_ORCID },
      { scheme: "ORCID", value: `https://orcid.org/${VALID_ORCID}` },
    ],
    expected: VALID_ORCID,
  },
  {
    name: "two distinct valid iDs for one mention fail closed",
    identifiers: [
      { scheme: "ORCID", value: VALID_ORCID },
      { scheme: "ORCID", value: OTHER_VALID_ORCID },
    ],
    expected: null,
  },
  {
    name: "a checksum-invalid candidate poisons the derived field",
    identifiers: [{ scheme: "ORCID", value: INVALID_CHECKSUM_ORCID }],
    expected: null,
  },
  {
    name: "a malformed candidate alongside a valid one still fails closed",
    identifiers: [
      { scheme: "ORCID", value: VALID_ORCID },
      { scheme: "ORCID", value: "garbage" },
    ],
    expected: null,
  },
  {
    name: "a non-ORCID scheme never populates the ORCID field",
    identifiers: [{ scheme: "ISNI", value: "0000000121032683" }],
    expected: null,
  },
  {
    name: "a non-ORCID scheme holding an ORCID-shaped value is still ignored",
    identifiers: [{ scheme: "ResearcherID", value: VALID_ORCID }],
    expected: null,
  },
  {
    name: "a non-ORCID identifier does not disturb a valid ORCID one",
    identifiers: [
      { scheme: "GRID", value: "grid.5335.0" },
      { scheme: "ORCID", value: VALID_ORCID },
    ],
    expected: VALID_ORCID,
  },
  {
    name: "a scheme that merely contains the word ORCID is not ORCID",
    identifiers: [{ scheme: "ORCID-like", value: VALID_ORCID }],
    expected: null,
  },
];
