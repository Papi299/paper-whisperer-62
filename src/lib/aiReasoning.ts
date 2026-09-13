/**
 * Reasoning-level presentation — AI-MULTI-PROVIDER-001C (C41).
 *
 * PRESENTATION ONLY. This module turns a canonical reasoning value into a label
 * and a sentence. It decides nothing:
 *
 *   * which levels a model offers is `ai_model_catalog.reasoning_levels`, read
 *     from the server on every Settings visit;
 *   * whether a user may choose one is `ai_model_catalog.reasoning_selectable`
 *     plus the entitlement projection, re-checked by the setter RPC;
 *   * what PaperLume sends for Automatic is the catalog's two `auto_*` columns,
 *     resolved server-side at request time.
 *
 * The list below is therefore NOT an allowlist, and must never be used as one.
 * It exists because a database value needs an English name before a human can
 * read it, and because "Extra High" is not something a server should have to
 * send over the wire.
 *
 * ## The vocabulary is deliberately product words, not provider words
 *
 * Nothing here says `thinking_level`, `output_config.effort`, `reasoning.effort`
 * or `adaptive thinking`. Those are three providers' spellings of one product
 * idea, they change on their own schedules, and a user choosing how much a
 * model should think does not need to learn any of them. The mapping from these
 * words to those parameters lives in the Edge adapters and stays there.
 *
 * ## Unknown values fail closed
 *
 * `reasoningLevelLabel` returns `null` for anything it does not recognise rather
 * than inventing a label. A value this build has never heard of is a value it
 * cannot describe honestly, and offering it as a choice would let a user save a
 * setting neither they nor this UI understands. The caller's job is to omit it,
 * not to render it.
 */

/**
 * PaperLume's canonical reasoning vocabulary, mirroring the Edge contract in
 * `supabase/functions/_shared/aiProvider.ts` and the database CHECK constraints.
 *
 * `automatic` is deliberately absent. Automatic is the ABSENCE of a manual
 * choice — a `null` preference — and the dropdown represents it with its own
 * sentinel value below rather than with a reasoning level.
 */
export const AI_REASONING_LEVELS = [
  "minimal",
  "off",
  "none",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

export type AiReasoningLevel = (typeof AI_REASONING_LEVELS)[number];

export function isAiReasoningLevel(value: unknown): value is AiReasoningLevel {
  return typeof value === "string" && (AI_REASONING_LEVELS as readonly string[]).includes(value);
}

/**
 * The Select value standing for "no manual choice — PaperLume decides".
 *
 * Deliberately not a reasoning level and deliberately not a value the server
 * accepts: choosing it calls `clear_current_user_ai_reasoning()`, and it is
 * never passed to the setter. Same shape, and the same reasoning, as
 * `PAPERLUME_DEFAULT_VALUE` for the model control.
 */
export const AUTOMATIC_REASONING_VALUE = "__automatic__";

/** The one label the Automatic option carries, everywhere it appears. */
export const AUTOMATIC_REASONING_LABEL = "Automatic (Recommended)";

const REASONING_LABELS: Readonly<Record<AiReasoningLevel, string>> = Object.freeze({
  minimal: "Minimal",
  off: "Off",
  none: "None",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra High",
  max: "Max",
});

/**
 * What choosing this level actually does, in one or two plain sentences.
 *
 * Every one of them says the choice applies to BOTH tasks, because that is the
 * single most surprising thing about this control: there is one setting, not
 * one per feature, and a user who assumed otherwise would be wrong about half
 * of what they just changed.
 *
 * No dollar figures anywhere. Cost direction is stated qualitatively because
 * PaperLume does not bill per request and a number here would be a promise
 * about someone else's pricing. Actual usage telemetry is a separate piece of
 * work.
 */
const REASONING_DESCRIPTIONS: Readonly<Record<AiReasoningLevel, string>> = Object.freeze({
  minimal:
    "Minimal applies to both Analyze and organization suggestions. It prioritizes speed and " +
    "lower token use. The model may still reason briefly on complex requests.",
  off: "Thinking is disabled for both Analyze and organization suggestions.",
  none: "Reasoning is disabled for both Analyze and organization suggestions.",
  low:
    "Low applies to both Analyze and organization suggestions. It is faster and typically less " +
    "expensive, with less reasoning depth.",
  medium:
    "Medium applies to both Analyze and organization suggestions. It provides a balanced " +
    "trade-off between quality, speed, and cost.",
  high:
    "High applies to both Analyze and organization suggestions. It uses more reasoning and may " +
    "be slower and more expensive.",
  xhigh:
    "Extra High applies to both tasks. It uses substantially more reasoning and may increase " +
    "latency and cost.",
  // "within PaperLume's output limits" is load-bearing, not hedging: Max is the
  // highest effort the provider offers, but every request still runs under
  // PaperLume's own per-operation output ceiling. Saying "maximum" alone would
  // promise something unbounded that this product does not offer.
  max:
    "Max applies maximum reasoning effort within PaperLume's output limits. It has the highest " +
    "expected latency and cost.",
});

/** The display label for a canonical level, or `null` if this build cannot name it. */
export function reasoningLevelLabel(level: string): string | null {
  return isAiReasoningLevel(level) ? REASONING_LABELS[level] : null;
}

/** The plain-language explanation for a canonical level, or `null` if unknown. */
export function reasoningLevelDescription(level: string): string | null {
  return isAiReasoningLevel(level) ? REASONING_DESCRIPTIONS[level] : null;
}

/**
 * The exact Automatic policy for a model, as one readable line.
 *
 * Built from the model's OWN catalog metadata, never from its id: a component
 * that branched on `google/gemini-3.5-flash` to decide what Automatic means
 * would be a second copy of the policy, in the browser, able to disagree with
 * the server that actually sends it. The values come down with the catalog row,
 * so a migration that changes PaperLume's policy changes this line with no
 * frontend deploy.
 *
 * Returns `null` when either level is missing or unnameable — a model with no
 * stated Automatic policy gets the generic explanation instead of an invented
 * specific one.
 */
export function formatAutomaticReasoningSummary(
  analyzeLevel: string | null,
  suggestLevel: string | null,
): string | null {
  if (analyzeLevel === null || suggestLevel === null) return null;
  const analyze = reasoningLevelLabel(analyzeLevel);
  const suggest = reasoningLevelLabel(suggestLevel);
  if (analyze === null || suggest === null) return null;
  return `Analyze: ${analyze} · Organization suggestions: ${suggest}`;
}
