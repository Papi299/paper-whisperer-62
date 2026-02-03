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

export interface Paper {
  id: string;
  user_id: string;
  project_id: string | null;
  title: string;
  authors: string[];
  year: number | null;
  journal: string | null;
  pmid: string | null;
  doi: string | null;
  abstract: string | null;
  study_type: string | null;
  statistical_methods: string | null;
  keywords: string[];
  mesh_terms: string[];
  substances: string[];
  pubmed_url: string | null;
  journal_url: string | null;
  drive_url: string | null;
  created_at: string;
  updated_at: string;
}

export interface PaperTag {
  id: string;
  paper_id: string;
  tag_id: string;
  created_at: string;
}

export interface PaperWithTags extends Paper {
  tags: Tag[];
  project?: Project | null;
}

export interface PaperMetadata {
  title: string;
  authors: string[];
  year: number | null;
  journal: string | null;
  pmid: string | null;
  doi: string | null;
  abstract: string | null;
  keywords: string[];
  mesh_terms: string[];
  substances: string[];
  study_type: string | null;
  pubmed_url: string | null;
  journal_url: string | null;
  drive_url?: string | null;
}
