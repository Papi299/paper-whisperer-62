// @vitest-environment node
//
// Node, not jsdom: the shipped function uses `Request`, `Response` and
// `AbortSignal.timeout` exactly as Deno provides them, and Node 22 provides the
// same ones.
//
// SEC-AI-QUOTA-REFUND-AUTHORITY-001 (C47) — analyze-paper consumes on the
// caller's client and refunds ONLY through the server-only refund client.
//
// ## This suite EXECUTES the shipped Edge Function
//
// The sibling suites read `index.ts` as text, because it is a `Deno.serve`
// shell with one remote import. That import is only `createClient`, so here it
// is replaced with a fake that hands back a caller-scoped client for the anon
// key and an elevated client for the platform secret key, `Deno` is stubbed
// with `serve` and `env.get`, and the real request path runs end to end: auth,
// body validation, model selection, reasoning policy, quota consumption, the
// real Google adapter and transport against a stubbed `fetch`, parsing,
// telemetry and refund. Nothing else in the function is faked. No network, no
// database and no provider is contacted.
//
// The caller-scoped fake answers `refund_ai_quota` the way the migrated
// database now does — `42501` — and records the attempt as a violation, so a
// regression that routed the refund back through the caller's JWT fails here
// even though its call would be swallowed as best-effort in Production.
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from "vitest";

const USER_ID = "11111111-2222-4333-8444-555555555555";
const OTHER_USER = "22222222-3333-4444-8555-666666666666";
const SUPABASE_URL = "https://project.supabase.test";
const ANON_KEY = "anon-key-test";
const SECRET_KEY = "sb_secret_test_value";
const LEGACY_KEY = "legacy_service_role_test_value";
const AUTH_HEADER = "Bearer caller-jwt";

type Call = { fn: string; args: Record<string, unknown> };

interface Scenario {
  env: Record<string, string | undefined>;
  userId: string;
  quota: Record<string, unknown>;
  provider: () => Response;
  refundAnswer: "ok" | "error" | "throws";
}

interface Recorder {
  callerCreations: Array<{ url: string; key: string; options: unknown }>;
  elevatedCreations: Array<{ url: string; key: string; options: unknown }>;
  callerRpc: Call[];
  callerViolations: string[];
  refundCalls: Call[];
  telemetryInserts: string[];
  providerRequests: string[];
  logs: string[];
}

const state: { scenario: Scenario; rec: Recorder } = {
  scenario: undefined as unknown as Scenario,
  rec: undefined as unknown as Recorder,
};

function freshRecorder(): Recorder {
  return {
    callerCreations: [],
    elevatedCreations: [],
    callerRpc: [],
    callerViolations: [],
    refundCalls: [],
    telemetryInserts: [],
    providerRequests: [],
    logs: [],
  };
}

function chain(result: { data: unknown; error: unknown }) {
  const builder = {
    select: () => builder,
    eq: () => builder,
    limit: () => Promise.resolve(result),
    maybeSingle: () => Promise.resolve(result),
  };
  return builder;
}

function fakeCallerClient() {
  return {
    auth: {
      getUser: async () => ({ data: { user: { id: state.scenario.userId } }, error: null }),
    },
    from: () => chain({ data: null, error: null }),
    rpc: (fn: string, args: Record<string, unknown>) => {
      state.rec.callerRpc.push({ fn, args });
      if (fn === "refund_ai_quota") {
        state.rec.callerViolations.push("caller-scoped refund_ai_quota");
        return Promise.resolve({
          data: null,
          error: { code: "42501", message: "permission denied for function refund_ai_quota" },
        });
      }
      if (fn === "get_current_user_access") {
        return Promise.resolve({ data: [{ role: "user", can_select_ai_model: false }], error: null });
      }
      if (fn === "consume_ai_quota") {
        return Promise.resolve({ data: [state.scenario.quota], error: null });
      }
      return Promise.resolve({ data: null, error: { message: `unexpected rpc ${fn}` } });
    },
  };
}

function fakeElevatedClient() {
  return {
    rpc: (fn: string, args: Record<string, unknown>) => {
      state.rec.refundCalls.push({ fn, args: { ...args } });
      const answer = state.scenario.refundAnswer;
      if (answer === "throws") throw new Error(`refund exploded ${SECRET_KEY} ${USER_ID}`);
      return Promise.resolve({
        error: answer === "error" ? { code: "P0001", message: `boom for ${USER_ID}` } : null,
      });
    },
    from: (table: string) => ({
      insert: () => {
        state.rec.telemetryInserts.push(table);
        return Promise.resolve({ error: null });
      },
    }),
  };
}

vi.mock("https://esm.sh/@supabase/supabase-js@2", () => ({
  createClient: (url: string, key: string, options: unknown) => {
    if (key === ANON_KEY) {
      state.rec.callerCreations.push({ url, key, options });
      return fakeCallerClient();
    }
    state.rec.elevatedCreations.push({ url, key, options });
    return fakeElevatedClient();
  },
}));

const OK_QUOTA = {
  allowed: true, reason: "ok", plan: "free", period_type: "lifetime",
  used: 3, quota: 15, remaining: 12, reset_at: null,
};

function geminiText(text: string, status = 200): Response {
  return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text }] } }] }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const GOOD_ANSWER = () =>
  geminiText(JSON.stringify({ tldr: "t", studyType: "RCT", statisticalMethods: "ANOVA" }));

function baseScenario(overrides: Partial<Scenario> = {}): Scenario {
  return {
    env: {
      SUPABASE_URL,
      SUPABASE_ANON_KEY: ANON_KEY,
      GEMINI_API_KEY: "gemini-key-test",
      GEMINI_MODEL: "gemini-3.6-flash",
      SUPABASE_SECRET_KEYS: JSON.stringify({ default: SECRET_KEY }),
      SUPABASE_SERVICE_ROLE_KEY: LEGACY_KEY,
    },
    userId: USER_ID,
    quota: OK_QUOTA,
    provider: GOOD_ANSWER,
    refundAnswer: "ok",
    ...overrides,
  };
}

let handler: (req: Request) => Promise<Response>;

beforeAll(async () => {
  state.scenario = baseScenario();
  state.rec = freshRecorder();
  (globalThis as unknown as { Deno: unknown }).Deno = {
    serve: (h: (req: Request) => Promise<Response>) => {
      handler = h;
    },
    env: { get: (name: string) => state.scenario.env[name] },
  };
  await import("../index.ts");
  if (typeof handler !== "function") throw new Error("analyze-paper did not register a handler");
});

beforeEach(() => {
  state.scenario = baseScenario();
  state.rec = freshRecorder();
  vi.stubGlobal("fetch", async (url: string | URL | Request) => {
    state.rec.providerRequests.push(String(url));
    return state.scenario.provider();
  });
  for (const level of ["log", "warn", "error"] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
      state.rec.logs.push(args.map(String).join(" "));
    });
  }
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function analyzeRequest(body: Record<string, unknown> = { title: "A title", abstract: "An abstract." }) {
  return new Request("https://edge.test/analyze-paper", {
    method: "POST",
    headers: { Authorization: AUTH_HEADER, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function run(overrides: Partial<Scenario> = {}, body?: Record<string, unknown>) {
  state.scenario = baseScenario(overrides);
  const response = await handler(analyzeRequest(body));
  return { status: response.status, body: await response.json() };
}

const callerFns = () => state.rec.callerRpc.map((c) => c.fn);

// ── The split ───────────────────────────────────────────────────────────────

describe("analyze-paper: consume on the caller's client, refund on the server's", () => {
  it("does not refund a successful analysis — and never builds a refund client for it", async () => {
    const result = await run();
    expect(result.status).toBe(200);
    expect(result.body).toEqual({ tldr: "t", studyType: "RCT", statisticalMethods: "ANOVA" });
    expect(state.rec.refundCalls).toEqual([]);
    expect(callerFns()).toEqual(["get_current_user_access", "consume_ai_quota"]);
    // The only elevated client built was the telemetry writer's.
    expect(state.rec.elevatedCreations).toHaveLength(1);
    expect(state.rec.telemetryInserts).toEqual(["ai_provider_usage_events"]);
    expect(state.rec.callerViolations).toEqual([]);
  });

  it("refunds exactly once, through the server client, after a provider failure", async () => {
    const result = await run({ provider: () => new Response("", { status: 500 }) });
    expect(result.status).toBe(500);
    expect(result.body.error).toBe("analysis_unavailable");
    expect(state.rec.refundCalls).toEqual([{ fn: "refund_ai_quota", args: { p_user_id: USER_ID } }]);
    expect(callerFns()).toEqual(["get_current_user_access", "consume_ai_quota"]);
    expect(state.rec.callerViolations).toEqual([]);
    expect(state.rec.providerRequests).toHaveLength(1);
  });

  it("refunds exactly once after a malformed provider answer", async () => {
    const result = await run({ provider: () => geminiText("this is not json at all") });
    expect(result.status).toBe(500);
    expect(result.body.error).toBe("analysis_unavailable");
    expect(result.body.code).toBe("malformed_response");
    expect(state.rec.refundCalls).toEqual([{ fn: "refund_ai_quota", args: { p_user_id: USER_ID } }]);
    expect(state.rec.callerViolations).toEqual([]);
  });

  it("refunds exactly once when the provider credential is missing after consumption", async () => {
    const env = { ...baseScenario().env, GEMINI_API_KEY: undefined };
    const result = await run({ env });
    expect(result.status).toBe(500);
    expect(result.body).toEqual({ error: "Analysis failed. Please try again later." });
    expect(callerFns()).toEqual(["get_current_user_access", "consume_ai_quota"]);
    expect(state.rec.refundCalls).toEqual([{ fn: "refund_ai_quota", args: { p_user_id: USER_ID } }]);
    expect(state.rec.providerRequests).toEqual([]);
    expect(state.rec.callerViolations).toEqual([]);
  });

  it("never refunds when nothing was consumed (the quota wall)", async () => {
    const result = await run({
      quota: { ...OK_QUOTA, allowed: false, reason: "quota_exceeded", used: 15, remaining: 0 },
    });
    expect(result.status).toBe(402);
    expect(state.rec.refundCalls).toEqual([]);
    expect(state.rec.elevatedCreations).toEqual([]);
    expect(state.rec.providerRequests).toEqual([]);
  });

  it("refunds the getUser() identity, whatever the body claims", async () => {
    await run(
      { userId: OTHER_USER, provider: () => new Response("", { status: 503 }) },
      { title: "t", abstract: "a", user_id: USER_ID, userId: USER_ID, p_user_id: USER_ID },
    );
    expect(state.rec.callerRpc.find((c) => c.fn === "consume_ai_quota")?.args).toEqual({ p_user_id: OTHER_USER });
    expect(state.rec.refundCalls).toEqual([{ fn: "refund_ai_quota", args: { p_user_id: OTHER_USER } }]);
  });
});

// ── The elevated client ─────────────────────────────────────────────────────

describe("analyze-paper: the refund client is the server's own", () => {
  it("is built from the current secret key, with no caller Authorization header and no session", async () => {
    await run({ provider: () => new Response("", { status: 500 }) });
    // Two elevated clients on a failure that reached the provider: the refund
    // (first — it precedes telemetry on the failure path) and the telemetry writer.
    expect(state.rec.elevatedCreations).toHaveLength(2);
    const refundClient = state.rec.elevatedCreations[0];
    expect(refundClient.url).toBe(SUPABASE_URL);
    expect(refundClient.key).toBe(SECRET_KEY);
    const serialized = JSON.stringify(refundClient.options);
    expect(serialized).not.toContain("Authorization");
    expect(serialized).not.toContain(AUTH_HEADER);
    expect((refundClient.options as { auth: unknown }).auth).toEqual({
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    });
    // The caller client, by contrast, is the anon key plus the caller's header.
    expect(state.rec.callerCreations).toHaveLength(1);
    expect(state.rec.callerCreations[0].options).toEqual({ global: { headers: { Authorization: AUTH_HEADER } } });
  });

  it("falls back to the legacy service-role key when no current secret key exists", async () => {
    const env = { ...baseScenario().env, SUPABASE_SECRET_KEYS: undefined };
    await run({ env, provider: () => new Response("", { status: 500 }) });
    expect(state.rec.elevatedCreations[0].key).toBe(LEGACY_KEY);
    expect(state.rec.refundCalls).toHaveLength(1);
  });
});

// ── Best-effort, and never a replacement for the real failure ───────────────

describe("analyze-paper: a refund-side problem never changes the response", () => {
  const cases: Array<[string, Partial<Scenario>, string]> = [
    [
      "no server key is available",
      { env: { ...baseScenario().env, SUPABASE_SECRET_KEYS: undefined, SUPABASE_SERVICE_ROLE_KEY: undefined } },
      "analyze-paper refund_failed no_server_key=1",
    ],
    ["the refund RPC returns an error", { refundAnswer: "error" }, "analyze-paper refund_failed rpc_error=1"],
    ["the refund RPC throws", { refundAnswer: "throws" }, "analyze-paper refund_failed threw=1"],
  ];

  it.each(cases)("keeps the original provider failure when %s, with no caller fallback", async (_label, overrides, line) => {
    const failing = () => new Response("", { status: 429 });
    const baseline = await run({ provider: failing });

    const result = await run({ ...overrides, provider: failing });
    expect(result).toEqual(baseline);
    expect(state.rec.logs).toContain(line);
    expect(callerFns()).not.toContain("refund_ai_quota");
    expect(state.rec.callerViolations).toEqual([]);
    const logged = state.rec.logs.join("\n");
    expect(logged).not.toContain(SECRET_KEY);
    expect(logged).not.toContain(LEGACY_KEY);
    expect(logged).not.toContain(USER_ID);
    expect(logged).not.toContain("exploded");
    expect(logged).not.toContain("boom");
  });

  it("keeps the missing-credential failure too when the refund cannot be made", async () => {
    const env = {
      ...baseScenario().env,
      GEMINI_API_KEY: undefined,
      SUPABASE_SECRET_KEYS: undefined,
      SUPABASE_SERVICE_ROLE_KEY: undefined,
    };
    const result = await run({ env });
    expect(result).toEqual({ status: 500, body: { error: "Analysis failed. Please try again later." } });
    expect(state.rec.logs).toContain("analyze-paper refund_failed no_server_key=1");
    expect(callerFns()).not.toContain("refund_ai_quota");
  });
});
