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
// ## The seeded set
//
// The four Google models Production can route to today, plus the two paid models
// AI-MULTI-PROVIDER-001E stages in `ai_model_catalog`. The paid rates were
// re-verified from each provider's own pricing page on the day they were added
// (2026-09-17) rather than copied from the 001B/001C source comments, which were
// written to describe a protocol and never claimed to be a price.
//
// Pricing a model here does not make it reachable. These records exist so that
// the FIRST paid request is measured rather than guessed at: a request whose
// cost is `unpriced` is honest but useless for deciding whether a paid provider
// is affordable, and the Phase-7 canaries are exactly where that number is
// wanted.
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

// ─────────────────────────────────────────────────────────────────────────────
// The paid providers — AI-MULTI-PROVIDER-001E, verified 2026-09-17
// ─────────────────────────────────────────────────────────────────────────────

const ANTHROPIC_PRICING_URL = "https://platform.claude.com/docs/en/about-claude/pricing";
const OPENAI_TERRA_PRICING_URL = "https://developers.openai.com/api/docs/models/gpt-5.6-terra";
const VERIFIED_2026_09_17 = "2026-09-17";
/** See `FROM_VERIFICATION`: a record never predates the day it was read. */
const FROM_VERIFICATION_001E = "2026-09-17T00:00:00Z";

/**
 * OpenAI's published prompt-size threshold for `gpt-5.6-terra`.
 *
 * The model page prices a request "exceeding 272K input tokens" at 2x the input
 * rate AND 1.5x the output rate, applied to the WHOLE request — not to the
 * excess. That is a second tier this record's four rates cannot express, so the
 * record stops here and a larger request is `unpriced`.
 *
 * `maxInputTokens` is compared with `>`, which lines up exactly with
 * "exceeding": a request of precisely 272,000 input tokens is still priced by
 * this record, and 272,001 is not.
 *
 * PaperLume's own prompts are nowhere near it — Suggest is hard-bounded far
 * below and Analyze is a title plus an abstract — so this is a correctness
 * property of the book rather than a case anyone expects to hit.
 */
const OPENAI_TERRA_STANDARD_TIER_MAX_INPUT_TOKENS = 272_000;

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

  /**
   * Claude Sonnet 5 — Anthropic's published table, read 2026-09-17:
   * base input $2, 5m cache writes $2.50, 1h cache writes $4,
   * cache hits and refreshes $0.20, output $10, all per MTok.
   *
   * ## Why `cacheWriteInputUsdPerMTok` is null, and is not $2.50
   *
   * Anthropic publishes TWO cache-write rates — $2.50 for a 5-minute write and
   * $4.00 for a 1-hour write — and this schema holds one. Which of the two a
   * given request used is a fact the adapter can only sometimes recover:
   * `readAnthropicUsage` maps the FLAT `cache_creation_input_tokens` field into
   * `cacheWriteInputTokens`, and Anthropic documents that field as the SUM over
   * both buckets. The per-bucket `cache_creation` breakdown that would split
   * them is only CONDITIONALLY present — Anthropic documents it as appearing
   * when a 1-hour TTL is used, when TTLs are mixed, or when a server tool
   * caches — so its absence is not proof that every token was a 5-minute write.
   *
   * Putting $2.50 here would therefore price an unknown mixture at the cheaper
   * of two rates and label the result `estimated`. The lower-bound machinery
   * does not save it: `unmodeledUsage` is raised from the breakdown object, so
   * in exactly the case where the breakdown is missing the flag reads false and
   * the estimate would claim to be exact.
   *
   * `null` is the truthful encoding of "this record prices no such tokens", and
   * `estimateAiListPriceCost` turns any positive cache write into `unpriced`.
   * PaperLume sends no `cache_control` and Anthropic caching is opt-in, so the
   * expected value of that dimension is a reported 0 — which prices fine, since
   * the unpriced branch is guarded on `> 0`. A nonzero one would mean Anthropic
   * began caching work PaperLume never asked it to cache, and `unpriced` is the
   * right answer to that until somebody has looked at it.
   *
   * Cache READS are not ambiguous — one rate, whatever the write's TTL was — so
   * they are priced at $0.20.
   *
   * No prompt-size tier: Anthropic prices the full 1M context window at
   * standard rates for Claude 4.6 and later, so `maxInputTokens` is null.
   */
  Object.freeze({
    id: `anthropic/claude-sonnet-5@${VERIFIED_2026_09_17}`,
    provider: "anthropic",
    providerModel: "claude-sonnet-5",
    validFrom: FROM_VERIFICATION_001E,
    validUntil: null,
    inputUsdPerMTok: "2.00",
    cachedInputUsdPerMTok: "0.20",
    cacheWriteInputUsdPerMTok: null,
    outputUsdPerMTok: "10.00",
    maxInputTokens: null,
    sourceUrl: ANTHROPIC_PRICING_URL,
    verifiedOn: VERIFIED_2026_09_17,
  }),

  /**
   * GPT-5.6 Terra — OpenAI's model page, read 2026-09-17: input $2, cached
   * input $0.20, output $12 per MTok, with cache writes billed at 1.25x the
   * uncached input rate ($2.50).
   *
   * ## Why this one DOES carry a cache-write rate
   *
   * The mirror image of the Anthropic record above, and the difference is
   * evidence, not preference. OpenAI publishes exactly ONE cache-write rate —
   * there are no TTL classes to confuse — and the Responses API reports the
   * dimension in its own field, `input_tokens_details.cache_write_tokens`,
   * which `readOpenAiUsage` maps straight through. One rate, one unambiguous
   * count: $2.50 prices it truthfully.
   *
   * It is also a dimension that can genuinely arrive here unasked. GPT-5.6 and
   * later cache implicitly, so a cache write can happen on a request that
   * requested none — which is precisely why this rate is worth holding, and why
   * a response that OMITS `cache_write_tokens` leaves it unreported and the
   * estimate `usage_incomplete` rather than guessing it was zero.
   *
   * `maxInputTokens` stops this record at the documented 272K threshold; see
   * `OPENAI_TERRA_STANDARD_TIER_MAX_INPUT_TOKENS`. No second record is written
   * for the long-context tier: its 2x input and 1.5x output multipliers are two
   * different multipliers on one request, which the four-rate shape here can
   * express only by accident, and `unpriced` is the honest alternative.
   */
  Object.freeze({
    id: `openai/gpt-5.6-terra@${VERIFIED_2026_09_17}`,
    provider: "openai",
    providerModel: "gpt-5.6-terra",
    validFrom: FROM_VERIFICATION_001E,
    validUntil: null,
    inputUsdPerMTok: "2.00",
    cachedInputUsdPerMTok: "0.20",
    cacheWriteInputUsdPerMTok: "2.50",
    outputUsdPerMTok: "12.00",
    maxInputTokens: OPENAI_TERRA_STANDARD_TIER_MAX_INPUT_TOKENS,
    sourceUrl: OPENAI_TERRA_PRICING_URL,
    verifiedOn: VERIFIED_2026_09_17,
  }),
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
