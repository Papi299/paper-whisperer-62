/// <reference types="https://esm.sh/@supabase/functions-js/src/edge-runtime.d.ts" />

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { requireEdgeEnv } from "../_shared/env.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

const jsonHeaders = { ...corsHeaders, "Content-Type": "application/json" };

/**
 * Fetch with bounded retry and exponential backoff.
 * Retries on 429, 5xx, network errors, and timeouts.
 * Does NOT retry on 4xx (except 429) — those are permanent failures.
 */
async function fetchWithRetry(
  url: string,
  init: RequestInit,
  maxRetries = 2,
  baseDelayMs = 2000,
): Promise<Response> {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const res = await fetch(url, {
        ...init,
        signal: AbortSignal.timeout(15_000),
      });

      if (res.ok) return res;

      // Non-retriable client errors (except 429)
      if (res.status !== 429 && res.status < 500) {
        return res;
      }

      // Retriable: 429 or 5xx
      if (attempt < maxRetries) {
        let delay = baseDelayMs * Math.pow(2, attempt);

        // Respect Retry-After header on 429
        if (res.status === 429) {
          const retryAfter = res.headers.get("Retry-After");
          if (retryAfter) {
            const retryMs = Number(retryAfter) * 1000;
            if (!isNaN(retryMs) && retryMs > 0) {
              delay = Math.min(Math.max(retryMs, delay), 10_000);
            }
          }
        }

        console.log(`fetchWithRetry: attempt ${attempt + 1}/${maxRetries + 1} got ${res.status}, retrying in ${delay}ms`);
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }

      // Exhausted retries
      return res;
    } catch (err) {
      // Network error or timeout
      if (attempt < maxRetries) {
        const delay = baseDelayMs * Math.pow(2, attempt);
        console.log(`fetchWithRetry: attempt ${attempt + 1}/${maxRetries + 1} network error, retrying in ${delay}ms`);
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }
      throw err;
    }
  }

  // Unreachable
  throw new Error("fetchWithRetry: exhausted retries");
}

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

    const geminiUrl = "https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:generateContent";
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
        temperature: 0.1,
      },
    };

    // Gemini-call-and-parse block. Any throw inside this block triggers
    // a best-effort refund of the quota unit consumed above. The throw
    // is then re-raised so the outer catch returns the existing 500
    // generic-error response — the user-visible failure surface is
    // bit-identical to the pre-quota behavior.
    try {
      const geminiRes = await fetchWithRetry(geminiUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": geminiKey },
        body: JSON.stringify(geminiBody),
      });

      console.log("5a. Gemini response status:", geminiRes.status);

      if (!geminiRes.ok) {
        console.log("5b. Gemini error, status:", geminiRes.status);
        throw new Error("Gemini API Error (" + geminiRes.status + ")");
      }

      const geminiData = await geminiRes.json();
      console.log("6. Parsing Gemini response");

      const rawText = geminiData?.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!rawText) {
        console.log("6a. Empty Gemini response (no candidates/text)");
        throw new Error("Empty response from Gemini");
      }
      console.log("6b. Gemini response received");

      let cleanText = rawText.replace(/```json/gi, "").replace(/```/g, "").trim();
      const startIndex = cleanText.indexOf("{");
      const endIndex = cleanText.lastIndexOf("}");
      if (startIndex === -1 || endIndex === -1) {
        console.log("6c. No JSON object found in Gemini response");
        throw new Error("Gemini response did not contain valid JSON");
      }
      cleanText = cleanText.substring(startIndex, endIndex + 1);
      let parsed;
      try {
        parsed = JSON.parse(cleanText);
      } catch (parseErr) {
        console.log("6c. JSON parse failed");
        throw new Error("Failed to parse Gemini JSON: " + (parseErr instanceof Error ? parseErr.message : "unknown"));
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
      // Best-effort refund. We log a swallowed refund error rather
      // than mask the original Gemini failure — the user sees the
      // real reason for the failure, and the operator sees both
      // events in Supabase logs.
      await safeRefundAiQuota(supabase, user.id);
      throw geminiErr;
    }
  } catch (err) {
    console.error("analyze-paper error:", err instanceof Error ? err.message : "Unknown error");
    return new Response(
      JSON.stringify({ error: "Analysis failed. Please try again later." }),
      { status: 500, headers: jsonHeaders },
    );
  }
});
