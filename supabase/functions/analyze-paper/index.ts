/// <reference types="https://esm.sh/@supabase/functions-js/src/edge-runtime.d.ts" />

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { requireEdgeEnv } from "../_shared/env.ts";
import {
  formatModelRoutingLog,
  resolveEffectiveAiModel,
  type AiModelSelectionClient,
} from "../_shared/aiModelSelection.ts";
import {
  getAiProviderAdapter,
  resolveSystemDefaultAiModel,
} from "../_shared/aiProviderRegistry.ts";
import {
  classifyProviderError,
  NEUTRAL_ANALYSIS_UNAVAILABLE_MESSAGE,
  type ProviderErrorClass,
} from "../_shared/providerError.ts";
import { buildAnalyzeGenerationRequest } from "./prompt.ts";

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

    // ── Step 2b: Resolve the model this request will actually use ──
    //
    // AI-MODEL-SELECTION-001B (C33). Two ordered sources, and nothing else:
    // Paperlume's system default from the trusted GEMINI_MODEL environment, and
    // — only for a caller whose entitlement is re-proven server-side right here,
    // on this request — their saved preference resolved through the
    // server-controlled ai_model_catalog. The request body is read exactly once,
    // above, for `title` and `abstract`; it carries no model field and no user
    // id, and `user.id` below is the authoritative getUser() identity.
    //
    // Placed after body validation and BEFORE quota consumption: a malformed
    // request still costs nothing, and a metadata problem here costs nothing
    // either, because every failure mode falls back to the system default
    // rather than failing the request. This spends no quota and makes no
    // provider call.
    const systemDefault = resolveSystemDefaultAiModel(Deno.env.get("GEMINI_MODEL"));
    const modelSelection = await resolveEffectiveAiModel({
      client: supabase as unknown as AiModelSelectionClient,
      userId: user.id,
      systemDefault,
      label: "analyze-paper",
      logger: console,
    });

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

    // The adapter for the provider this request resolved to. Total by
    // construction: `resolveEffectiveAiModel` can only return a provider the
    // runtime registry has a reviewed adapter for (AI-MULTI-PROVIDER-001A,
    // C39), so there is no lookup-failure branch here to mishandle after the
    // quota unit above has already been consumed.
    //
    // The ONLY provider delta from per-user model selection remains the model:
    // the request content, the credential, the transport policy, the parsing
    // and the quota semantics below are identical whether this is the system
    // default or an honoured preference. `providerModel` is either the resolved
    // GEMINI_MODEL value or a catalog-supplied string — never anything the
    // client sent.
    const providerAdapter = getAiProviderAdapter(modelSelection.provider);
    // One bounded routing line: operation, source, provider, public model name.
    // No user id, no email, no token, no key, no title/abstract.
    console.log(formatModelRoutingLog("analyze-paper", modelSelection));
    console.log("5. Calling Gemini API");

    // Provider-neutral: two prompt strings and a response format. How that
    // becomes a Gemini URL, envelope and `x-goog-api-key` header is the Google
    // adapter's business, and this function no longer knows any of it.
    const generationRequest = buildAnalyzeGenerationRequest(title, abstract);

    // Gemini-call-and-parse block. Any failure triggers a best-effort refund of
    // the quota unit consumed above, then returns a NEUTRAL 500 carrying a
    // machine-readable provider-error `code` (Part F). A provider rate-limit /
    // quota event is NEVER converted into a Paperlume 402 — it stays a 500, the
    // user sees neutral wording, and the classification (for telemetry + the
    // manager-only provider panel) never leaks Google project detail.
    let providerErrorClass: ProviderErrorClass = "unknown";
    let classified = false;
    try {
      // AI-PROVIDER-RESILIENCE-001A: the timeout/retry policy lives in
      // _shared/geminiTransport.ts, which the Google adapter calls, shared with
      // suggest-paper-organization so the two Gemini callers cannot drift.
      // TEMPORARY, per AI-PROVIDER-90S-PROD-DIAGNOSTIC-001A: 90 s per attempt
      // and ZERO retries, so every outcome — including a 429/5xx — resolves
      // after a single attempt and no backoff is slept. (The established policy
      // this will be restored to is 30 s with two bounded 2 s / 4 s retries;
      // see the transport header.) A timeout is TERMINAL under either policy
      // and is never automatically re-sent. This function pins none of it, and
      // neither does the adapter: both take whatever the shared constants are.
      const providerCall = await providerAdapter.generate(
        modelSelection,
        generationRequest,
        {
          apiKey: geminiKey,
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
        if (providerCall.kind === "network" || providerCall.kind === "timeout") {
          console.log("5b. Gemini transport failure:", providerCall.kind);
          providerErrorClass = classifyProviderError({ kind: providerCall.kind });
          classified = true;
          throw new Error("gemini_" + providerCall.kind);
        }
        if (providerCall.kind === "unreadable_response") {
          // A 2xx whose body the adapter could not read as a provider response.
          // Classified `provider_unavailable`, which is what this function has
          // always done with it: the body read used to happen here and its
          // failure fell through to the catch-all below.
          // suggest-paper-organization classifies the same case as
          // malformed_response; aligning the two is a behaviour change
          // AI-MULTI-PROVIDER-001A deliberately does not make.
          providerErrorClass = classifyProviderError({ kind: "network" });
          classified = true;
          throw new Error("gemini_unreadable_response");
        }
        if (providerCall.kind === "incomplete_response") {
          // A readable 2xx envelope in which the provider itself reports the
          // generation did not finish. AI-MULTI-PROVIDER-001B added this kind
          // for the two UNREGISTERED adapters (Anthropic's `stop_reason`,
          // OpenAI's `status`); Google's envelope has no such field, so this
          // branch is unreachable today and nothing about this function's
          // current behaviour changes. It is written now because the tail below
          // treats every remaining kind as `empty`, and a new kind falling into
          // it would report a truncated or abandoned generation as "the model
          // returned nothing" — in exactly the log line someone would use to
          // diagnose it. Classified `malformed_response`, which is also what
          // suggest-paper-organization does with it: unlike the two 001A kinds,
          // this one has no divergent history to preserve.
          console.log("5b. Provider reported an incomplete generation");
          providerErrorClass = classifyProviderError({ kind: "parse" });
          classified = true;
          throw new Error("provider_incomplete_response");
        }
        // A well-formed envelope carrying no generated text.
        console.log("6. Parsing Gemini response");
        console.log("6a. Empty Gemini response (no candidates/text)");
        providerErrorClass = classifyProviderError({ kind: "empty" });
        classified = true;
        throw new Error("gemini_empty");
      }

      console.log("6. Parsing Gemini response");

      // Normalized by the adapter to the generated text this function's own
      // parser has always received — never a provider envelope.
      const rawText = providerCall.text;
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
