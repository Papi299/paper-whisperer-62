// @vitest-environment node
//
// Node rather than jsdom for consistency with the sibling Edge suites: this
// module runs in Deno and nothing here wants a DOM. (The module itself is pure,
// so it would pass under either — but a suite that pins server behaviour should
// not be measuring jsdom's globals.)
//
// AI-MODEL-SELECTION-001B — the shared runtime routing decision.
//
// `_shared/aiModelSelection.ts` is the ONE implementation both AI operations
// use, so this suite is where "who may be routed off the system default" is
// actually pinned. Every case below is about what the resolver REFUSES to do:
// honour a preference it could not prove entitlement for, honour a retired
// model, call a provider it has no adapter for, read another user's row, trust a
// row it did not ask for, or turn any of those into a failed AI request.
//
// The fake client is a trap, not a stub — the same convention the
// `suggest-paper-organization` handler suite uses. `from()` and its builder are
// Proxies that throw on any property the resolver is not supposed to touch, so
// an edit that tried to `insert()`/`update()`/`delete()` entitlement, preference
// or catalog state would fail these tests rather than pass them quietly.
import { describe, it, expect } from "vitest";
import {
  buildGeminiGenerateContentUrl,
  formatModelRoutingLog,
  resolveEffectiveAiModel,
  SUPPORTED_AI_PROVIDER,
  type AiModelSelectionClient,
} from "../aiModelSelection.ts";

// ── Fixtures ──────────────────────────────────────────────────────────────
//
// The four model ids are the rows the catalog actually holds: 3.5 and 3.6 from
// migration 20260902120000, then 3.7 and 3.8 from 20260903120000 (C35). They are
// FIXTURE DATA, not a runtime rule: the resolver hard-codes no model list — see
// the "no TypeScript allowlist" assertions at the end, which route a model
// string that appears in no migration at all.
//
// That the 001D models needed no change to this file beyond fixtures IS the
// architectural claim. If supporting a new catalog model ever required editing
// `aiModelSelection.ts`, the database would have stopped being the allowlist.

const SYSTEM_DEFAULT = "gemini-3.6-flash-SYSTEM-DEFAULT-SENTINEL";
const USER_ID = "11111111-2222-4333-8444-555555555555";
const OTHER_USER_ID = "99999999-8888-4777-8666-555555555555";

const CATALOG_35 = {
  id: "google/gemini-3.5-flash",
  provider: "google",
  provider_model: "gemini-3.5-flash",
  enabled: true,
  selectable: true,
};
const CATALOG_36 = {
  id: "google/gemini-3.6-flash",
  provider: "google",
  provider_model: "gemini-3.6-flash",
  enabled: true,
  selectable: true,
};
const CATALOG_37 = {
  id: "google/gemini-3.7-flash",
  provider: "google",
  provider_model: "gemini-3.7-flash",
  enabled: true,
  selectable: true,
};
const CATALOG_38 = {
  id: "google/gemini-3.8-flash",
  provider: "google",
  provider_model: "gemini-3.8-flash",
  enabled: true,
  selectable: true,
};

// Sentinels that must never appear in a log line. If a diagnostic ever grows a
// user id, a bearer token, an API key or a raw database error body, the
// no-leak assertions below fail on the literal string.
const TOKEN = "Bearer SENTINEL-ACCESS-TOKEN";
const API_KEY = "SENTINEL-GEMINI-API-KEY";
const RAW_DB_ERROR =
  'permission denied for table user_ai_preferences (user SENTINEL-EMAIL@example.com)';

interface QueryRecord {
  table: string;
  columns: string;
  filters: Array<[string, string]>;
}

interface Options {
  /** `undefined` → an entitled access row. `null` → no row at all. */
  access?: unknown;
  accessError?: unknown;
  accessThrows?: boolean;
  /** `undefined` → no preference row. */
  preference?: Record<string, unknown> | null;
  preferenceError?: unknown;
  preferenceThrows?: boolean;
  /** `undefined` → no catalog row. */
  catalog?: Record<string, unknown> | null;
  catalogError?: unknown;
  catalogThrows?: boolean;
}

interface Harness {
  client: AiModelSelectionClient;
  queries: QueryRecord[];
  rpcCalls: Array<{ fn: string; args: unknown }>;
  warns: string[];
  forbidden: string[];
}

/** Wrap an object so any property outside `allowed` records a violation and throws. */
function trap<T extends object>(target: T, allowed: string[], forbidden: string[]): T {
  return new Proxy(target, {
    get(obj, prop, receiver) {
      if (typeof prop === "string" && !allowed.includes(prop)) {
        if (prop !== "then" && !prop.startsWith("_")) {
          forbidden.push(prop);
          throw new Error(`forbidden database method: ${prop}`);
        }
      }
      return Reflect.get(obj, prop, receiver);
    },
  }) as T;
}

function makeHarness(options: Options = {}): Harness {
  const queries: QueryRecord[] = [];
  const rpcCalls: Harness["rpcCalls"] = [];
  const warns: string[] = [];
  const forbidden: string[] = [];

  const client: AiModelSelectionClient = {
    rpc(fn: string, args: Record<string, unknown>) {
      rpcCalls.push({ fn, args });
      if (options.accessThrows) throw new Error("access rpc exploded");
      return Promise.resolve({
        data: options.accessError
          ? null
          : options.access === undefined
            ? [{ role: "user", plan: "pro", can_select_ai_model: true }]
            : options.access,
        error: options.accessError ?? null,
      });
    },
    from(table: string) {
      return trap(
        {
          select(columns: string) {
            const record: QueryRecord = { table, columns, filters: [] };
            const builder = trap(
              {
                eq(column: string, value: string) {
                  record.filters.push([column, value]);
                  return builder;
                },
                maybeSingle() {
                  queries.push(record);
                  if (table === "user_ai_preferences") {
                    if (options.preferenceThrows) throw new Error("preference select exploded");
                    return Promise.resolve({
                      data: options.preferenceError ? null : (options.preference ?? null),
                      error: options.preferenceError ?? null,
                    });
                  }
                  if (options.catalogThrows) throw new Error("catalog select exploded");
                  return Promise.resolve({
                    data: options.catalogError ? null : (options.catalog ?? null),
                    error: options.catalogError ?? null,
                  });
                },
              },
              ["eq", "maybeSingle"],
              forbidden,
            );
            return builder;
          },
        },
        ["select"],
        forbidden,
      );
    },
  };

  return { client, queries, rpcCalls, warns, forbidden };
}

function resolve(harness: Harness) {
  return resolveEffectiveAiModel({
    client: harness.client,
    userId: USER_ID,
    systemDefaultModel: SYSTEM_DEFAULT,
    label: "test-op",
    logger: { warn: (m: string) => harness.warns.push(m) },
  });
}

/** Entitled caller with a saved preference resolving to `catalog`. */
function entitledWith(catalog: Record<string, unknown> | null, modelId = CATALOG_35.id) {
  return makeHarness({ preference: { preferred_model_id: modelId }, catalog });
}

const expectSystemDefault = (
  selection: Awaited<ReturnType<typeof resolveEffectiveAiModel>>,
  reason: string,
) => {
  expect(selection.providerModel).toBe(SYSTEM_DEFAULT);
  expect(selection.source).toBe("system_default");
  expect(selection.provider).toBe("google");
  expect(selection.fallbackReason).toBe(reason);
};

// ── 1. System default ─────────────────────────────────────────────────────

describe("system default", () => {
  it("is used when the caller is not entitled", async () => {
    const harness = makeHarness({ access: [{ can_select_ai_model: false }] });
    expectSystemDefault(await resolve(harness), "not_entitled");
    // Not entitled means the preference is never even read.
    expect(harness.queries).toEqual([]);
  });

  it("is used when can_select_ai_model is absent", async () => {
    const harness = makeHarness({ access: [{ role: "user", plan: "free" }] });
    expectSystemDefault(await resolve(harness), "not_entitled");
  });

  it.each([
    ["a string 'true'", "true"],
    ["the number 1", 1],
    ["null", null],
  ])("refuses a non-boolean can_select_ai_model (%s)", async (_label, value) => {
    const harness = makeHarness({ access: [{ can_select_ai_model: value }] });
    expectSystemDefault(await resolve(harness), "not_entitled");
    expect(harness.queries).toEqual([]);
  });

  it("is used when the access projection returns no row", async () => {
    const harness = makeHarness({ access: [] });
    expectSystemDefault(await resolve(harness), "invalid_access_row");
  });

  it.each([
    ["null", null],
    ["a bare string", "entitled"],
    ["a number", 7],
  ])("is used when the access result is malformed (%s)", async (_label, value) => {
    const harness = makeHarness({ access: value });
    expectSystemDefault(await resolve(harness), "invalid_access_row");
  });

  it("is used when the access RPC returns an error", async () => {
    const harness = makeHarness({ accessError: { message: RAW_DB_ERROR } });
    expectSystemDefault(await resolve(harness), "access_lookup_failed");
    expect(harness.queries).toEqual([]);
  });

  it("is used when the access RPC throws", async () => {
    const harness = makeHarness({ accessThrows: true });
    expectSystemDefault(await resolve(harness), "access_lookup_failed");
  });

  it("reads the access projection defensively when it is not an array", async () => {
    // supabase-js surfaces a SETOF function as an array, but a single object is
    // read the same way `get-gemini-provider-quota` reads it.
    const harness = makeHarness({ access: { can_select_ai_model: true } , preference: null });
    expectSystemDefault(await resolve(harness), "no_preference");
  });
});

// ── 2. Preference ─────────────────────────────────────────────────────────

describe("saved preference", () => {
  it("falls back when an entitled caller has no preference row", async () => {
    const harness = makeHarness({ preference: null });
    expectSystemDefault(await resolve(harness), "no_preference");
    // The preference was looked for; the catalog was not.
    expect(harness.queries.map((q) => q.table)).toEqual(["user_ai_preferences"]);
  });

  it("falls back when the preference read errors", async () => {
    const harness = makeHarness({ preferenceError: { message: RAW_DB_ERROR } });
    expectSystemDefault(await resolve(harness), "preference_lookup_failed");
    expect(harness.queries.map((q) => q.table)).toEqual(["user_ai_preferences"]);
  });

  it("falls back when the preference read throws", async () => {
    const harness = makeHarness({ preferenceThrows: true });
    expectSystemDefault(await resolve(harness), "preference_lookup_failed");
  });

  it.each([
    ["a missing column", {}],
    ["a non-string id", { preferred_model_id: 42 }],
    ["null", { preferred_model_id: null }],
    ["an empty string", { preferred_model_id: "" }],
    ["whitespace only", { preferred_model_id: "   " }],
    ["an untrimmed id", { preferred_model_id: " google/gemini-3.5-flash " }],
  ])("falls back on a malformed preference (%s)", async (_label, row) => {
    const harness = makeHarness({ preference: row as Record<string, unknown> });
    expectSystemDefault(await resolve(harness), "invalid_preference");
    // A malformed preference never becomes a catalog lookup.
    expect(harness.queries.map((q) => q.table)).toEqual(["user_ai_preferences"]);
  });

  it("selects only the routing column it needs", async () => {
    const harness = entitledWith(CATALOG_35);
    await resolve(harness);
    expect(harness.queries[0]).toMatchObject({
      table: "user_ai_preferences",
      columns: "preferred_model_id",
    });
  });
});

// ── 3. Catalog ────────────────────────────────────────────────────────────

describe("catalog resolution", () => {
  it("honours a valid Gemini 3.5 preference", async () => {
    const harness = entitledWith(CATALOG_35, CATALOG_35.id);
    const selection = await resolve(harness);
    expect(selection).toEqual({
      provider: "google",
      providerModel: "gemini-3.5-flash",
      source: "user_preference",
      fallbackReason: null,
    });
    expect(harness.warns).toEqual([]);
  });

  it("honours a valid Gemini 3.6 preference", async () => {
    const harness = entitledWith(CATALOG_36, CATALOG_36.id);
    const selection = await resolve(harness);
    expect(selection).toEqual({
      provider: "google",
      providerModel: "gemini-3.6-flash",
      source: "user_preference",
      fallbackReason: null,
    });
    expect(harness.warns).toEqual([]);
  });

  // AI-MODEL-SELECTION-001D. Neither of the next two models existed when this
  // resolver was written, and the resolver was not edited to accept them: the
  // only thing that changed is the catalog row the fake client returns. That is
  // the whole test — a passing assertion here means a reviewed row is sufficient
  // to route a new Google model, and a failing one would mean a code allowlist
  // had appeared somewhere between the preference read and the URL.
  it("honours a valid Gemini 3.7 preference with no code change", async () => {
    const harness = entitledWith(CATALOG_37, CATALOG_37.id);
    const selection = await resolve(harness);
    expect(selection).toEqual({
      provider: "google",
      providerModel: "gemini-3.7-flash",
      source: "user_preference",
      fallbackReason: null,
    });
    expect(harness.warns).toEqual([]);
  });

  it("honours a valid Gemini 3.8 preference with no code change", async () => {
    const harness = entitledWith(CATALOG_38, CATALOG_38.id);
    const selection = await resolve(harness);
    expect(selection).toEqual({
      provider: "google",
      providerModel: "gemini-3.8-flash",
      source: "user_preference",
      fallbackReason: null,
    });
    expect(harness.warns).toEqual([]);
  });

  // The catalog's provider_model — not its id — is what reaches the provider.
  // Worth pinning per model, because the two strings differ only by the
  // `google/` prefix and a resolver that returned the id would look plausible.
  it.each([
    ["gemini-3.7-flash", CATALOG_37],
    ["gemini-3.8-flash", CATALOG_38],
  ])("sends %s — the catalog provider_model, never the catalog id", async (expected, row) => {
    const selection = await resolve(entitledWith(row, row.id));
    expect(selection.providerModel).toBe(expected);
    expect(selection.providerModel).not.toBe(row.id);
  });

  // The flags mean the same thing for a new model as for an old one: nothing
  // about 001D is special-cased.
  it("falls back when a newly added model is retired (enabled = false)", async () => {
    const harness = entitledWith({ ...CATALOG_38, enabled: false }, CATALOG_38.id);
    expectSystemDefault(await resolve(harness), "model_disabled");
  });

  it("STILL HONOURS a newly added model that is enabled but not selectable", async () => {
    const harness = entitledWith({ ...CATALOG_37, selectable: false }, CATALOG_37.id);
    const selection = await resolve(harness);
    expect(selection.source).toBe("user_preference");
    expect(selection.providerModel).toBe("gemini-3.7-flash");
  });

  it("falls back when the catalog row is missing", async () => {
    const harness = entitledWith(null, "google/retired-model");
    expectSystemDefault(await resolve(harness), "model_missing");
  });

  it("falls back when the catalog read errors", async () => {
    const harness = makeHarness({
      preference: { preferred_model_id: CATALOG_35.id },
      catalogError: { message: RAW_DB_ERROR },
    });
    expectSystemDefault(await resolve(harness), "catalog_lookup_failed");
  });

  it("falls back when the catalog read throws", async () => {
    const harness = makeHarness({
      preference: { preferred_model_id: CATALOG_35.id },
      catalogThrows: true,
    });
    expectSystemDefault(await resolve(harness), "catalog_lookup_failed");
  });

  it("refuses a row whose id is not the id that was asked for", async () => {
    // A filter that silently stopped filtering would otherwise route this user
    // to whatever row came back first.
    const harness = entitledWith(CATALOG_36, CATALOG_35.id);
    expectSystemDefault(await resolve(harness), "invalid_catalog_row");
  });

  it.each([
    ["a non-boolean enabled", { ...CATALOG_35, enabled: "true" }],
    ["a missing enabled", { id: CATALOG_35.id, provider: "google", provider_model: "x" }],
    ["a non-string provider", { ...CATALOG_35, provider: 1 }],
    ["an empty provider", { ...CATALOG_35, provider: "" }],
    ["an untrimmed provider", { ...CATALOG_35, provider: " google " }],
  ])("falls back on a malformed catalog row (%s)", async (_label, row) => {
    const harness = entitledWith(row as Record<string, unknown>, CATALOG_35.id);
    expectSystemDefault(await resolve(harness), "invalid_catalog_row");
  });

  it("falls back when the saved model has been retired (enabled = false)", async () => {
    const harness = entitledWith({ ...CATALOG_35, enabled: false }, CATALOG_35.id);
    expectSystemDefault(await resolve(harness), "model_disabled");
  });

  it("STILL HONOURS a saved model that is enabled but no longer selectable", async () => {
    // The two flags are deliberately different. `selectable = false` closes a
    // model to NEW choices; requiring it here would silently revoke a choice
    // users already made. Requiring both is the SETTER's job, at save time.
    const harness = entitledWith({ ...CATALOG_35, selectable: false }, CATALOG_35.id);
    const selection = await resolve(harness);
    expect(selection.source).toBe("user_preference");
    expect(selection.providerModel).toBe("gemini-3.5-flash");
    expect(harness.warns).toEqual([]);
  });

  it("retirement beats non-selectability — enabled=false wins either way", async () => {
    const harness = entitledWith(
      { ...CATALOG_35, enabled: false, selectable: false },
      CATALOG_35.id,
    );
    expectSystemDefault(await resolve(harness), "model_disabled");
  });

  it("selects only the routing metadata it needs, filtered on the exact id", async () => {
    const harness = entitledWith(CATALOG_35, CATALOG_35.id);
    await resolve(harness);
    expect(harness.queries[1]).toEqual({
      table: "ai_model_catalog",
      columns: "id,provider,provider_model,enabled,selectable",
      filters: [["id", CATALOG_35.id]],
    });
  });
});

// ── 4. Provider adapter boundary ──────────────────────────────────────────

describe("provider adapter boundary", () => {
  it.each(["anthropic", "openai", "azure", "GOOGLE", "google-vertex"])(
    "refuses to route to the unimplemented provider %s",
    async (provider) => {
      const harness = entitledWith(
        { ...CATALOG_35, provider, provider_model: "some-model" },
        CATALOG_35.id,
      );
      const selection = await resolve(harness);
      expectSystemDefault(selection, "unsupported_provider");
      // And nothing about that other provider's model reaches the URL.
      expect(buildGeminiGenerateContentUrl(selection)).not.toContain("some-model");
    },
  );

  it.each([
    ["an empty provider_model", ""],
    ["whitespace only", "   "],
    ["an untrimmed value", " gemini-3.5-flash "],
    ["a non-string", 3.5],
  ])("falls back on a blank or untrimmed provider_model (%s)", async (_label, value) => {
    const harness = entitledWith(
      { ...CATALOG_35, provider_model: value },
      CATALOG_35.id,
    );
    expectSystemDefault(await resolve(harness), "invalid_catalog_row");
  });

  it("names google as the one implemented adapter", () => {
    expect(SUPPORTED_AI_PROVIDER).toBe("google");
  });

  it("always reports provider google, even on every fallback path", async () => {
    for (const options of [
      { access: [{ can_select_ai_model: false }] },
      { accessError: { message: "x" } },
      { preference: null },
      { preference: { preferred_model_id: CATALOG_35.id }, catalog: null },
    ] as Options[]) {
      const selection = await resolve(makeHarness(options));
      expect(selection.provider).toBe("google");
    }
  });
});

// ── 5. Isolation — no identity but the authenticated one ──────────────────

describe("user isolation", () => {
  it("scopes the preference query to the authenticated user id", async () => {
    const harness = entitledWith(CATALOG_35);
    await resolve(harness);
    const preferenceQuery = harness.queries.find((q) => q.table === "user_ai_preferences");
    expect(preferenceQuery?.filters).toEqual([["user_id", USER_ID]]);
  });

  it("uses the id it was given, and never a value from anywhere else", async () => {
    // The resolver takes the authenticated id as a parameter and has no other
    // source for one — no request, no body, no header reaches it. Handing it a
    // different id changes exactly one thing: the filter it sends.
    const harness = entitledWith(CATALOG_35);
    await resolveEffectiveAiModel({
      client: harness.client,
      userId: OTHER_USER_ID,
      systemDefaultModel: SYSTEM_DEFAULT,
      label: "test-op",
    });
    expect(harness.queries[0].filters).toEqual([["user_id", OTHER_USER_ID]]);
  });

  it("asks the access RPC about the caller, passing no user id at all", async () => {
    const harness = entitledWith(CATALOG_35);
    await resolve(harness);
    expect(harness.rpcCalls).toHaveLength(1);
    expect(harness.rpcCalls[0].fn).toBe("get_current_user_access");
    // No p_user_id, and nothing else either — the RPC derives the caller from
    // auth.uid(), so there is no argument to get wrong.
    expect(harness.rpcCalls[0].args).toEqual({});
  });

  it("re-checks entitlement on every call rather than caching it", async () => {
    // A saved preference stays dormant after a downgrade, so a cached "yes"
    // would keep routing a lapsed user. Two calls, two access checks.
    const harness = entitledWith(CATALOG_35);
    await resolve(harness);
    await resolve(harness);
    expect(harness.rpcCalls.map((c) => c.fn)).toEqual([
      "get_current_user_access",
      "get_current_user_access",
    ]);
  });

  it("touches no write method on any table", async () => {
    const harness = entitledWith(CATALOG_35);
    await resolve(harness);
    expect(harness.forbidden).toEqual([]);
  });

  it("performs at most one access read, one preference read and one catalog read", async () => {
    const harness = entitledWith(CATALOG_35);
    await resolve(harness);
    expect(harness.rpcCalls).toHaveLength(1);
    expect(harness.queries.map((q) => q.table)).toEqual([
      "user_ai_preferences",
      "ai_model_catalog",
    ]);
  });
});

// ── 6. Bounded logging ────────────────────────────────────────────────────

describe("bounded diagnostics", () => {
  it("stays silent on the two ordinary paths", async () => {
    const notEntitled = makeHarness({ access: [{ can_select_ai_model: false }] });
    await resolve(notEntitled);
    expect(notEntitled.warns).toEqual([]);

    const noPreference = makeHarness({ preference: null });
    await resolve(noPreference);
    expect(noPreference.warns).toEqual([]);
  });

  it("stays silent when the preference IS honoured", async () => {
    const harness = entitledWith(CATALOG_35);
    await resolve(harness);
    expect(harness.warns).toEqual([]);
  });

  it.each<[string, Options, string]>([
    ["access_lookup_failed", { accessError: { message: RAW_DB_ERROR } }, "access_lookup_failed"],
    ["invalid_access_row", { access: null }, "invalid_access_row"],
    [
      "preference_lookup_failed",
      { preferenceError: { message: RAW_DB_ERROR } },
      "preference_lookup_failed",
    ],
    ["invalid_preference", { preference: { preferred_model_id: 1 } }, "invalid_preference"],
    [
      "catalog_lookup_failed",
      { preference: { preferred_model_id: CATALOG_35.id }, catalogError: { message: RAW_DB_ERROR } },
      "catalog_lookup_failed",
    ],
    [
      "model_missing",
      { preference: { preferred_model_id: CATALOG_35.id }, catalog: null },
      "model_missing",
    ],
    [
      "model_disabled",
      {
        preference: { preferred_model_id: CATALOG_35.id },
        catalog: { ...CATALOG_35, enabled: false },
      },
      "model_disabled",
    ],
    [
      "unsupported_provider",
      {
        preference: { preferred_model_id: CATALOG_35.id },
        catalog: { ...CATALOG_35, provider: "anthropic" },
      },
      "unsupported_provider",
    ],
    [
      "invalid_catalog_row",
      {
        preference: { preferred_model_id: CATALOG_35.id },
        catalog: { ...CATALOG_35, enabled: "yes" },
      },
      "invalid_catalog_row",
    ],
  ])("emits exactly one bounded line for %s", async (_name, options, reason) => {
    const harness = makeHarness(options);
    await resolve(harness);
    expect(harness.warns).toEqual([`test-op model_selection_fallback reason=${reason}`]);
  });

  it("never logs a user id, a token, a key or a raw database error body", async () => {
    // Every unexpected path, in one pass, checked against every sentinel.
    const cases: Options[] = [
      { accessError: { message: RAW_DB_ERROR } },
      { access: null },
      { preferenceError: { message: RAW_DB_ERROR } },
      { preference: { preferred_model_id: 1 } },
      { preference: { preferred_model_id: CATALOG_35.id }, catalogError: { message: RAW_DB_ERROR } },
      { preference: { preferred_model_id: CATALOG_35.id }, catalog: null },
      {
        preference: { preferred_model_id: CATALOG_35.id },
        catalog: { ...CATALOG_35, provider: "anthropic", provider_model: "claude-sentinel" },
      },
    ];
    const everything: string[] = [];
    for (const options of cases) {
      const harness = makeHarness(options);
      await resolveEffectiveAiModel({
        client: harness.client,
        userId: USER_ID,
        systemDefaultModel: SYSTEM_DEFAULT,
        label: "test-op",
        logger: { warn: (m: string) => harness.warns.push(m) },
      });
      everything.push(...harness.warns);
    }
    expect(everything.length).toBeGreaterThan(0);
    const joined = everything.join("\n");
    for (const secret of [USER_ID, TOKEN, API_KEY, RAW_DB_ERROR, "SENTINEL-EMAIL", "claude-sentinel"]) {
      expect(joined).not.toContain(secret);
    }
    // Every line is the same bounded shape and nothing else.
    for (const line of everything) {
      expect(line).toMatch(/^test-op model_selection_fallback reason=[a-z_]+$/);
    }
  });

  it("works with no logger at all", async () => {
    const harness = makeHarness({ accessError: { message: RAW_DB_ERROR } });
    const selection = await resolveEffectiveAiModel({
      client: harness.client,
      userId: USER_ID,
      systemDefaultModel: SYSTEM_DEFAULT,
      label: "test-op",
    });
    expect(selection.providerModel).toBe(SYSTEM_DEFAULT);
  });
});

// ── 7. The routing log line and the URL boundary ──────────────────────────

describe("routing log line", () => {
  it("carries the operation, the source, the provider and the public model name", async () => {
    const harness = entitledWith(CATALOG_35);
    const selection = await resolve(harness);
    expect(formatModelRoutingLog("analyze-paper", selection)).toBe(
      "analyze-paper model_routing source=user_preference provider=google model=gemini-3.5-flash",
    );
  });

  it("names the system default when nothing was honoured", async () => {
    const selection = await resolve(makeHarness({ preference: null }));
    expect(formatModelRoutingLog("suggest-organization", selection)).toBe(
      `suggest-organization model_routing source=system_default provider=google model=${SYSTEM_DEFAULT}`,
    );
  });

  it("carries no id, token, key or fallback detail", async () => {
    const harness = makeHarness({
      preference: { preferred_model_id: CATALOG_35.id },
      catalog: { ...CATALOG_35, enabled: false },
    });
    const line = formatModelRoutingLog("analyze-paper", await resolve(harness));
    for (const secret of [USER_ID, TOKEN, API_KEY, CATALOG_35.id, RAW_DB_ERROR]) {
      expect(line).not.toContain(secret);
    }
  });
});

describe("the Gemini URL boundary", () => {
  it("builds the default URL when the system default is in force", async () => {
    const selection = await resolve(makeHarness({ access: [{ can_select_ai_model: false }] }));
    expect(buildGeminiGenerateContentUrl(selection)).toBe(
      `https://generativelanguage.googleapis.com/v1beta/models/${SYSTEM_DEFAULT}:generateContent`,
    );
  });

  it("swaps ONLY the model component for an honoured preference", async () => {
    const preferred = await resolve(entitledWith(CATALOG_35, CATALOG_35.id));
    const fallbackSelection = await resolve(makeHarness({ preference: null }));
    const preferredUrl = buildGeminiGenerateContentUrl(preferred);
    const defaultUrl = buildGeminiGenerateContentUrl(fallbackSelection);

    expect(preferredUrl).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:generateContent",
    );
    // Same host, same version, same endpoint verb — one component differs.
    expect(preferredUrl.replace("gemini-3.5-flash", "M")).toBe(
      defaultUrl.replace(SYSTEM_DEFAULT, "M"),
    );
  });

  // The exact string that goes on the wire for each newly approved model. An
  // assertion on the whole URL rather than on the model component, because the
  // host, the API version and the `:generateContent` verb are just as much part
  // of the contract 001D must not have moved.
  it.each([
    ["gemini-3.7-flash", CATALOG_37],
    ["gemini-3.8-flash", CATALOG_38],
  ])("builds the exact generateContent URL for a catalog-selected %s", async (model, row) => {
    const selection = await resolve(entitledWith(row, row.id));
    expect(buildGeminiGenerateContentUrl(selection)).toBe(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
    );
  });

  it("stays on generativelanguage.googleapis.com for every routing outcome", async () => {
    for (const options of [
      { access: [{ can_select_ai_model: false }] },
      { preference: null },
      { preference: { preferred_model_id: CATALOG_36.id }, catalog: CATALOG_36 },
      { preference: { preferred_model_id: CATALOG_37.id }, catalog: CATALOG_37 },
      { preference: { preferred_model_id: CATALOG_38.id }, catalog: CATALOG_38 },
      {
        preference: { preferred_model_id: CATALOG_35.id },
        catalog: { ...CATALOG_35, provider: "anthropic", provider_model: "claude-sentinel" },
      },
    ] as Options[]) {
      const url = buildGeminiGenerateContentUrl(await resolve(makeHarness(options)));
      expect(url.startsWith("https://generativelanguage.googleapis.com/v1beta/models/")).toBe(true);
      expect(url.endsWith(":generateContent")).toBe(true);
    }
  });
});

// ── 8. The catalog is the allowlist — not a TypeScript list ───────────────

describe("no duplicated runtime allowlist", () => {
  it("routes to whatever the catalog says, including a model this code never heard of", async () => {
    // The proof that there is no hard-coded list: a catalog row naming a model
    // string that appears nowhere in the source is honoured. If a TypeScript
    // allowlist were reintroduced, this would fall back to the default.
    const harness = entitledWith(
      {
        id: "google/some-future-model",
        provider: "google",
        provider_model: "gemini-future-unheard-of",
        enabled: true,
        selectable: true,
      },
      "google/some-future-model",
    );
    const selection = await resolve(harness);
    expect(selection.source).toBe("user_preference");
    expect(selection.providerModel).toBe("gemini-future-unheard-of");
  });

  it("refuses a model the catalog does not have, however plausible its name", async () => {
    const harness = entitledWith(null, "google/gemini-3.5-flash");
    expectSystemDefault(await resolve(harness), "model_missing");
  });
});
