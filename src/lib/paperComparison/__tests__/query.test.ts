import { describe, expect, expectTypeOf, it, vi } from "vitest";
import type { Json } from "@/integrations/supabase/types";
import { buildComparisonQuery, COMPARISON_PAPER_SELECT, type ComparisonPaperRow } from "../query";
import { OWNER_ID, paperId } from "./fixtures";

/** Split a PostgREST select list at top-level commas, whitespace removed. */
function topLevelItems(select: string): string[] {
  const compact = select.replace(/\s+/g, "");
  const items: string[] = [];
  let depth = 0;
  let current = "";
  for (const char of compact) {
    if (char === "(") depth += 1;
    if (char === ")") depth -= 1;
    if (char === "," && depth === 0) {
      items.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  items.push(current);
  return items;
}

describe("COMPARISON_PAPER_SELECT", () => {
  it("selects exactly the comparison's columns and relationships", () => {
    expect(topLevelItems(COMPARISON_PAPER_SELECT)).toEqual([
      "id",
      "user_id",
      "title",
      "authors",
      "year",
      "journal",
      "pmid",
      "doi",
      "abstract",
      "study_type",
      "raw_study_type",
      "raw_publication_types",
      "statistical_methods",
      "tldr",
      "notes",
      "keywords",
      "raw_keywords",
      "mesh_terms",
      "substances",
      "paper_attachments(id,paper_id,user_id,file_type)",
      "paper_projects(paper_id,project:projects(id,user_id,name,color))",
      "paper_tags(paper_id,tag:tags(id,user_id,name,color))",
    ]);
  });

  it.each([
    "search_vector",
    "has_abstract",
    "author_provenance",
    "insert_order",
    "created_at",
    "updated_at",
    "pubmed_url",
    "journal_url",
    "drive_url",
    "file_path",
    "file_name",
    "size_bytes",
    "description",
    "*",
  ])("never selects %s", (column) => {
    const names = COMPARISON_PAPER_SELECT.replace(/\s+/g, "").split(/[(),:]/);
    expect(names).not.toContain(column);
  });
});

describe("buildComparisonQuery", () => {
  it("issues one owner-scoped, id-bounded, cancellable SELECT on papers and nothing else", () => {
    const calls: Array<[string, unknown[]]> = [];
    const builder: Record<string, (...args: unknown[]) => unknown> = {};
    for (const method of ["select", "in", "eq", "abortSignal"]) {
      builder[method] = (...args: unknown[]) => {
        calls.push([method, args]);
        return builder;
      };
    }
    for (const method of ["insert", "update", "upsert", "delete"]) {
      builder[method] = () => {
        throw new Error(`write method ${method} called`);
      };
    }
    const from = vi.fn(() => builder);
    const rpc = vi.fn();
    const client = { from, rpc } as unknown as Parameters<typeof buildComparisonQuery>[0];
    const signal = new AbortController().signal;
    const queryIds = Object.freeze([paperId(1), paperId(2)]);

    buildComparisonQuery(client, { ownerUserId: OWNER_ID, queryIds }, signal);

    expect(from).toHaveBeenCalledTimes(1);
    expect(from).toHaveBeenCalledWith("papers");
    expect(rpc).not.toHaveBeenCalled();
    expect(calls).toEqual([
      ["select", [COMPARISON_PAPER_SELECT]],
      ["in", ["id", queryIds]],
      ["eq", ["user_id", OWNER_ID]],
      ["abortSignal", [signal]],
    ]);
  });
});

/*
 * Type-level contract, enforced by `npm run typecheck` (these calls are no-ops
 * at runtime). If the generated `Database` schema stopped resolving a selected
 * column or relationship, postgrest-js would infer an error type and these
 * would fail to compile. The runtime shape is verified separately against a
 * real local Data API (see the PR's verification evidence).
 */
describe("ComparisonPaperRow (type-level)", () => {
  it("resolves every selected column against the generated schema", () => {
    expectTypeOf<ComparisonPaperRow["id"]>().toEqualTypeOf<string>();
    expectTypeOf<ComparisonPaperRow["user_id"]>().toEqualTypeOf<string>();
    expectTypeOf<ComparisonPaperRow["title"]>().toEqualTypeOf<string>();
    expectTypeOf<ComparisonPaperRow["year"]>().toEqualTypeOf<number | null>();
    expectTypeOf<ComparisonPaperRow["abstract"]>().toEqualTypeOf<string | null>();
    expectTypeOf<ComparisonPaperRow["study_type"]>().toEqualTypeOf<string | null>();
    expectTypeOf<ComparisonPaperRow["raw_study_type"]>().toEqualTypeOf<string | null>();
    expectTypeOf<ComparisonPaperRow["raw_publication_types"]>().toEqualTypeOf<Json | null>();
    expectTypeOf<ComparisonPaperRow["statistical_methods"]>().toEqualTypeOf<Json | null>();
    expectTypeOf<ComparisonPaperRow["tldr"]>().toEqualTypeOf<string | null>();
  });

  it("resolves the three embedded relationships", () => {
    expectTypeOf<ComparisonPaperRow["paper_attachments"]>().toEqualTypeOf<
      { id: string; paper_id: string; user_id: string; file_type: string }[]
    >();
    expectTypeOf<ComparisonPaperRow["paper_projects"][number]["paper_id"]>().toEqualTypeOf<string>();
    expectTypeOf<ComparisonPaperRow["paper_projects"][number]["project"]>().toExtend<{
      id: string;
      user_id: string;
      name: string;
      color: string | null;
    } | null>();
    expectTypeOf<ComparisonPaperRow["paper_tags"][number]["tag"]>().toExtend<{
      id: string;
      user_id: string;
      name: string;
      color: string | null;
    } | null>();
  });

  it("exposes no column outside the projection", () => {
    expectTypeOf<keyof ComparisonPaperRow>().toEqualTypeOf<
      | "id"
      | "user_id"
      | "title"
      | "authors"
      | "year"
      | "journal"
      | "pmid"
      | "doi"
      | "abstract"
      | "study_type"
      | "raw_study_type"
      | "raw_publication_types"
      | "statistical_methods"
      | "tldr"
      | "notes"
      | "keywords"
      | "raw_keywords"
      | "mesh_terms"
      | "substances"
      | "paper_attachments"
      | "paper_projects"
      | "paper_tags"
    >();
  });
});
