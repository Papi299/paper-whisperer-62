// @vitest-environment node
//
// EDGE-LOG-PRIVACY-HARDENING-001 — fetch-paper-metadata's upstream transport.
//
// This is the path that made the finding urgent: the old inline
// `fetchWithRetry` kept the runtime's own `fetch` error and rethrew it after the
// retry budget, and every caller logged `error.message`. A PubMed URL carries
// the PMID, the DOI or title being searched, and the user's `api_key`; a
// Crossref URL carries the DOI or the title.
//
// The transport now lives in `../upstreamFetch.ts` — shipped code, bundled into
// the deployed function — so these are behavioural tests driven by a fake
// `fetch` that rejects with exactly that hostile error, not source assertions.
// The second describe block additionally pins that the retry/backoff/timeout
// behaviour did not change while the logging did.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  createFetchWithRetry,
  UPSTREAM_DEFAULT_BASE_DELAY_MS,
  UPSTREAM_DEFAULT_MAX_RETRIES,
  UPSTREAM_FETCH_FAILED_MESSAGE,
  UPSTREAM_TIMEOUT_MS,
} from "../upstreamFetch.ts";

const SECRETS = {
  apiKey: "SECRET_VALUE",
  pmid: "12345678",
  doi: "10.1000/xyz123",
  title: "Synthetic Sleep and Memory Study",
  pubmedUrl:
    "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi?db=pubmed&id=12345678&retmode=xml&api_key=SECRET_VALUE",
  crossrefUrl:
    "https://api.crossref.org/works?query.title=Synthetic%20Sleep%20and%20Memory%20Study&rows=1",
} as const;

function expectNoContent(text: string): void {
  for (const [label, secret] of Object.entries(SECRETS)) {
    expect(text, `leaked ${label}`).not.toContain(secret);
  }
  expect(text).not.toContain("api_key");
  expect(text).not.toContain("query.title");
}

interface Harness {
  warnings: string[];
  delays: number[];
  calls: { url: string; init: RequestInit }[];
  fetchWithRetry: ReturnType<typeof createFetchWithRetry>;
}

function harness(fetchImpl: (url: string, init: RequestInit) => Promise<Response>): Harness {
  const warnings: string[] = [];
  const delays: number[] = [];
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchWithRetry = createFetchWithRetry({
    fetchImpl: (url, init) => {
      calls.push({ url, init });
      return fetchImpl(url, init);
    },
    sleep: async (ms) => {
      delays.push(ms);
    },
    logger: { warn: (message) => warnings.push(message) },
    // Injected so the suite never allocates a real 15-second platform timer.
    createTimeoutSignal: () => new AbortController().signal,
  });
  return { warnings, delays, calls, fetchWithRetry };
}

/** The shape a runtime `fetch` failure takes: the URL is inside the message. */
function transportError(url: string): TypeError {
  return new TypeError(`error sending request for url (${url}): connection closed`);
}

describe("a failing upstream fetch leaks nothing into the logs", () => {
  it("keeps the PubMed URL, its query and the api_key out of every log line and the thrown error", async () => {
    const h = harness(() => Promise.reject(transportError(SECRETS.pubmedUrl)));

    await expect(
      h.fetchWithRetry(SECRETS.pubmedUrl, { source: "pubmed", maxRetries: 1 }),
    ).rejects.toThrow(UPSTREAM_FETCH_FAILED_MESSAGE);

    expect(h.warnings.length).toBeGreaterThan(0);
    for (const line of h.warnings) expectNoContent(line);
    // And the thrown error itself, which a caller may log.
    try {
      await h.fetchWithRetry(SECRETS.pubmedUrl, { source: "pubmed", maxRetries: 1 });
    } catch (error) {
      expectNoContent((error as Error).message);
      expect((error as Error).message).toBe(UPSTREAM_FETCH_FAILED_MESSAGE);
      expectNoContent(String((error as Error).stack ?? ""));
      expect((error as Error & { cause?: unknown }).cause).toBeUndefined();
    }
  });

  it("keeps Crossref's DOI and title query out of the logs", async () => {
    const h = harness(() => Promise.reject(transportError(SECRETS.crossrefUrl)));
    await expect(
      h.fetchWithRetry(SECRETS.crossrefUrl, { source: "crossref" }),
    ).rejects.toThrow(UPSTREAM_FETCH_FAILED_MESSAGE);
    for (const line of h.warnings) expectNoContent(line);
  });

  it("logs the bounded facts that make a failure diagnosable", async () => {
    const h = harness(() => Promise.reject(transportError(SECRETS.pubmedUrl)));
    await expect(h.fetchWithRetry(SECRETS.pubmedUrl, { source: "pubmed", maxRetries: 1 })).rejects.toThrow();

    expect(h.warnings[0]).toBe(
      "upstream_retry source=pubmed error=TypeError attempt=1 delay_ms=1000 retry=1",
    );
    expect(h.warnings.at(-1)).toBe(
      "upstream_fetch_failed source=pubmed attempts=2 error=TypeError retry=0",
    );
  });

  it("reduces a non-Error rejection without stringifying it", async () => {
    const h = harness(() => Promise.reject(SECRETS.pubmedUrl));
    await expect(h.fetchWithRetry(SECRETS.pubmedUrl, { source: "pubmed", maxRetries: 0 })).rejects.toThrow();
    for (const line of h.warnings) expectNoContent(line);
    expect(h.warnings.at(-1)).toContain("error=non_error");
  });

  it("reduces a timeout to its name", async () => {
    const h = harness(() => Promise.reject(Object.assign(new Error("x"), { name: "TimeoutError" })));
    await expect(h.fetchWithRetry(SECRETS.pubmedUrl, { source: "pubmed", maxRetries: 0 })).rejects.toThrow();
    expect(h.warnings.at(-1)).toContain("error=TimeoutError");
  });

  it("logs no URL when an upstream returns a retryable status", async () => {
    const h = harness(() => Promise.resolve(new Response("", { status: 429 })));
    await h.fetchWithRetry(SECRETS.pubmedUrl, { source: "pubmed", maxRetries: 1 });
    for (const line of h.warnings) expectNoContent(line);
    expect(h.warnings[0]).toBe(
      "upstream_retry source=pubmed status=429 attempt=1 delay_ms=1000 retry=1",
    );
  });
});

describe("the retry contract is unchanged by the hardening", () => {
  it("keeps the previous default budget and backoff", async () => {
    expect(UPSTREAM_DEFAULT_MAX_RETRIES).toBe(3);
    expect(UPSTREAM_DEFAULT_BASE_DELAY_MS).toBe(1000);
    expect(UPSTREAM_TIMEOUT_MS).toBe(15_000);

    const h = harness(() => Promise.resolve(new Response("", { status: 503 })));
    await h.fetchWithRetry(SECRETS.crossrefUrl, { source: "crossref" });
    // 4 attempts (1 + 3 retries) and exponential 1s / 2s / 4s, exactly as the
    // inline implementation did.
    expect(h.calls).toHaveLength(4);
    expect(h.delays).toEqual([1000, 2000, 4000]);
  });

  it("keeps the reduced PubMed budget of one retry", async () => {
    const h = harness(() => Promise.resolve(new Response("", { status: 500 })));
    await h.fetchWithRetry(SECRETS.pubmedUrl, { source: "pubmed", maxRetries: 1 });
    expect(h.calls).toHaveLength(2);
    expect(h.delays).toEqual([1000]);
  });

  it("returns the last response rather than throwing when the budget ends on a status", async () => {
    const h = harness(() => Promise.resolve(new Response("", { status: 503 })));
    const response = await h.fetchWithRetry(SECRETS.pubmedUrl, { source: "pubmed", maxRetries: 1 });
    expect(response.status).toBe(503);
  });

  it("does not retry a non-retryable status", async () => {
    for (const status of [200, 400, 404]) {
      const h = harness(() => Promise.resolve(new Response("", { status })));
      const response = await h.fetchWithRetry(SECRETS.pubmedUrl, { source: "pubmed" });
      expect(response.status).toBe(status);
      expect(h.calls).toHaveLength(1);
      expect(h.delays).toEqual([]);
    }
  });

  it("recovers on a later attempt exactly as before", async () => {
    let attempt = 0;
    const h = harness(() => {
      attempt += 1;
      return attempt === 1
        ? Promise.reject(transportError(SECRETS.pubmedUrl))
        : Promise.resolve(new Response("ok", { status: 200 }));
    });
    const response = await h.fetchWithRetry(SECRETS.pubmedUrl, { source: "pubmed", maxRetries: 1 });
    expect(response.status).toBe(200);
    expect(h.calls).toHaveLength(2);
  });

  it("passes the caller's init through and attaches a per-attempt signal", async () => {
    const h = harness(() => Promise.resolve(new Response("", { status: 200 })));
    await h.fetchWithRetry(SECRETS.crossrefUrl, {
      source: "crossref",
      init: { headers: { "User-Agent": "PaperIndex/1.0 (mailto:support@paperindex.app)" } },
    });
    const [call] = h.calls;
    expect((call.init.headers as Record<string, string>)["User-Agent"]).toBe(
      "PaperIndex/1.0 (mailto:support@paperindex.app)",
    );
    expect(call.init.signal).toBeDefined();
    expect(call.url).toBe(SECRETS.crossrefUrl);
  });
});

describe("fetch-paper-metadata source keeps the boundary wired (guard)", () => {
  const SOURCE = readFileSync(fileURLToPath(new URL("../index.ts", import.meta.url)), "utf8");
  const CODE = SOURCE.replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !line.trim().startsWith("//"))
    .join("\n");

  it("passes no `.message` to any logger call", () => {
    const offenders = CODE.split("\n").filter(
      (line) => /console\.(log|warn|error)\(/.test(line) && /\.message/.test(line),
    );
    expect(offenders).toEqual([]);
  });

  it("never stringifies a throwable and keeps no raw error across attempts", () => {
    expect(CODE).not.toMatch(/String\(\s*error\b/);
    expect(CODE).not.toContain("lastError");
    expect(CODE).not.toMatch(/\.stack\b/);
  });

  it("routes every upstream call through the tested transport", () => {
    expect(CODE).toContain("createFetchWithRetry(");
    expect(CODE).toContain('from "./upstreamFetch.ts"');
    // No second copy of the retry loop or the timeout ceiling came back.
    expect(CODE).not.toMatch(/AbortSignal\.timeout/);
    expect(CODE).not.toMatch(/Math\.pow\(2, attempt\)/);
    expect(CODE).not.toContain("15_000");
    // Every call site declares its upstream, so each log line is attributable.
    // Counted over the call blocks themselves: `source: "pubmed"` also appears
    // in the returned metadata schema, which is a different field entirely.
    const callBlocks = [...CODE.matchAll(/fetchWithRetry\(url, \{/g)].map((m) =>
      CODE.slice(m.index ?? 0, (m.index ?? 0) + 220),
    );
    expect(callBlocks).toHaveLength(5);
    expect(callBlocks.filter((b) => b.includes('source: "pubmed"'))).toHaveLength(3);
    expect(callBlocks.filter((b) => b.includes('source: "crossref"'))).toHaveLength(2);
    for (const block of callBlocks) expect(block).toMatch(/source: "(pubmed|crossref)"/);
  });

  it("reduces each upstream catch to an allow-listed error name", () => {
    for (const label of [
      "pubmed_fetch_failed",
      "crossref_doi_fetch_failed",
      "crossref_title_search_failed",
      "request_failed",
    ]) {
      expect(CODE).toContain(`fetch-paper-metadata ${label} error=\${boundedErrorName(error)}`);
    }
    expect(CODE).toContain('from "../_shared/boundedLogging.ts"');
  });

  it("names a missing variable without logging the thrown message", () => {
    expect(CODE).toContain('requireEdgeEnvLogged("SUPABASE_URL")');
    expect(CODE).toContain('requireEdgeEnvLogged("SUPABASE_ANON_KEY")');
    expect(CODE).toContain("console.error(`fetch-paper-metadata env_missing env=${name}`);");
  });

  it("leaves the Crossref contact identity alone — CROSSREF-CONTACT-IDENTITY-001", () => {
    // Out of scope here on purpose: the owner-approved PaperLume contact has
    // not been supplied, so this task must not opportunistically change it.
    expect(CODE.match(/PaperIndex\/1\.0 \(mailto:support@paperindex\.app\)/g)).toHaveLength(2);
  });
});
