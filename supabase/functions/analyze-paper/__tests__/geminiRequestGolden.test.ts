// @vitest-environment node
//
// Node, not jsdom: this drives the real Gemini adapter, which uses the platform
// web APIs Deno provides (see the sibling Edge suites).
//
// AI-MULTI-PROVIDER-001A — the golden analyze-paper request.
//
// The acceptance criterion for this task is that the refactor changes nothing
// on the wire. So this suite drives the REAL composition — the operation's own
// request builder, the real Google adapter, the real shared transport — with an
// injected `fetch`, captures exactly what would have been POSTed, and compares
// it against values captured from the code as it stood BEFORE the refactor
// (commit 4998cf03, `analyze-paper/index.ts`, where the URL, the envelope and
// the header were assembled inline).
//
// The SHA-256 pins are the byte-for-byte half: they were computed by evaluating
// the pre-refactor `geminiBody` literal for the same inputs. The readable
// assertions beside them are the "what changed?" half, so a future prompt edit
// fails with a legible diff rather than only a hash mismatch.
//
// A change here is not a test to update lightly: if one of these fails, the
// request PaperLume sends to Google has moved.
import { describe, it, expect, vi } from "vitest";
import { createHash } from "node:crypto";
import { GOOGLE_AI_PROVIDER_ADAPTER } from "../../_shared/googleAiProvider.ts";
import { resolveSystemDefaultAiModel } from "../../_shared/aiProviderRegistry.ts";
import type { AiProviderCallDeps, AiCallPolicy } from "../../_shared/aiProvider.ts";
import type { GoogleReasoningLevel } from "../../_shared/googleAiProvider.ts";
import { AI_OPERATION_MAX_OUTPUT_TOKENS } from "../../_shared/aiReasoningPolicy.ts";
import {
  ANALYZE_SYSTEM_INSTRUCTION,
  buildAnalyzeGenerationRequest,
  buildAnalyzeUserContent,
} from "../prompt.ts";

// The deterministic inputs the golden values were captured for.
const TITLE = "Protein timing and hypertrophy";
const ABSTRACT = "A randomized trial of protein timing in resistance-trained adults.";
const API_KEY = "SENTINEL-GEMINI-API-KEY";
const MODEL = { provider: "google", providerModel: "gemini-3.5-flash" } as const;

// ── Golden values, captured from the pre-001A implementation ──────────────
//
// AI-MULTI-PROVIDER-001C adds ONE field to this request —
// `generationConfig.thinkingConfig.thinkingLevel` — and the original pins stay
// exactly where they were rather than being rewritten to match the new bytes.
// They now describe the PROVIDER-DEFAULT path: the fail-open fallback for
// unusable policy metadata, which must still produce the request PaperLume has
// always sent. Keeping them makes that claim testable instead of assumed, and a
// second set of pins below covers the ordinary path.
const GOLDEN_URL =
  "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:generateContent";
const GOLDEN_BODY_SHA256 = "3285186f0f12759b0f1b3c19e2d2866c0beafbfd12482cdc44da5670a04d1d31";
const GOLDEN_BODY_BYTES = 1973;

// ── The 001C request: the same bytes plus PaperLume's explicit thinking level ──
//
// `minimal` is Gemini 3.5/3.6 Flash's approved Automatic level for Analyze
// (C41). These pins are NOT captured from anything historical — they are the
// new contract, and a change to either means the request PaperLume will send
// once the 001C Edge runtime is deployed has moved.
const GOLDEN_ANALYZE_BODY_SHA256 =
  "e26b9bca572e8e2fba3b177cbb35b9c0d822f58e62bae4aab5abf5b3bf132ea6";
const GOLDEN_ANALYZE_BODY_BYTES = 2018;

/** The ordinary 001C Analyze policy for a Gemini 3.5/3.6 Flash request. */
const ANALYZE_POLICY: AiCallPolicy<GoogleReasoningLevel> = {
  reasoning: { kind: "level", level: "minimal" },
  maxOutputTokens: AI_OPERATION_MAX_OUTPUT_TOKENS.analyze,
};

/** The fail-open policy for unusable reasoning metadata. */
const PROVIDER_DEFAULT_POLICY: AiCallPolicy<GoogleReasoningLevel> = {
  reasoning: { kind: "provider_default" },
  maxOutputTokens: AI_OPERATION_MAX_OUTPUT_TOKENS.analyze,
};
const GOLDEN_SYSTEM_INSTRUCTION_SHA256 =
  "636b4ff6327a9a3f17dd6666bded488b561286cd65e5cd27a47a5295b280a6f7";
const GOLDEN_USER_CONTENT =
  "Title: Protein timing and hypertrophy\n\nAbstract: A randomized trial of protein timing in resistance-trained adults.";

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

/** Capture the request the real adapter would send, without any network. */
async function captureRequest(
  title: unknown,
  abstract: string,
  policy: AiCallPolicy<GoogleReasoningLevel> = ANALYZE_POLICY,
) {
  const fetchImpl = vi.fn(
    async () =>
      new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: "{}" }] } }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
  );
  const deps: AiProviderCallDeps = {
    apiKey: API_KEY,
    label: "analyze-paper",
    fetchImpl: fetchImpl as unknown as AiProviderCallDeps["fetchImpl"],
    sleep: async () => {},
    createTimeoutSignal: () => new AbortController().signal,
  };

  const result = await GOOGLE_AI_PROVIDER_ADAPTER.generate(
    MODEL,
    buildAnalyzeGenerationRequest(title, abstract),
    policy,
    deps,
  );

  expect(fetchImpl).toHaveBeenCalledTimes(1);
  const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
  return { url, init, result, body: String(init.body) };
}

describe("the exact request analyze-paper sends to Google", () => {
  it("POSTs to the same URL, with the same method and the same two headers", async () => {
    const { url, init } = await captureRequest(TITLE, ABSTRACT);
    expect(url).toBe(GOLDEN_URL);
    expect(init.method).toBe("POST");
    expect(init.headers).toEqual({
      "Content-Type": "application/json",
      "x-goog-api-key": API_KEY,
    });
  });

  it("serializes the 001C request body, byte for byte", async () => {
    const { body } = await captureRequest(TITLE, ABSTRACT);
    expect(sha256(body)).toBe(GOLDEN_ANALYZE_BODY_SHA256);
    expect(body.length).toBe(GOLDEN_ANALYZE_BODY_BYTES);
  });

  it("is the pre-001C body plus EXACTLY the thinking level, and nothing else", async () => {
    // The whole claim of 001C's Google change, measured rather than asserted in
    // prose: delete the one field this task added and the bytes are the bytes
    // PaperLume has always sent.
    const { body } = await captureRequest(TITLE, ABSTRACT);
    expect(body).toContain('"thinkingConfig":{"thinkingLevel":"minimal"}');
    const withoutThinking = body.replace(',"thinkingConfig":{"thinkingLevel":"minimal"}', "");
    expect(sha256(withoutThinking)).toBe(GOLDEN_BODY_SHA256);
    expect(withoutThinking.length).toBe(GOLDEN_BODY_BYTES);
  });

  it("serializes the PRE-001C body exactly on the provider-default fallback", async () => {
    // The fail-open path for unusable reasoning metadata must degrade to the
    // request that shipped, not to a third shape. This is the original golden
    // hash, unchanged since AI-MULTI-PROVIDER-001A.
    const { body, url } = await captureRequest(TITLE, ABSTRACT, PROVIDER_DEFAULT_POLICY);
    expect(url).toBe(GOLDEN_URL);
    expect(sha256(body)).toBe(GOLDEN_BODY_SHA256);
    expect(body.length).toBe(GOLDEN_BODY_BYTES);
    expect(body).not.toContain("thinking");
  });

  it("never sends PaperLume's output ceiling to Google", async () => {
    // The policy carries one — the type is provider-neutral and the paid
    // adapters need it — and the Google adapter deliberately does not act on
    // it. Gemini's output limit stays exactly where it has always been.
    const { body } = await captureRequest(TITLE, ABSTRACT);
    expect(JSON.parse(body).generationConfig).not.toHaveProperty("maxOutputTokens");
    expect(body).not.toContain(String(AI_OPERATION_MAX_OUTPUT_TOKENS.analyze));
  });

  it("carries the same system instruction, to the byte", async () => {
    const { body } = await captureRequest(TITLE, ABSTRACT);
    const parsed = JSON.parse(body);
    expect(parsed.system_instruction.parts[0].text).toBe(ANALYZE_SYSTEM_INSTRUCTION);
    expect(sha256(ANALYZE_SYSTEM_INSTRUCTION)).toBe(GOLDEN_SYSTEM_INSTRUCTION_SHA256);
    // A few load-bearing clauses, so an accidental edit reads as an edit.
    expect(ANALYZE_SYSTEM_INSTRUCTION).toContain("You are an expert academic data extractor.");
    expect(ANALYZE_SYSTEM_INSTRUCTION).toContain("NO GUESSING");
    expect(ANALYZE_SYSTEM_INSTRUCTION).toContain("TITLE OVERRIDE RULE");
    expect(ANALYZE_SYSTEM_INSTRUCTION).toContain("VOCABULARY MATCHING RULE");
  });

  it("carries the same user content: the title and the abstract, and nothing else", async () => {
    const { body } = await captureRequest(TITLE, ABSTRACT);
    const parsed = JSON.parse(body);
    expect(parsed.contents).toEqual([{ parts: [{ text: GOLDEN_USER_CONTENT }] }]);
    expect(buildAnalyzeUserContent(TITLE, ABSTRACT)).toBe(GOLDEN_USER_CONTENT);
  });

  it("keeps the same JSON response mode and no sampling override", async () => {
    const { body } = await captureRequest(TITLE, ABSTRACT);
    // `thinkingConfig` is the one field AI-MULTI-PROVIDER-001C added. Every
    // sampling knob is still absent, and `responseMimeType` still comes first.
    expect(JSON.parse(body).generationConfig).toEqual({
      responseMimeType: "application/json",
      thinkingConfig: { thinkingLevel: "minimal" },
    });
    expect(Object.keys(JSON.parse(body).generationConfig)).toEqual([
      "responseMimeType",
      "thinkingConfig",
    ]);
  });

  it("keeps the same whole envelope shape", async () => {
    const { body } = await captureRequest(TITLE, ABSTRACT);
    expect(Object.keys(JSON.parse(body))).toEqual([
      "system_instruction",
      "contents",
      "generationConfig",
    ]);
  });

  it("keeps the historical missing-title coercion", async () => {
    // `title` is never validated, so `undefined` still becomes "Unknown".
    const { body } = await captureRequest(undefined, ABSTRACT);
    expect(JSON.parse(body).contents[0].parts[0].text).toBe(
      `Title: Unknown\n\nAbstract: ${ABSTRACT}`,
    );
  });

  it("sends the caller's paper nowhere except that one user-content part", async () => {
    const { body, url } = await captureRequest(TITLE, ABSTRACT);
    const parsed = JSON.parse(body);
    expect(url).not.toContain(TITLE);
    expect(JSON.stringify(parsed.system_instruction)).not.toContain(TITLE);
    expect(JSON.stringify(parsed.system_instruction)).not.toContain(ABSTRACT);
    expect(JSON.stringify(parsed.generationConfig)).not.toContain(ABSTRACT);
  });

  it("routes the system default to the model the environment configures", async () => {
    // The model component is the only part of the URL that ever moves.
    const systemDefault = resolveSystemDefaultAiModel("gemini-3.6-flash");
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: "{}" }] } }] }), {
          status: 200,
        }),
    );
    // The system default is typed as ANY registered provider since
    // AI-MULTI-PROVIDER-001C; the Google adapter accepts Google models only, so
    // the narrowing is explicit and follows an assertion that it holds.
    expect(systemDefault.provider).toBe("google");
    await GOOGLE_AI_PROVIDER_ADAPTER.generate(
      { provider: "google", providerModel: systemDefault.providerModel },
      buildAnalyzeGenerationRequest(TITLE, ABSTRACT),
      ANALYZE_POLICY,
      {
        apiKey: API_KEY,
        label: "analyze-paper",
        fetchImpl: fetchImpl as unknown as AiProviderCallDeps["fetchImpl"],
        sleep: async () => {},
        createTimeoutSignal: () => new AbortController().signal,
      },
    );
    expect(fetchImpl.mock.calls[0][0]).toBe(GOLDEN_URL.replace("gemini-3.5-flash", "gemini-3.6-flash"));
    // Same bytes on the wire either way: selection changes the endpoint, never
    // the request.
    expect(sha256(String((fetchImpl.mock.calls[0][1] as RequestInit).body))).toBe(
      GOLDEN_ANALYZE_BODY_SHA256,
    );
  });

  it("returns the model's text to the caller's own parser, unmodified", async () => {
    const { result } = await captureRequest(TITLE, ABSTRACT);
    expect(result).toEqual({ ok: true, text: "{}", attempts: 1 });
  });
});
