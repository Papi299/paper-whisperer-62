import { describe, it, expect, vi, beforeEach } from "vitest";
import { createElement, type ReactNode } from "react";
import { renderHook, act } from "@testing-library/react";
import { QueryClient, QueryClientProvider, type InfiniteData } from "@tanstack/react-query";

/**
 * Focused cache-key coverage for the C25/baseline fix that threads
 * `serverFilterParams` / `serverSortParams` into `useProjectMutations` and
 * `useTagMutations`.
 *
 * These use the REAL `usePaperCacheHelpers`, the REAL `queryKeys`, and a REAL
 * QueryClient — only Supabase and the toast are mocked — so they prove:
 *   1. the active papers-list cache key is derived from the exact supplied
 *      filter/sort params (a decoy list seeded under different params is never
 *      touched, and the pre-fix `undefined`-param key would miss the seeded
 *      cache entirely);
 *   2. rename updates the meta cache and delete removes the chip from the
 *      active papers-list cache;
 *   3. a Supabase error rolls the optimistic cache back to the snapshot;
 *   4. the defense-in-depth `.eq("user_id", userId)` predicate is present.
 */

// ── Supabase mock (hoisted): from(table).update|delete().eq().eq() ──────
const { mockFrom, mockUpdate, mockDelete, eqCalls, setNextError, resetSupabase } =
  vi.hoisted(() => {
    const eqCalls: Array<[string, unknown]> = [];
    let nextError: { message: string } | null = null;
    const makeChain = () => {
      const chain: {
        eq: (col: string, val: unknown) => typeof chain;
        then: (onF: (v: { error: { message: string } | null }) => unknown, onR: (r: unknown) => unknown) => Promise<unknown>;
      } = {
        eq: (col: string, val: unknown) => {
          eqCalls.push([col, val]);
          return chain;
        },
        then: (onF, onR) => Promise.resolve({ error: nextError }).then(onF, onR),
      };
      return chain;
    };
    const mockUpdate = vi.fn(() => makeChain());
    const mockDelete = vi.fn(() => makeChain());
    const mockFrom = vi.fn(() => ({ update: mockUpdate, delete: mockDelete }));
    return {
      mockFrom,
      mockUpdate,
      mockDelete,
      eqCalls,
      setNextError: (e: { message: string } | null) => {
        nextError = e;
      },
      resetSupabase: () => {
        eqCalls.length = 0;
        nextError = null;
      },
    };
  });

vi.mock("@/integrations/supabase/client", () => ({ supabase: { from: mockFrom } }));

const mockToast = vi.fn();
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: mockToast }) }));

import { useProjectMutations } from "../useProjectMutations";
import { useTagMutations } from "../useTagMutations";
import { queryKeys } from "@/lib/queryKeys";
import type { Paper, Project, Tag } from "@/types/database";
import type { PapersPage, RawPaperWithJunctions, ServerFilterParams, ServerSortParams } from "../types";

const userId = "user-1";

// The active filter/sort the hooks must derive their cache key from.
const activeFilters: ServerFilterParams = {
  filterPaperIds: null,
  yearFrom: 2000,
  yearTo: null,
  studyTypes: ["RCT"],
  notesPresence: "all",
};
const activeSort: ServerSortParams = { sortColumn: "year", sortAscending: true };

// A decoy list cached under DIFFERENT params — must never be touched.
const decoyFilters: ServerFilterParams = {
  filterPaperIds: null,
  yearFrom: null,
  yearTo: null,
  studyTypes: ["Cohort"],
  notesPresence: "all",
};
const decoySort: ServerSortParams = { sortColumn: "insert_order", sortAscending: false };

const project: Project = { id: "proj-1", user_id: userId, name: "Old Name", description: null, color: "#111", created_at: "2020-01-01" };
const tag: Tag = { id: "tag-1", user_id: userId, name: "Old Tag", color: "#222", created_at: "2020-01-01" };

function makeRawPaper(): RawPaperWithJunctions {
  const base: Paper = {
    id: "paper-1", user_id: userId, title: "P", authors: [], year: 2021, journal: null,
    pmid: null, doi: null, study_type: null, raw_study_type: null, statistical_methods: null,
    keywords: [], raw_keywords: null, mesh_terms: [], substances: [], pubmed_url: null,
    journal_url: null, drive_url: null, tldr: null, notes: null, insert_order: 1,
    created_at: "2021-01-01", updated_at: "2021-01-01",
  };
  return { ...base, tagIds: ["tag-1"], projectIds: ["proj-1"] };
}

function makeInfiniteData(): InfiniteData<PapersPage> {
  return { pages: [{ papers: [makeRawPaper()], hasMore: false }], pageParams: [0] };
}

function seededClient() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  qc.setQueryData(queryKeys.projects.all(userId), [project]);
  qc.setQueryData(queryKeys.tags.all(userId), [tag]);
  qc.setQueryData(queryKeys.papers.list(userId, activeFilters, activeSort), makeInfiniteData());
  // Decoy list under different params.
  qc.setQueryData(queryKeys.papers.list(userId, decoyFilters, decoySort), makeInfiniteData());
  return qc;
}

function wrapperFor(qc: QueryClient) {
  return ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client: qc }, children);
}

function activePaper(qc: QueryClient): RawPaperWithJunctions {
  const data = qc.getQueryData<InfiniteData<PapersPage>>(queryKeys.papers.list(userId, activeFilters, activeSort));
  return data!.pages[0].papers[0];
}
function decoyPaper(qc: QueryClient): RawPaperWithJunctions {
  const data = qc.getQueryData<InfiniteData<PapersPage>>(queryKeys.papers.list(userId, decoyFilters, decoySort));
  return data!.pages[0].papers[0];
}

beforeEach(() => {
  resetSupabase();
  mockToast.mockClear();
  mockUpdate.mockClear();
  mockDelete.mockClear();
});

describe("useProjectMutations cache key + transforms", () => {
  it("updateProject renames the project in the active meta cache and issues a user_id-scoped update", async () => {
    const qc = seededClient();
    const { result } = renderHook(
      () => useProjectMutations(userId, [project], activeFilters, activeSort),
      { wrapper: wrapperFor(qc) },
    );

    await act(async () => {
      await result.current.updateProject("proj-1", { name: "New Name" });
    });

    const projects = qc.getQueryData<Project[]>(queryKeys.projects.all(userId))!;
    expect(projects.find((p) => p.id === "proj-1")?.name).toBe("New Name");
    // Active paper still references the project; decoy list is untouched.
    expect(activePaper(qc).projectIds).toEqual(["proj-1"]);
    expect(decoyPaper(qc).projectIds).toEqual(["proj-1"]);
    // Defense-in-depth predicate present.
    expect(mockUpdate).toHaveBeenCalledTimes(1);
    expect(eqCalls).toContainEqual(["user_id", userId]);
    expect(eqCalls).toContainEqual(["id", "proj-1"]);
  });

  it("deleteProject removes the project from the active papers-list cache only (correct key)", async () => {
    const qc = seededClient();
    const { result } = renderHook(
      () => useProjectMutations(userId, [project], activeFilters, activeSort),
      { wrapper: wrapperFor(qc) },
    );

    await act(async () => {
      await result.current.deleteProject("proj-1");
    });

    // The active list cache (keyed by the supplied filter/sort) lost the chip …
    expect(activePaper(qc).projectIds).toEqual([]);
    // … while the decoy list under different params is untouched (proves key).
    expect(decoyPaper(qc).projectIds).toEqual(["proj-1"]);
    expect(qc.getQueryData<Project[]>(queryKeys.projects.all(userId))!.some((p) => p.id === "proj-1")).toBe(false);
    expect(mockDelete).toHaveBeenCalledTimes(1);
    expect(eqCalls).toContainEqual(["user_id", userId]);
  });

  it("deleteProject rolls the active cache back to the snapshot on a Supabase error", async () => {
    const qc = seededClient();
    setNextError({ message: "boom" });
    const { result } = renderHook(
      () => useProjectMutations(userId, [project], activeFilters, activeSort),
      { wrapper: wrapperFor(qc) },
    );

    await act(async () => {
      await result.current.deleteProject("proj-1");
    });

    // Optimistic removal was rolled back: chip and meta entry restored.
    expect(activePaper(qc).projectIds).toEqual(["proj-1"]);
    expect(qc.getQueryData<Project[]>(queryKeys.projects.all(userId))!.some((p) => p.id === "proj-1")).toBe(true);
    expect(mockToast).toHaveBeenCalledWith(
      expect.objectContaining({ variant: "destructive" }),
    );
  });
});

describe("useTagMutations cache key + transforms", () => {
  it("updateTag renames the tag in the active meta cache and issues a user_id-scoped update", async () => {
    const qc = seededClient();
    const { result } = renderHook(
      () => useTagMutations(userId, [tag], activeFilters, activeSort),
      { wrapper: wrapperFor(qc) },
    );

    await act(async () => {
      await result.current.updateTag("tag-1", { name: "New Tag" });
    });

    const tags = qc.getQueryData<Tag[]>(queryKeys.tags.all(userId))!;
    expect(tags.find((t) => t.id === "tag-1")?.name).toBe("New Tag");
    expect(activePaper(qc).tagIds).toEqual(["tag-1"]);
    expect(mockUpdate).toHaveBeenCalledTimes(1);
    expect(eqCalls).toContainEqual(["user_id", userId]);
    expect(eqCalls).toContainEqual(["id", "tag-1"]);
  });

  it("deleteTag removes the tag from the active papers-list cache only (correct key)", async () => {
    const qc = seededClient();
    const { result } = renderHook(
      () => useTagMutations(userId, [tag], activeFilters, activeSort),
      { wrapper: wrapperFor(qc) },
    );

    await act(async () => {
      await result.current.deleteTag("tag-1");
    });

    expect(activePaper(qc).tagIds).toEqual([]);
    expect(decoyPaper(qc).tagIds).toEqual(["tag-1"]);
    expect(qc.getQueryData<Tag[]>(queryKeys.tags.all(userId))!.some((t) => t.id === "tag-1")).toBe(false);
    expect(mockDelete).toHaveBeenCalledTimes(1);
    expect(eqCalls).toContainEqual(["user_id", userId]);
  });

  it("deleteTag rolls the active cache back to the snapshot on a Supabase error", async () => {
    const qc = seededClient();
    setNextError({ message: "boom" });
    const { result } = renderHook(
      () => useTagMutations(userId, [tag], activeFilters, activeSort),
      { wrapper: wrapperFor(qc) },
    );

    await act(async () => {
      await result.current.deleteTag("tag-1");
    });

    expect(activePaper(qc).tagIds).toEqual(["tag-1"]);
    expect(qc.getQueryData<Tag[]>(queryKeys.tags.all(userId))!.some((t) => t.id === "tag-1")).toBe(true);
    expect(mockToast).toHaveBeenCalledWith(
      expect.objectContaining({ variant: "destructive" }),
    );
  });
});
