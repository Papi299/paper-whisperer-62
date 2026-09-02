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
 *  10. Consume quota         — one unit, and not before here.
 *  11. Provider call         — finite timeout, bounded retries, no retry
 *                              after a timeout.
 *  12. Strict parse          — unusable ⇒ refund + neutral 500.
 *
 * Steps 1–9 can only fail *before* a unit is spent, so a malformed request, a
 * foreign paper, an oversized library and a stale client are all free. The
 * Gemini key is checked at step 10's doorstep for the same reason: a
 * misconfigured deployment must not bill the user. Step 9 cannot fail the
 * request at all — every problem it meets resolves to the system default — and
 * it costs neither a quota unit nor a provider request.
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
  buildGeminiGenerateContentUrl,
  formatModelRoutingLog,
  resolveEffectiveAiModel,
  type AiModelSelectionClient,
} from "../_shared/aiModelSelection.ts";
import { callGeminiWithRetry } from "../_shared/geminiTransport.ts";
import { classifyProviderError, type ProviderErrorClass } from "../_shared/providerError.ts";
import {
  NEUTRAL_SUGGESTIONS_UNAVAILABLE_MESSAGE,
  PAPER_NOT_FOUND_MESSAGE,
  type OrganizationSuggestions,
  type OwnedProject,
  type OwnedTag,
  MAX_PROJECTS,
  MAX_TAGS,
} from "./contract.ts";
import { buildGeminiRequestBody, buildProviderInput } from "./prompt.ts";
import { extractProviderText, parseSuggestionsResponse } from "./parse.ts";
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
  /** Read from Deno env by `index.ts`; `null`/empty means the function is misconfigured. */
  getGeminiApiKey(): string | null;
  /**
   * Paperlume's SYSTEM DEFAULT model, resolved through the shared
   * `_shared/geminiModel.ts` from `GEMINI_MODEL`, so this function and
   * `analyze-paper` cannot disagree about the default.
   *
   * This is the starting point and the safe fallback, NOT necessarily the model
   * used: step 9b re-checks the caller's entitlement and may route the request
   * to their saved preference via `_shared/aiModelSelection.ts`. It is
   * deliberately not a "get the model for this user" dependency — resolving the
   * per-user model needs the caller-scoped client and the authenticated id, so
   * it happens inside the handler where both are already established and where
   * the tests can exercise it.
   */
  getGeminiModel(): string;
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

type ProviderCallResult =
  | { ok: true; payload: unknown; attempts: number }
  | { ok: false; kind: "http" | "network" | "timeout" | "parse"; status?: number; attempts: number };

/**
 * Call Gemini through the shared transport, then read the body.
 *
 * The retry/timeout policy itself lives in `_shared/geminiTransport.ts` —
 * AI-PROVIDER-RESILIENCE-001A moved it there because 001A changes it in BOTH
 * Gemini callers at once, which is exactly the situation the two-copy
 * arrangement was chosen to avoid. (The previous note here argued that sharing
 * would drag `analyze-paper` into this function's deploy artifact for no
 * behavioural gain; that trade-off no longer holds when the behavioural change
 * is `analyze-paper`'s too, and one shared policy is now the cheaper way to keep
 * them honest.)
 *
 * What stays here is the part that is genuinely this function's own: a 2xx whose
 * body is not JSON is an unusable *response*, not a transport failure, and is
 * classified `parse` without a retry — unchanged.
 */
async function callProvider(
  url: string,
  apiKey: string,
  body: Record<string, unknown>,
  deps: SuggestOrganizationDeps,
  logger: NonNullable<SuggestOrganizationDeps["logger"]>,
): Promise<ProviderCallResult> {
  const result = await callGeminiWithRetry(
    url,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
      body: JSON.stringify(body),
    },
    {
      label: "suggest-organization",
      fetchImpl: deps.fetchImpl,
      sleep: deps.sleep,
      createTimeoutSignal: deps.createTimeoutSignal,
      logger,
    },
  );

  if (!result.ok) {
    return { ok: false, kind: result.kind, status: result.status, attempts: result.attempts };
  }

  try {
    return { ok: true, payload: await result.response.json(), attempts: result.attempts };
  } catch {
    // A 200 whose body is not JSON is an unusable response, not a transport
    // failure — retrying it is unlikely to help.
    return { ok: false, kind: "parse", attempts: result.attempts };
  }
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

    // 9a. Configuration. Checked before the quota unit is spent so a
    //     misconfigured deployment costs the user nothing and needs no refund.
    const apiKey = deps.getGeminiApiKey();
    if (apiKey === null || apiKey.trim() === "") {
      logger.error("suggest-organization provider_key_missing");
      return fail(500, "internal_error", "Something went wrong. Please try again.");
    }

    // 9b. Which model will this request use? AI-MODEL-SELECTION-001B (C33).
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
    const systemDefaultModel = deps.getGeminiModel();
    const modelSelection = await resolveEffectiveAiModel({
      client: client as AiModelSelectionClient,
      userId,
      systemDefaultModel,
      label: "suggest-organization",
      logger,
    });

    // 9c. Consume exactly one unit of the EXISTING Paperlume AI quota, through
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
    //     The model component of this URL is the ONLY thing per-user selection
    //     changes: the request body, the `x-goog-api-key` auth with the one
    //     shared key, the transport policy, the parse and the refund rule are
    //     identical for the system default and for an honoured preference.
    const url = buildGeminiGenerateContentUrl(modelSelection);
    // One bounded routing line: operation, source, provider, public model name.
    // No user id, no paper id, no draft content, no Projects/Tags, no key.
    logger.log(formatModelRoutingLog("suggest-organization", modelSelection));

    const call = await callProvider(url, apiKey, buildGeminiRequestBody(built.serialized), deps, logger);

    let providerClass: ProviderErrorClass | null = null;
    let suggestions: OrganizationSuggestions | null = null;
    let failureDetail = "";

    if (!call.ok) {
      providerClass = classifyProviderError(
        call.kind === "http" ? { kind: "http", status: call.status } : { kind: call.kind },
      );
      failureDetail = call.kind === "http" ? `http_${call.status}` : call.kind;
    } else {
      // 11. Strict parse. A structurally valid response with four empty arrays
      //     is a SUCCESS, not a failure: "nothing here fits" is a real answer,
      //     and refunding it would be paying users to ask about papers that do
      //     not need organizing.
      const text = extractProviderText(call.payload);
      if (text === null) {
        providerClass = classifyProviderError({ kind: "empty" });
        failureDetail = "empty";
      } else {
        const parsed = parseSuggestionsResponse(text, built.refMap);
        if (!parsed.ok) {
          providerClass = classifyProviderError({ kind: "parse" });
          failureDetail = parsed.detail;
        } else {
          suggestions = parsed.suggestions;
        }
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
    // and URLs are handled and discarded inside `callProvider` and never reach
    // here.
    logger.error(
      `suggest-organization error: ${error instanceof Error ? error.message : "Unknown error"}`,
    );
    return fail(500, "internal_error", "Something went wrong. Please try again.");
  }
}
