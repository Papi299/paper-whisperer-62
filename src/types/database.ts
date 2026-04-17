export interface Profile {
  id: string;
  user_id: string;
  email: string | null;
  display_name: string | null;
  created_at: string;
  updated_at: string;
}

export interface Project {
  id: string;
  user_id: string;
  name: string;
  description: string | null;
  color: string;
  created_at: string;
  updated_at: string;
}

export interface Tag {
  id: string;
  user_id: string;
  name: string;
  color: string;
  created_at: string;
}

export interface PaperProject {
  id: string;
  paper_id: string;
  project_id: string;
  created_at: string;
}

export interface Paper {
  id: string;
  user_id: string;
  title: string;
  authors: string[];
  year: number | null;
  journal: string | null;
  pmid: string | null;
  doi: string | null;
  /** Full abstract text. Excluded from the base list query for payload optimization;
   *  fetched on demand when expanding a row, editing, or analyzing. */
  abstract?: string | null;
  /** Lightweight boolean derived from `abstract IS NOT NULL` (stored generated column).
   *  Included in the base list query so the UI knows whether expand/analyze are available. */
  has_abstract?: boolean;
  study_type: string | null;
  raw_study_type: string | null;
  statistical_methods: string | null;
  keywords: string[];
  raw_keywords: string[];
  mesh_terms: string[];
  substances: string[];
  pubmed_url: string | null;
  journal_url: string | null;
  drive_url: string | null;
  tldr: string | null;
  notes: string | null;
  insert_order: number;
  created_at: string;
  updated_at: string;
}

export interface PaperTag {
  id: string;
  paper_id: string;
  tag_id: string;
  created_at: string;
}

export interface PaperAttachment {
  id: string;
  file_name: string;
  file_path: string;
  file_type: string;
}

export interface PaperWithTags extends Paper {
  tags: Tag[];
  projects: Project[];
  paper_attachments?: PaperAttachment[];
}

/**
 * Metadata returned by the fetch-paper-metadata edge function.
 * Each entry corresponds to one identifier lookup attempt.
 */
/** Lightweight paper info returned by the get_duplicate_papers() RPC. */
export interface DuplicatePaperInfo {
  id: string;
  title: string;
  authors: string[];
  year: number | null;
  journal: string | null;
  pmid: string | null;
  doi: string | null;
  abstract: string | null;
  study_type: string | null;
  keywords: string[];
  created_at: string;
}

/** A group of papers sharing the same PMID or DOI, returned by get_duplicate_papers(). */
export interface DuplicateGroup {
  match_type: "doi" | "pmid";
  match_value: string;
  papers: DuplicatePaperInfo[];
}

/** Per-row result from the safe_bulk_insert_papers RPC. */
export interface BulkInsertResult {
  index: number;
  id?: string;
  status: "inserted" | "duplicate" | "error";
  error_message?: string;
}

export interface PaperMetadata {
  identifier: string;
  title?: string;
  authors?: string[];
  year?: number | null;
  journal?: string | null;
  pmid?: string | null;
  doi?: string | null;
  abstract?: string | null;
  keywords?: string[];
  mesh_terms?: string[];
  substances?: string[];
  study_type?: string | null;
  pubmed_url?: string | null;
  journal_url?: string | null;
  source?: "pubmed" | "crossref";
  error?: string;
}

