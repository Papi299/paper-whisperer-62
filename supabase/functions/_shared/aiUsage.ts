// Provider-neutral AI usage facts — AI-MULTI-PROVIDER-001D.
//
// The canonical vocabulary a provider adapter uses to report what the provider
// itself said about the work it did for one request. It sits beside the
// generation contract in `aiProvider.ts` and answers one question per request:
// **how many tokens of each billable kind did the provider report, and which of
// those numbers do we actually know?**
//
// ## Unknown is not zero
//
// The whole design turns on keeping four states apart that a plain
// `number | null` would collapse:
//
//   * REPORTED 0     — the provider said "none". A real, priceable fact.
//   * UNREPORTED     — this protocol has the dimension, but the provider did not
//                      give us a number for it on this request.
//   * NOT APPLICABLE — this protocol has no such dimension at all (Google has no
//                      cache-write tokens; Anthropic reports no grand total).
//   * UNAVAILABLE    — no trustworthy usage for the request at all: the provider
//                      never answered, answered without a usage block, or sent
//                      one that failed validation.
//
// A request that timed out is UNAVAILABLE, never zero: our clock stopping is
// not evidence that the provider stopped generating.
//
// ## The dimensions, and how they nest
//
//     inputTokens            every input token the provider processed, in any
//     ├─ cachedInputTokens   rate class — cache reads and cache writes included
//     └─ cacheWriteInputTokens
//                            the two subsets are DISJOINT; what remains is the
//                            ordinary (uncached) input
//     outputTokens           every output token the provider billed, reasoning
//     └─ reasoningOutputTokens   included; reasoning is a SUBSET, never added
//     providerTotalTokens    the provider's own total, stored exactly as sent and
//                            never computed — two first-party Google sources
//                            disagree about what its total includes
//
// Summing dimensions because they all say "tokens" is the double-count this
// module exists to prevent. The subset rules are enforced by
// `finalizeReportedUsage`, so an adapter cannot hand back a usage report in
// which a subset exceeds its parent.
//
// Which provider field feeds which dimension is each ADAPTER's knowledge, not
// this module's: nothing here names Google, Anthropic or OpenAI.
//
// Pure module: no Deno APIs, no remote imports, no I/O.

/**
 * The largest per-request token count accepted as a report.
 *
 * Far above any single request PaperLume can make (every current model's
 * context is about 1M tokens), and far below the database column's integer
 * range. A number past it is a malformed report, not a very large request.
 */
export const AI_USAGE_MAX_TOKENS = 100_000_000;

/** One usage dimension for one request. See the header for the three states. */
export type AiUsageCount =
  | { readonly state: "reported"; readonly tokens: number }
  | { readonly state: "unreported" }
  | { readonly state: "not_applicable" };

export const AI_USAGE_UNREPORTED: AiUsageCount = Object.freeze({ state: "unreported" });
export const AI_USAGE_NOT_APPLICABLE: AiUsageCount = Object.freeze({ state: "not_applicable" });

export function reportedTokens(tokens: number): AiUsageCount {
  return Object.freeze({ state: "reported", tokens });
}

/** The canonical dimensions. Nesting and disjointness rules are in the header. */
export interface AiUsageDimensions {
  readonly inputTokens: AiUsageCount;
  readonly cachedInputTokens: AiUsageCount;
  readonly cacheWriteInputTokens: AiUsageCount;
  readonly outputTokens: AiUsageCount;
  readonly reasoningOutputTokens: AiUsageCount;
  readonly providerTotalTokens: AiUsageCount;
}

/**
 * What the provider reported about one request.
 *
 * `unmodeledUsage` is true when the provider reported billable work in a
 * dimension this vocabulary does not price — a longer cache-retention class, a
 * server-side tool, a tool-use prompt. PaperLume sends none of those, so it
 * should stay false; when it is not, a cost estimate built from the modeled
 * dimensions is a lower bound rather than the whole cost, and the flag is what
 * says so.
 */
export type AiProviderUsage =
  | {
      readonly kind: "reported";
      readonly dimensions: AiUsageDimensions;
      readonly unmodeledUsage: boolean;
    }
  | { readonly kind: "unavailable"; readonly reason: "not_returned" | "invalid" };

/** No usage for this request: no response, an unreadable one, or no usage block. */
export const AI_USAGE_NOT_RETURNED: AiProviderUsage = Object.freeze({
  kind: "unavailable",
  reason: "not_returned",
});

/** A usage block was present but failed validation, so none of it is trusted. */
export const AI_USAGE_INVALID: AiProviderUsage = Object.freeze({
  kind: "unavailable",
  reason: "invalid",
});

/** The result of reading one raw provider count. */
export type AiUsageCountRead =
  | { readonly kind: "absent" }
  | { readonly kind: "value"; readonly tokens: number }
  | { readonly kind: "invalid" };

/**
 * Read one raw count from a provider payload.
 *
 * `undefined` and `null` are ABSENT — whether absence then means zero or
 * unknown is a protocol fact the adapter decides, not this function. Anything
 * that is not a non-negative safe integer within `AI_USAGE_MAX_TOKENS` is
 * INVALID: a string, a fraction, a negative number, `NaN`, `Infinity`, a
 * boolean. An adapter that meets an invalid count distrusts the whole usage
 * block rather than dropping one field, because a provider that sent one
 * impossible number has not earned trust in the others.
 */
export function readProviderTokenCount(value: unknown): AiUsageCountRead {
  if (value === undefined || value === null) return { kind: "absent" };
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value > AI_USAGE_MAX_TOKENS
  ) {
    return { kind: "invalid" };
  }
  return { kind: "value", tokens: value };
}

/**
 * Read one raw count on a protocol where absence carries no meaning of its own:
 * absent is UNREPORTED, never zero. Returns `null` for an invalid count, which
 * the caller must treat as the whole usage block being invalid.
 *
 * Google does NOT use this: its protocol gives absence a meaning (see the
 * Google adapter), so it reads with `readProviderTokenCount` instead.
 */
export function readCountOrUnreported(value: unknown): AiUsageCount | null {
  const read = readProviderTokenCount(value);
  if (read.kind === "invalid") return null;
  return read.kind === "absent" ? AI_USAGE_UNREPORTED : reportedTokens(read.tokens);
}

function tokensOf(count: AiUsageCount): number | null {
  return count.state === "reported" ? count.tokens : null;
}

/**
 * Seal an adapter's dimensions into a reported usage — or refuse them.
 *
 * Every adapter goes through here, so the nesting rules in the header are
 * enforced once rather than trusted three times. A report in which a subset
 * exceeds its parent is impossible, and an impossible report is `invalid`:
 * storing it would put a lie in the telemetry, and "fixing" it would be
 * PaperLume inventing a number the provider did not send.
 *
 * A rule is checked only where both sides are reported. An unreported parent
 * proves nothing about its subset, and pretending otherwise would reject real
 * reports for missing a number the provider never promised.
 */
export function finalizeReportedUsage(
  dimensions: AiUsageDimensions,
  unmodeledUsage: boolean,
): AiProviderUsage {
  for (const count of Object.values(dimensions) as AiUsageCount[]) {
    if (count.state !== "reported") continue;
    if (!Number.isSafeInteger(count.tokens) || count.tokens < 0 || count.tokens > AI_USAGE_MAX_TOKENS) {
      return AI_USAGE_INVALID;
    }
  }

  const input = tokensOf(dimensions.inputTokens);
  const cached = tokensOf(dimensions.cachedInputTokens);
  const cacheWrite = tokensOf(dimensions.cacheWriteInputTokens);
  if (input !== null) {
    if (cached !== null && cached > input) return AI_USAGE_INVALID;
    if (cacheWrite !== null && cacheWrite > input) return AI_USAGE_INVALID;
    if (cached !== null && cacheWrite !== null && cached + cacheWrite > input) return AI_USAGE_INVALID;
  }

  const output = tokensOf(dimensions.outputTokens);
  const reasoning = tokensOf(dimensions.reasoningOutputTokens);
  if (output !== null && reasoning !== null && reasoning > output) return AI_USAGE_INVALID;

  return Object.freeze({
    kind: "reported",
    dimensions: Object.freeze({ ...dimensions }),
    unmodeledUsage,
  });
}

/**
 * The bounded, row-level summary persisted beside the dimensions.
 *
 *   * `reported` — every dimension this protocol has was reported.
 *   * `partial`  — at least one dimension this protocol has was not.
 *   * `absent`   — no usage at all (`not_returned`).
 *   * `rejected` — usage arrived and failed validation (`invalid`).
 *
 * This is what lets a stored NULL be read correctly: under `reported`, a NULL
 * column can only be a dimension the provider does not have.
 */
export type AiUsageStatus = "reported" | "partial" | "absent" | "rejected";

export function aiUsageStatus(usage: AiProviderUsage): AiUsageStatus {
  if (usage.kind === "unavailable") return usage.reason === "invalid" ? "rejected" : "absent";
  const counts = Object.values(usage.dimensions) as AiUsageCount[];
  return counts.some((count) => count.state === "unreported") ? "partial" : "reported";
}

/** A reported dimension's tokens, or `null` — for persistence only. */
export function aiUsageTokensOrNull(count: AiUsageCount): number | null {
  return tokensOf(count);
}
