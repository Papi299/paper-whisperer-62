// @vitest-environment node
//
// SEC-AI-QUOTA-REFUND-AUTHORITY-001 (C47) — the server-only AI-quota refund.
//
// Two layers: the elevated client factory (which key it uses, what it refuses to
// carry, and what its type lets a holder do) and the never-throwing refund call
// (what happens when the key, the RPC or the network fails). No database, no
// network. The generation functions that hold this module are executed end to
// end in `analyze-paper/__tests__/quotaRefundAuthority.test.ts` and
// `suggest-paper-organization/__tests__/handler.test.ts`.
//
// The `@ts-expect-error` block is compile-time only: `npm run typecheck` does
// not cover `supabase/functions/**` (see `aiProviderTypeBoundary.test.ts`), so it
// is checked by running `tsc` directly over the Edge code, and each directive
// fails that check (TS2578) the moment the error it expects stops occurring.
// Under Vitest the negative calls sit in a function that is never invoked.
import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  AI_QUOTA_REFUND_RPC,
  AI_QUOTA_REFUND_TIMEOUT_MS,
  createAiQuotaRefundClient,
  refundAiQuotaUnit,
  type AiQuotaRefundClient,
  type AiQuotaRefundClientOptions,
} from "../aiQuotaRefund.ts";

const USER_ID = "11111111-2222-4333-8444-555555555555";
const SECRET = "sb_secret_current_value";
const LEGACY = "legacy_service_role_value";

// ── The elevated, refund-only client ──────────────────────────────────────

describe("createAiQuotaRefundClient", () => {
  function factory(env: Record<string, string | undefined>) {
    const reads: string[] = [];
    const calls: Array<{ url: string; key: string; options: AiQuotaRefundClientOptions }> = [];
    const fetchImpl = vi.fn(async () => new Response("[]", { status: 200 }));
    const timeouts: number[] = [];
    const sentinel = { rpc: vi.fn() };
    const client = createAiQuotaRefundClient({
      supabaseUrl: "https://project.supabase.test",
      readEnv: (name) => {
        reads.push(name);
        return env[name];
      },
      createSupabaseClient: (url, key, options) => {
        calls.push({ url, key, options });
        return sentinel;
      },
      fetchImpl,
      createTimeoutSignal: (ms) => {
        timeouts.push(ms);
        return new AbortController().signal;
      },
    });
    return { client, reads, calls, fetchImpl, timeouts, sentinel };
  }

  it("returns no client — never an unprivileged one — when neither key is present", () => {
    const f = factory({});
    expect(f.client).toBeNull();
    expect(f.calls).toEqual([]);
  });

  it("prefers the current secret key, and falls back to the legacy one", () => {
    const current = factory({
      SUPABASE_SECRET_KEYS: JSON.stringify({ default: SECRET }),
      SUPABASE_SERVICE_ROLE_KEY: LEGACY,
    });
    expect(current.calls[0].key).toBe(SECRET);
    expect(factory({ SUPABASE_SERVICE_ROLE_KEY: LEGACY }).calls[0].key).toBe(LEGACY);
  });

  it("falls back safely — without throwing — when the current key is malformed or missing its default", () => {
    for (const malformed of ["{not json", "[]", JSON.stringify({ other: SECRET }), JSON.stringify({ default: "  " })]) {
      expect(() => factory({ SUPABASE_SECRET_KEYS: malformed, SUPABASE_SERVICE_ROLE_KEY: LEGACY })).not.toThrow();
      expect(factory({ SUPABASE_SECRET_KEYS: malformed, SUPABASE_SERVICE_ROLE_KEY: LEGACY }).calls[0].key).toBe(LEGACY);
      expect(factory({ SUPABASE_SECRET_KEYS: malformed }).client).toBeNull();
    }
  });

  it("reads only the two platform-injected key names — no provider credential, no caller header", () => {
    const f = factory({ SUPABASE_SERVICE_ROLE_KEY: LEGACY });
    expect(f.reads).toEqual(["SUPABASE_SECRET_KEYS", "SUPABASE_SERVICE_ROLE_KEY"]);
  });

  it("builds a sessionless client with no Authorization header of the caller's", () => {
    const f = factory({ SUPABASE_SECRET_KEYS: JSON.stringify({ default: SECRET }) });
    expect(f.client).toBe(f.sentinel);
    expect(f.calls).toHaveLength(1);
    const { url, options } = f.calls[0];
    expect(url).toBe("https://project.supabase.test");
    expect(options.auth).toEqual({ persistSession: false, autoRefreshToken: false, detectSessionInUrl: false });
    expect(Object.keys(options)).toEqual(["auth", "global"]);
    expect(Object.keys(options.global)).toEqual(["fetch"]);
    expect(JSON.stringify(options)).not.toContain("Authorization");
    expect(JSON.stringify(options)).not.toContain("headers");
  });

  it("bounds every refund call with its own timeout, and keeps a signal the caller already set", async () => {
    const f = factory({ SUPABASE_SERVICE_ROLE_KEY: LEGACY });
    await f.calls[0].options.global.fetch("https://project.supabase.test/rest/v1/rpc/refund_ai_quota", { method: "POST" });
    expect(f.timeouts).toEqual([AI_QUOTA_REFUND_TIMEOUT_MS]);
    expect(AI_QUOTA_REFUND_TIMEOUT_MS).toBe(5_000);
    const [, init] = f.fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(init.method).toBe("POST");
    expect(init.signal).toBeInstanceOf(AbortSignal);

    const own = new AbortController().signal;
    await f.calls[0].options.global.fetch("https://project.supabase.test/rest/v1/rpc/refund_ai_quota", { signal: own });
    const [, second] = f.fetchImpl.mock.calls[1] as unknown as [string, RequestInit];
    expect(second.signal).toBe(own);
  });

  it("never returns the key itself", () => {
    const f = factory({ SUPABASE_SECRET_KEYS: JSON.stringify({ default: SECRET }) });
    expect(JSON.stringify(f.client)).not.toContain(SECRET);
    expect(f.client).not.toBe(SECRET);
  });
});

// ── The never-throwing refund ─────────────────────────────────────────────

describe("refundAiQuotaUnit", () => {
  function harness(behaviour: "ok" | "error" | "throws" | "rejects" = "ok") {
    const calls: Array<{ fn: string; args: unknown }> = [];
    const errors: string[] = [];
    const client: AiQuotaRefundClient = {
      rpc(fn, args) {
        calls.push({ fn, args });
        if (behaviour === "throws") throw new Error(`boom ${SECRET} ${USER_ID}`);
        if (behaviour === "rejects") return Promise.reject(new Error(`fetch failed https://x/${USER_ID}`));
        return Promise.resolve({
          error: behaviour === "error" ? { code: "42501", message: `permission denied for ${USER_ID}` } : null,
        });
      },
    };
    return { calls, errors, client, logger: { error: (m: string) => errors.push(m) } };
  }

  it("calls exactly refund_ai_quota, once, with exactly the given user id", async () => {
    const h = harness();
    const outcome = await refundAiQuotaUnit(USER_ID, {
      label: "analyze-paper",
      logger: h.logger,
      createClient: () => h.client,
    });
    expect(outcome).toBe("completed");
    expect(h.calls).toEqual([{ fn: "refund_ai_quota", args: { p_user_id: USER_ID } }]);
    expect(AI_QUOTA_REFUND_RPC).toBe("refund_ai_quota");
    expect(h.errors).toEqual([]);
  });

  it("builds the client lazily, once, only when a refund is actually attempted", async () => {
    const h = harness();
    const createClient = vi.fn(() => h.client);
    await refundAiQuotaUnit(USER_ID, { label: "x", logger: h.logger, createClient });
    expect(createClient).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["no server key", () => null, "suggest-organization refund_failed no_server_key=1", "no_server_key"],
    ["a factory that throws", () => {
      throw new Error(`SUPABASE_URL missing ${SECRET}`);
    }, "suggest-organization refund_failed threw=1", "threw"],
  ])("reports %s as one bounded line and makes no call", async (_label, createClient, line, outcome) => {
    const h = harness();
    const result = await refundAiQuotaUnit(USER_ID, {
      label: "suggest-organization",
      logger: h.logger,
      createClient: createClient as () => AiQuotaRefundClient | null,
    });
    expect(result).toBe(outcome);
    expect(h.errors).toEqual([line]);
    expect(h.calls).toEqual([]);
  });

  it.each([
    ["error", "analyze-paper refund_failed rpc_error=1", "rpc_error"],
    ["throws", "analyze-paper refund_failed threw=1", "threw"],
    ["rejects", "analyze-paper refund_failed threw=1", "threw"],
  ] as const)("never throws when the RPC %s — one bounded line, no database text, no id, no key", async (behaviour, line, outcome) => {
    const h = harness(behaviour);
    const result = await refundAiQuotaUnit(USER_ID, {
      label: "analyze-paper",
      logger: h.logger,
      createClient: () => h.client,
    });
    expect(result).toBe(outcome);
    expect(h.errors).toEqual([line]);
    const logged = h.errors.join("\n");
    expect(logged).not.toContain(USER_ID);
    expect(logged).not.toContain(SECRET);
    expect(logged).not.toContain("permission denied");
    expect(logged).not.toContain("https://");
  });

  it.each([
    ["an empty id", ""],
    ["a non-UUID id", "not-a-user"],
    ["a UUID with trailing text", `${USER_ID}' OR 1=1`],
    ["a non-string", 42 as unknown as string],
  ])("refuses %s without building a client or calling anything", async (_label, id) => {
    const h = harness();
    const createClient = vi.fn(() => h.client);
    const result = await refundAiQuotaUnit(id, { label: "analyze-paper", logger: h.logger, createClient });
    expect(result).toBe("invalid_user");
    expect(createClient).not.toHaveBeenCalled();
    expect(h.calls).toEqual([]);
    expect(h.errors).toEqual(["analyze-paper refund_failed invalid_user=1"]);
  });

  it("survives a logger that throws", async () => {
    const h = harness("error");
    await expect(
      refundAiQuotaUnit(USER_ID, {
        label: "analyze-paper",
        logger: {
          error: () => {
            throw new Error("logger down");
          },
        },
        createClient: () => h.client,
      }),
    ).resolves.toBe("threw");
  });
});

// ── The type is the boundary ──────────────────────────────────────────────

// Never invoked. Each line must be a compile error under `tsc`; see the header.
function refundClientTypeBoundary(client: AiQuotaRefundClient) {
  // @ts-expect-error — the refund client can call exactly one RPC.
  void client.rpc("consume_ai_quota", { p_user_id: USER_ID });
  // @ts-expect-error — …with exactly one argument shape.
  void client.rpc("refund_ai_quota", { p_user_id: USER_ID, p_amount: 5 });
  // @ts-expect-error — it has no table access at all.
  void client.from("usage_counters");
  // @ts-expect-error — and no Auth surface.
  void client.auth;
}
void refundClientTypeBoundary;

describe("the refund client stays narrow, and separate from the telemetry writer", () => {
  const SHARED = fileURLToPath(new URL("../", import.meta.url));
  const REFUND = readFileSync(`${SHARED}aiQuotaRefund.ts`, "utf8");
  const TELEMETRY = readFileSync(`${SHARED}aiUsageTelemetry.ts`, "utf8");
  /** Source with comments removed: a comment explaining a rule is not code breaking it. */
  const code = (source: string) =>
    source
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split("\n")
      .filter((line) => !line.trim().startsWith("//"))
      .join("\n");

  it("pins the one-call interface as source", () => {
    expect(REFUND).toContain(`export interface AiQuotaRefundClient {
  rpc(
    fn: typeof AI_QUOTA_REFUND_RPC,
    args: { readonly p_user_id: string },
  ): PromiseLike<{ error: unknown }>;
}`);
    expect(REFUND).toContain('export const AI_QUOTA_REFUND_RPC = "refund_ai_quota";');
  });

  it("uses the shared secret-key rule and names no key value, header or request", () => {
    expect(REFUND).toContain('import { selectEdgeSecretKey } from "./edgeSecretKey.ts";');
    expect(code(REFUND)).not.toMatch(/Authorization|headers\s*:/);
    expect(code(REFUND)).not.toMatch(/Deno\.|https:\/\//);
    expect(code(REFUND)).not.toMatch(/console\./);
  });

  it("leaves the telemetry writer insert-only — it did not grow an RPC", () => {
    expect(TELEMETRY).toContain(`export interface AiUsageEventInsertClient {
  from(table: typeof AI_PROVIDER_USAGE_EVENTS_TABLE): {
    insert(row: AiProviderUsageEventRow): PromiseLike<{ error: unknown }>;
  };
}`);
    expect(code(TELEMETRY)).not.toMatch(/\.rpc\(|refund_ai_quota/);
  });
});
