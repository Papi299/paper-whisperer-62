import { describe, it, expect } from "vitest";
import {
  buildESearchUrl,
  buildESummaryUrl,
  mapESummaryResponse,
  normalizeSearchPmid,
  parseESearchResponse,
  validateSearchRequest,
  PUBMED_SEARCH_DEFAULT_LIMIT,
  PUBMED_SEARCH_MAX_LIMIT,
  PUBMED_SEARCH_MAX_OFFSET,
  PUBMED_SEARCH_MAX_QUERY_LENGTH,
} from "../pubmedSearch.ts";

/**
 * PUBMED-IN-APP-SEARCH-001 — pure discovery-layer coverage.
 *
 * Every fixture below is shaped from a **live** NCBI response captured on
 * 2026-08-22, so what is asserted is what the service actually sends: `count`
 * as a string, an out-of-range `retstart` reported as HTTP 200 with an in-band
 * `ERROR`, a missing uid answered with `{ uid, error }`, `authtype:
 * "CollectiveName"` for consortium papers, and summary values that arrive
 * already entity-decoded.
 */

// ── Live-shaped fixtures ──────────────────────────────────────────────────

/** ESearch, `term=resistance training hypertrophy`, retstart=0, retmax=5. */
const ESEARCH_OK = {
  header: { type: "esearch", version: "0.3" },
  esearchresult: {
    count: "2509",
    retmax: "5",
    retstart: "0",
    idlist: ["41843416", "27102172", "28834797", "37414459", "37432300"],
    translationset: [{ from: "resistance training", to: "…" }],
    querytranslation: "…",
  },
};

/** ESearch for a term with no matches. HTTP 200, not an error. */
const ESEARCH_EMPTY = {
  header: { type: "esearch", version: "0.3" },
  esearchresult: {
    count: "0",
    retmax: "0",
    retstart: "0",
    idlist: [],
    translationset: [],
    warninglist: { phrasesignored: [], quotedphrasesnotfound: [], outputmessages: ["No items found."] },
  },
};

/** ESearch with `retstart=10000` — NCBI's own in-band failure, at HTTP 200. */
const ESEARCH_IN_BAND_ERROR = {
  header: { type: "esearch", version: "0.3" },
  esearchresult: {
    ERROR:
      "Search Backend failed: Exception: 'retstart' cannot be larger than 9998. For PubMed, ESearch can only retrieve the first 9,999 records matching the query.",
  },
};

/** ESummary v2.0, one complete record. */
const SUMMARY_COMPLETE = {
  uid: "41843416",
  pubdate: "2026 Apr 1",
  epubdate: "2026 Mar 5",
  source: "Med Sci Sports Exerc",
  fulljournalname: "Medicine and science in sports and exercise",
  authors: [
    { name: "Currier BS", authtype: "Author", clusterid: "" },
    { name: "D'Souza AC", authtype: "Author", clusterid: "" },
    { name: "Singh MAF", authtype: "Author", clusterid: "" },
    { name: "Lowisz CV", authtype: "Author", clusterid: "" },
  ],
  title:
    "American College of Sports Medicine Position Stand. Resistance Training Prescription for Muscle Function, Hypertrophy, and Physical Performance in Healthy Adults: An Overview of Reviews.",
  sorttitle: "american college of sports medicine position stand…",
  pubtype: ["Journal Article", "Review"],
  articleids: [
    { idtype: "pubmed", idtypen: 1, value: "41843416" },
    { idtype: "pmc", idtypen: 8, value: "PMC12965823" },
    { idtype: "doi", idtypen: 3, value: "10.1249/MSS.0000000000003897" },
    { idtype: "pii", idtypen: 4, value: "00005768-202604000-00021" },
  ],
  elocationid: "doi: 10.1249/MSS.0000000000003897",
  sortpubdate: "2026/04/01 00:00",
};

/** ESummary v2.0, PMID 41912805 — a real consortium record. */
const SUMMARY_COLLECTIVE = {
  uid: "41912805",
  pubdate: "2026 Apr",
  source: "Nat Med",
  fulljournalname: "Nature medicine",
  authors: [{ name: "GBD 2023 IHD & Dietary Risk Factors Collaborators", authtype: "CollectiveName", clusterid: "" }],
  title:
    "Global, regional and national burden of ischemic heart disease attributable to suboptimal diet, 1990-2023: a Global Burden of Disease study.",
  pubtype: ["Journal Article"],
  articleids: [{ idtype: "doi", idtypen: 3, value: "10.1038/s41591-026-04250-8" }],
  sortpubdate: "2026/04/01 00:00",
};

/** What NCBI returns for a uid that does not exist. */
const SUMMARY_ERROR_RECORD = { uid: "999999999", error: "cannot get document summary" };

function esummary(records: Record<string, unknown>[]) {
  const result: Record<string, unknown> = { uids: records.map((r) => r.uid) };
  for (const record of records) result[String(record.uid)] = record;
  return { header: { type: "esummary", version: "0.3" }, result };
}

// ══════════════════════════════════════════════════════════════════════════
// Request validation
// ══════════════════════════════════════════════════════════════════════════

describe("validateSearchRequest", () => {
  it("accepts a plain query and applies the default page window", () => {
    const validation = validateSearchRequest({ query: "resistance training hypertrophy" });
    expect(validation).toEqual({
      ok: true,
      request: { query: "resistance training hypertrophy", offset: 0, limit: PUBMED_SEARCH_DEFAULT_LIMIT },
    });
  });

  it("trims only surrounding whitespace", () => {
    const validation = validateSearchRequest({ query: "  \n cancer therapy \t " });
    expect(validation).toEqual({
      ok: true,
      request: { query: "cancer therapy", offset: 0, limit: PUBMED_SEARCH_DEFAULT_LIMIT },
    });
  });

  it.each([
    ['("resistance training"[Title/Abstract]) AND muscle'],
    ["diabetes AND randomized controlled trial[Publication Type]"],
    ['("2020"[Date - Publication] : "2024"[Date - Publication]) NOT review[pt]'],
    ["Smith J[au] AND (heart OR cardiac) AND 10.1000/x[doi]"],
  ])("passes PubMed syntax through untouched: %s", (query) => {
    const validation = validateSearchRequest({ query });
    expect(validation.ok).toBe(true);
    // No quote, parenthesis, bracket, field tag or Boolean operator is rewritten
    // or removed: a rewritten query is a different search than the user wrote.
    expect(validation.ok && validation.request.query).toBe(query);
  });

  it.each([
    [{}, "query is required."],
    [{ query: 42 }, "query is required."],
    [{ query: "" }, "query is required."],
    [{ query: "    " }, "query is required."],
    [null, "A JSON request body is required."],
    [["query"], "A JSON request body is required."],
    ["query=cancer", "A JSON request body is required."],
  ])("rejects %o", (body, message) => {
    expect(validateSearchRequest(body)).toEqual({ ok: false, message });
  });

  it("enforces a maximum query length on the TRIMMED value", () => {
    const atLimit = "a".repeat(PUBMED_SEARCH_MAX_QUERY_LENGTH);
    expect(validateSearchRequest({ query: atLimit }).ok).toBe(true);
    // Padding that trims away must not push a legal query over the bound.
    expect(validateSearchRequest({ query: `   ${atLimit}   ` }).ok).toBe(true);

    const overLimit = "a".repeat(PUBMED_SEARCH_MAX_QUERY_LENGTH + 1);
    expect(validateSearchRequest({ query: overLimit })).toEqual({
      ok: false,
      message: `query is too long (max ${PUBMED_SEARCH_MAX_QUERY_LENGTH} characters).`,
    });
  });

  it("bounds offset to PubMed's own retrievable window", () => {
    expect(validateSearchRequest({ query: "x", offset: 0 }).ok).toBe(true);
    expect(validateSearchRequest({ query: "x", offset: PUBMED_SEARCH_MAX_OFFSET }).ok).toBe(true);
    expect(validateSearchRequest({ query: "x", offset: PUBMED_SEARCH_MAX_OFFSET + 1 })).toEqual({
      ok: false,
      message: `offset must be between 0 and ${PUBMED_SEARCH_MAX_OFFSET}.`,
    });
    expect(validateSearchRequest({ query: "x", offset: -1 }).ok).toBe(false);
  });

  it("bounds limit independently of what the client sends", () => {
    expect(validateSearchRequest({ query: "x", limit: 1 }).ok).toBe(true);
    expect(validateSearchRequest({ query: "x", limit: PUBMED_SEARCH_MAX_LIMIT }).ok).toBe(true);
    expect(validateSearchRequest({ query: "x", limit: PUBMED_SEARCH_MAX_LIMIT + 1 })).toEqual({
      ok: false,
      message: `limit must be between 1 and ${PUBMED_SEARCH_MAX_LIMIT}.`,
    });
    expect(validateSearchRequest({ query: "x", limit: 0 }).ok).toBe(false);
  });

  it.each([
    [1.5, "offset must be an integer."],
    [Number.NaN, "offset must be an integer."],
    [Number.POSITIVE_INFINITY, "offset must be an integer."],
    [Number.MAX_SAFE_INTEGER + 2, "offset must be an integer."],
    ["10", "offset must be an integer."],
  ])("rejects a non-integer offset (%s)", (offset, message) => {
    expect(validateSearchRequest({ query: "x", offset })).toEqual({ ok: false, message });
  });

  it("accepts null/undefined pagination as 'use the defaults'", () => {
    expect(validateSearchRequest({ query: "x", offset: null, limit: undefined })).toEqual({
      ok: true,
      request: { query: "x", offset: 0, limit: PUBMED_SEARCH_DEFAULT_LIMIT },
    });
  });

  it("cannot carry a caller-supplied identity out of the request body", () => {
    const validation = validateSearchRequest({
      query: "cancer",
      userId: "00000000-0000-0000-0000-000000000000",
      user_id: "someone-else",
      apiKey: "stolen-key",
      api_key: "stolen-key",
    });
    expect(validation.ok).toBe(true);
    // Exactly three fields survive validation. Anything the client added is not
    // merely ignored downstream — it never becomes part of the request object,
    // so no later code can read an identity or a key out of it.
    expect(validation.ok && Object.keys(validation.request).sort()).toEqual([
      "limit",
      "offset",
      "query",
    ]);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// PMID validation
// ══════════════════════════════════════════════════════════════════════════

describe("normalizeSearchPmid", () => {
  it.each([["41843416", "41843416"], ["  27102172  ", "27102172"], ["1", "1"]])(
    "accepts bare decimal %s",
    (input, expected) => {
      expect(normalizeSearchPmid(input)).toBe(expected);
    },
  );

  it.each([
    ["uids"],
    ["PMC12965823"],
    ["41843416a"],
    ["-41843416"],
    ["41843416.0"],
    ["4 1843416"],
    [""],
    ["   "],
    [null],
    [undefined],
    [41843416],
    [{ uid: "41843416" }],
  ])("rejects %o", (input) => {
    expect(normalizeSearchPmid(input)).toBeNull();
  });
});

// ══════════════════════════════════════════════════════════════════════════
// URL construction
// ══════════════════════════════════════════════════════════════════════════

describe("buildESearchUrl", () => {
  it("targets ESearch with the JSON, sort and pagination parameters", () => {
    const url = new URL(buildESearchUrl({ query: "cancer", offset: 40, limit: 20 }));
    expect(url.origin + url.pathname).toBe(
      "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi",
    );
    expect(Object.fromEntries(url.searchParams)).toEqual({
      db: "pubmed",
      term: "cancer",
      retmode: "json",
      retstart: "40",
      retmax: "20",
      // PubMed's documented default ordering ("Best Match"), stated explicitly.
      sort: "relevance",
    });
  });

  it("encodes PubMed syntax so it survives transport with its meaning intact", () => {
    const query = '("resistance training"[Title/Abstract]) AND muscle & bone #1';
    const url = new URL(buildESearchUrl({ query, offset: 0, limit: 20 }));
    // Round-trips exactly — the `&` and `#` do not split the query string or
    // truncate it into a fragment, which is precisely what naive concatenation
    // would do.
    expect(url.searchParams.get("term")).toBe(query);
    expect(url.toString()).not.toContain(" ");
  });

  it("adds the API key only when one is configured", () => {
    expect(buildESearchUrl({ query: "x", offset: 0, limit: 20 })).not.toContain("api_key");
    expect(buildESearchUrl({ query: "x", offset: 0, limit: 20, apiKey: "secret" })).toContain(
      "api_key=secret",
    );
  });
});

describe("buildESummaryUrl", () => {
  it("requests version 2.0 JSON for a comma-joined id list", () => {
    const url = new URL(buildESummaryUrl({ pmids: ["1", "2", "3"] }));
    expect(url.origin + url.pathname).toBe(
      "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi",
    );
    expect(Object.fromEntries(url.searchParams)).toEqual({
      db: "pubmed",
      id: "1,2,3",
      retmode: "json",
      version: "2.0",
    });
  });
});

// ══════════════════════════════════════════════════════════════════════════
// ESearch parsing
// ══════════════════════════════════════════════════════════════════════════

describe("parseESearchResponse", () => {
  it("parses the string count and the ordered idlist", () => {
    expect(parseESearchResponse(ESEARCH_OK)).toEqual({
      ok: true,
      total: 2509,
      pmids: ["41843416", "27102172", "28834797", "37414459", "37432300"],
    });
  });

  it("treats a zero-result query as a successful empty answer", () => {
    expect(parseESearchResponse(ESEARCH_EMPTY)).toEqual({ ok: true, total: 0, pmids: [] });
  });

  it("reports NCBI's in-band ERROR as an upstream failure, not as zero results", () => {
    expect(parseESearchResponse(ESEARCH_IN_BAND_ERROR)).toEqual({
      ok: false,
      reason: "upstream_error",
    });
  });

  it("does not propagate NCBI's error text", () => {
    const parsed = parseESearchResponse(ESEARCH_IN_BAND_ERROR);
    expect(JSON.stringify(parsed)).not.toContain("Search Backend failed");
  });

  it.each([
    ["a non-object payload", "not json"],
    ["a missing esearchresult", { header: {} }],
    ["a non-numeric count", { esearchresult: { count: "many", idlist: [] } }],
    ["a negative count", { esearchresult: { count: "-1", idlist: [] } }],
    ["a fractional count", { esearchresult: { count: "12.5", idlist: [] } }],
    ["a missing idlist", { esearchresult: { count: "5" } }],
    ["a non-array idlist", { esearchresult: { count: "5", idlist: "41843416" } }],
  ])("fails safely on %s", (_label, payload) => {
    expect(parseESearchResponse(payload)).toEqual({ ok: false, reason: "malformed" });
  });

  it("never yields NaN from an unparseable count", () => {
    const parsed = parseESearchResponse({ esearchresult: { count: "n/a", idlist: [] } });
    expect(parsed.ok).toBe(false);
    expect(parsed).not.toHaveProperty("total");
  });

  it("drops idlist entries that are not valid PMIDs rather than importing them", () => {
    const parsed = parseESearchResponse({
      esearchresult: {
        count: "4",
        idlist: ["41843416", "PMC123", null, "", "27102172", { uid: "3" }],
      },
    });
    expect(parsed).toEqual({ ok: true, total: 4, pmids: ["41843416", "27102172"] });
  });

  it("de-duplicates a repeated PMID while preserving first-seen order", () => {
    const parsed = parseESearchResponse({
      esearchresult: { count: "3", idlist: ["2", "1", "2", "3"] },
    });
    expect(parsed).toEqual({ ok: true, total: 3, pmids: ["2", "1", "3"] });
  });
});

// ══════════════════════════════════════════════════════════════════════════
// ESummary mapping
// ══════════════════════════════════════════════════════════════════════════

describe("mapESummaryResponse", () => {
  it("maps a complete record onto the discovery shape", () => {
    const results = mapESummaryResponse(esummary([SUMMARY_COMPLETE]), ["41843416"]);
    expect(results).toEqual([
      {
        pmid: "41843416",
        title:
          "American College of Sports Medicine Position Stand. Resistance Training Prescription for Muscle Function, Hypertrophy, and Physical Performance in Healthy Adults: An Overview of Reviews.",
        authors: ["Currier BS", "D'Souza AC", "Singh MAF", "Lowisz CV"],
        journal: "Medicine and science in sports and exercise",
        publicationDate: "2026 Apr 1",
        year: 2026,
        publicationTypes: ["Journal Article", "Review"],
        doi: "10.1249/MSS.0000000000003897",
      },
    ]);
  });

  it("keeps a consortium (CollectiveName) author as a display author", () => {
    const results = mapESummaryResponse(esummary([SUMMARY_COLLECTIVE]), ["41912805"]);
    expect(results?.[0].authors).toEqual(["GBD 2023 IHD & Dietary Risk Factors Collaborators"]);
  });

  it("PRESERVES THE ESEARCH ORDER, not the payload's own key order", () => {
    // NCBI's `result` object here is keyed in the opposite order to the search
    // ranking. Reading the object would silently replace PubMed's relevance
    // order with a serializer artefact.
    const payload = esummary([SUMMARY_COLLECTIVE, SUMMARY_COMPLETE]);
    expect((payload.result as Record<string, unknown>).uids).toEqual(["41912805", "41843416"]);

    const results = mapESummaryResponse(payload, ["41843416", "41912805"]);
    expect(results?.map((r) => r.pmid)).toEqual(["41843416", "41912805"]);
  });

  it("still lists a record NCBI could not summarise, keeping the PMID authoritative", () => {
    const results = mapESummaryResponse(
      esummary([SUMMARY_COMPLETE, SUMMARY_ERROR_RECORD]),
      ["41843416", "999999999"],
    );
    expect(results).toHaveLength(2);
    expect(results?.[1]).toEqual({
      pmid: "999999999",
      title: null,
      authors: [],
      journal: null,
      publicationDate: null,
      year: null,
      publicationTypes: [],
      doi: null,
    });
  });

  it("still lists a PMID the summary payload omitted entirely", () => {
    const results = mapESummaryResponse(esummary([SUMMARY_COMPLETE]), ["41843416", "27102172"]);
    expect(results?.map((r) => r.pmid)).toEqual(["41843416", "27102172"]);
    expect(results?.[1].title).toBeNull();
  });

  it("invents nothing for missing optional fields", () => {
    const results = mapESummaryResponse(
      esummary([{ uid: "1", title: "Bare record" }]),
      ["1"],
    );
    expect(results?.[0]).toEqual({
      pmid: "1",
      title: "Bare record",
      authors: [],
      journal: null,
      publicationDate: null,
      year: null,
      publicationTypes: [],
      doi: null,
    });
  });

  it("falls back to the NLM journal abbreviation when there is no full name", () => {
    const results = mapESummaryResponse(
      esummary([{ uid: "1", source: "Med Sci Sports Exerc" }]),
      ["1"],
    );
    expect(results?.[0].journal).toBe("Med Sci Sports Exerc");
  });

  it.each([
    [{ pubdate: "2019 Nov-Dec" }, 2019],
    [{ pubdate: "2020" }, 2020],
    [{ pubdate: "Spring 2021", sortpubdate: "2021/03/01 00:00" }, 2021],
    [{ sortpubdate: "1998/01/01 00:00" }, 1998],
    [{ pubdate: "n.d." }, null],
    [{}, null],
  ])("derives the year from PubMed's own date fields (%o)", (fields, expected) => {
    const results = mapESummaryResponse(esummary([{ uid: "1", ...fields }]), ["1"]);
    expect(results?.[0].year).toBe(expected);
  });

  it("keeps PubMed's own pubdate text rather than reformatting it", () => {
    const results = mapESummaryResponse(esummary([{ uid: "1", pubdate: "2019 Nov-Dec" }]), ["1"]);
    expect(results?.[0].publicationDate).toBe("2019 Nov-Dec");
  });

  it("skips malformed author entries without losing the good ones", () => {
    const results = mapESummaryResponse(
      esummary([{ uid: "1", authors: [{ name: "Good A" }, { name: "" }, null, "Bare string", { authtype: "Author" }] }]),
      ["1"],
    );
    expect(results?.[0].authors).toEqual(["Good A"]);
  });

  it("skips malformed publication types and non-DOI article ids", () => {
    const results = mapESummaryResponse(
      esummary([
        {
          uid: "1",
          pubtype: ["Journal Article", "", null, 42, "Review"],
          articleids: [
            { idtype: "pubmed", value: "1" },
            { idtype: "doi", value: "   " },
            { idtype: "doi", value: "10.5555/real" },
          ],
        },
      ]),
      ["1"],
    );
    expect(results?.[0].publicationTypes).toEqual(["Journal Article", "Review"]);
    expect(results?.[0].doi).toBe("10.5555/real");
  });

  it("returns null when the payload is not an ESummary response at all", () => {
    expect(mapESummaryResponse(null, ["1"])).toBeNull();
    expect(mapESummaryResponse("<html>502</html>", ["1"])).toBeNull();
    expect(mapESummaryResponse({ header: {} }, ["1"])).toBeNull();
    expect(mapESummaryResponse({ result: "unavailable" }, ["1"])).toBeNull();
  });

  it("answers an empty PMID list without consulting the payload", () => {
    expect(mapESummaryResponse(null, [])).toEqual([]);
  });

  it("does NOT entity-decode: ESummary JSON already arrives decoded", () => {
    // Measured live: `fulljournalname` for Alzheimers Dement is
    // "Alzheimer's & dementia …" with a literal `&` and `'`, and a title such as
    // "…TNF-α…" arrives as the real code point. Decoding this payload a second
    // time is what turns a legitimate literal into markup, so values are carried
    // through byte-for-byte.
    const literal = "p<0.05 in Alzheimer's & dementia — TNF-α &amp; friends";
    const results = mapESummaryResponse(
      esummary([{ uid: "1", title: literal, fulljournalname: literal }]),
      ["1"],
    );
    expect(results?.[0].title).toBe(literal);
    expect(results?.[0].journal).toBe(literal);
  });
});
