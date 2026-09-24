// Server-only AI-quota refund — SEC-AI-QUOTA-REFUND-AUTHORITY-001 (C47).
//
// Gives back the one `ai_analysis` unit a generation function consumed for an
// attempt that then failed to deliver. Shared by `analyze-paper` and
// `suggest-paper-organization`, so the two cannot drift in how they refund,
// which client they refund through, or what they log.
//
// ## Why a refund is the server's, and consumption is not
//
// Consuming a unit is something a caller may always do to themselves, so
// `consume_ai_quota` stays on the caller's own client and keeps its
// `auth.uid()` guard. Giving a unit BACK is different: if the caller can do it,
// the caller can do it whenever they like, and the quota stops bounding
// anything. Until C47, `refund_ai_quota` was granted to `authenticated` because
// both functions refunded through the caller-scoped client — which also let any
// signed-in browser call it directly and reset its own counter. The database
// now grants the refund to `service_role` only, and this module is the one way
// the Edge runtime reaches it.
//
// ## The elevated client, and why it is a separate one
//
// `createAiQuotaRefundClient` builds a client from the platform-injected secret
// key through the same `selectEdgeSecretKey` rule `delete-account` and the
// usage-telemetry writer use (`SUPABASE_SECRET_KEYS["default"]`, then the legacy
// `SUPABASE_SERVICE_ROLE_KEY`), so no manually managed secret is involved. It
// carries NO caller Authorization header and no session: the request is the
// server's own, which is the point. Its type exposes one call —
// `rpc("refund_ai_quota", { p_user_id })` — and nothing else, and it is NOT the
// telemetry writer's client: that one is insert-only on one table, and widening
// it to call an RPC would widen every holder of it.
//
// ## Best-effort, and never a replacement for the real failure
//
// A refund runs only after the attempt has already failed, and the user must see
// THAT failure. `refundAiQuotaUnit` therefore never throws and never rejects:
// a missing key, an RPC error and a thrown fetch are each one bounded log line
// and a returned outcome. There is no fallback to the caller's client — that
// fallback would be the defect C47 closes.
//
// The user id comes from the caller of this module, which must pass the
// identity its own `auth.getUser()` authenticated. Nothing here reads a request.
//
// Pure module: no Deno APIs, no remote imports. The Edge shells inject
// `createClient`, the environment reader and `fetch`.

import { selectEdgeSecretKey } from "./edgeSecretKey.ts";

/** The one database function this module may call. */
export const AI_QUOTA_REFUND_RPC = "refund_ai_quota";

/** Upper bound on one refund call, so a slow database cannot hold the failure response. */
export const AI_QUOTA_REFUND_TIMEOUT_MS = 5_000;

/**
 * The entire database surface the refund client exposes: one RPC, one
 * argument. No `from`, no `auth`, no other function name — a later edit that
 * tried to read or write anything else through it would not type-check.
 */
export interface AiQuotaRefundClient {
  rpc(
    fn: typeof AI_QUOTA_REFUND_RPC,
    args: { readonly p_user_id: string },
  ): PromiseLike<{ error: unknown }>;
}

/** The only options the refund client is ever built with. */
export interface AiQuotaRefundClientOptions {
  readonly auth: {
    readonly persistSession: false;
    readonly autoRefreshToken: false;
    readonly detectSessionInUrl: false;
  };
  readonly global: {
    readonly fetch: (resource: string | URL | Request, init?: RequestInit) => Promise<Response>;
  };
}

export interface AiQuotaRefundClientFactoryInput {
  readonly supabaseUrl: string;
  /** Reads one platform-injected variable; the elevated key never passes through a caller. */
  readonly readEnv: (name: string) => string | undefined | null;
  /** `createClient` from supabase-js, injected so this stays pure. */
  readonly createSupabaseClient: (url: string, key: string, options: AiQuotaRefundClientOptions) => unknown;
  readonly fetchImpl?: (resource: string | URL | Request, init?: RequestInit) => Promise<Response>;
  readonly createTimeoutSignal?: (ms: number) => AbortSignal;
}

/**
 * Build the refund client from the platform-injected secret key, or return
 * `null` when neither key is available — never an unprivileged client, which
 * the database would now refuse anyway.
 *
 * The key itself is never returned, logged, or handed to anything but
 * `createSupabaseClient`.
 */
export function createAiQuotaRefundClient(
  input: AiQuotaRefundClientFactoryInput,
): AiQuotaRefundClient | null {
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
          signal: init?.signal ?? createTimeoutSignal(AI_QUOTA_REFUND_TIMEOUT_MS),
        }),
    },
  }) as AiQuotaRefundClient;
}

export type AiQuotaRefundOutcome =
  | "completed"
  | "invalid_user"
  | "no_server_key"
  | "rpc_error"
  | "threw";

export interface AiQuotaRefundDeps {
  /** Log prefix, e.g. `"analyze-paper"`. */
  readonly label: string;
  readonly logger: { error(message: string): void };
  /**
   * Build the refund client, lazily — only when a refund is actually needed.
   * Returns `null` when no server key is available.
   */
  readonly createClient: () => AiQuotaRefundClient | null;
}

/** The shape every authenticated Supabase user id has. */
const USER_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Refund one unit for `userId` through the server-only client. NEVER throws and
 * never rejects; the caller's own response is unaffected whatever happens here.
 *
 * `completed` means the RPC ran without an error — including its own tolerant
 * `refunded = false` answer for a missing counter, which is not a failure worth
 * logging. Every other outcome is one bounded log line naming the operation's
 * label and the class of failure, never a user id, a key, or the database's own
 * message (arbitrary text from outside this function).
 */
export async function refundAiQuotaUnit(
  userId: string,
  deps: AiQuotaRefundDeps,
): Promise<AiQuotaRefundOutcome> {
  const { label, logger } = deps;
  try {
    if (typeof userId !== "string" || !USER_ID_PATTERN.test(userId)) {
      logger.error(`${label} refund_failed invalid_user=1`);
      return "invalid_user";
    }

    let client: AiQuotaRefundClient | null;
    try {
      client = deps.createClient();
    } catch {
      // A factory that throws (e.g. a missing SUPABASE_URL) says nothing about
      // the refund worth quoting; its message is not logged.
      logger.error(`${label} refund_failed threw=1`);
      return "threw";
    }
    if (client === null) {
      logger.error(`${label} refund_failed no_server_key=1`);
      return "no_server_key";
    }

    let error: unknown;
    try {
      ({ error } = await client.rpc(AI_QUOTA_REFUND_RPC, { p_user_id: userId }));
    } catch {
      // A thrown fetch error can quote the URL; nothing of it is logged.
      logger.error(`${label} refund_failed threw=1`);
      return "threw";
    }
    if (error) {
      logger.error(`${label} refund_failed rpc_error=1`);
      return "rpc_error";
    }
    return "completed";
  } catch {
    // Unreachable by construction; kept so a future edit above can never turn a
    // refund problem into an operation failure.
    try {
      logger.error(`${label} refund_failed threw=1`);
    } catch {
      // A logger that throws is not this function's problem to report.
    }
    return "threw";
  }
}
