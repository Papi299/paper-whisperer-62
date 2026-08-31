/// <reference types="https://esm.sh/@supabase/functions-js/src/edge-runtime.d.ts" />

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { requireEdgeEnv } from "../_shared/env.ts";
import { resolveGeminiModel } from "../_shared/geminiModel.ts";
import { callGeminiWithRetry } from "../_shared/geminiTransport.ts";
import {
  classifyProviderError,
  NEUTRAL_ANALYSIS_UNAVAILABLE_MESSAGE,
  type ProviderErrorClass,
} from "../_shared/providerError.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

const jsonHeaders = { ...corsHeaders, "Content-Type": "application/json" };

/**
 * Best-effort refund of one AI quota unit. Swallows any error so the
 * caller can still surface the ORIGINAL Gemini failure without being
 * shadowed by a refund-side issue. The refund_ai_quota RPC itself is
 * also tolerant (returns refunded=false on missing counter), so the
 * combination is layered defense-in-depth.
 *
 * Takes a Supabase client that is authenticated as the caller so the
 * RPC sees the right auth.uid() and the S1 ownership guard passes.
 * Uses a minimal structural type covering just the `.rpc()` shape
 * actually called below — avoids importing the full SupabaseClient
 * generic type (which requires a Database type that this Edge
 * Function doesn't ship with).
 */
type RpcClient = {
  rpc: (
    fn: string,
    args: Record<string, unknown>,
  ) => Promise<{ error: { message: string } | null }>;
};

async function safeRefundAiQuota(supabase: RpcClient, userId: string): Promise<void> {
  try {
    const { error } = await supabase.rpc("refund_ai_quota", { p_user_id: userId });
    if (error) {
      console.error("refund_ai_quota RPC returned error (swallowed):", error.message);
    }
  } catch (refundErr) {
    console.error("refund_ai_quota threw (swallowed):", refundErr instanceof Error ? refundErr.message : "unknown");
  }
}

Deno.serve(async (req) => {
  // CORS preflight — MUST be first, before any auth logic
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    // ── Step 1: Auth ──
    console.log("1. Checking Auth Header");
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      console.log("1a. Missing Authorization header");
      return new Response(
        JSON.stringify({ error: "Missing Authorization header" }),
        { status: 401, headers: jsonHeaders },
      );
    }
    console.log("1a. Auth header present");

    console.log("2. Calling Supabase getUser");
    // Fail fast with an actionable error if either runtime-required var is
    // missing — replaces the previous `?? ""` fallback which silently
    // produced a broken `createClient("", "")` whose downstream
    // `auth.getUser()` failure was hard to attribute. Auto-injected by
    // the Supabase Edge runtime in production; the throw is a safety net.
    const supabaseUrl = requireEdgeEnv("SUPABASE_URL");
    const supabaseAnonKey = requireEdgeEnv("SUPABASE_ANON_KEY");
    const supabase = createClient(supabaseUrl, supabaseAnonKey, {
      global: { headers: { Authorization: authHeader } },
    });

    const { data: { user }, error: authError } = await supabase.auth.getUser();
    if (authError) {
      console.log("2a. Auth failed");
      return new Response(
        JSON.stringify({ error: "Auth failed: " + authError.message }),
        { status: 401, headers: jsonHeaders },
      );
    }
    if (!user) {
      console.log("2a. No user returned from getUser");
      return new Response(
        JSON.stringify({ error: "Auth failed: no user returned" }),
        { status: 401, headers: jsonHeaders },
      );
    }
    console.log("2b. User authenticated");

    // ── Step 2: Parse input ──
    // Body validation happens BEFORE the quota check so a malformed
    // request never consumes a quota unit (and never needs a refund).
    console.log("3. Parsing request body");
    const { title, abstract } = await req.json();
    if (!abstract || typeof abstract !== "string") {
      console.log("3a. Invalid input: missing or non-string abstract");
      return new Response(
        JSON.stringify({ error: "Missing or invalid 'abstract' field" }),
        { status: 400, headers: jsonHeaders },
      );
    }
    console.log("3a. Input received");

    // ── Step 3: Consume AI quota (server-side enforcement) ──
    // Calls the SECURITY DEFINER consume_ai_quota RPC through the
    // caller-authenticated Supabase client, so the RPC sees the
    // caller's auth.uid() and the S1 ownership guard validates the
    // p_user_id argument against it. The RPC atomically increments
    // usage_counters.used iff used < quota; the application code
    // here trusts the RPC's `allowed` flag and does NOT do its own
    // quota arithmetic.
    console.log("3b. Consuming AI quota");
    const { data: quotaData, error: quotaError } = await supabase.rpc(
      "consume_ai_quota",
      { p_user_id: user.id },
    );
    if (quotaError) {
      console.error("3c. consume_ai_quota RPC error:", quotaError.message);
      return new Response(
        JSON.stringify({
          error: "Analysis failed. Please try again later.",
        }),
        { status: 500, headers: jsonHeaders },
      );
    }
    // RPC returns SETOF (a TABLE-typed function); supabase-js surfaces
    // it as an array. Pull the first row defensively.
    const quotaRow = Array.isArray(quotaData) ? quotaData[0] : quotaData;
    if (!quotaRow || quotaRow.allowed !== true) {
      const reason = (quotaRow?.reason as string | undefined) ?? "quota_exceeded";
      console.log("3d. Quota denied:", reason);
      // 402 Payment Required is the correct shape for a commercial
      // quota wall: it tells the client the request is well-formed and
      // authorized but blocked on a paywall. The client distinguishes
      // 402 from 401 (re-auth) and from 500 (retry).
      return new Response(
        JSON.stringify({
          error: "quota_exceeded",
          message: reason === "quota_exceeded"
            ? "AI analysis quota exceeded."
            : `AI analysis not available (${reason}).`,
          details: {
            plan: quotaRow?.plan ?? null,
            period_type: quotaRow?.period_type ?? null,
            used: quotaRow?.used ?? 0,
            quota: quotaRow?.quota ?? 0,
            remaining: quotaRow?.remaining ?? 0,
            reset_at: quotaRow?.reset_at ?? null,
          },
        }),
        { status: 402, headers: jsonHeaders },
      );
    }
    console.log("3e. Quota consumed; remaining:", quotaRow.remaining);

    // ── Step 4: Call Gemini ──
    // Wrapped in an inner try so a Gemini / parsing failure triggers a
    // best-effort refund of the quota unit just consumed. The refund
    // RPC is best-effort: if it itself fails, we log and rethrow the
    // ORIGINAL Gemini error so the caller sees the real failure
    // reason, not a refund-side error.
    console.log("4. Checking Gemini API key");
    const geminiKey = Deno.env.get("GEMINI_API_KEY");
    if (!geminiKey) {
      // Refund before throwing — the user did not get the analysis.
      await safeRefundAiQuota(supabase, user.id);
      throw new Error("GEMINI_API_KEY not configured in Supabase secrets");
    }
    console.log("4a. Gemini key present");

    // Centralized model config (Part D): GEMINI_MODEL secret with the exact
    // historical fallback. analyze-paper and get-gemini-provider-quota resolve
    // the same value so they can never silently disagree.
    const geminiModel = resolveGeminiModel(Deno.env.get("GEMINI_MODEL"));
    const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${geminiModel}:generateContent`;
    console.log("5. Calling Gemini API");

    const geminiBody = {
      system_instruction: {
        parts: [{
          text: `You are an expert academic data extractor. Analyze the provided title and abstract.
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
     Also include standard tests (ANOVA, Odds Ratio, etc.). Output 'Not specified' if none are found.`,
        }],
      },
      contents: [{
        parts: [{
          text: `Title: ${title || "Unknown"}\n\nAbstract: ${abstract}`,
        }],
      }],
      generationConfig: {
        responseMimeType: "application/json",
      },
    };

    // Gemini-call-and-parse block. Any failure triggers a best-effort refund of
    // the quota unit consumed above, then returns a NEUTRAL 500 carrying a
    // machine-readable provider-error `code` (Part F). A provider rate-limit /
    // quota event is NEVER converted into a Paperlume 402 — it stays a 500, the
    // user sees neutral wording, and the classification (for telemetry + the
    // manager-only provider panel) never leaks Google project detail.
    let providerErrorClass: ProviderErrorClass = "unknown";
    let classified = false;
    try {
      // AI-PROVIDER-RESILIENCE-001A: the timeout/retry policy now lives in
      // _shared/geminiTransport.ts, shared with suggest-paper-organization so
      // the two Gemini callers cannot drift. 30 s per attempt; 429/5xx and
      // ordinary network errors keep the same bounded 2 s / 4 s retry budget; a
      // timeout is TERMINAL and is never automatically re-sent.
      const providerCall = await callGeminiWithRetry(
        geminiUrl,
        {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-goog-api-key": geminiKey },
          body: JSON.stringify(geminiBody),
        },
        {
          label: "analyze-paper",
          fetchImpl: (url, init) => fetch(url, init),
          sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
          logger: console,
        },
      );

      console.log("5a. Gemini provider attempts:", providerCall.attempts);

      if (!providerCall.ok) {
        // A timeout is distinguished from a generic network failure here rather
        // than collapsed into one: the two are diagnosed very differently, and
        // only one of them means "we stopped waiting while Google may still have
        // been generating". Both still classify to `provider_unavailable`, so
        // nothing the user or the provider panel sees changes.
        if (providerCall.kind === "http") {
          console.log("5b. Gemini error, status:", providerCall.status);
          providerErrorClass = classifyProviderError({ kind: "http", status: providerCall.status });
          classified = true;
          throw new Error("gemini_http_" + providerCall.status);
        }
        console.log("5b. Gemini transport failure:", providerCall.kind);
        providerErrorClass = classifyProviderError({ kind: providerCall.kind });
        classified = true;
        throw new Error("gemini_" + providerCall.kind);
      }

      const geminiData = await providerCall.response.json();
      console.log("6. Parsing Gemini response");

      const rawText = geminiData?.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!rawText) {
        console.log("6a. Empty Gemini response (no candidates/text)");
        providerErrorClass = classifyProviderError({ kind: "empty" });
        classified = true;
        throw new Error("gemini_empty");
      }
      console.log("6b. Gemini response received");

      let cleanText = rawText.replace(/```json/gi, "").replace(/```/g, "").trim();
      const startIndex = cleanText.indexOf("{");
      const endIndex = cleanText.lastIndexOf("}");
      if (startIndex === -1 || endIndex === -1) {
        console.log("6c. No JSON object found in Gemini response");
        providerErrorClass = classifyProviderError({ kind: "parse" });
        classified = true;
        throw new Error("gemini_no_json");
      }
      cleanText = cleanText.substring(startIndex, endIndex + 1);
      let parsed;
      try {
        parsed = JSON.parse(cleanText);
      } catch (parseErr) {
        console.log("6c. JSON parse failed");
        providerErrorClass = classifyProviderError({ kind: "parse" });
        classified = true;
        throw new Error("gemini_parse_failed: " + (parseErr instanceof Error ? parseErr.message : "unknown"));
      }
      console.log("7. Success! Returning parsed result");

      // Success path — quota stays consumed (no refund). Response
      // shape and headers are bit-identical to the pre-quota version.
      return new Response(
        JSON.stringify({
          tldr: parsed.tldr || "",
          studyType: parsed.studyType || "",
          statisticalMethods: parsed.statisticalMethods || "",
        }),
        { status: 200, headers: jsonHeaders },
      );
    } catch (geminiErr) {
      // Reached without an HTTP/empty/parse classification → network / timeout.
      if (!classified) {
        providerErrorClass = classifyProviderError({ kind: "network" });
      }
      // Best-effort refund — the user did not receive a valid analysis.
      await safeRefundAiQuota(supabase, user.id);
      // Log the class + a bounded reason; never the raw Google body.
      console.error(
        "analyze-paper provider failure:",
        providerErrorClass,
        geminiErr instanceof Error ? geminiErr.message : "unknown",
      );
      // Neutral, non-operational wording for the user. A provider limit is NOT a
      // Paperlume plan wall — this stays a 500, never a 402.
      return new Response(
        JSON.stringify({
          error: "analysis_unavailable",
          code: providerErrorClass,
          message: NEUTRAL_ANALYSIS_UNAVAILABLE_MESSAGE,
        }),
        { status: 500, headers: jsonHeaders },
      );
    }
  } catch (err) {
    console.error("analyze-paper error:", err instanceof Error ? err.message : "Unknown error");
    return new Response(
      JSON.stringify({ error: "Analysis failed. Please try again later." }),
      { status: 500, headers: jsonHeaders },
    );
  }
});
