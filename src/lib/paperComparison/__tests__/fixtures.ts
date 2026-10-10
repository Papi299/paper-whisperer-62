/**
 * Synthetic comparison fixtures. Every title, abstract and term is invented;
 * none comes from a real paper or a real library.
 */

export const OWNER_ID = "0b6e8a52-5f3c-4c1e-9d43-2f1a7c9e0a11";
export const OTHER_USER_ID = "7d2c41f0-9a8b-4e6d-8c5f-3b1e2a4d6c22";

/** A well-formed, distinct paper id per `n`. */
export function paperId(n: number): string {
  return `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
}

export type RawRow = Record<string, unknown>;

/**
 * A response row shaped exactly as `COMPARISON_PAPER_SELECT` returns one, with
 * every field populated. Nested records point at `id` and `OWNER_ID`.
 */
export function makePaperRow(id: string = paperId(1), overrides: RawRow = {}): RawRow {
  return {
    id,
    user_id: OWNER_ID,
    title: "Synthetic randomized trial of compound A",
    authors: ["Doe J", "Roe R", "Poe P", "Moe M"],
    year: 2021,
    journal: "Journal of Synthetic Fixtures",
    pmid: "12345678",
    doi: "10.5555/synthetic.0001",
    abstract: "Background: synthetic. Results: 10<sup>-4</sup> &#xd7; 2.5 ± 0.3.",
    study_type: "Randomized Controlled Trial",
    raw_study_type: "Randomized Controlled Trial, Clinical Trial, Phase II",
    raw_publication_types: ["Randomized Controlled Trial", "Clinical Trial, Phase II", "Journal Article"],
    statistical_methods: "Mixed-effects model",
    tldr: "Synthetic summary for compound A.",
    notes: "Synthetic note.",
    keywords: ["compound A", "adults"],
    raw_keywords: ["Compound A"],
    mesh_terms: ["Humans", "Adult"],
    substances: ["Compound A"],
    paper_attachments: [
      { id: `${id}-att-1`, paper_id: id, user_id: OWNER_ID, file_type: "application/pdf" },
      { id: `${id}-att-2`, paper_id: id, user_id: OWNER_ID, file_type: "image/png" },
    ],
    paper_projects: [
      { paper_id: id, project: { id: `${id}-proj-1`, user_id: OWNER_ID, name: "Synthetic project", color: "#336699" } },
    ],
    paper_tags: [{ paper_id: id, tag: { id: `${id}-tag-1`, user_id: OWNER_ID, name: "synthetic-tag", color: null } }],
    ...overrides,
  };
}

/** A row with every optional value absent and no relationships. */
export function makeSparsePaperRow(id: string, overrides: RawRow = {}): RawRow {
  return makePaperRow(id, {
    title: "Synthetic sparse record",
    authors: [],
    year: null,
    journal: null,
    pmid: null,
    doi: null,
    abstract: null,
    study_type: null,
    raw_study_type: null,
    raw_publication_types: null,
    statistical_methods: null,
    tldr: null,
    notes: null,
    keywords: [],
    raw_keywords: [],
    mesh_terms: [],
    substances: [],
    paper_attachments: [],
    paper_projects: [],
    paper_tags: [],
    ...overrides,
  });
}
