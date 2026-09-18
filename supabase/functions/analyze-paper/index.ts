/// <reference types="https://esm.sh/@supabase/functions-js/src/edge-runtime.d.ts" />

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { requireEdgeEnv } from "../_shared/env.ts";
import {
  formatModelRoutingLog,
  resolveEffectiveAiModel,
  type AiModelSelectionClient,
} from "../_shared/aiModelSelection.ts";
import {
  generateWithRegisteredAiProvider,
  resolveSystemDefaultAiModel,
} from "../_shared/aiProviderRegistry.ts";
import { resolveAiProviderCredential } from "../_shared/aiProviderCredentials.ts";
import {
  formatReasoningPolicyLog,
  resolveAiReasoningPolicy,
} from "../_shared/aiReasoningPolicy.ts";
import {
  classifyProviderError,
  NEUTRAL_ANALYSIS_UNAVAILABLE_MESSAGE,
  type ProviderErrorClass,
} from "../_shared/providerError.ts";
import { buildAnalyzeGenerationRequest } from "./prompt.ts";
import type { AiProviderResult } from "../_shared/aiProvider.ts";
import {
  createAiUsageEventInsertClient,
  recordAiProviderUsage,
  type AiOperationOutcome,
} from "../_shared/aiUsageTelemetry.ts";
import {
  analyzeEnvMissingLog,
  analyzeProviderFailureLog,
  analyzeRequestFailureLog,
  type AnalyzeProviderFailureReason,
  type AnalyzeRequiredEnvName,
} from "./logging.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

const jsonHeaders = { ...corsHeaders, "Content-Type": "application/json" };

/**
 * Best-effort refund of one AI quota unit. Swallows any error so the
 * caller can still surface the ORIGINAL provider failure without being
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

/**
 * Read a runtime-required variable, logging only its NAME when it is missing.
 *
 * EDGE-LOG-PRIVACY-HARDENING-001. `requireEdgeEnv` throws an actionable message
 * naming the variable, and the outer catch used to log that message — which is
 * how a documented operator diagnostic (docs/deployment.md §10.2) rode the same
 * channel as arbitrary throwable text. Now the name is stated here, as a
 * bounded line built from a literal argument, and the thrown message is not
 * logged by anyone.
 */
function requireEdgeEnvLogged(name: AnalyzeRequiredEnvName): string {
  try {
    return requireEdgeEnv(name);
  } catch {
    console.error(analyzeEnvMissingLog(name));
    throw new Error("env_missing");
  }
}

async function safeRefundAiQuota(supabase: RpcClient, userId: string): Promise<void> {
  try {
    const { error } = await supabase.rpc("refund_ai_quota", { p_user_id: userId });
    // EDGE-LOG-PRIVACY-HARDENING-001: the failure is reported as a bounded flag
    // rather than the database's own message, which is arbitrary text from
    // outside this function. Same spelling as `suggest-paper-organization`'s
    // `safeRefund`, so the two refund paths report failure identically.
    if (error) {
      console.error("analyze-paper refund_failed rpc_error=1");
    }
  } catch {
    console.error("analyze-paper refund_failed threw=1");
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
    const supabaseUrl = requireEdgeEnvLogged("SUPABASE_URL");
    const supabaseAnonKey = requireEdgeEnvLogged("SUPABASE_ANON_KEY");
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

    // ── Step 2c: How hard should this request think? ──
    //
    // AI-MULTI-PROVIDER-001C (C41). PaperLume's own reasoning policy, resolved
    // from the effective model's server-controlled catalog metadata and the
    // caller's saved preference — never inherited from whatever the provider
    // currently defaults to. Placed here, beside model selection and still
    // BEFORE the quota unit, for the same reasons: it is a read-only metadata
    // lookup that spends nothing, makes no provider call, and cannot fail the
    // request (every failure mode resolves to a bounded provider-default
    // fallback that preserves the feature).
    const reasoningDecision = await resolveAiReasoningPolicy({
      client: supabase as unknown as AiModelSelectionClient,
      operation: "analyze",
      selection: modelSelection,
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
      // Bounded: the RPC's own message is arbitrary external text. Mirrors
      // `suggest-organization quota_rpc_error`.
      console.error("3c. analyze-paper quota_rpc_error");
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

    // ── Step 4: Call the selected provider ──
    // Wrapped in an inner try so a provider / parsing failure triggers a
    // best-effort refund of the quota unit just consumed. The refund
    // RPC is best-effort: if it itself fails, it is logged as its own bounded
    // line and the ORIGINAL provider failure still decides the response, so a
    // refund-side problem never masks the real outcome. Since
    // EDGE-LOG-PRIVACY-HARDENING-001 the failure is reported by its bounded
    // class and reason, never by the thrown error's message.
    // ── Step 4: the SELECTED PROVIDER's credential ──
    //
    // AI-MULTI-PROVIDER-001C. This used to read `GEMINI_API_KEY`
    // unconditionally, which was correct while Google was the only registered
    // provider and is a hazard now that three are: a request routed to
    // Anthropic while still reading Google's variable would put PaperLume's
    // Gemini key in a header addressed to another provider. The name comes from
    // the one reviewed provider→credential mapping, and exactly that one
    // variable is read.
    //
    // The ORDER is unchanged on purpose. The quota unit has already been
    // consumed above, so a misconfigured deployment must refund before it
    // fails — the pre-001C behaviour for a missing key, preserved exactly, just
    // for whichever provider this request actually resolved to.
    console.log("4. Checking provider credential");
    const credential = resolveAiProviderCredential(
      modelSelection.provider,
      (name) => Deno.env.get(name),
    );
    if (!credential.ok) {
      // Refund before throwing — the user did not get the analysis. The log
      // line names the missing ENVIRONMENT VARIABLE, never a value: without the
      // name a misconfigured deployment is undiagnosable, and the name is not a
      // secret. It is stated here, as its own bounded line (the spelling
      // `suggest-paper-organization` already uses), because the outer catch no
      // longer logs the thrown message.
      console.error(`analyze-paper provider_key_missing env=${credential.envName}`);
      await safeRefundAiQuota(supabase, user.id);
      throw new Error(`${credential.envName} not configured in Supabase secrets`);
    }
    console.log("4a. Provider credential present:", credential.envName);

    // One bounded routing line: operation, source, provider, public model name.
    // No user id, no email, no token, no key, no title/abstract.
    console.log(formatModelRoutingLog("analyze-paper", modelSelection));
    // One bounded reasoning line: operation, who decided, the concrete public
    // level, and PaperLume's output ceiling.
    console.log(formatReasoningPolicyLog("analyze-paper", "analyze", reasoningDecision));
    console.log("5. Calling AI provider");

    // Provider-neutral: two prompt strings and a response format. How that
    // becomes a Gemini URL, envelope and `x-goog-api-key` header is the Google
    // adapter's business, and this function no longer knows any of it.
    const generationRequest = buildAnalyzeGenerationRequest(title, abstract);

    // Provider-call-and-parse block. Any failure triggers a best-effort refund of
    // the quota unit consumed above, then returns a NEUTRAL 500 carrying a
    // machine-readable provider-error `code` (Part F). A provider rate-limit /
    // quota event is NEVER converted into a Paperlume 402 — it stays a 500, the
    // user sees neutral wording, and the classification (for telemetry + the
    // manager-only provider panel) never leaks Google project detail.
    let providerErrorClass: ProviderErrorClass = "unknown";
    let classified = false;
    // EDGE-LOG-PRIVACY-HARDENING-001. The bounded reason the failure log will
    // carry, set beside the classification at each branch below. It replaces
    // reading the caught throwable's message: every value it can hold is one of
    // the closed `AnalyzeProviderFailureReason` literals, so no branch can put
    // generated text, a request fragment or a URL into an operational log.
    let failureReason: AnalyzeProviderFailureReason = "provider_unknown";

    // AI-MULTI-PROVIDER-001D. The provider call, once it has happened, and the
    // one place its usage is recorded: exactly once per request that reached a
    // provider — on the success return and in the failure catch — and only
    // AFTER the outcome is decided, so telemetry can neither change nor shadow
    // it. `recordAiProviderUsage` never throws and nothing reads its result.
    // The quota refund is untouched: provider cost and PaperLume quota are
    // different ledgers. The telemetry client is the only elevated client in
    // this function; it is built lazily from the platform-injected secret key
    // and can INSERT one telemetry row and nothing else.
    let dispatchedCall: AiProviderResult | null = null;
    const recordProviderUsage = async (operationOutcome: AiOperationOutcome): Promise<void> => {
      if (dispatchedCall === null) return;
      await recordAiProviderUsage(
        {
          userId: user.id,
          operation: "analyze",
          selection: modelSelection,
          reasoning: reasoningDecision,
          call: dispatchedCall,
          operationOutcome,
        },
        {
          label: "analyze-paper",
          logger: console,
          createClient: () =>
            createAiUsageEventInsertClient({
              supabaseUrl,
              readEnv: (name) => Deno.env.get(name),
              createSupabaseClient: (url, key, options) => createClient(url, key, options),
            }),
        },
      );
    };

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
      const providerCall = await generateWithRegisteredAiProvider(
        modelSelection,
        generationRequest,
        reasoningDecision.policy,
        {
          apiKey: credential.apiKey,
          label: "analyze-paper",
          fetchImpl: (url, init) => fetch(url, init),
          sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
          logger: console,
        },
      );

      dispatchedCall = providerCall;
      console.log("5a. Provider attempts:", providerCall.attempts);

      if (!providerCall.ok) {
        // A timeout is distinguished from a generic network failure here rather
        // than collapsed into one: the two are diagnosed very differently, and
        // only one of them means "we stopped waiting while Google may still have
        // been generating". Both still classify to `provider_unavailable`, so
        // nothing the user or the provider panel sees changes.
        if (providerCall.kind === "http") {
          console.log("5b. Provider HTTP error, status:", providerCall.status);
          providerErrorClass = classifyProviderError({ kind: "http", status: providerCall.status });
          classified = true;
          failureReason = typeof providerCall.status === "number"
            ? `provider_http_${providerCall.status}`
            : "provider_http_unknown";
          throw new Error(failureReason);
        }
        if (providerCall.kind === "network" || providerCall.kind === "timeout") {
          console.log("5b. Provider transport failure:", providerCall.kind);
          providerErrorClass = classifyProviderError({ kind: providerCall.kind });
          classified = true;
          failureReason = providerCall.kind === "timeout" ? "provider_timeout" : "provider_network";
          throw new Error(failureReason);
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
          failureReason = "provider_unreadable_response";
          throw new Error(failureReason);
        }
        if (providerCall.kind === "incomplete_response") {
          // A readable 2xx envelope in which the provider itself reports the
          // generation did not finish. AI-MULTI-PROVIDER-001B added this kind
          // for the Anthropic and OpenAI adapters (Anthropic's `stop_reason`,
          // OpenAI's `status`); Google's envelope has no such field, so a
          // Gemini request cannot produce it. It became genuinely reachable with
          // AI-MULTI-PROVIDER-001E: both paid rows are staged `enabled` in
          // Production (Phase 7 routed a real request to each), so a truncated
          // Claude or OpenAI generation lands here. It was written before that
          // was possible, because the tail below treats every remaining kind as
          // `empty`, and a new kind falling into it would report a truncated or
          // abandoned generation as "the model returned nothing" — in exactly
          // the log line someone would use to diagnose it. Classified
          // `malformed_response`, which is also what suggest-paper-organization
          // does with it: unlike the two 001A kinds, this one has no divergent
          // history to preserve.
          console.log("5b. Provider reported an incomplete generation");
          providerErrorClass = classifyProviderError({ kind: "parse" });
          classified = true;
          failureReason = "provider_incomplete_response";
          throw new Error(failureReason);
        }
        // A well-formed envelope carrying no generated text.
        console.log("6. Parsing provider response");
        console.log("6a. Empty provider response (no generated text)");
        providerErrorClass = classifyProviderError({ kind: "empty" });
        classified = true;
        failureReason = "provider_empty_response";
        throw new Error(failureReason);
      }

      console.log("6. Parsing provider response");

      // Normalized by the adapter to the generated text this function's own
      // parser has always received — never a provider envelope.
      const rawText = providerCall.text;
      console.log("6b. Provider response received");

      let cleanText = rawText.replace(/```json/gi, "").replace(/```/g, "").trim();
      const startIndex = cleanText.indexOf("{");
      const endIndex = cleanText.lastIndexOf("}");
      if (startIndex === -1 || endIndex === -1) {
        console.log("6c. No JSON object found in provider response");
        providerErrorClass = classifyProviderError({ kind: "parse" });
        classified = true;
        failureReason = "provider_no_json";
        throw new Error(failureReason);
      }
      cleanText = cleanText.substring(startIndex, endIndex + 1);
      let parsed;
      try {
        parsed = JSON.parse(cleanText);
      } catch {
        // EDGE-LOG-PRIVACY-HARDENING-001: the parser's own exception is
        // DISCARDED, not logged. V8 quotes the input it choked on, so that
        // message is a fragment of the generated answer — the paper's content,
        // in an operational log. The fact worth keeping is that the answer did
        // not parse, which the bounded reason states.
        console.log("6c. JSON parse failed");
        providerErrorClass = classifyProviderError({ kind: "parse" });
        classified = true;
        failureReason = "provider_json_parse_failed";
        throw new Error(failureReason);
      }
      console.log("7. Success! Returning parsed result");
      await recordProviderUsage("succeeded");

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
    } catch {
      // Reached without an HTTP/empty/parse classification → network / timeout.
      // The throwable itself is deliberately not bound: every branch above
      // already recorded a bounded `failureReason`, and anything unexpected
      // that lands here keeps `provider_unknown` rather than contributing its
      // own text.
      if (!classified) {
        providerErrorClass = classifyProviderError({ kind: "network" });
      }
      // Best-effort refund — the user did not receive a valid analysis.
      await safeRefundAiQuota(supabase, user.id);
      // The provider's usage is recorded even though the user got nothing: a
      // parse failure after a completed generation still cost the provider
      // work. A request that never reached the provider records nothing.
      await recordProviderUsage("failed");
      // Log the class + a bounded reason; never the raw provider body, and
      // never the throwable's own message.
      console.error(analyzeProviderFailureLog(providerErrorClass, failureReason));
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
    // EDGE-LOG-PRIVACY-HARDENING-001: an allow-listed error NAME, never the
    // message. This is the catch a malformed `req.json()` body reaches, and
    // V8's SyntaxError quotes that body — so logging the message let a caller
    // put a fragment of their own request into the Edge log.
    console.error(analyzeRequestFailureLog(err));
    return new Response(
      JSON.stringify({ error: "Analysis failed. Please try again later." }),
      { status: 500, headers: jsonHeaders },
    );
  }
});
