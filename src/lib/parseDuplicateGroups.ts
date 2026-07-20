import type { Json } from "@/integrations/supabase/types";
import type { DuplicateGroup, DuplicatePaperInfo, DuplicatePaperSet } from "@/types/database";

/**
 * Runtime-validating parser for the `get_duplicate_papers()` RPC result.
 *
 * The RPC returns `jsonb`, which the generated types surface as the opaque
 * `Json` union. This guard narrows that untrusted payload into the strongly
 * typed `DuplicateGroup[]` domain shape at the query boundary. For each raw
 * group it requires a valid `"doi"`/`"pmid"` `match_type`, a non-empty
 * (trimmed) `match_value`, and an array of papers; each paper is parsed
 * through a runtime guard, malformed papers are dropped, papers are
 * deduplicated by `id` (preserving RPC order), and the **entire group is
 * discarded unless at least two distinct valid papers remain**. This upholds
 * the `DuplicatePaperSet` at-least-two invariant, so downstream consumers
 * (`suggestKeepPaper`, the dedup dialog) can safely access `papers[0]` /
 * `papers[1]` without optional chaining or placeholder papers.
 */

/** Type guard proving an array holds at least two elements (a `DuplicatePaperSet`). */
function hasAtLeastTwo(items: DuplicatePaperInfo[]): items is DuplicatePaperSet {
  return items.length >= 2;
}

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
    // The raw RPC only ever emits "doi" or "pmid"; "both" is synthesized later
    // by mergeOverlappingGroups and must not appear in parser input.
    if (row.match_type !== "doi" && row.match_type !== "pmid") continue;
    if (typeof row.match_value !== "string" || row.match_value.trim() === "") continue;
    if (!Array.isArray(row.papers)) continue;

    // Parse, drop malformed papers, then deduplicate by id (RPC order preserved).
    const seen = new Set<string>();
    const papers: DuplicatePaperInfo[] = [];
    for (const rawPaper of row.papers) {
      const paper = parsePaper(rawPaper);
      if (paper === null || seen.has(paper.id)) continue;
      seen.add(paper.id);
      papers.push(paper);
    }

    // A group is meaningful only with at least two distinct valid papers.
    if (!hasAtLeastTwo(papers)) continue;
    groups.push({ match_type: row.match_type, match_value: row.match_value, papers });
  }
  return groups;
}
