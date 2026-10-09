import { describe, it, expect } from "vitest";
import {
  buildConsensusSearchUrl,
  classifyConsensusFailure,
  consensusFilterMaxYear,
  consensusFilterParamNames,
  countResultsOutsideYearRange,
  parseConsensusSearchResponse,
  toImportDoi,
  toSafeConsensusUrl,
  validateConsensusSearchRequest,
  CONSENSUS_FILTER_MIN_YEAR,
  CONSENSUS_IMPORT_DOI_MAX_LENGTH,
  CONSENSUS_SEARCH_ENDPOINT,
  CONSENSUS_SEARCH_MAX_QUERY_LENGTH,
  CONSENSUS_SEARCH_PAGE_SIZE,
  CONSENSUS_STUDY_TYPES,
  CONSENSUS_URL_MAX_LENGTH,
  type ConsensusSearchFilters,
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
    ["a provider key", { query: "x", apiKey: "sk-live-123" }],
    ["full-text chunks under another name", { query: "x", fullText: true }],
    ["raw URL parameters", { query: "x", params: "year_min=1800&page=3" }],
    ["a nested filter object", { query: "x", filters: { yearMin: 2020 } }],
    ["Consensus's own year_min name", { query: "x", year_min: 2020 }],
    ["Consensus's own study_types name", { query: "x", study_types: "rct" }],
    ["Consensus's own exclude_preprints name", { query: "x", exclude_preprints: true }],
    ["a documented Consensus filter PaperLume does not offer", { query: "x", sjrMax: 1 }],
    ["a month filter PaperLume does not offer", { query: "x", monthMin: 3 }],
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
// Advanced filters (CONSENSUS-ADVANCED-FILTERS-001A)
// ══════════════════════════════════════════════════════════════════════════

/** A pinned clock: in 2026 a filter year may run from 1900 to 2027. */
const NOW = new Date("2026-10-10T12:00:00Z");
const validate = (body: unknown) => validateConsensusSearchRequest(body, { now: NOW });

const FULL_FILTERS: ConsensusSearchFilters = {
  yearMin: 2020,
  yearMax: 2026,
  studyTypes: ["rct", "meta-analysis"],
  human: true,
  excludePreprints: true,
};

describe("CONSENSUS_STUDY_TYPES — the curated V1 allowlist", () => {
  it("is exactly the four designs whose REST spelling official sources agree on, in send order", () => {
    expect(CONSENSUS_STUDY_TYPES).toEqual(["rct", "meta-analysis", "systematic review", "cohort study"]);
  });

  it("is frozen", () => {
    expect(Object.isFrozen(CONSENSUS_STUDY_TYPES)).toBe(true);
  });

  it("leaves out every documented design whose REST value is not established", () => {
    for (const excluded of [
      "literature review", // MCP list only
      "case report", // MCP list only
      "non-rct experimental", // MCP spelling …
      "non-randomized experimental study", // … contradicted by a REST example
      "non-rct observational study",
      "non-rct in vitro",
      "animal",
      "cross-sectional study",
      "longitudinal / panel data study",
      "Longitudinal / panel study", // a web-app label, not a value
      "RCT",
    ]) {
      expect(CONSENSUS_STUDY_TYPES).not.toContain(excluded);
    }
  });

  it("holds no value with a comma, so the comma-separated parameter is unambiguous", () => {
    for (const value of CONSENSUS_STUDY_TYPES) expect(value).not.toContain(",");
  });
});

describe("validateConsensusSearchRequest — advanced filters", () => {
  it("keeps an unfiltered request exactly the V1 shape", () => {
    expect(validate({ query: "x" })).toEqual({ ok: true, request: { query: "x" } });
  });

  it("accepts the full filter set", () => {
    expect(
      validate({
        query: "  Does creatine improve cognition?  ",
        yearMin: 2020,
        yearMax: 2026,
        studyTypes: ["rct", "meta-analysis"],
        human: true,
        excludePreprints: true,
      }),
    ).toEqual({ ok: true, request: { query: "Does creatine improve cognition?", ...FULL_FILTERS } });
  });

  it.each([
    ["a start year alone", { yearMin: 2015 }],
    ["an end year alone", { yearMax: 2010 }],
    ["a range", { yearMin: 2015, yearMax: 2020 }],
    ["a single-year range", { yearMin: 2020, yearMax: 2020 }],
    [`the floor (${CONSENSUS_FILTER_MIN_YEAR})`, { yearMin: 1900, yearMax: 1900 }],
    ["the ceiling (the current UTC year + 1)", { yearMin: 2027 }],
  ])("accepts %s", (_label, years) => {
    expect(validate({ query: "x", ...years })).toEqual({ ok: true, request: { query: "x", ...years } });
  });

  it.each([
    ["a year as a string", { yearMin: "2020" }, "yearMin"],
    ["a fractional year", { yearMin: 2020.5 }, "yearMin"],
    ["NaN", { yearMax: Number.NaN }, "yearMax"],
    ["Infinity", { yearMax: Number.POSITIVE_INFINITY }, "yearMax"],
    ["-Infinity", { yearMin: Number.NEGATIVE_INFINITY }, "yearMin"],
    ["null", { yearMin: null }, "yearMin"],
    ["a boolean", { yearMax: true }, "yearMax"],
    ["a one-element list", { yearMin: [2020] }, "yearMin"],
    ["a year below the floor", { yearMin: 1899 }, "yearMin"],
    ["a year past the ceiling", { yearMax: 2028 }, "yearMax"],
    ["a negative year", { yearMin: -2020 }, "yearMin"],
    ["zero", { yearMin: 0 }, "yearMin"],
    ["a five-digit year", { yearMax: 20260 }, "yearMax"],
  ])("refuses %s with a fixed message naming the field", (_label, years, field) => {
    expect(validate({ query: "x", ...years })).toEqual({
      ok: false,
      message: `${field} must be a whole year from 1900 to 2027.`,
    });
  });

  it("refuses a reversed range", () => {
    expect(validate({ query: "x", yearMin: 2024, yearMax: 2020 })).toEqual({
      ok: false,
      message: "yearMin must not be later than yearMax.",
    });
  });

  it("reads the year ceiling from the UTC calendar", () => {
    expect(consensusFilterMaxYear(new Date("2026-12-31T23:59:59Z"))).toBe(2027);
    expect(consensusFilterMaxYear(new Date("2027-01-01T00:00:00Z"))).toBe(2028);
    expect(validateConsensusSearchRequest({ query: "x", yearMax: 2028 }, { now: new Date("2027-01-01T00:00:00Z") }).ok).toBe(true);
    expect(validateConsensusSearchRequest({ query: "x", yearMax: 2028 }, { now: new Date("2026-12-31T23:59:59Z") }).ok).toBe(false);
  });

  it("puts a valid multi-select in allowlist order, never changing a value", () => {
    expect(validate({ query: "x", studyTypes: ["cohort study", "meta-analysis", "rct"] })).toEqual({
      ok: true,
      request: { query: "x", studyTypes: ["rct", "meta-analysis", "cohort study"] },
    });
  });

  it("accepts every allowlisted design at once", () => {
    const all = [...CONSENSUS_STUDY_TYPES].reverse();
    expect(validate({ query: "x", studyTypes: all })).toEqual({
      ok: true,
      request: { query: "x", studyTypes: [...CONSENSUS_STUDY_TYPES] },
    });
  });

  it("treats an empty study-design list as no restriction", () => {
    expect(validate({ query: "x", studyTypes: [] })).toEqual({ ok: true, request: { query: "x" } });
  });

  it.each([
    ["an unknown design", ["rct", "case-control study"]],
    ["a documented design outside the V1 allowlist", ["case report"]],
    ["a design only the MCP list documents", ["literature review"]],
    ["an upper-case spelling", ["RCT"]],
    ["a padded spelling", [" rct"]],
    ["a display label instead of the value", ["Randomized controlled trial"]],
    ["an empty value", [""]],
    ["a number", [1]],
    ["null", [null]],
    ["an object entry", [{ value: "rct" }]],
    ["a nested list", [["rct"]]],
    ["a comma-joined string instead of a list", "rct,meta-analysis"],
    ["a single string", "rct"],
    ["an object", { 0: "rct" }],
    ["null instead of a list", null],
    ["more entries than the allowlist has", ["rct", "meta-analysis", "systematic review", "cohort study", "rct"]],
  ])("refuses %s", (_label, studyTypes) => {
    expect(validate({ query: "x", studyTypes })).toEqual({
      ok: false,
      message: "studyTypes must be a list of supported study designs.",
    });
  });

  it("refuses a repeated design rather than de-duplicating it", () => {
    expect(validate({ query: "x", studyTypes: ["rct", "meta-analysis", "rct"] })).toEqual({
      ok: false,
      message: "studyTypes must not repeat a study design.",
    });
  });

  it("keeps human and excludePreprints only when true — false is no restriction", () => {
    expect(validate({ query: "x", human: true, excludePreprints: true })).toEqual({
      ok: true,
      request: { query: "x", human: true, excludePreprints: true },
    });
    expect(validate({ query: "x", human: false, excludePreprints: false })).toEqual({ ok: true, request: { query: "x" } });
  });

  it.each([
    ['the string "true"', "true"],
    ['the string "false"', "false"],
    ["1", 1],
    ["0", 0],
    ["null", null],
    ["an object", {}],
  ])("refuses %s where a boolean is required", (_label, value) => {
    expect(validate({ query: "x", human: value })).toEqual({ ok: false, message: "human must be true or false." });
    expect(validate({ query: "x", excludePreprints: value })).toEqual({
      ok: false,
      message: "excludePreprints must be true or false.",
    });
  });

  it("never echoes a submitted value in a refusal", () => {
    const marker = "<script>alert('filter')</script>";
    for (const body of [
      { query: "x", studyTypes: [marker] },
      { query: "x", yearMin: marker },
      { query: "x", human: marker },
      { query: "x", excludePreprints: marker },
    ]) {
      const result = validate(body);
      expect(result.ok).toBe(false);
      expect(JSON.stringify(result)).not.toContain("script");
    }
  });

  it("reads only the body's own fields: a polluted prototype cannot set a filter", () => {
    const body = Object.create({ yearMin: 1000, human: "yes", studyTypes: ["bogus"] }) as Record<string, unknown>;
    body.query = "x";
    expect(validate(body)).toEqual({ ok: true, request: { query: "x" } });
  });

  it("checks the query before any filter", () => {
    expect(validate({ yearMin: "not a year" })).toEqual({ ok: false, message: "query is required." });
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

  it("builds exactly the V1 URL for an unfiltered search — with or without an empty filter set", () => {
    expect(buildConsensusSearchUrl("creatine cognition")).toBe(
      "https://api.consensus.app/v1/search?query=creatine+cognition&page_size=20",
    );
    expect(buildConsensusSearchUrl("creatine cognition", {})).toBe(buildConsensusSearchUrl("creatine cognition"));
    expect(buildConsensusSearchUrl("creatine cognition", { studyTypes: [] })).toBe(
      buildConsensusSearchUrl("creatine cognition"),
    );
  });

  it("maps every filter onto Consensus's documented snake_case parameter, after the V1 pair", () => {
    const url = new URL(buildConsensusSearchUrl("creatine cognition", FULL_FILTERS));
    expect([...url.searchParams.entries()]).toEqual([
      ["query", "creatine cognition"],
      ["page_size", "20"],
      ["year_min", "2020"],
      ["year_max", "2026"],
      ["study_types", "rct,meta-analysis"],
      ["human", "true"],
      ["exclude_preprints", "true"],
    ]);
  });

  it("sends study_types as ONE comma-separated value, encoded once", () => {
    const built = buildConsensusSearchUrl("x", { studyTypes: ["systematic review", "cohort study"] });
    expect(new URL(built).searchParams.getAll("study_types")).toEqual(["systematic review,cohort study"]);
    // URLSearchParams form-encoding: a space is `+`, the separator is `%2C` —
    // what the official README's JavaScript example (`new URLSearchParams`) sends.
    expect(built).toContain("study_types=systematic+review%2Ccohort+study");
  });

  it.each([
    ["a start year", { yearMin: 2015 }, ["year_min"]],
    ["an end year", { yearMax: 2010 }, ["year_max"]],
    ["one design", { studyTypes: ["rct"] }, ["study_types"]],
    ["human studies only", { human: true }, ["human"]],
    ["no preprints", { excludePreprints: true }, ["exclude_preprints"]],
  ] as Array<[string, ConsensusSearchFilters, string[]]>)("sends only what is set: %s", (_label, filters, expected) => {
    expect([...new URL(buildConsensusSearchUrl("x", filters)).searchParams.keys()]).toEqual([
      "query",
      "page_size",
      ...expected,
    ]);
  });

  it("never adds a page, full-text chunks or a credential, whatever the filters", () => {
    const built = buildConsensusSearchUrl("x", FULL_FILTERS);
    const url = new URL(built);
    expect(url.searchParams.has("page")).toBe(false);
    expect(url.searchParams.has("include_full_text_chunks")).toBe(false);
    expect(url.searchParams.get("page_size")).toBe("20");
    expect(built).not.toMatch(/api[-_]?key|x-api-key|token/i);
  });

  it("keeps the query exact beside the filters: a query cannot smuggle in a parameter", () => {
    const query = `creatine & year_min=1800&page=3 #frag`;
    const url = new URL(buildConsensusSearchUrl(query, { yearMin: 2020 }));
    expect(url.searchParams.get("query")).toBe(query);
    expect(url.searchParams.getAll("year_min")).toEqual(["2020"]);
    expect(url.searchParams.has("page")).toBe(false);
    expect(url.hash).toBe("");
  });

  it("consensusFilterParamNames names exactly the filter parameters the URL carries", () => {
    const cases: ConsensusSearchFilters[] = [
      {},
      { yearMin: 2020 },
      { yearMax: 2020 },
      { studyTypes: ["cohort study"] },
      { studyTypes: [] },
      { human: true, excludePreprints: true },
      FULL_FILTERS,
    ];
    for (const filters of cases) {
      const filterKeys = [...new URL(buildConsensusSearchUrl("x", filters)).searchParams.keys()].filter(
        (key) => key !== "query" && key !== "page_size",
      );
      expect(consensusFilterParamNames(filters)).toEqual(filterKeys);
    }
  });

  it("round-trips: a validated body builds a URL carrying exactly its filters", () => {
    const validated = validate({
      query: "creatine",
      excludePreprints: true,
      studyTypes: ["meta-analysis", "rct"],
      human: false,
      yearMax: 2024,
    });
    if (!validated.ok) throw new Error("expected a valid request");
    const { query, ...filters } = validated.request;
    expect([...new URL(buildConsensusSearchUrl(query, filters)).searchParams.entries()]).toEqual([
      ["query", "creatine"],
      ["page_size", "20"],
      ["year_max", "2024"],
      ["study_types", "rct,meta-analysis"],
      ["exclude_preprints", "true"],
    ]);
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
      preprints: 0,
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
    expect(parseConsensusSearchResponse(consensusEnvelope([]))).toEqual({ ok: true, results: [], dropped: 0, preprints: 0 });
  });

  it("counts forwarded records flagged is_preprint: true — and still never forwards the flag", () => {
    const parsed = parseConsensusSearchResponse(
      consensusEnvelope([
        consensusResult({ is_preprint: true }),
        consensusResult({ is_preprint: false }),
        consensusResult({ is_preprint: "true" }), // not exactly `true`
        minimalConsensusResult({ is_preprint: true }),
        // Dropped as unusable, so it is not counted either.
        consensusResult({ title: "", doi: "not a doi", url: "http://consensus.app/papers/x", is_preprint: true }),
      ]),
    );
    expect(parsed).toMatchObject({ ok: true, dropped: 1, preprints: 2 });
    expect(parsed.ok && JSON.stringify(parsed.results)).not.toMatch(/preprint/i);
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

  it.each([
    [403, "filters_not_allowed"],
    [400, "filters_rejected"],
    [422, "filters_rejected"],
    [401, "upstream_auth"],
    [402, "upstream_billing"],
    [404, "upstream_rejected"],
    [500, "upstream_error"],
    [503, "upstream_error"],
  ])("maps HTTP %i on a FILTERED search to %s", (status, expected) => {
    expect(classifyConsensusFailure(status, "", true)).toBe(expected);
  });

  it("keeps the two 429s apart on a filtered search too", () => {
    expect(classifyConsensusFailure(429, "You have used all included searches.", true)).toBe("quota_exhausted");
    expect(classifyConsensusFailure(429, '{"detail":"Too many requests"}', true)).toBe("rate_limited");
  });

  it("classifies an unfiltered search exactly as V1 did", () => {
    expect(classifyConsensusFailure(403, "", false)).toBe("upstream_forbidden");
    expect(classifyConsensusFailure(400, "", false)).toBe("upstream_rejected");
    expect(classifyConsensusFailure(422, "", false)).toBe("upstream_rejected");
  });
});

// ══════════════════════════════════════════════════════════════════════════
// Filter diagnostics for the log line
// ══════════════════════════════════════════════════════════════════════════

describe("countResultsOutsideYearRange — a log diagnostic, never a filter", () => {
  const parsedYears = (years: unknown[]) => {
    const parsed = parseConsensusSearchResponse(
      consensusEnvelope(years.map((year, i) => consensusResult({ publish_year: year, doi: `10.5555/y${i}` }))),
    );
    if (!parsed.ok) throw new Error("expected a parsed page");
    return parsed.results;
  };

  it("is null when the search set no year filter", () => {
    expect(countResultsOutsideYearRange(parsedYears([1990, 2024]), {})).toBeNull();
    expect(countResultsOutsideYearRange(parsedYears([1990]), { human: true, studyTypes: ["rct"] })).toBeNull();
  });

  it("counts results outside a range, on either side", () => {
    expect(countResultsOutsideYearRange(parsedYears([2019, 2020, 2023, 2026, 2027]), { yearMin: 2020, yearMax: 2026 })).toBe(2);
  });

  it("counts against a single bound", () => {
    expect(countResultsOutsideYearRange(parsedYears([2014, 2015, 2030]), { yearMin: 2015 })).toBe(1);
    expect(countResultsOutsideYearRange(parsedYears([2009, 2010, 2011]), { yearMax: 2010 })).toBe(1);
  });

  it("does not count a result without a usable year", () => {
    expect(countResultsOutsideYearRange(parsedYears(["2019", null, 2019.5, 2024]), { yearMin: 2020 })).toBe(0);
  });

  it("changes nothing it is given", () => {
    const results = parsedYears([1990, 2024]);
    const before = JSON.stringify(results);
    countResultsOutsideYearRange(results, { yearMin: 2020 });
    expect(JSON.stringify(results)).toBe(before);
  });
});
