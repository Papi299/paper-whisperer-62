// @vitest-environment node
//
// DOI-PUBMED-MATCH-HARDENING-001 — the DOI lookup in fetch-paper-metadata.
//
// A PubMed DOI search answers with candidates, and the lookup used to trust
// the first one: the PubMed-first path returned whatever record the first PMID
// fetched — backfilling the requested DOI into it when it carried none — and
// the Crossref branch attached that record's PMID, keywords, MeSH terms,
// substances, study type and PubMed URL without comparing DOIs. These tests
// drive the decision, which now lives in `../doiLookup.ts`, with scripted
// provider fakes: no PubMed, Crossref, doi.org or Consensus request is made,
// and `fetch` itself is stubbed to fail the test if anything tries.
//
// The last describe block is a source-level fitness check on `index.ts`, which
// Vitest cannot import (Deno runtime, remote imports): behavioural tests on the
// module cannot show that the deployed entrypoint still uses it.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { classifyPubMedDoiMatch, createFetchByDoi, type DoiLookupRecord } from "../doiLookup.ts";
import { canonicalDoiUrl } from "../../_shared/identifierDetection.ts";
import { extractPubMedArticleDoi } from "../../_shared/pubmedArticleIdentifiers.ts";
import {
  CITED_DOI,
  OWN_NO_DOI_CITES_DOI,
  articleId,
  efetchDocument,
  pubmedArticle,
  reference,
  referenceList,
} from "../../_shared/__tests__/fixtures/pubmedEfetchXml.ts";

interface TestRecord extends DoiLookupRecord {
  identifier: string;
  title: string;
  journal_url?: string | null;
  source: "pubmed" | "crossref";
}

const DOI_A = "10.1000/requested-paper";
const DOI_A_UPPER = "10.1000/REQUESTED-PAPER";
const DOI_B = "10.1000/other-paper";
const PMID_P = "11111111";
const API_KEY = "SECRET_PUBMED_KEY";

/** What `fetchFromPubMed` builds: `journal_url` comes from the record's own DOI. */
function pubmedRecord(pmid: string, doi: string | null | undefined): TestRecord {
  return {
    identifier: pmid,
    title: `PubMed paper ${pmid}`,
    pmid,
    doi,
    keywords: [`keyword-${pmid}`],
    mesh_terms: [`mesh-${pmid}`],
    substances: [`substance-${pmid}`],
    study_type: "Randomized Controlled Trial, Journal Article",
    publication_types: ["Randomized Controlled Trial", "Journal Article"],
    pubmed_url: `https://pubmed.ncbi.nlm.nih.gov/${pmid}/`,
    journal_url: canonicalDoiUrl(doi),
    source: "pubmed",
  };
}

/** What `mapCrossrefToSchema` builds: no PubMed fields, no `publication_types`. */
function crossrefRecord(doi: string): TestRecord {
  return {
    identifier: doi,
    title: "The paper Crossref resolved",
    pmid: null,
    doi,
    keywords: [],
    mesh_terms: [],
    substances: [],
    study_type: "Journal Article",
    pubmed_url: null,
    journal_url: canonicalDoiUrl(doi),
    source: "crossref",
  };
}

interface Script {
  /** PubMed DOI search, keyed by the exact DOI string searched for. */
  search?: Record<string, string>;
  /** PubMed EFetch, keyed by PMID. A fresh copy is issued on every call. */
  pubmed?: Record<string, TestRecord>;
  /** Crossref works lookup, keyed by the exact DOI string. */
  crossref?: Record<string, TestRecord>;
}

function harness(script: Script) {
  const calls: string[] = [];
  const logs: string[] = [];
  const warnings: string[] = [];
  const issuedPubmed: TestRecord[] = [];
  const fetchByDoi = createFetchByDoi<TestRecord>({
    searchPubMedByDoi: async (doi, apiKey) => {
      calls.push(`search ${doi} key=${apiKey ?? "-"}`);
      return script.search?.[doi] ?? null;
    },
    fetchFromPubMed: async (pmid, apiKey) => {
      calls.push(`efetch ${pmid} key=${apiKey ?? "-"}`);
      const template = script.pubmed?.[pmid];
      if (!template) return null;
      const record = structuredClone(template);
      issuedPubmed.push(record);
      return record;
    },
    fetchFromCrossrefByDoi: async (doi) => {
      calls.push(`crossref ${doi}`);
      const template = script.crossref?.[doi];
      return template ? structuredClone(template) : null;
    },
    logger: {
      log: (message) => logs.push(message),
      warn: (message) => warnings.push(message),
    },
  });
  return { fetchByDoi, calls, logs, warnings, issuedPubmed };
}

const FALLBACK_LOG = "PubMed unavailable for DOI, falling back to Crossref";
const rejected = (match: "missing" | "mismatch", stage: "direct" | "enrichment") =>
  `fetch-paper-metadata doi_pubmed_match=${match} stage=${stage}`;

let fetchSpy: ReturnType<typeof vi.fn>;
beforeEach(() => {
  fetchSpy = vi.fn(() => {
    throw new Error("network access attempted from a unit test");
  });
  vi.stubGlobal("fetch", fetchSpy);
});
afterEach(() => {
  expect(fetchSpy).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
});

describe("classifyPubMedDoiMatch", () => {
  it("is a match only for an equivalent DOI", () => {
    expect(classifyPubMedDoiMatch(DOI_A, DOI_A)).toBe("match");
    expect(classifyPubMedDoiMatch(DOI_A_UPPER, DOI_A)).toBe("match");
    expect(classifyPubMedDoiMatch(DOI_B, DOI_A)).toBe("mismatch");
  });

  it("calls an absent or empty DOI missing", () => {
    expect(classifyPubMedDoiMatch(undefined, DOI_A)).toBe("missing");
    expect(classifyPubMedDoiMatch(null, DOI_A)).toBe("missing");
    expect(classifyPubMedDoiMatch("", DOI_A)).toBe("missing");
  });

  it("never matches an empty DOI, even against an empty request", () => {
    // `doiNamesAreEquivalent("", "")` is true; emptiness is checked first.
    expect(classifyPubMedDoiMatch("", "")).toBe("missing");
  });

  it("does not trim, decode or case-map beyond ASCII", () => {
    expect(classifyPubMedDoiMatch(` ${DOI_A}`, DOI_A)).toBe("mismatch");
    expect(classifyPubMedDoiMatch("10.1000/a%23b", "10.1000/a#b")).toBe("mismatch");
    expect(classifyPubMedDoiMatch("10.26321/Á", "10.26321/á")).toBe("mismatch");
  });
});

describe("PubMed-first path", () => {
  it("returns a PubMed record whose own DOI is the requested DOI", async () => {
    const h = harness({ search: { [DOI_A]: PMID_P }, pubmed: { [PMID_P]: pubmedRecord(PMID_P, DOI_A) } });

    const result = await h.fetchByDoi(DOI_A, API_KEY);

    expect(h.issuedPubmed).toHaveLength(1);
    expect(result).toBe(h.issuedPubmed[0]);
    expect(result).toEqual(pubmedRecord(PMID_P, DOI_A));
    expect(h.calls).toEqual([`search ${DOI_A} key=${API_KEY}`, `efetch ${PMID_P} key=${API_KEY}`]);
    expect(h.logs).toEqual([]);
    expect(h.warnings).toEqual([]);
  });

  it("accepts an ASCII-case-equivalent DOI and keeps PubMed's own spelling", async () => {
    const h = harness({
      search: { [DOI_A_UPPER]: PMID_P },
      pubmed: { [PMID_P]: pubmedRecord(PMID_P, DOI_A) },
    });

    const result = await h.fetchByDoi(DOI_A_UPPER);

    expect(result).toBe(h.issuedPubmed[0]);
    // Neither the DOI nor the link built from it is rewritten to the request.
    expect(result?.doi).toBe(DOI_A);
    expect(result?.journal_url).toBe(canonicalDoiUrl(DOI_A));
    expect(h.calls).toEqual([`search ${DOI_A_UPPER} key=-`, `efetch ${PMID_P} key=-`]);
    expect(h.warnings).toEqual([]);
  });

  it("rejects a record naming a different DOI and falls back to Crossref", async () => {
    const h = harness({
      search: { [DOI_A]: PMID_P },
      pubmed: { [PMID_P]: pubmedRecord(PMID_P, DOI_B) },
      crossref: { [DOI_A]: crossrefRecord(DOI_A) },
    });

    const result = await h.fetchByDoi(DOI_A, API_KEY);

    expect(result).toEqual(crossrefRecord(DOI_A));
    expect(h.issuedPubmed).not.toContain(result);
    // The enrichment search finds the same wrong record and rejects it too —
    // the same call sequence a failed PubMed fetch already produced.
    expect(h.calls).toEqual([
      `search ${DOI_A} key=${API_KEY}`,
      `efetch ${PMID_P} key=${API_KEY}`,
      `crossref ${DOI_A}`,
      `search ${DOI_A} key=${API_KEY}`,
      `efetch ${PMID_P} key=${API_KEY}`,
    ]);
    expect(h.logs).toEqual([FALLBACK_LOG]);
    expect(h.warnings).toEqual([rejected("mismatch", "direct"), rejected("mismatch", "enrichment")]);
  });

  it("rejects a record with no DOI and falls back to Crossref", async () => {
    const h = harness({
      search: { [DOI_A]: PMID_P },
      pubmed: { [PMID_P]: pubmedRecord(PMID_P, undefined) },
      crossref: { [DOI_A]: crossrefRecord(DOI_A) },
    });

    const result = await h.fetchByDoi(DOI_A);

    expect(result).toEqual(crossrefRecord(DOI_A));
    expect(h.issuedPubmed).not.toContain(result);
    expect(h.warnings).toEqual([rejected("missing", "direct"), rejected("missing", "enrichment")]);
  });

  it("rejects a record with an empty DOI", async () => {
    const h = harness({
      search: { [DOI_A]: PMID_P },
      pubmed: { [PMID_P]: pubmedRecord(PMID_P, "") },
      crossref: { [DOI_A]: crossrefRecord(DOI_A) },
    });

    expect(await h.fetchByDoi(DOI_A)).toEqual(crossrefRecord(DOI_A));
    expect(h.warnings[0]).toBe(rejected("missing", "direct"));
  });

  it("rejects a record whose DOI differs only by non-ASCII case", async () => {
    const requested = "10.26321/Á.GUTIÉRREZ";
    const h = harness({
      search: { [requested]: PMID_P },
      pubmed: { [PMID_P]: pubmedRecord(PMID_P, "10.26321/á.gutiérrez") },
      crossref: { [requested]: crossrefRecord(requested) },
    });

    expect(await h.fetchByDoi(requested)).toEqual(crossrefRecord(requested));
    expect(h.warnings[0]).toBe(rejected("mismatch", "direct"));
  });

  it("never gives an unverified record the requested DOI, even when Crossref finds nothing", async () => {
    // The backfill this replaced turned exactly this case into a success: a
    // DOI-less record — possibly a different paper — came back labelled with
    // the DOI that was asked for.
    const h = harness({
      search: { [DOI_A]: PMID_P },
      pubmed: { [PMID_P]: pubmedRecord(PMID_P, undefined) },
    });

    const result = await h.fetchByDoi(DOI_A);

    expect(result).toBeNull();
    expect(h.issuedPubmed).toHaveLength(1);
    expect(h.issuedPubmed[0].doi).toBeUndefined();
    expect(h.issuedPubmed[0].journal_url).toBeNull();
    expect(h.calls).toEqual([`search ${DOI_A} key=-`, `efetch ${PMID_P} key=-`, `crossref ${DOI_A}`]);
  });

  it("never returns a mismatched record when Crossref finds nothing", async () => {
    const h = harness({
      search: { [DOI_A]: PMID_P },
      pubmed: { [PMID_P]: pubmedRecord(PMID_P, DOI_B) },
    });

    expect(await h.fetchByDoi(DOI_A)).toBeNull();
    expect(h.issuedPubmed[0].doi).toBe(DOI_B);
  });

  it("keeps the existing fallback when PubMed has no candidate", async () => {
    const h = harness({ crossref: { [DOI_A]: crossrefRecord(DOI_A) } });

    expect(await h.fetchByDoi(DOI_A)).toEqual(crossrefRecord(DOI_A));
    expect(h.calls).toEqual([`search ${DOI_A} key=-`, `crossref ${DOI_A}`, `search ${DOI_A} key=-`]);
    expect(h.logs).toEqual([FALLBACK_LOG]);
    expect(h.warnings).toEqual([]);
  });

  it("keeps the existing fallback when the PubMed fetch returns nothing", async () => {
    const h = harness({ search: { [DOI_A]: PMID_P }, crossref: { [DOI_A]: crossrefRecord(DOI_A) } });

    expect(await h.fetchByDoi(DOI_A)).toEqual(crossrefRecord(DOI_A));
    expect(h.warnings).toEqual([]);
  });
});

describe("Crossref enrichment", () => {
  // The PubMed-first search uses the requested spelling and finds nothing; the
  // enrichment search uses the spelling Crossref returned and finds PMID_P.
  // That isolates the enrichment decision from the PubMed-first one.
  const enrichmentScript = (pubmedDoi: string | null | undefined): Script => ({
    search: { [DOI_A]: PMID_P },
    pubmed: { [PMID_P]: pubmedRecord(PMID_P, pubmedDoi) },
    crossref: { [DOI_A_UPPER]: crossrefRecord(DOI_A) },
  });

  it("enriches from a PubMed record naming the Crossref DOI", async () => {
    const h = harness(enrichmentScript(DOI_A));

    const result = await h.fetchByDoi(DOI_A_UPPER, API_KEY);

    expect(h.calls).toEqual([
      `search ${DOI_A_UPPER} key=${API_KEY}`,
      `crossref ${DOI_A_UPPER}`,
      `search ${DOI_A} key=${API_KEY}`,
      `efetch ${PMID_P} key=${API_KEY}`,
    ]);
    expect(result).toEqual({
      ...crossrefRecord(DOI_A),
      pmid: PMID_P,
      keywords: [`keyword-${PMID_P}`],
      mesh_terms: [`mesh-${PMID_P}`],
      substances: [`substance-${PMID_P}`],
      study_type: "Randomized Controlled Trial, Journal Article",
      publication_types: ["Randomized Controlled Trial", "Journal Article"],
      pubmed_url: `https://pubmed.ncbi.nlm.nih.gov/${PMID_P}/`,
    });
    expect(h.warnings).toEqual([]);
  });

  it("enriches when the two DOIs differ only by ASCII case", async () => {
    const h = harness(enrichmentScript(DOI_A_UPPER));

    const result = await h.fetchByDoi(DOI_A_UPPER);

    expect(result?.pmid).toBe(PMID_P);
    // The Crossref record keeps Crossref's DOI spelling and link.
    expect(result?.doi).toBe(DOI_A);
    expect(result?.journal_url).toBe(canonicalDoiUrl(DOI_A));
  });

  it("attaches nothing from a PubMed record naming a different DOI", async () => {
    const h = harness(enrichmentScript(DOI_B));

    const result = await h.fetchByDoi(DOI_A_UPPER, API_KEY);

    expect(result).toEqual(crossrefRecord(DOI_A));
    expect(result?.pmid).toBeNull();
    expect(result).not.toHaveProperty("publication_types");
    expect(h.warnings).toEqual([rejected("mismatch", "enrichment")]);
  });

  it("attaches nothing from a PubMed record with no DOI", async () => {
    const h = harness(enrichmentScript(undefined));

    const result = await h.fetchByDoi(DOI_A_UPPER);

    expect(result).toEqual(crossrefRecord(DOI_A));
    expect(h.warnings).toEqual([rejected("missing", "enrichment")]);
  });

  it("still returns the Crossref paper when enrichment is rejected", async () => {
    const h = harness(enrichmentScript(DOI_B));

    const result = await h.fetchByDoi(DOI_A_UPPER);

    expect(result?.source).toBe("crossref");
    expect(result?.title).toBe("The paper Crossref resolved");
    expect(result?.doi).toBe(DOI_A);
  });

  it("does not attempt enrichment when Crossref returned no DOI", async () => {
    const withoutDoi = { ...crossrefRecord(DOI_A), doi: null };
    const h = harness({ crossref: { [DOI_A]: withoutDoi } });

    expect(await h.fetchByDoi(DOI_A)).toEqual(withoutDoi);
    expect(h.calls).toEqual([`search ${DOI_A} key=-`, `crossref ${DOI_A}`]);
  });
});

describe("rejection logging is bounded", () => {
  it("never names the DOI, PMID, title, a URL or the API key", async () => {
    const lines: string[] = [];
    for (const script of [
      { search: { [DOI_A]: PMID_P }, pubmed: { [PMID_P]: pubmedRecord(PMID_P, DOI_B) }, crossref: { [DOI_A]: crossrefRecord(DOI_A) } },
      { search: { [DOI_A]: PMID_P }, pubmed: { [PMID_P]: pubmedRecord(PMID_P, undefined) }, crossref: { [DOI_A]: crossrefRecord(DOI_A) } },
    ]) {
      const h = harness(script);
      await h.fetchByDoi(DOI_A, API_KEY);
      expect(h.warnings.length).toBeGreaterThan(0);
      for (const warning of h.warnings) {
        expect(warning).toMatch(/^fetch-paper-metadata doi_pubmed_match=(missing|mismatch) stage=(direct|enrichment)$/);
      }
      lines.push(...h.logs, ...h.warnings);
    }

    for (const line of lines) {
      for (const secret of [DOI_A, DOI_B, "requested-paper", "other-paper", PMID_P, "PubMed paper", "Crossref resolved", "doi.org", "pubmed.ncbi", API_KEY]) {
        expect(line, `log line leaked ${secret}`).not.toContain(secret);
      }
    }
  });
});

describe("PubMed DOI provenance end to end (PUBMED-OWN-DOI-EXTRACTION-HARDENING-001)", () => {
  // The record a PubMed candidate becomes: its `doi` is what fetchFromPubMed
  // now derives from the EFetch XML, i.e. `extractPubMedArticleDoi(xml)`.
  const candidateFrom = (xml: string) => pubmedRecord(PMID_P, extractPubMedArticleDoi(xml));

  it("does not accept a PubMed candidate that only cites the requested DOI", async () => {
    // The candidate states no DOI of its own; one of its references is the
    // requested paper. Read globally, that reference DOI would have matched
    // and passed the candidate off as the requested paper.
    const candidate = candidateFrom(OWN_NO_DOI_CITES_DOI);
    expect(candidate.doi).toBeNull();

    const h = harness({
      search: { [CITED_DOI]: PMID_P },
      pubmed: { [PMID_P]: candidate },
      crossref: { [CITED_DOI]: crossrefRecord(CITED_DOI) },
    });
    const result = await h.fetchByDoi(CITED_DOI);

    expect(result).toEqual(crossrefRecord(CITED_DOI));
    expect(h.issuedPubmed).not.toContain(result);
    expect(h.warnings).toEqual([rejected("missing", "direct"), rejected("missing", "enrichment")]);
  });

  it("still accepts a candidate whose own identifiers state the requested DOI", async () => {
    const xml = efetchDocument(
      pubmedArticle({
        ownIds: [articleId("doi", DOI_A)],
        referenceLists: [referenceList(reference("Cited A.", [articleId("doi", CITED_DOI)]))],
      }),
    );
    const h = harness({ search: { [DOI_A]: PMID_P }, pubmed: { [PMID_P]: candidateFrom(xml) } });

    const result = await h.fetchByDoi(DOI_A);

    expect(result).toBe(h.issuedPubmed[0]);
    expect(result?.doi).toBe(DOI_A);
    expect(h.warnings).toEqual([]);
  });
});

describe("index.ts uses this lookup (source-level)", () => {
  // Resolved from the repository root, like the other suites here.
  const read = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");
  // Comments are prose, not capability: assert negatives against code only.
  const stripComments = (source: string) =>
    source
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split("\n")
      .filter((line) => !line.trim().startsWith("//"))
      .join("\n");
  const INDEX = stripComments(read("supabase/functions/fetch-paper-metadata/index.ts"));
  const LOOKUP = stripComments(read("supabase/functions/fetch-paper-metadata/doiLookup.ts"));

  it("builds fetchByDoi from createFetchByDoi with the real provider calls", () => {
    expect(INDEX).toMatch(/import \{ createFetchByDoi \} from "\.\/doiLookup\.ts";/);
    expect(INDEX).toMatch(
      /const fetchByDoi = createFetchByDoi<PaperMetadata>\(\{\s*searchPubMedByDoi,\s*fetchFromPubMed,\s*fetchFromCrossrefByDoi,\s*logger: console,\s*\}\);/,
    );
    expect(INDEX.match(/fetchByDoi\s*=/g) ?? []).toHaveLength(1);
    expect(INDEX).not.toMatch(/function fetchByDoi/);
    expect(INDEX).toMatch(/result = await fetchByDoi\(detected\.doi, apiKey\);/);
  });

  it("takes the PubMed record's DOI from the article's own identifiers only", () => {
    expect(INDEX).toMatch(
      /import \{ extractPubMedArticleDoi \} from "\.\.\/_shared\/pubmedArticleIdentifiers\.ts";/,
    );
    expect(INDEX).toMatch(/const doi = extractPubMedArticleDoi\(xml\);/);
    // No document-wide DOI search survives in the entrypoint.
    expect(INDEX).not.toMatch(/IdType="doi"/);
  });

  it("keeps no second copy of the decision in index.ts", () => {
    expect(INDEX).not.toMatch(/pubmedResult\./);
    expect(INDEX).not.toMatch(/crossrefResult\./);
    expect(INDEX).not.toContain("pubmedStudyTypeOverride");
  });

  it("writes the requested DOI into no record, anywhere", () => {
    for (const code of [INDEX, LOOKUP]) {
      expect(code).not.toMatch(/\|\|\s*doi\b/);
      expect(code).not.toMatch(/\|\|\s*canonicalDoiUrl\(/);
    }
    expect(LOOKUP).not.toMatch(/\.doi\s*=(?!=)/);
    expect(LOOKUP).not.toMatch(/\.journal_url\s*=(?!=)/);
    expect(LOOKUP).not.toContain("canonicalDoiUrl");
  });
});
