/**
 * suggest-paper-organization — the complete request path, expressed without any
 * runtime binding.
 *
 * AI-PROJECT-TAG-SUGGESTIONS-001A. `index.ts` supplies the real Supabase client,
 * the real `fetch` and the real environment, and calls `Deno.serve`; every
 * decision that matters lives here and in the four pure modules beside it, so
 * Vitest exercises the actual shipped path — CORS-before-auth, method gating,
 * the authoritative `auth.getUser()` check, paper ownership, taxonomy loading,
 * quota consumption, the provider call, and refund on an unusable result — with
 * fake clients and a fake `fetch`. No security-sensitive logic is re-implemented
 * for testability. Same split as `search-pubmed/handler.ts` and
 * `delete-account/handler.ts`.
 *
 * ## This endpoint is advisory. It mutates nothing in the application domain.
 *
 * It answers "where might this paper belong?" and returns suggestions. It never
 * inserts, updates or deletes a Project, a Tag, a `paper_projects` row, a
 * `paper_tags` row or a paper, and it never persists a suggestion. That is
 * enforced structurally, not by convention: `CallerClient` below is the entire
 * database surface this module can reach, and it exposes `select`, `rpc` and
 * nothing else — there is no `insert`, `update`, `upsert` or `delete` to call.
 * The only writes are the two pre-existing AI-quota RPCs.
 *
 * ## Order of operations, and why
 *
 *   1. CORS preflight        — before auth; a preflight carries no credentials.
 *   2. Method gate           — before the token is read.
 *   3. Authorization header  — required.
 *   4. `auth.getUser()`      — authoritative; the ONLY source of caller identity.
 *   5. Request validation    — shape, bounds, eligibility.
 *   6. Paper ownership       — non-disclosing 404 for missing *or* foreign.
 *   7. Taxonomy load         — caller-scoped; overflow fails honestly.
 *   8. Provider input build  — allow-listed fields, ephemeral refs, size bound.
 *   9. Model selection       — re-check entitlement, resolve a saved preference
 *                              through the server-controlled catalog, fail
 *                              closed to the system default.
 *  10. Reasoning policy      — PaperLume's own per-model, per-operation level.
 *  11. Provider credential   — the SELECTED provider's, and only its.
 *  12. Consume quota         — one unit, and not before here.
 *  13. Provider call         — finite timeout, bounded retries, no retry
 *                              after a timeout.
 *  14. Strict parse          — unusable ⇒ refund + neutral 500.
 *
 * Steps 1–11 can only fail *before* a unit is spent, so a malformed request, a
 * foreign paper, an oversized library, a stale client and a misconfigured
 * deployment are all free. The credential check MOVED from before model
 * selection to after it (AI-MULTI-PROVIDER-001C) because which credential to
 * check is now a consequence of which provider was selected — but it stayed on
 * the free side of the quota boundary, which is the property that mattered.
 * Steps 9 and 10 cannot fail the request at all — every problem they meet
 * resolves to the system default or to a bounded provider-default reasoning
 * fallback — and they cost neither a quota unit nor a provider request.
 *
 * ## Provider failure is never a Paperlume paywall
 *
 * A Google 429/403/5xx is a provider-side limit on a shared project, not this
 * user's plan being exhausted. It stays an HTTP 500 with a neutral message and a
 * machine-readable class from `_shared/providerError.ts` — exactly as
 * `analyze-paper` does — while an actual Paperlume quota wall is the structured
 * 402. Conflating them would tell a paying user they were out of requests
 * because Google was busy.
 */

import {
  formatModelRoutingLog,
  resolveEffectiveAiModel,
  type AiModelSelectionClient,
} from "../_shared/aiModelSelection.ts";
import {
  generateWithRegisteredAiProvider,
  type RegisteredAiProvider,
} from "../_shared/aiProviderRegistry.ts";
import { resolveAiProviderCredential } from "../_shared/aiProviderCredentials.ts";
import {
  formatReasoningPolicyLog,
  resolveAiReasoningPolicy,
} from "../_shared/aiReasoningPolicy.ts";
import { classifyProviderError, type ProviderErrorClass } from "../_shared/providerError.ts";
import type { AiProviderModel, AiProviderResult } from "../_shared/aiProvider.ts";
import {
  NEUTRAL_SUGGESTIONS_UNAVAILABLE_MESSAGE,
  PAPER_NOT_FOUND_MESSAGE,
  type OrganizationSuggestions,
  type OwnedProject,
  type OwnedTag,
  MAX_PROJECTS,
  MAX_TAGS,
} from "./contract.ts";
import { buildProviderInput, buildSuggestGenerationRequest } from "./prompt.ts";
import { parseSuggestionsResponse } from "./parse.ts";
import { validateSuggestRequest } from "./validation.ts";

export const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const jsonHeaders = { ...corsHeaders, "Content-Type": "application/json" };

// ── Injected dependencies ─────────────────────────────────────────────────

/**
 * The minimal shape of the caller-scoped (anon key + caller bearer token)
 * client — and deliberately the *entire* database surface this function has.
 *
 * There is no `insert`, `update`, `upsert` or `delete` here. A future edit that
 * tried to write a Project, a Tag or an assignment would not type-check against
 * this interface, which is a stronger guarantee than a comment asking it not to.
 *
 * Model selection (step 9) reads `user_ai_preferences` and `ai_model_catalog`
 * through this same surface, so it too is structurally read-only — it cannot
 * grant an entitlement or edit the catalog it is checking against.
 */
export interface TableQuery {
  eq(column: string, value: string): TableQuery;
  limit(count: number): PromiseLike<{ data: Record<string, unknown>[] | null; error: unknown }>;
  maybeSingle(): PromiseLike<{ data: Record<string, unknown> | null; error: unknown }>;
}

export interface CallerClient {
  auth: {
    getUser(): Promise<{
      data: { user: { id?: unknown } | null } | null;
      error: unknown;
    }>;
  };
  from(table: string): { select(columns: string): TableQuery };
  rpc(
    fn: string,
    args: Record<string, unknown>,
  ): PromiseLike<{ data: unknown; error: { message: string } | null }>;
}

export interface SuggestOrganizationDeps {
  /** Build a client bound to the caller's `Authorization` header. */
  createCallerClient(authHeader: string): CallerClient;
  /** Injected so the retry/backoff policy is exercised by tests, not mocked around. */
  fetchImpl(url: string, init: RequestInit): Promise<Response>;
  /** Injected so tests never spend real wall-clock time on backoff. */
  sleep(ms: number): Promise<void>;
  /**
   * Injected so a test can assert the configured per-attempt timeout without
   * waiting for it. `index.ts` leaves this unset and the shared transport uses
   * the platform `AbortSignal.timeout`.
   */
  createTimeoutSignal?(ms: number): AbortSignal;
  /**
   * Read ONE named environment variable — the credential for whichever provider
   * this request resolved to (AI-MULTI-PROVIDER-001C).
   *
   * Replaces the previous `getGeminiApiKey()`, which was correct while Google
   * was the only registered provider and is a hazard now that three are: a
   * request routed to Anthropic while still reading Google's variable would put
   * PaperLume's Gemini key in a header addressed to another provider.
   *
   * Deliberately takes a NAME and returns one value, rather than handing the
   * handler a bag of secrets. The handler never chooses the name — that comes
   * from the reviewed provider→credential mapping — and a test can prove that
   * exactly one variable was read, and which.
   */
  getProviderCredential(envName: string): string | null;
  /**
   * Paperlume's SYSTEM DEFAULT model, as provider AND model metadata, resolved
   * by `index.ts` through the shared `_shared/aiProviderRegistry.ts` (which in
   * turn resolves `GEMINI_MODEL` through `_shared/geminiModel.ts`), so this
   * function and `analyze-paper` cannot disagree about the default.
   *
   * Provider/model metadata rather than a bare model string since
   * AI-MULTI-PROVIDER-001A (C39): the handler no longer assumes the default is
   * Google, it just routes to whatever registered provider the default names.
   *
   * This is the starting point and the safe fallback, NOT necessarily the model
   * used: step 9b re-checks the caller's entitlement and may route the request
   * to their saved preference via `_shared/aiModelSelection.ts`. It is
   * deliberately not a "get the model for this user" dependency — resolving the
   * per-user model needs the caller-scoped client and the authenticated id, so
   * it happens inside the handler where both are already established and where
   * the tests can exercise it.
   */
  getSystemDefaultModel(): AiProviderModel<RegisteredAiProvider>;
  /** Injected so tests can assert exactly what is (and is not) logged. */
  logger?: { log(message: string): void; warn(message: string): void; error(message: string): void };
}

function fail(status: number, error: string, message: string, extra?: Record<string, unknown>): Response {
  return new Response(JSON.stringify({ error, message, ...extra }), { status, headers: jsonHeaders });
}

// ── Quota ─────────────────────────────────────────────────────────────────

/**
 * Best-effort refund of the one unit consumed for this attempt.
 *
 * Swallows every error, exactly as `analyze-paper` does, so a refund-side
 * problem can never replace the provider failure the user actually needs to
 * see. `refund_ai_quota` is itself tolerant (`GREATEST(used - 1, 0)`, and a
 * no-op when the counter row is missing), so the two layers compose.
 */
async function safeRefund(
  client: CallerClient,
  userId: string,
  logger: NonNullable<SuggestOrganizationDeps["logger"]>,
): Promise<void> {
  try {
    const { error } = await client.rpc("refund_ai_quota", { p_user_id: userId });
    if (error) logger.error("suggest-organization refund_failed rpc_error=1");
  } catch {
    logger.error("suggest-organization refund_failed threw=1");
  }
}

// ── Provider transport ────────────────────────────────────────────────────

/**
 * Map one bounded adapter failure onto this function's existing provider-error
 * class and log detail. Nothing here is provider-specific — the adapter has
 * already reduced Google's outcome to a kind and, for HTTP, a status.
 *
 * The 2xx kinds stay distinct on purpose, exactly as before 001A:
 *
 *   * `unreadable_response` — a 200 whose body is not JSON at all. An unusable
 *     *response*, not a transport failure, so it is `parse` and is not retried.
 *   * `empty` — a well-formed envelope with no generated text.
 *   * `incomplete_response` — a readable envelope in which the provider itself
 *     reports the generation did not finish. AI-MULTI-PROVIDER-001B added this
 *     kind for the Anthropic and OpenAI adapters, so Google cannot produce it and
 *     nothing about this function's current behaviour changes. The branch is
 *     written now anyway: `classifyProviderFailure` had a catch-all tail, and a
 *     kind that fell through it would have been classified by accident rather
 *     than by decision. It maps to `malformed_response` — the same class as an
 *     unreadable body — because the defining case is a provider that answered
 *     with a truncated or abandoned generation, which is an unusable response
 *     rather than a provider-availability problem, and retrying an answer our
 *     own output ceiling cut short would not help. 001C set that ceiling per
 *     operation (Suggest: 8192) and kept this classification; revisit it when
 *     it sets the real output budget.
 *
 * The retry/timeout policy behind all of this remains
 * `_shared/geminiTransport.ts`'s, which the Google adapter calls: one policy
 * for both Gemini callers, so they cannot drift in how long they wait for
 * Google or how often they ask.
 */
function classifyProviderFailure(
  failure: Extract<AiProviderResult, { ok: false }>,
): { providerClass: ProviderErrorClass; detail: string } {
  if (failure.kind === "http") {
    return {
      providerClass: classifyProviderError({ kind: "http", status: failure.status }),
      detail: `http_${failure.status}`,
    };
  }
  if (failure.kind === "unreadable_response") {
    return { providerClass: classifyProviderError({ kind: "parse" }), detail: "parse" };
  }
  if (failure.kind === "empty") {
    return { providerClass: classifyProviderError({ kind: "empty" }), detail: "empty" };
  }
  if (failure.kind === "incomplete_response") {
    return { providerClass: classifyProviderError({ kind: "parse" }), detail: "incomplete" };
  }
  return { providerClass: classifyProviderError({ kind: failure.kind }), detail: failure.kind };
}

// ── Taxonomy loading ──────────────────────────────────────────────────────

/**
 * Read the caller's own Projects/Tags.
 *
 * Two independent guards: the query is filtered on `user_id`, and it runs under
 * the caller's own RLS through the anon-key client. No elevated key exists in
 * this function, so a foreign row is unreachable even if the filter were wrong.
 *
 * `limit(max + 1)` is how overflow is *detected* rather than silently applied —
 * one row past the supported size is enough to know, and the request then fails
 * honestly instead of comparing the paper against part of the library.
 */
async function loadProjects(
  client: CallerClient,
  userId: string,
): Promise<{ ok: true; projects: OwnedProject[] } | { ok: false }> {
  const { data, error } = await client
    .from("projects")
    .select("id,name,description")
    .eq("user_id", userId)
    .limit(MAX_PROJECTS + 1);
  if (error || !Array.isArray(data)) return { ok: false };

  const projects: OwnedProject[] = [];
  for (const row of data) {
    if (typeof row.id !== "string" || typeof row.name !== "string") return { ok: false };
    projects.push({
      id: row.id,
      name: row.name,
      description: typeof row.description === "string" ? row.description : null,
    });
  }
  return { ok: true, projects };
}

async function loadTags(
  client: CallerClient,
  userId: string,
): Promise<{ ok: true; tags: OwnedTag[] } | { ok: false }> {
  const { data, error } = await client
    .from("tags")
    .select("id,name")
    .eq("user_id", userId)
    .limit(MAX_TAGS + 1);
  if (error || !Array.isArray(data)) return { ok: false };

  const tags: OwnedTag[] = [];
  for (const row of data) {
    if (typeof row.id !== "string" || typeof row.name !== "string") return { ok: false };
    tags.push({ id: row.id, name: row.name });
  }
  return { ok: true, tags };
}

// ── Handler ───────────────────────────────────────────────────────────────

export async function handleSuggestOrganizationRequest(
  req: Request,
  deps: SuggestOrganizationDeps,
): Promise<Response> {
  const logger = deps.logger ?? console;

  // 1. CORS preflight — answered before auth and before anything else.
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  // 2. POST only.
  if (req.method !== "POST") {
    return fail(405, "method_not_allowed", "This endpoint accepts POST only.");
  }

  try {
    // 3. Bearer credential required.
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return fail(401, "unauthenticated", "You must be signed in to request suggestions.");
    }

    // 4. Authoritative validation of the caller. `getUser()` is a network check
    //    against the Auth server, not a local decode, and the resulting id is
    //    the only identity this function will ever use. No request field can
    //    name a user: `validateSuggestRequest` reads exactly `paperId`,
    //    `draft`, `currentProjectIds` and `currentTagIds`, and nothing below
    //    consults the body for an identity.
    const client = deps.createCallerClient(authHeader);
    const { data: authData, error: authError } = await client.auth.getUser();
    const userId = authData?.user?.id;
    if (authError || typeof userId !== "string" || userId === "") {
      return fail(401, "unauthenticated", "You must be signed in to request suggestions.");
    }

    // 5. Request validation — before any database read, any quota unit and any
    //    provider work.
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return fail(400, "invalid_request", "A JSON request body is required.");
    }

    const validation = validateSuggestRequest(body);
    if (!validation.ok) {
      logger.log(`suggest-organization outcome=invalid_request reason=${validation.reason}`);
      return fail(400, "invalid_request", validation.message, { reason: validation.reason });
    }
    const { paperId, draft, currentProjectIds, currentTagIds } = validation.request;

    // 6. Paper ownership. Possession of a UUID is not ownership: the row must be
    //    the caller's. Missing and foreign are answered identically so the
    //    response never confirms that someone else's paper exists.
    const { data: paperRow, error: paperError } = await client
      .from("papers")
      .select("id")
      .eq("id", paperId)
      .eq("user_id", userId)
      .maybeSingle();
    if (paperError) {
      logger.error("suggest-organization paper_lookup_failed");
      return fail(500, "internal_error", "Something went wrong. Please try again.");
    }
    if (!paperRow || typeof paperRow.id !== "string") {
      logger.log("suggest-organization outcome=paper_not_found");
      return fail(404, "paper_not_found", PAPER_NOT_FOUND_MESSAGE);
    }

    // 7. The caller's complete taxonomy, read under their own identity.
    const projectsResult = await loadProjects(client, userId);
    if (!projectsResult.ok) {
      logger.error("suggest-organization taxonomy_load_failed entity=projects");
      return fail(500, "internal_error", "Something went wrong. Please try again.");
    }
    const tagsResult = await loadTags(client, userId);
    if (!tagsResult.ok) {
      logger.error("suggest-organization taxonomy_load_failed entity=tags");
      return fail(500, "internal_error", "Something went wrong. Please try again.");
    }

    // 8. Provider input — allow-listed fields only, ephemeral refs, size bound,
    //    and the fail-closed check of the client's "already selected" claims.
    const built = buildProviderInput({
      draft,
      projects: projectsResult.projects,
      tags: tagsResult.tags,
      currentProjectIds: currentProjectIds ?? [],
      currentTagIds: currentTagIds ?? [],
    });
    if (!built.ok) {
      logger.log(
        `suggest-organization outcome=input_rejected reason=${built.reason} ` +
          `projects=${projectsResult.projects.length} tags=${tagsResult.tags.length}`,
      );
      return fail(400, "invalid_request", built.message, { reason: built.reason });
    }

    // 9a. Which model will this request use? AI-MODEL-SELECTION-001B (C33).
    //
    //     The last pre-provider boundary that is still BEFORE the quota unit is
    //     spent, and it spends nothing itself: no quota, no provider request.
    //     Every failure mode inside the resolver — an access RPC error, a
    //     missing/disabled catalog row, a provider with no adapter — falls back
    //     to the system default rather than failing this request, so a metadata
    //     problem can never cost the user a suggestion.
    //
    //     Entitlement is re-proven HERE, on this request, through the caller's
    //     own client: a saved preference deliberately survives a downgrade as a
    //     dormant row, so its existence is never treated as permission. The
    //     request body cannot influence any of it — `validateSuggestRequest`
    //     reads exactly `paperId`, `draft`, `currentProjectIds` and
    //     `currentTagIds`, and `userId` here is the `getUser()` identity.
    const systemDefault = deps.getSystemDefaultModel();
    const modelSelection = await resolveEffectiveAiModel({
      client: client as AiModelSelectionClient,
      userId,
      systemDefault,
      label: "suggest-organization",
      logger,
    });

    // 9b. How hard should this request think? AI-MULTI-PROVIDER-001C (C41).
    //
    //     PaperLume's own reasoning policy for THIS model and THIS operation,
    //     resolved from the server-controlled catalog and the caller's saved
    //     preference — never inherited from whatever the provider currently
    //     defaults to. Like model selection it spends nothing and cannot fail
    //     the request: unusable policy metadata degrades to a bounded
    //     provider-default fallback rather than costing the user a suggestion.
    //
    //     Organization suggestions take the HIGHER Automatic level of the two
    //     operations (medium on every current model, against analyze's
    //     minimal/low) because this one weighs a whole library rather than
    //     extracting three fields from one abstract.
    const reasoningDecision = await resolveAiReasoningPolicy({
      client: client as AiModelSelectionClient,
      operation: "suggest",
      selection: modelSelection,
      label: "suggest-organization",
      logger,
    });

    // 9c. The SELECTED PROVIDER's credential, and only its.
    //
    //     Still checked BEFORE the quota unit is spent, so a misconfigured
    //     deployment costs the user nothing and needs no refund — the property
    //     this function has always had. What changed is only WHICH variable is
    //     read: the name comes from the one reviewed provider→credential
    //     mapping, applied to the provider step 9a actually resolved.
    //
    //     The log line names the missing ENVIRONMENT VARIABLE and never a
    //     value. Without the name a misconfigured deployment is undiagnosable;
    //     the name itself is not a secret. The user still sees the same neutral
    //     internal-error message as before.
    const credential = resolveAiProviderCredential(
      modelSelection.provider,
      (name) => deps.getProviderCredential(name),
    );
    if (!credential.ok) {
      logger.error(`suggest-organization provider_key_missing env=${credential.envName}`);
      return fail(500, "internal_error", "Something went wrong. Please try again.");
    }

    // 9d. Consume exactly one unit of the EXISTING Paperlume AI quota, through
    //     the caller-authenticated client so the RPC's `auth.uid()` guard sees
    //     the right user. The RPC is the enforcement authority: this code reads
    //     its `allowed` flag and does no quota arithmetic of its own, which is
    //     also why the owner/manager `ai_quota_exempt` grant keeps working here
    //     without this function knowing anything about internal roles.
    const { data: quotaData, error: quotaError } = await client.rpc("consume_ai_quota", {
      p_user_id: userId,
    });
    if (quotaError) {
      logger.error("suggest-organization quota_rpc_error");
      return fail(500, "internal_error", "Something went wrong. Please try again.");
    }
    const quotaRow = (Array.isArray(quotaData) ? quotaData[0] : quotaData) as
      | Record<string, unknown>
      | null
      | undefined;
    if (!quotaRow || quotaRow.allowed !== true) {
      const reason = (typeof quotaRow?.reason === "string" ? quotaRow.reason : "quota_exceeded");
      logger.log(`suggest-organization outcome=quota_denied reason=${reason}`);
      // 402 is the Paperlume paywall, and only the Paperlume paywall. A provider
      // limit never reaches this branch — see the 500 path below.
      return new Response(
        JSON.stringify({
          error: "quota_exceeded",
          message: reason === "quota_exceeded"
            ? "AI quota exceeded."
            : `AI suggestions are not available (${reason}).`,
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

    // 10. The provider call. From here on, every failure path refunds.
    //
    //     The model is the ONLY thing per-user selection changes: the request
    //     content, the credential, the transport policy, the parse and the
    //     refund rule are identical for the system default and for an honoured
    //     preference.
    //
    //     The adapter lookup is total by construction — `resolveEffectiveAiModel`
    //     can only name a provider the runtime registry has a reviewed adapter
    //     for (AI-MULTI-PROVIDER-001A, C39) — so there is no lookup failure to
    //     turn into a user-visible error, and a catalog row naming an
    //     unimplemented provider was already resolved to the system default one
    //     step above rather than reaching this line.
    // One bounded routing line: operation, source, provider, public model name.
    // No user id, no paper id, no draft content, no Projects/Tags, no key.
    logger.log(formatModelRoutingLog("suggest-organization", modelSelection));
    // One bounded reasoning line: operation, who decided, the concrete public
    // level, and PaperLume's output ceiling.
    logger.log(formatReasoningPolicyLog("suggest-organization", "suggest", reasoningDecision));

    // Provider-neutral: the system instruction, the serialized allow-listed
    // input, the demand for JSON, and PaperLume's reasoning/output policy. The
    // endpoint, the request envelope, the credential header, how that policy is
    // spelled and the response envelope are the adapter's.
    const call = await generateWithRegisteredAiProvider(
      modelSelection,
      buildSuggestGenerationRequest(built.serialized),
      reasoningDecision.policy,
      {
        apiKey: credential.apiKey,
        label: "suggest-organization",
        fetchImpl: deps.fetchImpl,
        sleep: deps.sleep,
        createTimeoutSignal: deps.createTimeoutSignal,
        logger,
      },
    );

    let providerClass: ProviderErrorClass | null = null;
    let suggestions: OrganizationSuggestions | null = null;
    let failureDetail = "";

    if (!call.ok) {
      const failure = classifyProviderFailure(call);
      providerClass = failure.providerClass;
      failureDetail = failure.detail;
    } else if (call.text.trim() === "") {
      // Generated text that is only whitespace is an empty answer rather than
      // something to parse — the judgement this function has always made, kept
      // on this side of the seam because "is this answer usable?" is product
      // semantics while "did the provider return text?" is the adapter's.
      providerClass = classifyProviderError({ kind: "empty" });
      failureDetail = "empty";
    } else {
      // 11. Strict parse. A structurally valid response with four empty arrays
      //     is a SUCCESS, not a failure: "nothing here fits" is a real answer,
      //     and refunding it would be paying users to ask about papers that do
      //     not need organizing.
      const parsed = parseSuggestionsResponse(call.text, built.refMap);
      if (!parsed.ok) {
        providerClass = classifyProviderError({ kind: "parse" });
        failureDetail = parsed.detail;
      } else {
        suggestions = parsed.suggestions;
      }
    }

    if (suggestions === null) {
      // Best-effort refund — the user did not receive a usable result. Its own
      // failure is logged separately and never replaces the provider outcome.
      await safeRefund(client, userId, logger);
      logger.error(
        `suggest-organization outcome=provider_failure class=${providerClass} ` +
          `detail=${failureDetail} provider_attempts=${call.attempts} refund=attempted`,
      );
      return fail(500, "suggestions_unavailable", NEUTRAL_SUGGESTIONS_UNAVAILABLE_MESSAGE, {
        code: providerClass,
      });
    }

    logger.log(
      `suggest-organization outcome=ok provider_attempts=${call.attempts} ` +
        `projects_in=${projectsResult.projects.length} ` +
        `tags_in=${tagsResult.tags.length} existing_projects=${suggestions.existingProjects.length} ` +
        `existing_tags=${suggestions.existingTags.length} new_projects=${suggestions.newProjects.length} ` +
        `new_tags=${suggestions.newTags.length}`,
    );
    return new Response(JSON.stringify(suggestions), { status: 200, headers: jsonHeaders });
  } catch (error) {
    // The message originates in this function's own code paths; provider bodies
    // and URLs stay inside the provider adapter (`_shared/googleAiProvider.ts`),
    // which returns only generated text or a bounded failure kind, and never
    // reach here.
    logger.error(
      `suggest-organization error: ${error instanceof Error ? error.message : "Unknown error"}`,
    );
    return fail(500, "internal_error", "Something went wrong. Please try again.");
  }
}
