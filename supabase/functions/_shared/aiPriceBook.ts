// PaperLume's AI list-price book — AI-MULTI-PROVIDER-001D.
//
// Immutable, effective-dated records of what a provider PUBLISHES as the
// price of one model's tokens. Consumed by `aiCostEstimate.ts`, and by nothing
// that decides anything: this is cost data, not an allowlist. A model with no
// record here is still routed exactly as `ai_model_catalog` says — its cost
// estimate is simply `unpriced`, and says so.
//
// ## What a record is, and is not
//
// A record is the provider's STANDARD, paid-tier list price, per million
// tokens, in USD, over a stated validity window. It is NOT what PaperLume is
// invoiced. PaperLume has no billing evidence at all: the Google project runs
// on the Gemini Free Tier (C29), and a list-price estimate for a request that
// cost nothing is still a useful number — it is what the request WOULD cost at
// published rates — but it must never be read as a charge. The persisted column
// is named for that reason (`list_price_estimate_usd`).
//
// ## Why history cannot drift
//
// Every persisted estimate stores the id of the record it used AND the rates it
// applied. Editing, superseding or deleting a record here later therefore
// changes no stored row: the database re-derives nothing from this module, and
// a row's own CHECK proves its amount from its own tokens and rates. A price
// change is a NEW record with a later `validFrom` — never an edit of an old one.
//
// ## Rules every record obeys (pinned by `aiPriceBook.test.ts`)
//
//   * `id` is `<provider>/<providerModel>@<YYYY-MM-DD>`, unique, never reused.
//   * `validFrom` is inclusive and `validUntil` exclusive, both UTC instants;
//     two records for one model never overlap, so a lookup is never a choice.
//   * rates are decimal STRINGS with at most 9 fractional digits, never floats,
//     so the estimate is exact integer arithmetic end to end.
//   * `outputUsdPerMTok` covers reasoning/thinking tokens — every current
//     provider documents reasoning as billed as output — so there is no
//     separate reasoning rate to double-count.
//   * a `null` cache rate means "this record prices no such tokens": a request
//     that REPORTS such tokens is `unpriced`, never priced at some other rate.
//   * only models whose price was verified on a first-party pricing page are
//     here, with the page and the date of verification.
//
// ## The seeded set, and why it is this small
//
// The four Google models Production can route to today, and nothing else. The
// Anthropic and OpenAI adapters are registered but unreachable (no catalog row,
// no credential, no deployed runtime), so pricing them now would be seeding data
// for a phase that has not been authorized. Their records belong to that phase,
// re-verified on the day. Until then their usage is recorded and their estimate
// is `unpriced`.
//
// ## The 2027-01-01 Gemini price change
//
// Google's page (last updated 2026-09-11 UTC, read 2026-09-13) prices Gemini
// 3.6/3.7/3.8 Flash at one rate "through December 31, 2026" and another
// "starting January 1, 2027" — and names no timezone. Rather than guess one,
// the first record ends at the earliest instant it is January 1 anywhere
// (2026-12-31T10:00Z, UTC+14) and the second starts at the latest instant it is
// still December 31 anywhere (2027-01-01T12:00Z, UTC−12). A request inside that
// window is honestly `unpriced`. Nothing is interpolated.
//
// Pure module: no Deno APIs, no remote imports, no I/O.

/** The basis every record here is quoted on. Stated once so no record differs. */
export const AI_LIST_PRICE_BASIS = "provider_standard_paid_tier_list_price" as const;

export interface AiListPriceRecord {
  /** `<provider>/<providerModel>@<YYYY-MM-DD>`. Persisted on every estimate. */
  readonly id: string;
  readonly provider: string;
  readonly providerModel: string;
  /** Inclusive, ISO-8601 UTC instant. */
  readonly validFrom: string;
  /** Exclusive, ISO-8601 UTC instant; `null` until a successor is published. */
  readonly validUntil: string | null;
  /** USD per 1,000,000 ordinary (uncached) input tokens. */
  readonly inputUsdPerMTok: string;
  /** USD per 1,000,000 input tokens served from a prompt cache; `null` = unpriced. */
  readonly cachedInputUsdPerMTok: string | null;
  /** USD per 1,000,000 input tokens written to a prompt cache; `null` = unpriced. */
  readonly cacheWriteInputUsdPerMTok: string | null;
  /** USD per 1,000,000 output tokens, reasoning included. */
  readonly outputUsdPerMTok: string;
  /**
   * The largest total input this record prices, or `null` when the provider
   * publishes no prompt-size tier for the model. A request above it is
   * `unpriced` rather than priced at a tier the record does not describe.
   */
  readonly maxInputTokens: number | null;
  /** The first-party page the rates were read from. */
  readonly sourceUrl: string;
  /** The date (UTC) the rates were read from `sourceUrl`. */
  readonly verifiedOn: string;
}

const GOOGLE_PRICING_URL = "https://ai.google.dev/gemini-api/docs/pricing";
const VERIFIED_2026_09_13 = "2026-09-13";

/**
 * Nothing before the day the rates were verified: an earlier date would be a
 * claim about prices nobody here observed, and no event can predate the code
 * that records it.
 */
const FROM_VERIFICATION = "2026-09-13T00:00:00Z";
/** Earliest instant it is 2027-01-01 anywhere (UTC+14). See the header. */
const GEMINI_2026_RATE_ENDS = "2026-12-31T10:00:00Z";
/** Latest instant it is still 2026-12-31 anywhere (UTC−12). See the header. */
const GEMINI_2027_RATE_STARTS = "2027-01-01T12:00:00Z";

function gemini(
  providerModel: string,
  idDate: string,
  validFrom: string,
  validUntil: string | null,
  rates: { input: string; cachedInput: string; output: string },
): AiListPriceRecord {
  return Object.freeze({
    id: `google/${providerModel}@${idDate}`,
    provider: "google",
    providerModel,
    validFrom,
    validUntil,
    inputUsdPerMTok: rates.input,
    // Google's "Context caching price" — what a reported
    // `cachedContentTokenCount` is priced at. The per-hour STORAGE price only
    // applies to explicit caches, which PaperLume never creates.
    cachedInputUsdPerMTok: rates.cachedInput,
    // Google's usage has no cache-WRITE dimension at all (it is
    // `not_applicable`, never reported), so there is no rate to hold.
    cacheWriteInputUsdPerMTok: null,
    // The page's row is "Output price (including thinking tokens)".
    outputUsdPerMTok: rates.output,
    // No prompt-size tier is published for these models.
    maxInputTokens: null,
    sourceUrl: GOOGLE_PRICING_URL,
    verifiedOn: VERIFIED_2026_09_13,
  });
}

const GEMINI_FLASH_2026 = { input: "0.75", cachedInput: "0.075", output: "3.75" };
const GEMINI_FLASH_2027 = { input: "1.50", cachedInput: "0.15", output: "7.50" };

/** Every list-price record PaperLume knows. Append only. */
export const AI_LIST_PRICE_RECORDS: readonly AiListPriceRecord[] = Object.freeze([
  gemini("gemini-3.5-flash", VERIFIED_2026_09_13, FROM_VERIFICATION, null, {
    input: "1.50",
    cachedInput: "0.15",
    output: "9.00",
  }),
  gemini("gemini-3.6-flash", VERIFIED_2026_09_13, FROM_VERIFICATION, GEMINI_2026_RATE_ENDS, GEMINI_FLASH_2026),
  gemini("gemini-3.6-flash", "2027-01-01", GEMINI_2027_RATE_STARTS, null, GEMINI_FLASH_2027),
  gemini("gemini-3.7-flash", VERIFIED_2026_09_13, FROM_VERIFICATION, GEMINI_2026_RATE_ENDS, GEMINI_FLASH_2026),
  gemini("gemini-3.7-flash", "2027-01-01", GEMINI_2027_RATE_STARTS, null, GEMINI_FLASH_2027),
  gemini("gemini-3.8-flash", VERIFIED_2026_09_13, FROM_VERIFICATION, GEMINI_2026_RATE_ENDS, GEMINI_FLASH_2026),
  gemini("gemini-3.8-flash", "2027-01-01", GEMINI_2027_RATE_STARTS, null, GEMINI_FLASH_2027),
]);

/**
 * The one record in effect for this provider model at this instant, or `null`.
 *
 * Exact string match on provider and model — no alias resolution, no prefix
 * match, no "closest model": `gemini-flash-latest` is a floating alias whose
 * target PaperLume cannot see, so it is correctly unpriced. More than one
 * match is a broken book and also returns `null`; the test suite proves the
 * shipped book never overlaps, so that branch exists only so a future bad edit
 * degrades to `unpriced` instead of to an arbitrary choice.
 */
export function findAiListPriceRecord(
  provider: string,
  providerModel: string,
  at: Date,
  records: readonly AiListPriceRecord[] = AI_LIST_PRICE_RECORDS,
): AiListPriceRecord | null {
  const t = at.getTime();
  if (!Number.isFinite(t)) return null;
  const matches = records.filter(
    (record) =>
      record.provider === provider &&
      record.providerModel === providerModel &&
      Date.parse(record.validFrom) <= t &&
      (record.validUntil === null || t < Date.parse(record.validUntil)),
  );
  return matches.length === 1 ? matches[0] : null;
}
