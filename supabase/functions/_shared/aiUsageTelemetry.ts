// Server-trusted AI provider usage telemetry — AI-MULTI-PROVIDER-001D.
//
// Turns ONE provider-call sequence into ONE durable, content-free event row and
// writes it through the narrowest server path this architecture has. Shared by
// `analyze-paper` and `suggest-paper-organization`, so the two cannot drift in
// what they record or how.
//
// ## What one event is
//
// One PaperLume operation that reached a provider — one call to
// `generateWithRegisteredAiProvider` — whatever happened next. `provider_attempts`
// inside it counts the real HTTP requests that sequence made, so "one user
// action" and "N provider requests" stay distinguishable if retries return.
// Nothing is recorded for a request refused before the provider (auth, body,
// ownership, quota 402, missing credential): those are not provider usage.
//
// ## What is persisted — and what cannot be
//
// The row type below IS the privacy boundary. Its only strings are the server
// user id, bounded enums, the public provider/model names, a price-record id and
// decimal rates. There is no field that could hold a prompt, a title, an
// abstract, a Project or Tag, generated text, a provider body, an error message,
// an email, a token or a key — and the database enforces the same shapes with
// CHECK constraints, so a later edit cannot widen it quietly on either side.
//
// ## Observational, never a gate
//
// Telemetry runs after the operation has decided its outcome, and
// `recordAiProviderUsage` never throws. A failed write is one bounded log line,
// nothing else: a paid-for generation is never discarded, and a provider
// failure is never shadowed, because a telemetry table said no. A stricter
// "no record, no generation" gate would be a spending-control decision, not
// this foundation's.
//
// ## The elevated key
//
// Browsers must not be able to write telemetry — an RLS policy proving
// `user_id = auth.uid()` proves ownership, not truthfulness — so the writer is
// the server. `createAiUsageEventInsertClient` builds the one elevated client
// either generation function holds, from the platform-injected secret key, with
// no caller Authorization header and no session. Its type exposes
// `from(<telemetry table>).insert()` and nothing else, and the database grants
// that role INSERT on this one table and nothing else on it. Model selection,
// entitlement, quota and every product read keep using the caller's own client.
//
// Pure module: no Deno APIs, no remote imports. The Edge shells inject
// `createClient`, the environment reader and `fetch`.

import { aiUsageStatus, aiUsageTokensOrNull, type AiUsageStatus } from "./aiUsage.ts";
import { estimateAiListPriceCost, type AiCostStatus } from "./aiCostEstimate.ts";
import type { AiListPriceRecord } from "./aiPriceBook.ts";
import type { AiProviderResult, AiReasoningLevel } from "./aiProvider.ts";
import type { AiModelSelection, AiModelSelectionSource } from "./aiModelSelection.ts";
import type {
  AiOperation,
  AiReasoningPolicyDecision,
  AiReasoningPolicySource,
} from "./aiReasoningPolicy.ts";
import { selectEdgeSecretKey } from "./edgeSecretKey.ts";

/** The one relation this module may write. */
export const AI_PROVIDER_USAGE_EVENTS_TABLE = "ai_provider_usage_events";

/**
 * The semantics version of a row: the usage mapping, the cost statuses and the
 * estimate formula together. The database accepts exactly this value, so a
 * semantic change needs a migration that says so.
 */
export const AI_USAGE_TELEMETRY_VERSION = 1;

/** Upper bound on one telemetry write, so a slow database cannot hold a response. */
export const AI_USAGE_WRITE_TIMEOUT_MS = 5_000;

/** The largest attempt count a row accepts — far above any transport budget. */
export const AI_USAGE_MAX_RECORDED_ATTEMPTS = 10;

/** The adapter's bounded outcome, spelled for storage. */
export type AiProviderOutcome =
  | "completed"
  | "http_error"
  | "network_error"
  | "timeout"
  | "unreadable_response"
  | "empty_response"
  | "incomplete_response";

/**
 * Whether the USER got a result. Separate from the provider outcome on purpose:
 * a provider can complete and PaperLume still fail to use the answer (an
 * unparseable response), which is exactly the case where the provider's usage
 * must still be recorded.
 */
export type AiOperationOutcome = "succeeded" | "failed";

/** Exactly the columns an event is inserted with. `id` and `recorded_at` are the database's. */
export interface AiProviderUsageEventRow {
  readonly occurred_at: string;
  readonly user_id: string;
  readonly telemetry_version: typeof AI_USAGE_TELEMETRY_VERSION;
  readonly operation: AiOperation;
  readonly provider: string;
  readonly provider_model: string;
  readonly model_selection_source: AiModelSelectionSource;
  readonly reasoning_source: AiReasoningPolicySource;
  readonly resolved_reasoning_level: AiReasoningLevel | null;
  readonly provider_outcome: AiProviderOutcome;
  readonly provider_http_status: number | null;
  readonly provider_attempts: number;
  readonly operation_outcome: AiOperationOutcome;
  readonly usage_status: AiUsageStatus;
  readonly input_tokens: number | null;
  readonly cached_input_tokens: number | null;
  readonly cache_write_input_tokens: number | null;
  readonly output_tokens: number | null;
  readonly reasoning_output_tokens: number | null;
  readonly provider_total_tokens: number | null;
  readonly has_unmodeled_usage: boolean;
  readonly cost_status: AiCostStatus;
  readonly list_price_estimate_usd: string | null;
  readonly price_record_id: string | null;
  readonly input_usd_per_mtok: string | null;
  readonly cached_input_usd_per_mtok: string | null;
  readonly cache_write_input_usd_per_mtok: string | null;
  readonly output_usd_per_mtok: string | null;
}

export function aiProviderOutcome(call: AiProviderResult): AiProviderOutcome {
  if (call.ok) return "completed";
  switch (call.kind) {
    case "http":
      return "http_error";
    case "network":
      return "network_error";
    case "timeout":
      return "timeout";
    case "unreadable_response":
      return "unreadable_response";
    case "empty":
      return "empty_response";
    case "incomplete_response":
      return "incomplete_response";
    default: {
      const unreachable: never = call.kind;
      return unreachable;
    }
  }
}

export interface AiProviderUsageEventInput {
  /** The authoritative `auth.getUser()` id — never anything from a request body. */
  readonly userId: string;
  readonly operation: AiOperation;
  readonly selection: Pick<AiModelSelection, "provider" | "providerModel" | "source">;
  readonly reasoning: Pick<AiReasoningPolicyDecision, "policy" | "source">;
  readonly call: AiProviderResult;
  readonly operationOutcome: AiOperationOutcome;
  readonly occurredAt: Date;
  /** Injected by tests; production always uses the shipped price book. */
  readonly priceRecords?: readonly AiListPriceRecord[];
}

// The same shapes the table's CHECK constraints enforce, checked first so a
// value the database would reject is refused here with a bounded reason.
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const AI_USAGE_PROVIDER_PATTERN = /^[a-z][a-z0-9_-]{0,31}$/;
export const AI_USAGE_PROVIDER_MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;

export type AiProviderUsageEventBuild =
  | { readonly ok: true; readonly row: AiProviderUsageEventRow }
  | { readonly ok: false; readonly reason: "invalid_event" };

/**
 * Build the row for one provider call. Pure and total: anything the table would
 * reject comes back as `invalid_event` instead of a row.
 */
export function buildAiProviderUsageEvent(input: AiProviderUsageEventInput): AiProviderUsageEventBuild {
  const invalid = { ok: false, reason: "invalid_event" } as const;
  const { call, selection } = input;

  if (typeof input.userId !== "string" || !UUID_PATTERN.test(input.userId)) return invalid;
  if (!AI_USAGE_PROVIDER_PATTERN.test(selection.provider)) return invalid;
  if (!AI_USAGE_PROVIDER_MODEL_PATTERN.test(selection.providerModel)) return invalid;
  if (!Number.isFinite(input.occurredAt.getTime())) return invalid;
  if (
    !Number.isInteger(call.attempts) ||
    call.attempts < 1 ||
    call.attempts > AI_USAGE_MAX_RECORDED_ATTEMPTS
  ) {
    return invalid;
  }
  // A result the user received requires a provider that completed.
  if (input.operationOutcome === "succeeded" && !call.ok) return invalid;

  let httpStatus: number | null = null;
  if (!call.ok && call.kind === "http") {
    if (typeof call.status !== "number" || !Number.isInteger(call.status) || call.status < 100 || call.status > 599) {
      return invalid;
    }
    httpStatus = call.status;
  }

  const usage = call.usage;
  const dims = usage.kind === "reported" ? usage.dimensions : null;
  const estimate = estimateAiListPriceCost({
    provider: selection.provider,
    providerModel: selection.providerModel,
    at: input.occurredAt,
    attempts: call.attempts,
    usage,
    priceRecords: input.priceRecords,
  });
  const reasoning = input.reasoning.policy.reasoning;

  return {
    ok: true,
    row: Object.freeze({
      occurred_at: input.occurredAt.toISOString(),
      user_id: input.userId,
      telemetry_version: AI_USAGE_TELEMETRY_VERSION,
      operation: input.operation,
      provider: selection.provider,
      provider_model: selection.providerModel,
      model_selection_source: selection.source,
      reasoning_source: input.reasoning.source,
      // What PaperLume's policy resolved. `null` exactly when no reasoning
      // parameter was sent (the provider-default fallback).
      resolved_reasoning_level: reasoning.kind === "level" ? reasoning.level : null,
      provider_outcome: aiProviderOutcome(call),
      provider_http_status: httpStatus,
      provider_attempts: call.attempts,
      operation_outcome: input.operationOutcome,
      usage_status: aiUsageStatus(usage),
      input_tokens: dims ? aiUsageTokensOrNull(dims.inputTokens) : null,
      cached_input_tokens: dims ? aiUsageTokensOrNull(dims.cachedInputTokens) : null,
      cache_write_input_tokens: dims ? aiUsageTokensOrNull(dims.cacheWriteInputTokens) : null,
      output_tokens: dims ? aiUsageTokensOrNull(dims.outputTokens) : null,
      reasoning_output_tokens: dims ? aiUsageTokensOrNull(dims.reasoningOutputTokens) : null,
      provider_total_tokens: dims ? aiUsageTokensOrNull(dims.providerTotalTokens) : null,
      has_unmodeled_usage: usage.kind === "reported" ? usage.unmodeledUsage : false,
      cost_status: estimate.status,
      list_price_estimate_usd: estimate.amountUsd,
      price_record_id: estimate.prices?.recordId ?? null,
      input_usd_per_mtok: estimate.prices?.inputUsdPerMTok ?? null,
      cached_input_usd_per_mtok: estimate.prices?.cachedInputUsdPerMTok ?? null,
      cache_write_input_usd_per_mtok: estimate.prices?.cacheWriteInputUsdPerMTok ?? null,
      output_usd_per_mtok: estimate.prices?.outputUsdPerMTok ?? null,
    }),
  };
}

// ── Persistence ───────────────────────────────────────────────────────────

/**
 * The entire database surface the telemetry writer has: INSERT into one table.
 * No select, update, delete or rpc — an edit that tried to read telemetry back
 * or touch another table through this client would not type-check.
 */
export interface AiUsageEventInsertClient {
  from(table: typeof AI_PROVIDER_USAGE_EVENTS_TABLE): {
    insert(row: AiProviderUsageEventRow): PromiseLike<{ error: unknown }>;
  };
}

export interface AiUsageTelemetryLogger {
  log(message: string): void;
  error(message: string): void;
}

export interface AiUsageTelemetryDeps {
  /** Log prefix, e.g. `"analyze-paper"`. */
  readonly label: string;
  readonly logger: AiUsageTelemetryLogger;
  /**
   * Build the insert-only client, or `null` when no server key is available.
   * Called lazily — only once a provider call has happened — and at most once.
   */
  readonly createClient: () => AiUsageEventInsertClient | null;
  /** Injected by tests; defaults to the wall clock. */
  readonly now?: () => Date;
  /** Injected by tests; production always uses the shipped price book. */
  readonly priceRecords?: readonly AiListPriceRecord[];
}

export type AiUsageRecordOutcome =
  | "recorded"
  | "invalid_event"
  | "no_server_key"
  | "write_rejected"
  | "write_failed";

/**
 * A database error's code, if it is one of the two bounded shapes a code takes.
 * Never the message, details or hint: a constraint violation's details quote the
 * failing row, and that row names the user.
 */
function boundedErrorCode(error: unknown): string {
  if (typeof error === "object" && error !== null) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string" && /^([0-9A-Z]{5}|PGRST\d{3})$/.test(code)) return code;
  }
  return "unknown";
}

/**
 * Build and persist one provider-usage event. NEVER throws and never rejects:
 * every failure becomes one bounded log line and a returned outcome, and the
 * caller's own response is unaffected whatever happens here.
 *
 * Logs name the operation, the public provider and model, the provider outcome,
 * the attempt count and the two statuses — never a user id, a token count
 * beyond what the row holds, an error message, or anything from the request.
 */
export async function recordAiProviderUsage(
  input: Omit<AiProviderUsageEventInput, "occurredAt" | "priceRecords">,
  deps: AiUsageTelemetryDeps,
): Promise<AiUsageRecordOutcome> {
  const { label, logger } = deps;
  try {
    const built = buildAiProviderUsageEvent({
      ...input,
      occurredAt: deps.now ? deps.now() : new Date(),
      priceRecords: deps.priceRecords,
    });
    if (!built.ok) {
      // Only the operation: an invalid provider or model string is exactly the
      // kind of value that must not be echoed into a log.
      logger.error(`${label} usage_telemetry recorded=0 reason=invalid_event operation=${input.operation}`);
      return "invalid_event";
    }
    const row = built.row;
    const context =
      `operation=${row.operation} provider=${row.provider} model=${row.provider_model} ` +
      `provider_outcome=${row.provider_outcome} attempts=${row.provider_attempts}`;

    let client: AiUsageEventInsertClient | null;
    try {
      client = deps.createClient();
    } catch {
      client = null;
    }
    if (client === null) {
      logger.error(`${label} usage_telemetry recorded=0 reason=no_server_key ${context}`);
      return "no_server_key";
    }

    let error: unknown;
    try {
      ({ error } = await client.from(AI_PROVIDER_USAGE_EVENTS_TABLE).insert(row));
    } catch {
      // A thrown fetch error can quote the URL; nothing of it is logged.
      logger.error(`${label} usage_telemetry recorded=0 reason=write_failed ${context}`);
      return "write_failed";
    }
    if (error) {
      logger.error(
        `${label} usage_telemetry recorded=0 reason=write_rejected code=${boundedErrorCode(error)} ${context}`,
      );
      return "write_rejected";
    }

    logger.log(
      `${label} usage_telemetry recorded=1 ${context} usage=${row.usage_status} cost=${row.cost_status}`,
    );
    return "recorded";
  } catch {
    // Unreachable by construction; kept so that a future edit above can never
    // turn a telemetry problem into an operation failure.
    try {
      logger.error(`${label} usage_telemetry recorded=0 reason=write_failed operation=${input.operation}`);
    } catch {
      // A logger that throws is not this function's problem to report.
    }
    return "write_failed";
  }
}

// ── The elevated, insert-only client ──────────────────────────────────────

/** The only options the telemetry client is ever built with. */
export interface AiUsageClientOptions {
  readonly auth: {
    readonly persistSession: false;
    readonly autoRefreshToken: false;
    readonly detectSessionInUrl: false;
  };
  readonly global: {
    readonly fetch: (resource: string | URL | Request, init?: RequestInit) => Promise<Response>;
  };
}

export interface AiUsageClientFactoryInput {
  readonly supabaseUrl: string;
  /** Reads one platform-injected variable; the elevated key never passes through a caller. */
  readonly readEnv: (name: string) => string | undefined | null;
  /** `createClient` from supabase-js, injected so this stays pure. */
  readonly createSupabaseClient: (url: string, key: string, options: AiUsageClientOptions) => unknown;
  readonly fetchImpl?: (resource: string | URL | Request, init?: RequestInit) => Promise<Response>;
  readonly createTimeoutSignal?: (ms: number) => AbortSignal;
}

/**
 * Build the telemetry writer's client from the platform-injected secret key,
 * or return `null` when neither key is available.
 *
 * The key comes from the same `selectEdgeSecretKey` rule `delete-account` uses
 * (`SUPABASE_SECRET_KEYS["default"]`, then the legacy `SUPABASE_SERVICE_ROLE_KEY`),
 * so no manually managed secret is involved. The client carries NO caller
 * Authorization header — the request is the server's own, which is the point —
 * no session, and a fetch bounded by `AI_USAGE_WRITE_TIMEOUT_MS`. It is returned
 * typed as the insert-only surface above; the key itself is never returned,
 * logged, or handed to any provider adapter.
 */
export function createAiUsageEventInsertClient(
  input: AiUsageClientFactoryInput,
): AiUsageEventInsertClient | null {
  const key = selectEdgeSecretKey(
    input.readEnv("SUPABASE_SECRET_KEYS"),
    input.readEnv("SUPABASE_SERVICE_ROLE_KEY"),
  );
  if (key === null) return null;

  const fetchImpl = input.fetchImpl ?? ((resource, init) => fetch(resource, init));
  const createTimeoutSignal =
    input.createTimeoutSignal ?? ((ms: number) => AbortSignal.timeout(ms));

  return input.createSupabaseClient(input.supabaseUrl, key, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: {
      fetch: (resource, init) =>
        fetchImpl(resource, {
          ...init,
          signal: init?.signal ?? createTimeoutSignal(AI_USAGE_WRITE_TIMEOUT_MS),
        }),
    },
  }) as AiUsageEventInsertClient;
}
