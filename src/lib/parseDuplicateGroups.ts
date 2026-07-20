import type { Json } from "@/integrations/supabase/types";
import type { DuplicateGroup, DuplicatePaperInfo } from "@/types/database";

/**
 * Runtime-validating parser for the `get_duplicate_papers()` RPC result.
 *
 * The RPC returns `jsonb`, which the generated types surface as the opaque
 * `Json` union. This guard narrows that untrusted payload into the strongly
 * typed `DuplicateGroup[]` domain shape at the query boundary, dropping any
 * entry that does not match the expected structure rather than asserting
 * blindly. Malformed rows are skipped so a single bad group can never crash
 * the dedup scan.
 */

function asStringArray(value: Json | undefined): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === "string");
}

function parsePaper(value: Json): DuplicatePaperInfo | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const row = value as { [key: string]: Json | undefined };
  if (typeof row.id !== "string" || typeof row.title !== "string") return null;
  return {
    id: row.id,
    title: row.title,
    authors: asStringArray(row.authors),
    year: typeof row.year === "number" ? row.year : null,
    journal: typeof row.journal === "string" ? row.journal : null,
    pmid: typeof row.pmid === "string" ? row.pmid : null,
    doi: typeof row.doi === "string" ? row.doi : null,
    abstract: typeof row.abstract === "string" ? row.abstract : null,
    study_type: typeof row.study_type === "string" ? row.study_type : null,
    keywords: asStringArray(row.keywords),
    created_at: typeof row.created_at === "string" ? row.created_at : "",
  };
}

export function parseDuplicateGroups(data: Json | null): DuplicateGroup[] {
  if (!Array.isArray(data)) return [];
  const groups: DuplicateGroup[] = [];
  for (const item of data) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) continue;
    const row = item as { [key: string]: Json | undefined };
    if (row.match_type !== "doi" && row.match_type !== "pmid") continue;
    if (typeof row.match_value !== "string") continue;
    const papers = Array.isArray(row.papers)
      ? row.papers.map(parsePaper).filter((p): p is DuplicatePaperInfo => p !== null)
      : [];
    groups.push({ match_type: row.match_type, match_value: row.match_value, papers });
  }
  return groups;
}
