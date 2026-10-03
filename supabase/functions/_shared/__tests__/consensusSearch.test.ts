import { describe, it, expect } from "vitest";
import {
  buildConsensusSearchUrl,
  classifyConsensusFailure,
  parseConsensusSearchResponse,
  toImportDoi,
  toSafeConsensusUrl,
  validateConsensusSearchRequest,
  CONSENSUS_IMPORT_DOI_MAX_LENGTH,
  CONSENSUS_SEARCH_ENDPOINT,
  CONSENSUS_SEARCH_MAX_QUERY_LENGTH,
  CONSENSUS_SEARCH_PAGE_SIZE,
  CONSENSUS_URL_MAX_LENGTH,
} from "../consensusSearch.ts";
import {
  AUDITED_CONSENSUS_RESULT_FIELDS,
  consensusEnvelope,
  consensusResult,
  minimalConsensusResult,
} from "./fixtures/consensusSearchResponse.ts";

/**
 * CONSENSUS-SEARCH-MVP-001A — the pure Consensus contract: what a request may
 * contain, the one URL a search may call, which upstream DOI may reach the
 * importer, which upstream link may be rendered, and what a Consensus payload
 * is allowed to mean. No network.
 */

/** The browser-facing result keys. Anything else would be upstream passthrough. */
const CONTRACT_KEYS = [
  "abstract",
  "authors",
  "citationCount",
  "consensusUrl",
  "importDoi",
  "journal",
  "rank",
  "studyType",
  "takeaway",
  "title",
  "year",
].sort();

// ══════════════════════════════════════════════════════════════════════════
// Request validation
// ══════════════════════════════════════════════════════════════════════════

describe("validateConsensusSearchRequest", () => {
  it("accepts a natural-language query and trims only its ends", () => {
    expect(validateConsensusSearchRequest({ query: "  Does creatine improve cognition in healthy adults?  " })).toEqual({
      ok: true,
      request: { query: "Does creatine improve cognition in healthy adults?" },
    });
  });

  it("carries the query verbatim otherwise — no rewriting of its words or punctuation", () => {
    const query = `creatine "working memory" (older adults) & sleep # 2024?`;
    expect(validateConsensusSearchRequest({ query })).toEqual({ ok: true, request: { query } });
  });

  it.each([
    ["null", null],
    ["an array", [{ query: "x" }]],
    ["a string", "creatine"],
    ["a number", 7],
  ])("refuses %s as a body", (_label, body) => {
    expect(validateConsensusSearchRequest(body)).toEqual({ ok: false, message: "A JSON request body is required." });
  });

  it.each([
    ["missing", {}],
    ["null", { query: null }],
    ["a number", { query: 42 }],
    ["an array", { query: ["creatine"] }],
    ["empty", { query: "" }],
    ["whitespace only", { query: " \n\t " }],
  ])("refuses a %s query", (_label, body) => {
    expect(validateConsensusSearchRequest(body)).toEqual({ ok: false, message: "query is required." });
  });

  it(`accepts exactly ${CONSENSUS_SEARCH_MAX_QUERY_LENGTH} characters and refuses one more`, () => {
    expect(CONSENSUS_SEARCH_MAX_QUERY_LENGTH).toBe(500);
    const atLimit = "q".repeat(CONSENSUS_SEARCH_MAX_QUERY_LENGTH);
    expect(validateConsensusSearchRequest({ query: atLimit })).toEqual({ ok: true, request: { query: atLimit } });
    expect(validateConsensusSearchRequest({ query: `${atLimit}q` })).toEqual({
      ok: false,
      message: "query is too long (max 500 characters).",
    });
  });

  it("measures the bound after trimming, so surrounding whitespace never costs length", () => {
    const atLimit = "q".repeat(CONSENSUS_SEARCH_MAX_QUERY_LENGTH);
    expect(validateConsensusSearchRequest({ query: `   ${atLimit}   ` })).toEqual({ ok: true, request: { query: atLimit } });
  });

  it.each([
    ["page", { query: "x", page: 1 }],
    ["page_size", { query: "x", page_size: 200 }],
    ["pageSize", { query: "x", pageSize: 100 }],
    ["limit", { query: "x", limit: 50 }],
    ["include_full_text_chunks", { query: "x", include_full_text_chunks: true }],
    ["a URL", { query: "x", url: "https://api.consensus.app/v1/quick_search" }],
    ["an endpoint", { query: "x", endpoint: "/v1/quick_search" }],
    ["a user id", { query: "x", userId: "11111111-2222-3333-4444-555555555555" }],
    ["a role claim", { query: "x", role: "owner" }],
    ["an undocumented filter", { query: "x", year_min: 2020 }],
    ["a PaperLume-named filter this V1 does not implement", { query: "x", yearMin: 2020 }],
  ])("refuses a request that also carries %s — the contract is closed", (_label, body) => {
    expect(validateConsensusSearchRequest(body)).toEqual({
      ok: false,
      message: "The request contains an unsupported field.",
    });
  });

  it("refuses an own `__proto__` key from a parsed JSON body as an unsupported field", () => {
    const body: unknown = JSON.parse('{"query":"x","__proto__":{"role":"owner"}}');
    expect(validateConsensusSearchRequest(body)).toEqual({
      ok: false,
      message: "The request contains an unsupported field.",
    });
  });

  it("returns the query and nothing else", () => {
    const result = validateConsensusSearchRequest({ query: "x" });
    expect(result.ok && Object.keys(result.request)).toEqual(["query"]);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// Upstream URL
// ══════════════════════════════════════════════════════════════════════════

describe("buildConsensusSearchUrl", () => {
  it("targets the documented /v1/search endpoint — never the deprecated /v1/quick_search", () => {
    expect(CONSENSUS_SEARCH_ENDPOINT).toBe("https://api.consensus.app/v1/search");
    const url = new URL(buildConsensusSearchUrl("creatine"));
    expect(`${url.origin}${url.pathname}`).toBe("https://api.consensus.app/v1/search");
    expect(url.pathname).not.toContain("quick_search");
  });

  it("sends exactly two parameters: the query and page_size=20", () => {
    expect(CONSENSUS_SEARCH_PAGE_SIZE).toBe(20);
    const url = new URL(buildConsensusSearchUrl("creatine cognition"));
    expect([...url.searchParams.keys()]).toEqual(["query", "page_size"]);
    expect(url.searchParams.get("page_size")).toBe("20");
    // No page (page 0 is the default; later pages are paid and a second call),
    // no filters, no paid full-text chunks.
    expect(url.searchParams.has("page")).toBe(false);
    expect(url.searchParams.has("include_full_text_chunks")).toBe(false);
  });

  it("percent-encodes the query once, so reserved characters keep their meaning", () => {
    const query = `creatine & "working memory" #1 + sleep? 100%`;
    const built = new URL(buildConsensusSearchUrl(query));
    expect(built.searchParams.get("query")).toBe(query);
    // A raw `&` would have split off an extra parameter, and a raw `#` would
    // have started a fragment.
    expect([...built.searchParams.keys()]).toEqual(["query", "page_size"]);
    expect(built.hash).toBe("");
  });

  it("never puts a credential in the URL", () => {
    const built = buildConsensusSearchUrl("creatine");
    expect(built).not.toMatch(/api[-_]?key|x-api-key|token/i);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// The DOI boundary
// ══════════════════════════════════════════════════════════════════════════

describe("toImportDoi — the only value that may reach the importer", () => {
  it.each([
    ["a plain bare DOI", "10.5555/consensus-mvp.0001"],
    ["upper-case letters, preserved as written", "10.5555/ABC.Def-001"],
    ["parentheses (as in the audited sample's SICI-like suffix)", "10.5555/ijx.3(47).2025.3516"],
    ["a suffix that itself contains slashes", "10.5555/a/b/c"],
    ["a five-digit registrant code", "10.55555/x"],
    ["reserved punctuation in the suffix", "10.5555/a;b:c<d>e#f?g%20h"],
    ["non-ASCII letters, which are legitimate DOI data", "10.5555/Á.GUTIÉRREZ.2018"],
  ])("accepts %s and returns it byte-for-byte", (_label, doi) => {
    expect(toImportDoi(doi)).toBe(doi);
  });

  it.each([
    ["undefined", undefined],
    ["null", null],
    ["a number", 10.5555],
    ["an object", { doi: "10.5555/x" }],
    ["an array", ["10.5555/x"]],
    ["the empty string", ""],
    ["a prefix with no suffix (the importer's loose rule would take it)", "10.5555"],
    ["a prefix and separator with no suffix", "10.5555/"],
    ["a non-10 directory", "11.5555/x"],
    ["the doi: presentation form", "doi:10.5555/x"],
    ["the DOI: presentation form", "DOI: 10.5555/x"],
    ["a resolver URL", "https://doi.org/10.5555/x"],
    ["a scheme-less resolver path", "doi.org/10.5555/x"],
    ["leading whitespace", " 10.5555/x"],
    ["trailing whitespace", "10.5555/x "],
    ["interior whitespace", "10.5555/a b"],
    ["a newline", "10.5555/a\nb"],
    ["a NUL", "10.5555/a\u0000b"],
    ["a C1 control", "10.5555/a\u0085b"],
    ["a right-to-left override", "10.5555/a‮b"],
    ["a zero-width space", "10.5555/a​b"],
    ["a byte-order mark", "﻿10.5555/x"],
    ["a lone surrogate", "10.5555/a\ud800"],
    ["free text that merely contains a DOI", "see 10.5555/x"],
    ["a title", "Creatine and cognition"],
  ])("refuses %s", (_label, value) => {
    expect(toImportDoi(value)).toBeNull();
  });

  it(`accepts ${CONSENSUS_IMPORT_DOI_MAX_LENGTH} characters (the importer's own bound) and refuses one more`, () => {
    const prefix = "10.5555/";
    const atLimit = prefix + "x".repeat(CONSENSUS_IMPORT_DOI_MAX_LENGTH - prefix.length);
    expect(atLimit).toHaveLength(500);
    expect(toImportDoi(atLimit)).toBe(atLimit);
    expect(toImportDoi(`${atLimit}x`)).toBeNull();
  });

  it("never repairs: two spellings of one DOI stay two distinct, untouched values", () => {
    expect(toImportDoi("10.5555/ABC")).toBe("10.5555/ABC");
    expect(toImportDoi("10.5555/abc")).toBe("10.5555/abc");
  });
});

// ══════════════════════════════════════════════════════════════════════════
// The link boundary
// ══════════════════════════════════════════════════════════════════════════

describe("toSafeConsensusUrl — which upstream link may be rendered", () => {
  const AUDITED = "https://consensus.app/papers/synthetic-slug/0123456789abcdef0123456789abcdef/?utm_source=publicapi";

  it("accepts the audited paper-URL shape and returns the parser's normalized href", () => {
    expect(toSafeConsensusUrl(AUDITED)).toBe(AUDITED);
    expect(toSafeConsensusUrl("https://CONSENSUS.APP/papers/x/")).toBe("https://consensus.app/papers/x/");
  });

  it.each([
    ["plain http", "http://consensus.app/papers/x/"],
    ["a look-alike host", "https://consensus.app.evil.example/papers/x/"],
    ["a different host carrying the real URL in its query", "https://evil.example/?u=https://consensus.app/papers/x/"],
    ["a subdomain outside the allowlist", "https://www.consensus.app/papers/x/"],
    ["the API host", "https://api.consensus.app/papers/x/"],
    ["embedded credentials", "https://user:pass@consensus.app/papers/x/"],
    ["an explicit port", "https://consensus.app:8443/papers/x/"],
    ["a non-paper path", "https://consensus.app/search/?q=x"],
    ["the site root", "https://consensus.app/"],
    ["a traversal that normalizes out of /papers/", "https://consensus.app/papers/../logout"],
    ["javascript:", "javascript:alert(1)"],
    ["a data: URL", "data:text/html,<script>alert(1)</script>"],
    ["a relative path", "/papers/x/"],
    ["a scheme-relative URL", "//consensus.app/papers/x/"],
    ["the empty string", ""],
    ["a number", 42],
    ["null", null],
  ])("refuses %s", (_label, value) => {
    expect(toSafeConsensusUrl(value)).toBeNull();
  });

  it(`refuses anything longer than ${CONSENSUS_URL_MAX_LENGTH} characters`, () => {
    const base = "https://consensus.app/papers/";
    expect(toSafeConsensusUrl(base + "x".repeat(CONSENSUS_URL_MAX_LENGTH - base.length))).not.toBeNull();
    expect(toSafeConsensusUrl(base + "x".repeat(CONSENSUS_URL_MAX_LENGTH - base.length + 1))).toBeNull();
  });
});

// ══════════════════════════════════════════════════════════════════════════
// Response parsing
// ══════════════════════════════════════════════════════════════════════════

describe("parseConsensusSearchResponse", () => {
  it("maps an audit-shaped result onto the application-owned contract", () => {
    const parsed = parseConsensusSearchResponse(consensusEnvelope([consensusResult()]));
    expect(parsed).toEqual({
      ok: true,
      dropped: 0,
      results: [
        {
          rank: 1,
          title: "Synthetic fixture: creatine supplementation and working memory in healthy adults",
          authors: ["Ada Fixture", "Ben Placeholder", "Cara Example", "Dan Sample"],
          journal: "Journal of Synthetic Fixtures",
          year: 2024,
          abstract:
            "Background: this abstract is invented for a test. Methods: none. Results: none. Conclusions: it exists so the discovery card has an abstract to excerpt.",
          citationCount: 47,
          studyType: "rct",
          takeaway: "Synthetic takeaway: the fixture suggests a small positive effect.",
          consensusUrl:
            "https://consensus.app/papers/synthetic-fixture-creatine-fixture/0123456789abcdef0123456789abcdef/?utm_source=publicapi",
          importDoi: "10.5555/consensus-mvp.0001",
        },
      ],
    });
  });

  it("keeps Consensus's relevance order and numbers it from 1", () => {
    const parsed = parseConsensusSearchResponse(
      consensusEnvelope([
        consensusResult({ title: "First", doi: "10.5555/a" }),
        minimalConsensusResult({ title: "Second" }),
        consensusResult({ title: "Third", doi: "10.5555/c" }),
      ]),
    );
    expect(parsed.ok && parsed.results.map((r) => [r.rank, r.title])).toEqual([
      [1, "First"],
      [2, "Second"],
      [3, "Third"],
    ]);
  });

  it("treats omitted optional fields as absent — the audited normal case", () => {
    const parsed = parseConsensusSearchResponse(consensusEnvelope([minimalConsensusResult()]));
    expect(parsed.ok && parsed.results[0]).toMatchObject({ studyType: null, citationCount: 0, year: 2019 });
  });

  it("degrades every malformed display field to null or empty without failing the result", () => {
    const parsed = parseConsensusSearchResponse(
      consensusEnvelope([
        consensusResult({
          title: 12345,
          authors: ["Ada Fixture", 7, null, "  ", { name: "x" }, "Ben Placeholder"],
          journal_name: ["not", "a", "string"],
          publish_year: "2024",
          abstract: "   ",
          citation_count: -3,
          study_type: "",
          takeaway: { text: "x" },
        }),
        consensusResult({ publish_year: 2024.5, citation_count: 1.5, authors: "Ada Fixture" }),
        consensusResult({ publish_year: 99999, citation_count: Number.MAX_SAFE_INTEGER + 2 }),
      ]),
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.results[0]).toMatchObject({
      title: null,
      authors: ["Ada Fixture", "Ben Placeholder"],
      journal: null,
      year: null,
      abstract: null,
      citationCount: null,
      studyType: null,
      takeaway: null,
      // The import identity is independent of the broken display fields.
      importDoi: "10.5555/consensus-mvp.0001",
    });
    expect(parsed.results[1]).toMatchObject({ year: null, citationCount: null, authors: [] });
    expect(parsed.results[2]).toMatchObject({ year: null, citationCount: null });
  });

  it("sets importDoi to null for an invalid DOI and preserves a valid one exactly", () => {
    const parsed = parseConsensusSearchResponse(
      consensusEnvelope([
        consensusResult({ doi: "10.5555/Keep.THIS.Spelling" }),
        consensusResult({ doi: "https://doi.org/10.5555/x" }),
        consensusResult({ doi: "10.5555" }),
        consensusResult({ doi: null }),
        (() => {
          const withoutDoi = consensusResult();
          delete withoutDoi.doi;
          return withoutDoi;
        })(),
      ]),
    );
    expect(parsed.ok && parsed.results.map((r) => r.importDoi)).toEqual([
      "10.5555/Keep.THIS.Spelling",
      null,
      null,
      null,
      null,
    ]);
  });

  it("hides an arbitrary upstream URL and keeps a valid Consensus link", () => {
    const parsed = parseConsensusSearchResponse(
      consensusEnvelope([
        consensusResult({ url: "javascript:alert(document.cookie)" }),
        consensusResult({ url: "https://evil.example/papers/x/" }),
        consensusResult(),
      ]),
    );
    expect(parsed.ok && parsed.results.map((r) => r.consensusUrl)).toEqual([
      null,
      null,
      "https://consensus.app/papers/synthetic-fixture-creatine-fixture/0123456789abcdef0123456789abcdef/?utm_source=publicapi",
    ]);
  });

  it("lets no raw upstream field through — the browser receives the contract keys only", () => {
    const everyAuditedField = consensusResult({
      countries_of_study: ["Fixtureland"],
      population_type: "human",
      study_count: 4,
      study_duration_days: 84,
      full_text_chunks: ["Section: Methods | an invented passage"],
      semantic_score: 0.9,
      paper_id: "aaaabbbbccccddddeeeeffff00001111",
      pmid: "31415926",
      unexpected_new_field: "anything",
    });
    for (const field of AUDITED_CONSENSUS_RESULT_FIELDS) expect(everyAuditedField).toHaveProperty(field);

    const parsed = parseConsensusSearchResponse(consensusEnvelope([everyAuditedField]));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(Object.keys(parsed.results[0]).sort()).toEqual(CONTRACT_KEYS);
    const serialized = JSON.stringify(parsed.results);
    for (const leaked of ["full_text_chunks", "Section: Methods", "Fixtureland", "Fixture University", "31415926", "aaaabbbbccccddddeeeeffff00001111", "semantic_score", "unexpected_new_field"]) {
      expect(serialized).not.toContain(leaked);
    }
  });

  it("drops unusable entries without sinking the page, and counts them", () => {
    const nothingToShow = consensusResult({ title: "", doi: "not a doi", url: "http://consensus.app/papers/x" });
    const parsed = parseConsensusSearchResponse(
      consensusEnvelope([null, "a string", 42, ["array"], nothingToShow, consensusResult({ title: "Survivor" })]),
    );
    expect(parsed).toMatchObject({ ok: true, dropped: 5 });
    expect(parsed.ok && parsed.results.map((r) => [r.rank, r.title])).toEqual([[1, "Survivor"]]);
  });

  it("keeps a result that is discovery-only: a title but no importable DOI", () => {
    const parsed = parseConsensusSearchResponse(consensusEnvelope([consensusResult({ doi: "10.5555" })]));
    expect(parsed.ok && parsed.results[0]).toMatchObject({ title: expect.any(String), importDoi: null });
  });

  it(`never forwards more than one page of ${CONSENSUS_SEARCH_PAGE_SIZE}, whatever arrives`, () => {
    const many = Array.from({ length: 25 }, (_, i) => consensusResult({ doi: `10.5555/n${i}`, title: `Paper ${i}` }));
    const parsed = parseConsensusSearchResponse(consensusEnvelope(many));
    expect(parsed).toMatchObject({ ok: true, dropped: 5 });
    expect(parsed.ok && parsed.results).toHaveLength(20);
    expect(parsed.ok && parsed.results.at(-1)?.rank).toBe(20);
  });

  it("answers an empty result list as a valid, empty answer", () => {
    expect(parseConsensusSearchResponse(consensusEnvelope([]))).toEqual({ ok: true, results: [], dropped: 0 });
  });

  it.each([
    ["null", null],
    ["a string", "results"],
    ["an array", [consensusResult()]],
    ["an envelope without results", { page: 0, page_size: 20, is_end: true }],
    ["results that is not an array", { results: { 0: consensusResult() } }],
    ["results that is null", { results: null }],
  ])("reports %s as malformed rather than as an empty page", (_label, payload) => {
    expect(parseConsensusSearchResponse(payload)).toEqual({ ok: false, reason: "malformed" });
  });
});

// ══════════════════════════════════════════════════════════════════════════
// Upstream failure classification
// ══════════════════════════════════════════════════════════════════════════

describe("classifyConsensusFailure", () => {
  it.each([
    [401, "upstream_auth"],
    [402, "upstream_billing"],
    [403, "upstream_forbidden"],
    [500, "upstream_error"],
    [502, "upstream_error"],
    [503, "upstream_error"],
    [400, "upstream_rejected"],
    [404, "upstream_rejected"],
    [422, "upstream_rejected"],
  ])("maps HTTP %i to %s", (status, expected) => {
    expect(classifyConsensusFailure(status, "")).toBe(expected);
  });

  it("recognizes the documented monthly-allowance 429 by its phrase, in any case or wrapper", () => {
    expect(classifyConsensusFailure(429, "You have used all included searches for this month.")).toBe("quota_exhausted");
    expect(classifyConsensusFailure(429, '{"detail":"USED ALL INCLUDED SEARCHES"}')).toBe("quota_exhausted");
  });

  it("treats the documented per-second 429, and any unrecognized 429, as rate limiting", () => {
    expect(classifyConsensusFailure(429, '{"detail":"Too many requests"}')).toBe("rate_limited");
    expect(classifyConsensusFailure(429, "")).toBe("rate_limited");
    expect(classifyConsensusFailure(429, "<html>busy</html>")).toBe("rate_limited");
  });
});
