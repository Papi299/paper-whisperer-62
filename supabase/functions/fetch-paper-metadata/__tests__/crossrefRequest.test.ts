// @vitest-environment node
//
// CROSSREF-OPERATIONAL-IDENTITY-001A — the identity every Crossref request carries.
//
// Behavioural first: the URL builders and the request init are the shipped
// module, and the transport is the shipped `createFetchWithRetry` driven by a
// fake `fetch`, so these tests see exactly what would leave the Edge Function.
// The source guard at the end is an additional check that nothing shipped still
// carries the retired identity; it is not the proof on its own.
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  CROSSREF_CONTACT_EMAIL,
  CROSSREF_USER_AGENT,
  crossrefRequestInit,
  crossrefTitleSearchUrl,
  crossrefWorkUrl,
} from "../crossrefRequest.ts";
import { createFetchWithRetry, UPSTREAM_FETCH_FAILED_MESSAGE } from "../upstreamFetch.ts";

const EXPECTED_USER_AGENT = "PaperLume/1.0 (mailto:mutrisport@gmail.com)";
const EXPECTED_CONTACT = "mutrisport@gmail.com";
/** Crossref's own pattern for the `mailto` parameter, from its OpenAPI description (api.crossref.org). */
const CROSSREF_MAILTO_PATTERN = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+\.[A-Za-z]{2,6}$/;
/** The retired identity, and a mailbox that is not active yet. */
const RETIRED = ["PaperIndex", "paperindex", "support@paperindex.app"];
const INACTIVE_MAILBOX = "support@paperlume.app";

const DOI = "10.1000/xyz123";
const TITLE = "Synthetic Sleep and Memory Study";

function userAgentOf(init: RequestInit): string | null {
  return new Headers(init.headers).get("User-Agent");
}

describe("the canonical Crossref identity", () => {
  it("is PaperLume's, with the published operator contact", () => {
    expect(CROSSREF_USER_AGENT).toBe(EXPECTED_USER_AGENT);
    expect(CROSSREF_CONTACT_EMAIL).toBe(EXPECTED_CONTACT);
    expect(userAgentOf(crossrefRequestInit())).toBe(EXPECTED_USER_AGENT);
  });

  it("uses a contact that Crossref's own `mailto` pattern accepts", () => {
    expect(CROSSREF_CONTACT_EMAIL).toMatch(CROSSREF_MAILTO_PATTERN);
  });

  it("names neither the retired identity nor the inactive mailbox", () => {
    for (const value of [CROSSREF_USER_AGENT, CROSSREF_CONTACT_EMAIL, crossrefWorkUrl(DOI), crossrefTitleSearchUrl(TITLE)]) {
      for (const retired of RETIRED) expect(value).not.toContain(retired);
      expect(value).not.toContain(INACTIVE_MAILBOX);
    }
  });

  it("hands every caller a fresh init, so one request cannot alter another's identity", () => {
    const first = crossrefRequestInit();
    (first.headers as Record<string, string>)["User-Agent"] = "tampered";
    expect(userAgentOf(crossrefRequestInit())).toBe(EXPECTED_USER_AGENT);
  });
});

describe("the DOI lookup URL", () => {
  it("is /works/{doi}, the DOI one encoded path segment, the contact as `mailto`", () => {
    expect(crossrefWorkUrl(DOI)).toBe(
      "https://api.crossref.org/works/10.1000%2Fxyz123?mailto=mutrisport@gmail.com",
    );
  });

  it("encodes a hostile DOI exactly once and adds nothing but `mailto`", () => {
    for (const doi of [
      "10.1000/a#b",
      "10.1000/a?rows=50&mailto=x@evil.example",
      "10.1000/50%off",
      "10.1000/a b+c",
      "10.1002/(SICI)1097-4636(199706)35:4<405::AID-JBM1>3.0.CO;2-E",
      "10.1000/ünïcode",
    ]) {
      const url = new URL(crossrefWorkUrl(doi));
      expect(url.origin).toBe("https://api.crossref.org");
      expect(url.pathname).toBe(`/works/${encodeURIComponent(doi)}`);
      // One decode gives the DOI back, so it was encoded once, not twice.
      expect(decodeURIComponent(url.pathname.slice("/works/".length))).toBe(doi);
      expect([...url.searchParams]).toEqual([["mailto", EXPECTED_CONTACT]]);
      expect(url.hash).toBe("");
    }
  });
});

describe("the title search URL", () => {
  it("keeps the encoded `query.title` and `rows=1`, then adds the contact", () => {
    expect(crossrefTitleSearchUrl(TITLE)).toBe(
      "https://api.crossref.org/works?query.title=Synthetic%20Sleep%20and%20Memory%20Study&rows=1&mailto=mutrisport@gmail.com",
    );
  });

  it("round-trips a hostile title, which cannot add or steer a parameter", () => {
    for (const title of [
      "A & B = C?",
      "x&rows=50&mailto=x@evil.example",
      "100% + more #1",
      "Ünïcødé — title",
      "  spaced  ",
    ]) {
      const raw = crossrefTitleSearchUrl(title);
      const url = new URL(raw);
      expect(url.pathname).toBe("/works");
      expect([...url.searchParams.keys()]).toEqual(["query.title", "rows", "mailto"]);
      expect(url.searchParams.get("query.title")).toBe(title);
      expect(url.searchParams.get("rows")).toBe("1");
      expect(url.searchParams.get("mailto")).toBe(EXPECTED_CONTACT);
      // The title is encoded exactly as it was before this change.
      expect(raw).toContain(`?query.title=${encodeURIComponent(title)}&rows=1&`);
    }
  });
});

interface Harness {
  warnings: string[];
  calls: { url: string; init: RequestInit }[];
  fetchWithRetry: ReturnType<typeof createFetchWithRetry>;
}

function harness(fetchImpl: () => Promise<Response>): Harness {
  const warnings: string[] = [];
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchWithRetry = createFetchWithRetry({
    fetchImpl: (url, init) => {
      calls.push({ url, init });
      return fetchImpl();
    },
    sleep: async () => {},
    logger: { warn: (message) => warnings.push(message) },
    createTimeoutSignal: () => new AbortController().signal,
  });
  return { warnings, calls, fetchWithRetry };
}

const REQUESTS = [
  ["DOI lookup", crossrefWorkUrl(DOI)],
  ["title search", crossrefTitleSearchUrl(TITLE)],
] as const;

describe("through the shipped transport", () => {
  it.each(REQUESTS)("%s: every retried attempt carries the same identity", async (_, url) => {
    const h = harness(() => Promise.resolve(new Response("", { status: 503 })));
    await h.fetchWithRetry(url, { source: "crossref", init: crossrefRequestInit() });

    expect(h.calls).toHaveLength(4); // 1 + the unchanged Crossref budget of 3 retries
    for (const call of h.calls) {
      expect(call.url).toBe(url);
      expect(userAgentOf(call.init)).toBe(EXPECTED_USER_AGENT);
      expect(new URL(call.url).searchParams.get("mailto")).toBe(EXPECTED_CONTACT);
      expect(call.init.signal).toBeDefined();
    }
  });

  it.each(REQUESTS)("%s: the identity survives a thrown attempt", async (_, url) => {
    let attempt = 0;
    const h = harness(() => {
      attempt += 1;
      return attempt === 1
        ? Promise.reject(new TypeError(`error sending request for url (${url}): connection closed`))
        : Promise.resolve(new Response("{}", { status: 200 }));
    });
    const response = await h.fetchWithRetry(url, { source: "crossref", init: crossrefRequestInit() });

    expect(response.status).toBe(200);
    expect(h.calls).toHaveLength(2);
    for (const call of h.calls) expect(userAgentOf(call.init)).toBe(EXPECTED_USER_AGENT);
  });

  it.each(REQUESTS)("%s: a URL-bearing failure logs no DOI, title or contact", async (_, url) => {
    const h = harness(() =>
      Promise.reject(new TypeError(`error sending request for url (${url}): connection closed`)),
    );

    let thrown: unknown;
    try {
      await h.fetchWithRetry(url, { source: "crossref", init: crossrefRequestInit() });
    } catch (error) {
      thrown = error;
    }

    expect((thrown as Error).message).toBe(UPSTREAM_FETCH_FAILED_MESSAGE);
    expect(h.warnings).toHaveLength(4);
    expect(h.warnings.at(-1)).toBe("upstream_fetch_failed source=crossref attempts=4 error=TypeError retry=0");
    const logged = [...h.warnings, (thrown as Error).message, String((thrown as Error).stack ?? "")].join("\n");
    for (const content of [
      DOI,
      encodeURIComponent(DOI),
      TITLE,
      encodeURIComponent(TITLE),
      EXPECTED_CONTACT,
      "mailto",
      "api.crossref.org",
      "query.title",
    ]) {
      expect(logged, `logged ${content}`).not.toContain(content);
    }
  });
});

describe("no shipped Edge source carries the retired or inactive identity (guard)", () => {
  const FUNCTIONS_DIR = fileURLToPath(new URL("../../", import.meta.url));

  function shippedSources(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      const full = path.join(dir, name);
      if (statSync(full).isDirectory()) return name === "__tests__" ? [] : shippedSources(full);
      return /\.(ts|js|mjs|json)$/.test(name) ? [full] : [];
    });
  }

  /** Code only: comments may name the retired identity as history. Same stripping as the privacy guard. */
  function code(file: string): string {
    return readFileSync(file, "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split("\n")
      .filter((line) => !line.trim().startsWith("//"))
      .join("\n");
  }

  const SOURCES = shippedSources(FUNCTIONS_DIR);
  const relative = (file: string) => path.relative(FUNCTIONS_DIR, file);

  it("walks the real function tree", () => {
    const names = SOURCES.map(relative);
    expect(names).toContain(path.join("fetch-paper-metadata", "index.ts"));
    expect(names).toContain(path.join("fetch-paper-metadata", "crossrefRequest.ts"));
  });

  it("finds the retired `PaperIndex` identity in no shipped code", () => {
    expect(SOURCES.filter((file) => /paperindex/i.test(code(file))).map(relative)).toEqual([]);
  });

  it("gives fetch-paper-metadata no use of the inactive `support@paperlume.app`", () => {
    const own = SOURCES.filter((file) => relative(file).startsWith(`fetch-paper-metadata${path.sep}`));
    expect(own.length).toBeGreaterThanOrEqual(3);
    expect(own.filter((file) => code(file).includes(INACTIVE_MAILBOX)).map(relative)).toEqual([]);
  });
});
