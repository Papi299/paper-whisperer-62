// @vitest-environment node
//
// AI-MULTI-PROVIDER-001D — building, recording and writing provider-usage events.
//
// Three layers: the pure row builder (what an event says), the never-throwing
// recorder (what happens when the write fails), and the elevated client factory
// (which key it uses, and what it refuses to carry). No database, no network.
import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  AI_PROVIDER_USAGE_EVENTS_TABLE,
  AI_USAGE_TELEMETRY_VERSION,
  AI_USAGE_WRITE_TIMEOUT_MS,
  aiProviderOutcome,
  buildAiProviderUsageEvent,
  createAiUsageEventInsertClient,
  recordAiProviderUsage,
  type AiProviderUsageEventInput,
  type AiUsageClientOptions,
  type AiUsageEventInsertClient,
} from "../aiUsageTelemetry.ts";
import {
  AI_USAGE_INVALID,
  AI_USAGE_NOT_APPLICABLE,
  AI_USAGE_NOT_RETURNED,
  AI_USAGE_UNREPORTED,
  finalizeReportedUsage,
  reportedTokens as R,
} from "../aiUsage.ts";
import type { AiProviderResult } from "../aiProvider.ts";

const USER_ID = "11111111-2222-4333-8444-555555555555";
const AT = new Date("2026-10-01T12:00:00Z");

const GOOGLE_USAGE = finalizeReportedUsage(
  {
    inputTokens: R(1200),
    cachedInputTokens: R(300),
    cacheWriteInputTokens: AI_USAGE_NOT_APPLICABLE,
    outputTokens: R(190),
    reasoningOutputTokens: R(40),
    providerTotalTokens: R(1390),
  },
  false,
);

function input(overrides: Partial<AiProviderUsageEventInput> = {}): AiProviderUsageEventInput {
  return {
    userId: USER_ID,
    operation: "analyze",
    selection: { provider: "google", providerModel: "gemini-3.6-flash", source: "system_default" },
    reasoning: {
      policy: { reasoning: { kind: "level", level: "minimal" }, maxOutputTokens: 4096 },
      source: "automatic",
    },
    call: { ok: true, text: "SENTINEL-GENERATED-TEXT", attempts: 1, usage: GOOGLE_USAGE },
    operationOutcome: "succeeded",
    occurredAt: AT,
    ...overrides,
  };
}

function row(overrides: Partial<AiProviderUsageEventInput> = {}) {
  const built = buildAiProviderUsageEvent(input(overrides));
  if (!built.ok) throw new Error("expected a valid event");
  return built.row;
}

const failure = (
  kind: Extract<AiProviderResult, { ok: false }>["kind"],
  extra: Partial<Extract<AiProviderResult, { ok: false }>> = {},
): AiProviderResult => ({ ok: false, kind, attempts: 1, usage: AI_USAGE_NOT_RETURNED, ...extra });

/** Column names declared in the migration's CREATE TABLE, in order. */
function migrationColumns(): string[] {
  const sql = readFileSync(
    fileURLToPath(new URL("../../../migrations/20260913120000_add_ai_provider_usage_telemetry.sql", import.meta.url)),
    "utf8",
  );
  const body = sql.slice(
    sql.indexOf("CREATE TABLE public.ai_provider_usage_events ("),
    sql.indexOf("CONSTRAINT ai_provider_usage_events_version"),
  );
  return [...body.matchAll(/^ {4}([a-z_]+)\s+(UUID|TIMESTAMPTZ|SMALLINT|TEXT|INTEGER|BOOLEAN|NUMERIC)/gm)].map(
    (m) => m[1],
  );
}

// ── The row ───────────────────────────────────────────────────────────────

describe("the event row", () => {
  it("has exactly the table's insert columns — and no field that could hold content", () => {
    const keys = Object.keys(row()).sort();
    expect(keys).toEqual(
      migrationColumns()
        .filter((c) => c !== "id" && c !== "recorded_at")
        .sort(),
    );
    expect(keys).toHaveLength(28);
  });

  it("records a successful Google call completely", () => {
    expect(row()).toEqual({
      occurred_at: "2026-10-01T12:00:00.000Z",
      user_id: USER_ID,
      telemetry_version: AI_USAGE_TELEMETRY_VERSION,
      operation: "analyze",
      provider: "google",
      provider_model: "gemini-3.6-flash",
      model_selection_source: "system_default",
      reasoning_source: "automatic",
      resolved_reasoning_level: "minimal",
      provider_outcome: "completed",
      provider_http_status: null,
      provider_attempts: 1,
      operation_outcome: "succeeded",
      usage_status: "reported",
      input_tokens: 1200,
      cached_input_tokens: 300,
      cache_write_input_tokens: null,
      output_tokens: 190,
      reasoning_output_tokens: 40,
      provider_total_tokens: 1390,
      has_unmodeled_usage: false,
      cost_status: "estimated",
      list_price_estimate_usd: "0.001410000000000",
      price_record_id: "google/gemini-3.6-flash@2026-09-13",
      input_usd_per_mtok: "0.75",
      cached_input_usd_per_mtok: "0.075",
      cache_write_input_usd_per_mtok: null,
      output_usd_per_mtok: "3.75",
    });
  });

  it("never carries the generated text, and never anything from the call but bounded facts", () => {
    expect(JSON.stringify(row())).not.toContain("SENTINEL");
  });

  it.each([
    ["http", "http_error"],
    ["network", "network_error"],
    ["timeout", "timeout"],
    ["unreadable_response", "unreadable_response"],
    ["empty", "empty_response"],
    ["incomplete_response", "incomplete_response"],
  ] as const)("names the adapter outcome %s as %s", (kind, stored) => {
    expect(aiProviderOutcome(failure(kind, { status: kind === "http" ? 503 : undefined }))).toBe(stored);
  });

  it("keeps an HTTP status only for an HTTP failure", () => {
    expect(row({ call: failure("http", { status: 429 }), operationOutcome: "failed" })).toMatchObject({
      provider_outcome: "http_error",
      provider_http_status: 429,
    });
    expect(row({ call: failure("network"), operationOutcome: "failed" }).provider_http_status).toBeNull();
  });

  it("records a timeout as unknown work — no tokens and no amount, never zero", () => {
    expect(row({ call: failure("timeout"), operationOutcome: "failed" })).toMatchObject({
      provider_outcome: "timeout",
      usage_status: "absent",
      input_tokens: null,
      cached_input_tokens: null,
      output_tokens: null,
      has_unmodeled_usage: false,
      cost_status: "usage_unavailable",
      list_price_estimate_usd: null,
      price_record_id: null,
      input_usd_per_mtok: null,
    });
  });

  it("records rejected usage as rejected, with no numbers", () => {
    const r = row({ call: { ok: true, text: "x", attempts: 1, usage: AI_USAGE_INVALID } });
    expect(r).toMatchObject({ usage_status: "rejected", input_tokens: null, cost_status: "usage_unavailable" });
  });

  it("keeps the usage of an incomplete generation — it was billed", () => {
    const usage = finalizeReportedUsage(
      {
        inputTokens: R(300),
        cachedInputTokens: R(0),
        cacheWriteInputTokens: AI_USAGE_UNREPORTED,
        outputTokens: R(4096),
        reasoningOutputTokens: R(4096),
        providerTotalTokens: R(4396),
      },
      false,
    );
    const r = row({
      selection: { provider: "openai", providerModel: "gpt-5.6-terra", source: "user_preference" },
      reasoning: { policy: { reasoning: { kind: "level", level: "medium" }, maxOutputTokens: 4096 }, source: "manual" },
      call: { ok: false, kind: "incomplete_response", attempts: 1, usage },
      operationOutcome: "failed",
    });
    expect(r).toMatchObject({
      provider_outcome: "incomplete_response",
      usage_status: "partial",
      input_tokens: 300,
      output_tokens: 4096,
      reasoning_output_tokens: 4096,
      cache_write_input_tokens: null,
      reasoning_source: "manual",
      resolved_reasoning_level: "medium",
      // Cache writes were not reported, so no amount is guessed.
      cost_status: "usage_incomplete",
      list_price_estimate_usd: null,
    });
  });

  it("records a completed call whose answer PaperLume could not use as a failed operation with usage", () => {
    expect(row({ operationOutcome: "failed" })).toMatchObject({
      provider_outcome: "completed",
      operation_outcome: "failed",
      input_tokens: 1200,
      cost_status: "estimated",
    });
  });

  it("marks an estimate after more than one attempt as a lower bound", () => {
    expect(row({ call: { ok: true, text: "x", attempts: 3, usage: GOOGLE_USAGE } })).toMatchObject({
      provider_attempts: 3,
      cost_status: "estimated_lower_bound",
      list_price_estimate_usd: "0.001410000000000",
    });
  });

  it("records the provider-default fallback as no level, and says so", () => {
    expect(
      row({ reasoning: { policy: { reasoning: { kind: "provider_default" }, maxOutputTokens: 4096 }, source: "provider_default_fallback" } }),
    ).toMatchObject({ reasoning_source: "provider_default_fallback", resolved_reasoning_level: null });
  });

  it("records usage but no amount for a model with no verified price", () => {
    expect(
      row({ selection: { provider: "google", providerModel: "gemini-flash-latest", source: "system_default" } }),
    ).toMatchObject({
      input_tokens: 1200,
      cost_status: "unpriced",
      list_price_estimate_usd: null,
      price_record_id: null,
      input_usd_per_mtok: null,
      output_usd_per_mtok: null,
    });
  });

  it.each([
    ["a user id that is not a UUID", { userId: "user@example.com" }],
    ["an uppercase provider", { selection: { provider: "Google", providerModel: "gemini-3.6-flash", source: "system_default" as const } }],
    ["a model with a space", { selection: { provider: "google", providerModel: "gemini 3.6", source: "system_default" as const } }],
    ["a model shaped like an email", { selection: { provider: "google", providerModel: "a@b.c", source: "system_default" as const } }],
    ["zero attempts", { call: { ok: true as const, text: "x", attempts: 0, usage: GOOGLE_USAGE } }],
    ["too many attempts", { call: { ok: true as const, text: "x", attempts: 11, usage: GOOGLE_USAGE } }],
    ["a fractional attempt count", { call: { ok: true as const, text: "x", attempts: 1.5, usage: GOOGLE_USAGE } }],
    ["a success the provider did not complete", { call: failure("empty"), operationOutcome: "succeeded" as const }],
    ["an impossible HTTP status", { call: failure("http", { status: 700 }), operationOutcome: "failed" as const }],
    ["an invalid instant", { occurredAt: new Date(Number.NaN) }],
  ])("refuses %s", (_label, overrides) => {
    // Cast on purpose: several of these values are ones the types already
    // forbid (an unregistered provider spelling, a bad attempt count). The
    // builder is the runtime guard behind those types and must refuse them too.
    const event = input(overrides as unknown as Partial<AiProviderUsageEventInput>);
    expect(buildAiProviderUsageEvent(event)).toEqual({ ok: false, reason: "invalid_event" });
  });
});

// ── The recorder ──────────────────────────────────────────────────────────

function recorderHarness(behaviour: "ok" | "rejected" | "throws" | "rejects" = "ok", code = "23514") {
  const inserts: Array<{ table: string; row: unknown }> = [];
  const logs: string[] = [];
  const errors: string[] = [];
  const client: AiUsageEventInsertClient = {
    from: (table) => ({
      insert: (r) => {
        inserts.push({ table, row: r });
        if (behaviour === "throws") throw new Error(`fetch https://db.example/rest?user=${USER_ID}`);
        if (behaviour === "rejects") return Promise.reject(new Error("socket hang up"));
        return Promise.resolve(
          behaviour === "ok"
            ? { error: null }
            : {
                error: {
                  code,
                  message: `new row violates check constraint; Failing row contains (${USER_ID})`,
                  details: `Failing row contains (${USER_ID}, analyze, …)`,
                },
              },
        );
      },
    }),
  };
  const createClient = vi.fn(() => client);
  const deps = {
    label: "analyze-paper",
    logger: { log: (m: string) => logs.push(m), error: (m: string) => errors.push(m) },
    createClient,
    now: () => AT,
  };
  const { occurredAt: _omit, ...event } = input();
  return { inserts, logs, errors, createClient, deps, event };
}

describe("recordAiProviderUsage", () => {
  it("writes exactly one row into the telemetry table and logs one bounded line", async () => {
    const h = recorderHarness();
    await expect(recordAiProviderUsage(h.event, h.deps)).resolves.toBe("recorded");
    expect(h.createClient).toHaveBeenCalledTimes(1);
    expect(h.inserts).toEqual([{ table: AI_PROVIDER_USAGE_EVENTS_TABLE, row: row() }]);
    expect(h.logs).toEqual([
      "analyze-paper usage_telemetry recorded=1 operation=analyze provider=google model=gemini-3.6-flash " +
        "provider_outcome=completed attempts=1 usage=reported cost=estimated",
    ]);
    expect(h.errors).toEqual([]);
  });

  it("logs a refused write by bounded code only — never the message, details or user", async () => {
    const h = recorderHarness("rejected");
    await expect(recordAiProviderUsage(h.event, h.deps)).resolves.toBe("write_rejected");
    expect(h.errors).toHaveLength(1);
    expect(h.errors[0]).toContain("recorded=0 reason=write_rejected code=23514");
    expect(h.errors[0]).not.toContain(USER_ID);
    expect(h.errors[0]).not.toContain("Failing row");
  });

  it("does not echo an error code that is not a bounded code", async () => {
    const h = recorderHarness("rejected", `x' OR user=${USER_ID}`);
    await recordAiProviderUsage(h.event, h.deps);
    expect(h.errors[0]).toContain("code=unknown");
    expect(h.errors[0]).not.toContain(USER_ID);
  });

  it.each([["throws"], ["rejects"]] as const)("resolves — never rejects — when the insert %s", async (behaviour) => {
    const h = recorderHarness(behaviour);
    await expect(recordAiProviderUsage(h.event, h.deps)).resolves.toBe("write_failed");
    expect(h.errors.join("\n")).not.toContain(USER_ID);
    expect(h.errors.join("\n")).not.toContain("db.example");
  });

  it("records nothing, and says why, when no server key is available", async () => {
    const h = recorderHarness();
    await expect(recordAiProviderUsage(h.event, { ...h.deps, createClient: () => null })).resolves.toBe("no_server_key");
    await expect(
      recordAiProviderUsage(h.event, {
        ...h.deps,
        createClient: () => {
          throw new Error("Missing required Edge Function environment variable: SUPABASE_URL");
        },
      }),
    ).resolves.toBe("no_server_key");
    expect(h.errors.every((e) => e.includes("reason=no_server_key"))).toBe(true);
  });

  it("builds no client for an invalid event, and echoes nothing but the operation", async () => {
    const h = recorderHarness();
    const outcome = await recordAiProviderUsage(
      { ...h.event, selection: { provider: "google", providerModel: "SENTINEL MODEL", source: "system_default" } },
      h.deps,
    );
    expect(outcome).toBe("invalid_event");
    expect(h.createClient).not.toHaveBeenCalled();
    expect(h.errors).toEqual(["analyze-paper usage_telemetry recorded=0 reason=invalid_event operation=analyze"]);
  });

  it("resolves even when the logger itself throws", async () => {
    const h = recorderHarness();
    const outcome = await recordAiProviderUsage(
      { ...h.event, userId: "not-a-uuid" },
      {
        ...h.deps,
        logger: {
          log: () => {
            throw new Error("log sink down");
          },
          error: () => {
            throw new Error("log sink down");
          },
        },
      },
    );
    expect(outcome).toBe("write_failed");
  });
});

// ── The elevated, insert-only client ──────────────────────────────────────

describe("createAiUsageEventInsertClient", () => {
  function factory(env: Record<string, string | undefined>) {
    const reads: string[] = [];
    const calls: Array<{ url: string; key: string; options: AiUsageClientOptions }> = [];
    const fetchImpl = vi.fn(async () => new Response(null, { status: 201 }));
    const timeouts: number[] = [];
    const sentinel = { sentinel: "client" };
    const client = createAiUsageEventInsertClient({
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
    expect(f.reads).toEqual(["SUPABASE_SECRET_KEYS", "SUPABASE_SERVICE_ROLE_KEY"]);
  });

  it("prefers the current secret key, and falls back to the legacy one", () => {
    const current = factory({
      SUPABASE_SECRET_KEYS: JSON.stringify({ default: "sb_secret_current" }),
      SUPABASE_SERVICE_ROLE_KEY: "legacy",
    });
    expect(current.calls[0].key).toBe("sb_secret_current");
    expect(factory({ SUPABASE_SERVICE_ROLE_KEY: "legacy" }).calls[0].key).toBe("legacy");
  });

  it("reads only the two platform-injected key names — no provider credential, no caller header", () => {
    const f = factory({ SUPABASE_SERVICE_ROLE_KEY: "legacy" });
    expect(f.reads).toEqual(["SUPABASE_SECRET_KEYS", "SUPABASE_SERVICE_ROLE_KEY"]);
  });

  it("builds a sessionless client with no Authorization header of the caller's", () => {
    const f = factory({ SUPABASE_SERVICE_ROLE_KEY: "legacy" });
    expect(f.client).toBe(f.sentinel);
    expect(f.calls).toHaveLength(1);
    const { url, options } = f.calls[0];
    expect(url).toBe("https://project.supabase.test");
    expect(options.auth).toEqual({ persistSession: false, autoRefreshToken: false, detectSessionInUrl: false });
    expect(Object.keys(options.global)).toEqual(["fetch"]);
    expect(JSON.stringify(options)).not.toContain("Authorization");
  });

  it("bounds every write with its own timeout, and keeps a signal the caller already set", async () => {
    const f = factory({ SUPABASE_SERVICE_ROLE_KEY: "legacy" });
    await f.calls[0].options.global.fetch("https://project.supabase.test/rest/v1/x", { method: "POST" });
    expect(f.timeouts).toEqual([AI_USAGE_WRITE_TIMEOUT_MS]);
    expect(AI_USAGE_WRITE_TIMEOUT_MS).toBe(5_000);
    const [, init] = f.fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(init.method).toBe("POST");
    expect(init.signal).toBeInstanceOf(AbortSignal);

    const own = new AbortController().signal;
    await f.calls[0].options.global.fetch("https://project.supabase.test/rest/v1/x", { signal: own });
    const [, second] = f.fetchImpl.mock.calls[1] as unknown as [string, RequestInit];
    expect(second.signal).toBe(own);
  });
});
