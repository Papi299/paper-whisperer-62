// analyze-paper — the provider-neutral generation request.
//
// AI-MULTI-PROVIDER-001A (C39) moved this out of `index.ts`, verbatim. The
// wording is unchanged and must stay unchanged here: it is the contract the
// analysis parser and the product's output both depend on, and it is pinned
// byte-for-byte by the golden request test.
//
// Two reasons it is a module rather than an object literal inside the Deno
// shell. It is now the operation's half of the provider seam — the operation
// says WHAT to ask, and the Google adapter says how to phrase that to Gemini —
// and `index.ts` is a `Deno.serve` shell with remote imports that Vitest
// cannot load, so a prompt living there could only ever be asserted as source
// text. Here the exact request that reaches the provider is executable.
//
// Pure module: no Deno APIs, no remote imports, no provider knowledge. It names
// no model, no endpoint, no credential and no response envelope.

import type { AiGenerationRequest } from "../_shared/aiProvider.ts";

/** The analysis system instruction, unchanged since before 001A. */
export const ANALYZE_SYSTEM_INSTRUCTION = `You are an expert academic data extractor. Analyze the provided title and abstract.
CRITICAL RULES:
1. NO GUESSING. Only extract explicit information.
2. ENGLISH ONLY.
3. Return ONLY a valid JSON object with exactly these three keys:
   - tldr: A concise narrative summary of the objective, the main comparison (e.g., Intervention A vs. Intervention B), and the core conclusion (~30-45 words). NARRATIVE RULE: Do not just list numbers. You MUST capture the physiological or clinical meaning of the findings (e.g., 'sustained for 5 hours', 'transient effect', 'greater amplitude than control'). RESULTS RULE: Include key numerical effect sizes to support the narrative, but STRICTLY EXCLUDE all statistical noise (95% CIs, SDs, exact p-values).
   - studyType: The specific study design. TITLE OVERRIDE RULE: If the study design is explicitly stated in the paper's TITLE, you MUST use that exact design. Expand acronyms. Output 'Not specified' if unknown.
   - statisticalMethods: A comma-separated list of analytical tests AND methodological features. VOCABULARY MATCHING RULE: You MUST explicitly check for and include any of the following terms if they are mentioned or implied:
     * Blinding: 'double-blind', 'single-blind', 'triple-blind', 'blinded', 'blinding', 'masked', 'masking'
     * Crossover: 'crossover', 'cross-over', 'crossover study', 'crossover trial'
     * Placebo: 'placebo', 'placebo-controlled'
     * Additional: 'multicenter', 'open-label'
     * Assessment/Guidelines: 'grade', 'prisma', 'cochrane', 'robins-i', 'amstar', 'moose', 'quadas', 'consort', 'strobe', 'prospero'
     Also include standard tests (ANOVA, Odds Ratio, etc.). Output 'Not specified' if none are found.`;

/**
 * The single user-content part: exactly the two values that reach the provider.
 *
 * `title` is deliberately `unknown` — it arrives from the request body and is
 * not validated (only `abstract` is), so the historical `title || "Unknown"`
 * coercion is preserved exactly rather than tightened. Nothing else about the
 * paper, the user or the request is interpolated here.
 */
export function buildAnalyzeUserContent(title: unknown, abstract: string): string {
  return `Title: ${title || "Unknown"}\n\nAbstract: ${abstract}`;
}

/** The provider-neutral request `analyze-paper` hands to the resolved adapter. */
export function buildAnalyzeGenerationRequest(
  title: unknown,
  abstract: string,
): AiGenerationRequest {
  return {
    systemInstruction: ANALYZE_SYSTEM_INSTRUCTION,
    userContent: buildAnalyzeUserContent(title, abstract),
    responseFormat: "json",
  };
}
