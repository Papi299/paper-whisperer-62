// PaperLume's AI list-price cost estimate — AI-MULTI-PROVIDER-001D.
//
// A pure function from (what the provider reported, which provider model, when,
// how many attempts) to an estimate and a status that says how far to trust it.
// No network, no database, no clock of its own: everything arrives as input, so
// every rule below is exercised by Vitest exactly as it ships.
//
// ## What the number means — and does not
//
// The amount is the request's cost at the provider's published STANDARD
// paid-tier list price (`aiPriceBook.ts`), computed from the usage the provider
// reported. It is an ESTIMATE. It is not an invoice, not a charge and not
// "provider spend": PaperLume has no billing evidence, and the Google project
// is on the Gemini Free Tier (C29), where the same request may cost nothing.
// Free-tier status is a fact about an account; it is not a price of $0, and
// nothing here ever treats it as one.
//
// ## The statuses, in the order they are decided
//
//   1. `usage_unavailable` — the provider gave no trustworthy usage: no
//      response (network, timeout, HTTP error), an unreadable one, no usage
//      block, or one that failed validation. No amount — and specifically NOT
//      zero: a timeout means PaperLume stopped waiting, not that the provider
//      stopped working.
//   2. `usage_incomplete` — usage arrived, but a dimension with a price of its
//      own was not reported (input, output, cache reads, cache writes), so any
//      amount would be a guess about how the tokens split between rates.
//   3. `unpriced` — no verified price record covers this provider model at this
//      instant, the input is beyond the record's prompt-size tier, or tokens
//      were reported in a rate class the record does not price.
//   4. `estimated` — an exact amount for the reported usage, and nothing is
//      known to be missing from it.
//   5. `estimated_lower_bound` — the same exact arithmetic, but PaperLume KNOWS
//      the true list-price cost may be higher: more than one provider attempt
//      happened and only the last one's usage was reported, or the provider
//      reported billable work in a dimension this vocabulary does not price.
//
// A status is chosen before an amount exists, so a missing fact can never be
// quietly replaced by a number.
//
// ## No double counting
//
// Input is split into three DISJOINT classes — uncached, cache read, cache
// write — and each class is priced once:
//
//     uncached = inputTokens − cachedInputTokens − cacheWriteInputTokens
//     cost     = uncached × input + cached × cachedInput
//              + cacheWrite × cacheWriteInput + outputTokens × output
//
// `outputTokens` already includes reasoning on every provider, so reasoning is
// never added a second time, and the provider's own total is never used at all.
// The same formula is a CHECK constraint on the persisted row.
//
// ## Exact decimal arithmetic
//
// Rates are parsed from decimal strings into integers of 1e-9 USD per million
// tokens; `tokens × rate` is then an exact integer count of 1e-15 USD, formatted
// back to a 15-decimal string. No floating point touches money.
//
// Pure module: no Deno APIs, no remote imports, no I/O.

import {
  AI_LIST_PRICE_RECORDS,
  findAiListPriceRecord,
  type AiListPriceRecord,
} from "./aiPriceBook.ts";
import type { AiProviderUsage, AiUsageCount } from "./aiUsage.ts";

export type AiCostStatus =
  | "estimated"
  | "estimated_lower_bound"
  | "usage_unavailable"
  | "usage_incomplete"
  | "unpriced";

/** Why an estimate is a lower bound rather than the whole cost. */
export type AiLowerBoundReason = "multiple_attempts" | "unmodeled_usage";

/** The exact rates an estimate used — persisted beside it, so it never drifts. */
export interface AiAppliedListPrices {
  readonly recordId: string;
  readonly inputUsdPerMTok: string;
  readonly cachedInputUsdPerMTok: string | null;
  readonly cacheWriteInputUsdPerMTok: string | null;
  readonly outputUsdPerMTok: string;
}

export type AiCostEstimate =
  | {
      readonly status: "estimated" | "estimated_lower_bound";
      /** USD with exactly `AI_COST_AMOUNT_DECIMALS` fractional digits. */
      readonly amountUsd: string;
      readonly prices: AiAppliedListPrices;
      readonly lowerBoundReasons: readonly AiLowerBoundReason[];
    }
  | {
      readonly status: "usage_unavailable" | "usage_incomplete" | "unpriced";
      readonly amountUsd: null;
      readonly prices: null;
      readonly lowerBoundReasons: readonly AiLowerBoundReason[];
    };

/** Fractional digits in `amountUsd`: 9 rate digits plus the 6 of "per million". */
export const AI_COST_AMOUNT_DECIMALS = 15;

const RATE_DECIMALS = 9;
const RATE_PATTERN = /^(0|[1-9]\d{0,8})(?:\.(\d{1,9}))?$/;

/**
 * Parse a price-book rate ("0.075") into integer units of 1e-9 USD per million
 * tokens, or `null` if it is not a plain non-negative decimal with at most nine
 * fractional digits. A malformed record prices nothing rather than something.
 */
export function parseRateNanoUsdPerMTok(rate: string): bigint | null {
  const match = RATE_PATTERN.exec(rate);
  if (match === null) return null;
  const whole = BigInt(match[1]);
  const fraction = BigInt((match[2] ?? "").padEnd(RATE_DECIMALS, "0"));
  return whole * 10n ** BigInt(RATE_DECIMALS) + fraction;
}

/** Format a non-negative count of 1e-15 USD as a fixed 15-decimal string. */
export function formatFemtoUsd(femtoUsd: bigint): string {
  if (femtoUsd < 0n) throw new RangeError("a cost estimate cannot be negative");
  const digits = femtoUsd.toString().padStart(AI_COST_AMOUNT_DECIMALS + 1, "0");
  return `${digits.slice(0, -AI_COST_AMOUNT_DECIMALS)}.${digits.slice(-AI_COST_AMOUNT_DECIMALS)}`;
}

export interface AiCostEstimateInput {
  readonly provider: string;
  readonly providerModel: string;
  /** The instant the price is looked up for — the end of the provider call. */
  readonly at: Date;
  /** Real provider requests in this call sequence (`AiProviderResult.attempts`). */
  readonly attempts: number;
  readonly usage: AiProviderUsage;
  /** Injected by tests; production always uses the shipped book. */
  readonly priceRecords?: readonly AiListPriceRecord[];
}

function noEstimate(status: "usage_unavailable" | "usage_incomplete" | "unpriced"): AiCostEstimate {
  return Object.freeze({ status, amountUsd: null, prices: null, lowerBoundReasons: Object.freeze([]) });
}

/** A dimension that must be REPORTED to be priced (input, output). */
function required(count: AiUsageCount): number | null {
  return count.state === "reported" ? count.tokens : null;
}

/** A rate-class subset: reported, or zero when the protocol has no such class. */
function subset(count: AiUsageCount): number | null {
  if (count.state === "reported") return count.tokens;
  return count.state === "not_applicable" ? 0 : null;
}

/** Parse an optional record rate; `undefined` marks a malformed one. */
function optionalRate(rate: string | null): bigint | null | undefined {
  if (rate === null) return null;
  const parsed = parseRateNanoUsdPerMTok(rate);
  return parsed === null ? undefined : parsed;
}

/**
 * Estimate one provider call's list-price cost. Never throws: every input
 * resolves to a status, because a telemetry calculation must not be able to
 * fail the operation that paid for the generation.
 */
export function estimateAiListPriceCost(input: AiCostEstimateInput): AiCostEstimate {
  const { usage } = input;
  if (usage.kind !== "reported") return noEstimate("usage_unavailable");

  const dims = usage.dimensions;
  const inputTokens = required(dims.inputTokens);
  const outputTokens = required(dims.outputTokens);
  const cachedTokens = subset(dims.cachedInputTokens);
  const cacheWriteTokens = subset(dims.cacheWriteInputTokens);
  if (inputTokens === null || outputTokens === null || cachedTokens === null || cacheWriteTokens === null) {
    return noEstimate("usage_incomplete");
  }
  const uncachedTokens = inputTokens - cachedTokens - cacheWriteTokens;
  // `finalizeReportedUsage` already refuses subsets larger than their parent;
  // this is the same rule restated where the subtraction happens.
  if (uncachedTokens < 0) return noEstimate("usage_unavailable");

  const record = findAiListPriceRecord(
    input.provider,
    input.providerModel,
    input.at,
    input.priceRecords ?? AI_LIST_PRICE_RECORDS,
  );
  if (record === null) return noEstimate("unpriced");
  if (record.maxInputTokens !== null && inputTokens > record.maxInputTokens) return noEstimate("unpriced");

  const inputRate = parseRateNanoUsdPerMTok(record.inputUsdPerMTok);
  const outputRate = parseRateNanoUsdPerMTok(record.outputUsdPerMTok);
  const cachedRate = optionalRate(record.cachedInputUsdPerMTok);
  const cacheWriteRate = optionalRate(record.cacheWriteInputUsdPerMTok);
  if (inputRate === null || outputRate === null || cachedRate === undefined || cacheWriteRate === undefined) {
    return noEstimate("unpriced");
  }
  // Tokens in a rate class the record does not price are never priced at some
  // other class's rate: cache reads are cheaper than input and cache writes
  // dearer, so either substitution would misstate the cost.
  if (cachedTokens > 0 && cachedRate === null) return noEstimate("unpriced");
  if (cacheWriteTokens > 0 && cacheWriteRate === null) return noEstimate("unpriced");

  const femtoUsd =
    BigInt(uncachedTokens) * inputRate +
    BigInt(cachedTokens) * (cachedRate ?? 0n) +
    BigInt(cacheWriteTokens) * (cacheWriteRate ?? 0n) +
    BigInt(outputTokens) * outputRate;

  const lowerBoundReasons: AiLowerBoundReason[] = [];
  if (input.attempts > 1) lowerBoundReasons.push("multiple_attempts");
  if (usage.unmodeledUsage) lowerBoundReasons.push("unmodeled_usage");

  return Object.freeze({
    status: lowerBoundReasons.length > 0 ? "estimated_lower_bound" : "estimated",
    amountUsd: formatFemtoUsd(femtoUsd),
    prices: Object.freeze({
      recordId: record.id,
      inputUsdPerMTok: record.inputUsdPerMTok,
      cachedInputUsdPerMTok: record.cachedInputUsdPerMTok,
      cacheWriteInputUsdPerMTok: record.cacheWriteInputUsdPerMTok,
      outputUsdPerMTok: record.outputUsdPerMTok,
    }),
    lowerBoundReasons: Object.freeze(lowerBoundReasons),
  });
}
