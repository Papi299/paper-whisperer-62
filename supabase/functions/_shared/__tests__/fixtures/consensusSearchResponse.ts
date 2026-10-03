/**
 * Synthetic Consensus `/v1/search` payloads shaped like the one live response
 * CONSENSUS-API-CAPABILITY-AUDIT-001 inspected on 2026-10-02 (owner's Free key,
 * 20 results).
 *
 * Every value here is invented. The DOIs use the `10.5555` test prefix, the
 * titles and names are fictional, and the Consensus URLs follow the audited
 * shape (`https://consensus.app/papers/<slug>/<32 hex>/?utm_source=publicapi`)
 * with made-up slugs and ids. Nothing is copied from a real response.
 *
 * What IS taken from the audit is the structure, recorded here so tests can
 * pin it:
 *
 * - the envelope is `{ results, page, page_size, is_end }` — no `next_page`;
 * - every result carried `title`, `authors` (strings), `journal_name`,
 *   `publish_year` (integer), `publish_date`, `abstract`, `citation_count`,
 *   `influential_citation_count`, `doi` (a bare `10.x/…` name), `url`,
 *   `takeaway`, `is_preprint`, `pages` and `volume` (`""` when unknown);
 * - `study_type`, `publisher_name`, `institutions`, `sjr_best_quartile`,
 *   `study_count`, `study_duration_days`, `sample_size`, `population_type` and
 *   `countries_of_study` appeared on some results only — an absent optional
 *   field is OMITTED, never `null`;
 * - there was no id field and no PMID.
 *
 * Kept outside any `*.test.ts` file so both the parser suite and the handler
 * suite use the same payloads; Vitest only collects `*.test.ts`.
 */

/** The 23 per-result field names the audit observed, for passthrough tests. */
export const AUDITED_CONSENSUS_RESULT_FIELDS = [
  "abstract",
  "authors",
  "citation_count",
  "countries_of_study",
  "doi",
  "influential_citation_count",
  "institutions",
  "is_preprint",
  "journal_name",
  "pages",
  "population_type",
  "publish_date",
  "publish_year",
  "publisher_name",
  "sample_size",
  "sjr_best_quartile",
  "study_count",
  "study_duration_days",
  "study_type",
  "takeaway",
  "title",
  "url",
  "volume",
] as const;

/** One complete, audit-shaped result. `overrides` replace or add fields. */
export function consensusResult(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    title: "Synthetic fixture: creatine supplementation and working memory in healthy adults",
    authors: ["Ada Fixture", "Ben Placeholder", "Cara Example", "Dan Sample"],
    journal_name: "Journal of Synthetic Fixtures",
    publisher_name: "Fixture Press",
    publish_year: 2024,
    publish_date: "2024-03-01",
    volume: "12",
    pages: "",
    abstract:
      "Background: this abstract is invented for a test. Methods: none. Results: none. Conclusions: it exists so the discovery card has an abstract to excerpt.",
    citation_count: 47,
    influential_citation_count: 3,
    doi: "10.5555/consensus-mvp.0001",
    url: "https://consensus.app/papers/synthetic-fixture-creatine-fixture/0123456789abcdef0123456789abcdef/?utm_source=publicapi",
    takeaway: "Synthetic takeaway: the fixture suggests a small positive effect.",
    study_type: "rct",
    is_preprint: false,
    institutions: ["Fixture University"],
    sjr_best_quartile: 1,
    sample_size: 120,
    ...overrides,
  };
}

/** A result carrying only the fields every audited result had. */
export function minimalConsensusResult(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    title: "Synthetic fixture: a result without optional fields",
    authors: ["Eve Minimal"],
    journal_name: "Fixture Letters",
    publish_year: 2019,
    publish_date: "2019-01-01",
    volume: "",
    pages: "",
    abstract: "An invented abstract.",
    citation_count: 0,
    influential_citation_count: 0,
    doi: "10.5555/consensus-mvp.0002",
    url: "https://consensus.app/papers/synthetic-fixture-minimal/fedcba9876543210fedcba9876543210/?utm_source=publicapi",
    takeaway: "Synthetic takeaway for a minimal result.",
    is_preprint: false,
    ...overrides,
  };
}

/** The audited envelope around `results`. */
export function consensusEnvelope(results: unknown[]): Record<string, unknown> {
  return { results, page: 0, page_size: 20, is_end: false };
}
