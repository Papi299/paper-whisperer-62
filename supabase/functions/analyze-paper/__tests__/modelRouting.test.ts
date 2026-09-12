// @vitest-environment node
//
// Node, not jsdom: this suite reads a committed source file, and jsdom
// substitutes the global `URL` so a relative reference resolves against the
// document base rather than `import.meta.url` — the same reason the sibling
// `providerTransport.test.ts` takes this pragma.
//
// AI-MODEL-SELECTION-001B — analyze-paper's per-user model routing.
//
// ## Why this suite is half executed and half read
//
// `analyze-paper/index.ts` is a single `Deno.serve` shell with remote
// (`https://esm.sh/…`) imports, so Vitest cannot import and run it the way it
// runs `suggest-paper-organization/handler.ts`. Extracting its whole request
// path is a redesign this task excludes.
//
// So the split is deliberate, and it is not a gap:
//
//   * The DECISION is executed. `analyze-paper` contains no routing logic of
//     its own — every branch lives in `_shared/aiModelSelection.ts`, which this
//     suite drives end to end with a fake caller-scoped client, once per
//     required routing case, through to the exact provider URL that would be
//     POSTed. The `suggest-paper-organization` handler suite additionally runs
//     that same shared module inside a complete request, with a fake `fetch`, so
//     the composition is proven executable there too.
//
//   * The WIRING is read. What remains for this file is that the shipped Edge
//     Function calls that shared decision, with the authoritative identity, in
//     the right order relative to quota, and that nothing else in the file can
//     supply a model string. Reading committed source as a contract is an
//     existing convention here (the extension's manifest-permission and
//     no-network boundary suites, and this function's own transport suite).
//
// No provider is contacted: there is no `fetch` in this file at all.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  resolveEffectiveAiModel,
  type AiModelSelectionClient,
} from "../../_shared/aiModelSelection.ts";
import {
  getAiProviderAdapter,
  resolveSystemDefaultAiModel,
} from "../../_shared/aiProviderRegistry.ts";
import {
  buildGeminiGenerateContentUrl,
  GOOGLE_AI_PROVIDER_ADAPTER,
} from "../../_shared/googleAiProvider.ts";
import { resolveGeminiModel } from "../../_shared/geminiModel.ts";
import {
  GEMINI_PROVIDER_MAX_RETRIES,
  GEMINI_PROVIDER_TIMEOUT_MS,
} from "../../_shared/geminiTransport.ts";
import { buildAnalyzeGenerationRequest } from "../prompt.ts";

const INDEX_PATH = fileURLToPath(new URL("../index.ts", import.meta.url));
const SOURCE = readFileSync(INDEX_PATH, "utf8");

/**
 * The shipped source with its comments removed.
 *
 * "This function no longer knows X" is a claim about code. A comment saying the
 * Google adapter owns the `x-goog-api-key` header, or a preserved log string
 * reading "no candidates/text", must not read as evidence that this file still
 * speaks the protocol.
 */
const CODE = SOURCE.replace(/\/\*[\s\S]*?\*\//g, "")
  .split("\n")
  .filter((line) => !line.trim().startsWith("//"))
  .join("\n");

// The model Production currently configures, resolved exactly as the function
// resolves it. Written as a variable rather than a literal so this suite makes
// no claim about which model Production runs.
const PRODUCTION_DEFAULT = resolveGeminiModel("gemini-3.6-flash");
const USER_ID = "11111111-2222-4333-8444-555555555555";

const CATALOG = {
  "google/gemini-3.5-flash": {
    id: "google/gemini-3.5-flash",
    provider: "google",
    provider_model: "gemini-3.5-flash",
    enabled: true,
    selectable: true,
  },
  "google/gemini-3.6-flash": {
    id: "google/gemini-3.6-flash",
    provider: "google",
    provider_model: "gemini-3.6-flash",
    enabled: true,
    selectable: true,
  },
  // AI-MODEL-SELECTION-001D (C35). Added to this fixture and nowhere else in
  // the shipped function — see "names no concrete model string of its own"
  // below, which reads the committed source and would fail if either id had
  // been written into `index.ts`.
  "google/gemini-3.7-flash": {
    id: "google/gemini-3.7-flash",
    provider: "google",
    provider_model: "gemini-3.7-flash",
    enabled: true,
    selectable: true,
  },
  "google/gemini-3.8-flash": {
    id: "google/gemini-3.8-flash",
    provider: "google",
    provider_model: "gemini-3.8-flash",
    enabled: true,
    selectable: true,
  },
} as const;

interface Scenario {
  entitled?: boolean;
  preferredModelId?: string | null;
  catalogRow?: Record<string, unknown> | null;
}

interface Recorded {
  rpcCalls: string[];
  tables: string[];
}

/** A caller-scoped client exactly as analyze-paper builds one: reads only. */
function makeClient(scenario: Scenario, recorded: Recorded): AiModelSelectionClient {
  return {
    rpc(fn: string) {
      recorded.rpcCalls.push(fn);
      return Promise.resolve({
        data: [{ role: "user", can_select_ai_model: scenario.entitled !== false }],
        error: null,
      });
    },
    from(table: string) {
      recorded.tables.push(table);
      const builder = {
        eq: () => builder,
        maybeSingle: () =>
          Promise.resolve({
            data:
              table === "user_ai_preferences"
                ? scenario.preferredModelId
                  ? { preferred_model_id: scenario.preferredModelId }
                  : null
                : (scenario.catalogRow ?? null),
            error: null,
          }),
      };
      return { select: () => builder };
    },
  };
}

/**
 * Run the exact decision analyze-paper runs, then resolve the adapter exactly
 * as analyze-paper resolves it, and return the URL that adapter would POST to.
 *
 * Since AI-MULTI-PROVIDER-001A the URL is the Google adapter's to build, so
 * this composition — resolver → registry → adapter → URL — is the real shipped
 * path rather than a re-implementation of it.
 */
async function routeToUrl(
  scenario: Scenario,
): Promise<{ url: string; provider: string; recorded: Recorded }> {
  const recorded: Recorded = { rpcCalls: [], tables: [] };
  const selection = await resolveEffectiveAiModel({
    client: makeClient(scenario, recorded),
    userId: USER_ID,
    systemDefault: resolveSystemDefaultAiModel(PRODUCTION_DEFAULT),
    label: "analyze-paper",
  });
  const adapter = getAiProviderAdapter(selection.provider);
  return { url: buildGeminiGenerateContentUrl(selection), provider: adapter.provider, recorded };
}

const urlFor = (model: string) =>
  `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;

// ── 1. The routing outcomes, executed ─────────────────────────────────────

describe("analyze-paper routes to the right model", () => {
  it("uses the system default when the caller has no preference", async () => {
    const { url } = await routeToUrl({ entitled: true, preferredModelId: null });
    expect(url).toBe(urlFor(PRODUCTION_DEFAULT));
  });

  it("uses a valid Gemini 3.5 preference", async () => {
    const { url } = await routeToUrl({
      entitled: true,
      preferredModelId: "google/gemini-3.5-flash",
      catalogRow: { ...CATALOG["google/gemini-3.5-flash"] },
    });
    expect(url).toBe(urlFor("gemini-3.5-flash"));
  });

  it("uses a valid Gemini 3.6 preference", async () => {
    const { url } = await routeToUrl({
      entitled: true,
      preferredModelId: "google/gemini-3.6-flash",
      catalogRow: { ...CATALOG["google/gemini-3.6-flash"] },
    });
    expect(url).toBe(urlFor("gemini-3.6-flash"));
  });

  // The 001D models, routed by the same code path and asserted the same way as
  // 3.5 and 3.6 above. Parameterized rather than copied four times: the point is
  // not that each model works in isolation, it is that Analyze needs no
  // per-model branch at all.
  it.each([
    ["google/gemini-3.7-flash", "gemini-3.7-flash"],
    ["google/gemini-3.8-flash", "gemini-3.8-flash"],
  ])("routes a catalog-selected %s to its own provider URL", async (id, providerModel) => {
    const { url } = await routeToUrl({
      entitled: true,
      preferredModelId: id,
      catalogRow: { ...CATALOG[id as keyof typeof CATALOG] },
    });
    expect(url).toBe(urlFor(providerModel));
    expect(url).not.toContain(PRODUCTION_DEFAULT);
  });

  it("ignores a DORMANT preference belonging to a caller who is no longer entitled", async () => {
    // The row deliberately survives a downgrade. Entitlement is re-proven per
    // request, so the row's existence grants nothing.
    const { url, recorded } = await routeToUrl({
      entitled: false,
      preferredModelId: "google/gemini-3.5-flash",
      catalogRow: { ...CATALOG["google/gemini-3.5-flash"] },
    });
    expect(url).toBe(urlFor(PRODUCTION_DEFAULT));
    // It was not even read.
    expect(recorded.tables).toEqual([]);
  });

  it("ignores a preference whose model has been retired (enabled = false)", async () => {
    const { url } = await routeToUrl({
      entitled: true,
      preferredModelId: "google/gemini-3.5-flash",
      catalogRow: { ...CATALOG["google/gemini-3.5-flash"], enabled: false },
    });
    expect(url).toBe(urlFor(PRODUCTION_DEFAULT));
  });

  it("keeps honouring a preference whose model is merely non-selectable", async () => {
    const { url } = await routeToUrl({
      entitled: true,
      preferredModelId: "google/gemini-3.5-flash",
      catalogRow: { ...CATALOG["google/gemini-3.5-flash"], selectable: false },
    });
    expect(url).toBe(urlFor("gemini-3.5-flash"));
  });

  it("ignores a preference naming a provider with no adapter", async () => {
    const { url } = await routeToUrl({
      entitled: true,
      preferredModelId: "google/gemini-3.5-flash",
      catalogRow: {
        ...CATALOG["google/gemini-3.5-flash"],
        provider: "anthropic",
        provider_model: "claude-sentinel",
      },
    });
    expect(url).toBe(urlFor(PRODUCTION_DEFAULT));
    expect(url).not.toContain("claude-sentinel");
  });

  it("ignores a preference whose catalog row is missing", async () => {
    const { url } = await routeToUrl({
      entitled: true,
      preferredModelId: "google/gemini-3.5-flash",
      catalogRow: null,
    });
    expect(url).toBe(urlFor(PRODUCTION_DEFAULT));
  });

  it("adds no provider request — routing is database reads only", async () => {
    const { recorded } = await routeToUrl({
      entitled: true,
      preferredModelId: "google/gemini-3.5-flash",
      catalogRow: { ...CATALOG["google/gemini-3.5-flash"] },
    });
    // One access RPC and two metadata SELECTs. No quota RPC, no fetch — this
    // file imports no `fetch` and defines none.
    expect(recorded.rpcCalls).toEqual(["get_current_user_access"]);
    expect(recorded.tables).toEqual(["user_ai_preferences", "ai_model_catalog"]);
    expect(recorded.rpcCalls).not.toContain("consume_ai_quota");
    expect(recorded.rpcCalls).not.toContain("refund_ai_quota");
  });
});

// ── 2. The wiring, read from the shipped source ───────────────────────────

describe("analyze-paper is wired to the shared selection module", () => {
  it("calls the shared resolver rather than deciding anything locally", () => {
    expect(SOURCE).toContain('from "../_shared/aiModelSelection.ts"');
    expect(SOURCE).toContain("resolveEffectiveAiModel({");
    // Exactly one call site: two would be two decisions.
    expect(SOURCE.match(/resolveEffectiveAiModel\(/g)?.length).toBe(1);
  });

  it("keeps the system default as the resolver's fallback input", () => {
    // Provider + model metadata since AI-MULTI-PROVIDER-001A, still resolved
    // from the one trusted GEMINI_MODEL environment value.
    expect(SOURCE).toContain('resolveSystemDefaultAiModel(Deno.env.get("GEMINI_MODEL"))');
    expect(SOURCE).toContain("systemDefault,");
  });

  it("passes the authoritative getUser() identity, never a body field", () => {
    expect(SOURCE).toContain("userId: user.id,");
    // The body is destructured exactly once, for exactly two fields.
    expect(SOURCE).toContain("const { title, abstract } = await req.json();");
    expect(SOURCE.match(/await req\.json\(\)/g)?.length).toBe(1);
  });

  it("hands the resolver the caller-scoped client, not an elevated one", () => {
    expect(SOURCE).toContain("client: supabase as unknown as AiModelSelectionClient");
    // The only client this function constructs is the anon-key +
    // caller-token one. (The other `createClient(` in the file is inside a
    // comment, hence the anchored match rather than a bare count.)
    expect(SOURCE.match(/const supabase = createClient\(/g)?.length).toBe(1);
    expect(SOURCE).toContain('requireEdgeEnv("SUPABASE_ANON_KEY")');
    expect(SOURCE).not.toContain("SERVICE_ROLE");
  });

  it("resolves the model after body validation and before the quota unit", () => {
    const validation = SOURCE.indexOf("Missing or invalid 'abstract' field");
    const selection = SOURCE.indexOf("resolveEffectiveAiModel({");
    const quota = SOURCE.indexOf('"consume_ai_quota"');
    expect(validation).toBeGreaterThan(-1);
    expect(validation).toBeLessThan(selection);
    expect(selection).toBeLessThan(quota);
  });

  it("reaches the provider only through the registered adapter", () => {
    // AI-MULTI-PROVIDER-001A: the selection names a provider, the registry
    // hands back that provider's adapter, and the adapter is the only way out.
    expect(SOURCE).toContain('from "../_shared/aiProviderRegistry.ts"');
    expect(SOURCE).toContain("getAiProviderAdapter(modelSelection.provider)");
    expect(SOURCE.match(/providerAdapter\.generate\(/g)?.length).toBe(1);
    // The lookup is total by construction, so there is no adapter-missing
    // branch here that could turn routing metadata into a user-visible error.
    expect(SOURCE).not.toMatch(/providerAdapter\s*===?\s*(null|undefined)/);
    expect(SOURCE).not.toMatch(/if\s*\(\s*!\s*providerAdapter/);
  });

  it("knows no Gemini URL, envelope, credential header or response envelope", () => {
    // The four things AI-MULTI-PROVIDER-001A requires this function to stop
    // knowing. Asserted against CODE: prose describing what the adapter owns,
    // and the preserved "no candidates/text" log string, are not knowledge of
    // the protocol.
    expect(CODE).not.toContain("generativelanguage.googleapis.com");
    expect(CODE).not.toContain("system_instruction");
    expect(CODE).not.toContain("generationConfig");
    expect(CODE).not.toContain("responseMimeType");
    expect(CODE).not.toContain("x-goog-api-key");
    expect(CODE).not.toContain(".candidates");
    expect(CODE).not.toContain("content.parts");
    expect(CODE).not.toContain("buildGeminiGenerateContentUrl");
    // And it no longer calls the Gemini transport directly — the adapter does.
    expect(CODE).not.toContain("callGeminiWithRetry");
    expect(CODE).not.toContain('from "../_shared/geminiTransport.ts"');
  });

  it("uses the selection for exactly four things, all of them local", () => {
    const uses = SOURCE.match(/\bmodelSelection\b/g) ?? [];
    // Declaration, adapter lookup, routing log, and the generate() argument.
    expect(uses.length).toBe(4);
    expect(SOURCE).toContain('formatModelRoutingLog("analyze-paper", modelSelection)');
  });
});

// ── 3. No caller-supplied model, no caller-supplied identity ──────────────

describe("no model can enter from the request", () => {
  it("reads no model field from the body, the query string or a header", () => {
    // The only header read is Authorization; the only body fields are title and
    // abstract; there is no URL parsing at all.
    expect(SOURCE.match(/req\.headers\.get\(/g)?.length).toBe(1);
    expect(SOURCE).toContain('req.headers.get("Authorization")');
    expect(SOURCE).not.toMatch(/searchParams/);
    expect(SOURCE).not.toMatch(/new URL\(\s*req/);
    // No body/query/header destructuring or lookup that could name a model.
    expect(SOURCE).not.toMatch(/\bmodel\s*[:=]\s*(body|payload|params|query)\b/);
  });

  it("names no concrete model string of its own", () => {
    // The two sources are GEMINI_MODEL and the catalog. A literal here would be
    // a third, and a silent one.
    expect(SOURCE).not.toContain("gemini-3");
    expect(SOURCE).not.toContain("gemini-flash-latest");
    expect(SOURCE).not.toMatch(/models\/gemini/);
  });

  it("reads no user id from the request", () => {
    expect(SOURCE).not.toMatch(/\buserId\b\s*=\s*(body|payload)/);
    expect(SOURCE).not.toContain("p_user_id: body");
    // Both quota RPCs are scoped to the authenticated id: `consume_ai_quota`
    // passes `user.id` directly, and the refund helper's `userId` parameter is
    // only ever called with `user.id` (twice, asserted below).
    expect(SOURCE).toContain("{ p_user_id: user.id }");
    expect(SOURCE).toContain('rpc("refund_ai_quota", { p_user_id: userId })');
    expect(SOURCE.match(/safeRefundAiQuota\(supabase, user\.id\)/g)?.length).toBe(2);
    expect(SOURCE.match(/safeRefundAiQuota\(/g)?.length).toBe(3);
  });
});

// ── 4. Everything else about the provider call is unchanged ───────────────

describe("model selection changes the model and nothing else", () => {
  it("leaves the request independent of the model — structurally, not by luck", () => {
    // The request builder takes `title` and `abstract` and nothing else, so a
    // preference cannot change the prompt, only the endpoint. Executable since
    // AI-MULTI-PROVIDER-001A moved the prompt into an importable module.
    const request = buildAnalyzeGenerationRequest("A title", "An abstract.");
    expect(Object.keys(request).sort()).toEqual([
      "responseFormat",
      "systemInstruction",
      "userContent",
    ]);
    expect(request.userContent).toBe("Title: A title\n\nAbstract: An abstract.");
    expect(buildAnalyzeGenerationRequest.length).toBe(2);
    const serialized = JSON.stringify(request);
    for (const forbidden of ["gemini-3", "gemini-flash-latest", "GEMINI_MODEL", "provider"]) {
      expect(serialized).not.toContain(forbidden);
    }
    // The call site passes exactly those two body fields.
    expect(SOURCE).toContain("buildAnalyzeGenerationRequest(title, abstract)");
  });

  it("keeps JSON response mode and no sampling override", () => {
    // The mode is now stated provider-neutrally here and translated by the
    // Google adapter (whose suite pins `responseMimeType: "application/json"`).
    expect(buildAnalyzeGenerationRequest("t", "a").responseFormat).toBe("json");
    expect(SOURCE).not.toMatch(/\btemperature\s*:/);
    expect(SOURCE).not.toMatch(/\b(topP|topK|top_p|top_k)\s*:/);
  });

  it("keeps one shared API key, handed to the adapter rather than to a header", () => {
    expect(SOURCE.match(/Deno\.env\.get\("GEMINI_API_KEY"\)/g)?.length).toBe(1);
    expect(SOURCE).toContain("apiKey: geminiKey,");
    // The credential header itself is the adapter's business now.
    expect(CODE).not.toContain("x-goog-api-key");
    // No per-model or per-user credential was introduced, and no second
    // provider's credential exists.
    expect(SOURCE).not.toMatch(/GEMINI_API_KEY_/);
    expect(SOURCE).not.toMatch(/ANTHROPIC|OPENAI/);
  });

  it("still consumes exactly one quota unit, from one call site", () => {
    expect(SOURCE.match(/rpc\(\s*\n?\s*"consume_ai_quota"/g)?.length).toBe(1);
  });

  it("still refunds from exactly the two pre-existing call sites", () => {
    expect(SOURCE.match(/safeRefundAiQuota\(supabase, user\.id\)/g)?.length).toBe(2);
    // Neither of them is a model-selection path.
    expect(SOURCE).not.toMatch(/model_selection[\s\S]{0,120}safeRefundAiQuota/);
    expect(SOURCE).not.toMatch(/resolveEffectiveAiModel[\s\S]{0,400}safeRefundAiQuota/);
  });

  it("makes exactly one provider call site", () => {
    expect(SOURCE.match(/providerAdapter\.generate\(/g)?.length).toBe(1);
  });

  it("inherits the 90-second, zero-retry transport policy unchanged", () => {
    expect(GEMINI_PROVIDER_TIMEOUT_MS).toBe(90_000);
    expect(GEMINI_PROVIDER_MAX_RETRIES).toBe(0);
    // And pins none of it locally — neither does the adapter it now calls
    // through, which is asserted executably in the Google adapter suite.
    expect(SOURCE).not.toMatch(/90_?000/);
    expect(SOURCE).not.toMatch(/AbortSignal\.timeout/);
    expect(GOOGLE_AI_PROVIDER_ADAPTER.provider).toBe("google");
  });

  it("keeps a metadata problem out of the quota and error paths", () => {
    // The resolver cannot throw, so there is no try/catch around it and no 402
    // or 500 attributable to model selection. The only 402 remains the quota
    // wall, and it still sits above the provider call.
    expect(SOURCE.match(/status: 402/g)?.length).toBe(1);
    expect(SOURCE.indexOf("status: 402")).toBeLessThan(
      SOURCE.indexOf("providerAdapter.generate("),
    );
    expect(SOURCE).not.toMatch(/model_selection[\s\S]{0,200}status: (402|500)/);
  });
});
