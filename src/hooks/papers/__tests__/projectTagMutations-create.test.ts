/**
 * The `createProject` / `createTag` return contract added for
 * AI-PROJECT-TAG-SUGGESTIONS-001B, plus proof that the behaviour every existing
 * caller depends on is unchanged.
 *
 * "Create & select" in Edit Paper needs the created row's `id` so it can enter
 * the dialog's LOCAL selection. That is the whole reason these mutations now
 * resolve to an entity — and the reason `null` on every failure path is
 * load-bearing: a caller must never select an id it cannot prove exists.
 *
 * Existing callers (`Sidebar` → `ManageProjectsModal` / `ManageTagsModal`) pass
 * a name and ignore the promise. The toasts, the duplicate short-circuit, the
 * meta-cache update and the explicit `user_id` on the insert are asserted here
 * exactly as they behaved before.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { createElement, type ReactNode } from "react";
import { renderHook, act } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

// ── Supabase mock: from(table).insert(row).select().single() ────────────
const { mockFrom, mockInsert, insertCalls, setNextResult, resetSupabase } = vi.hoisted(() => {
  const insertCalls: Array<{ table: string; row: Record<string, unknown> }> = [];
  let nextResult: { data: unknown; error: unknown } = { data: null, error: null };
  let lastTable = "";

  const mockInsert = vi.fn((row: Record<string, unknown>) => {
    insertCalls.push({ table: lastTable, row });
    return {
      select: () => ({
        single: () => Promise.resolve(nextResult),
      }),
    };
  });

  const mockFrom = vi.fn((table: string) => {
    lastTable = table;
    return { insert: mockInsert };
  });

  return {
    mockFrom,
    mockInsert,
    insertCalls,
    setNextResult: (r: { data: unknown; error: unknown }) => {
      nextResult = r;
    },
    resetSupabase: () => {
      insertCalls.length = 0;
      nextResult = { data: null, error: null };
    },
  };
});

vi.mock("@/integrations/supabase/client", () => ({ supabase: { from: mockFrom } }));

const mockToast = vi.fn();
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: mockToast }) }));

import { useProjectMutations } from "../useProjectMutations";
import { useTagMutations } from "../useTagMutations";
import { queryKeys } from "@/lib/queryKeys";
import type { Project, Tag } from "@/types/database";
import type { ServerFilterParams, ServerSortParams } from "../types";

const userId = "user-1";
const filters: ServerFilterParams = {
  filterPaperIds: null,
  yearFrom: null,
  yearTo: null,
  studyTypes: [],
  notesPresence: "all",
};
const sort: ServerSortParams = { sortColumn: "insert_order", sortAscending: false };

const existingProject: Project = {
  id: "proj-existing",
  user_id: userId,
  name: "Sarcopenia",
  description: null,
  color: "#111",
  created_at: "2020-01-01",
};
const existingTag: Tag = {
  id: "tag-existing",
  user_id: userId,
  name: "RCT",
  color: "#222",
  created_at: "2020-01-01",
};

function seededClient() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  qc.setQueryData(queryKeys.projects.all(userId), [existingProject]);
  qc.setQueryData(queryKeys.tags.all(userId), [existingTag]);
  return qc;
}

function wrapperFor(qc: QueryClient) {
  return ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client: qc }, children);
}

function renderProjects(qc: QueryClient, projects: Project[] = [existingProject]) {
  return renderHook(() => useProjectMutations(userId, projects, filters, sort), {
    wrapper: wrapperFor(qc),
  });
}
function renderTags(qc: QueryClient, tags: Tag[] = [existingTag]) {
  return renderHook(() => useTagMutations(userId, tags, filters, sort), {
    wrapper: wrapperFor(qc),
  });
}

beforeEach(() => {
  resetSupabase();
  mockToast.mockClear();
  mockFrom.mockClear();
  mockInsert.mockClear();
});

describe("createProject", () => {
  it("returns the created Project and caches it", async () => {
    const created: Project = {
      id: "proj-new",
      user_id: userId,
      name: "Resistance Training",
      description: null,
      color: "#333",
      created_at: "2026-01-01",
    };
    setNextResult({ data: created, error: null });
    const qc = seededClient();
    const { result } = renderProjects(qc);

    let returned: Project | null = null;
    await act(async () => {
      returned = await result.current.createProject("Resistance Training");
    });

    expect(returned).toEqual(created);
    expect(qc.getQueryData<Project[]>(queryKeys.projects.all(userId))).toEqual([
      existingProject,
      created,
    ]);
  });

  it("persists an optional description and keeps the explicit user_id", async () => {
    const created: Project = {
      id: "proj-new",
      user_id: userId,
      name: "Resistance Training",
      description: "Strength interventions in older adults.",
      color: "#333",
      created_at: "2026-01-01",
    };
    setNextResult({ data: created, error: null });
    const { result } = renderProjects(seededClient());

    await act(async () => {
      await result.current.createProject(
        "Resistance Training",
        "Strength interventions in older adults.",
      );
    });

    expect(insertCalls).toHaveLength(1);
    expect(insertCalls[0].table).toBe("projects");
    expect(insertCalls[0].row).toEqual({
      user_id: userId,
      name: "Resistance Training",
      description: "Strength interventions in older adults.",
    });
  });

  it("omits the description column entirely when the caller supplies none", async () => {
    setNextResult({
      data: { id: "p", user_id: userId, name: "N", description: null, color: "#1", created_at: "x" },
      error: null,
    });
    const { result } = renderProjects(seededClient());

    await act(async () => {
      await result.current.createProject("N");
    });

    // Byte-identical to the pre-001B insert every existing caller produces.
    expect(insertCalls[0].row).toEqual({ user_id: userId, name: "N" });
    expect(insertCalls[0].row).not.toHaveProperty("description");
  });

  it("passes an explicit null description through when asked", async () => {
    setNextResult({
      data: { id: "p", user_id: userId, name: "N", description: null, color: "#1", created_at: "x" },
      error: null,
    });
    const { result } = renderProjects(seededClient());

    await act(async () => {
      await result.current.createProject("N", null);
    });

    expect(insertCalls[0].row).toEqual({ user_id: userId, name: "N", description: null });
  });

  it("short-circuits on a deterministic in-memory duplicate: toast, no insert, existing returned", async () => {
    const qc = seededClient();
    const { result } = renderProjects(qc);

    let returned: Project | null = null;
    await act(async () => {
      returned = await result.current.createProject("  sarcopenia  ".trim().toUpperCase());
    });

    expect(mockInsert).not.toHaveBeenCalled();
    expect(mockToast).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Project exists" }),
    );
    expect(returned).toEqual(existingProject);
    // The cache is untouched — no duplicate row was appended.
    expect(qc.getQueryData<Project[]>(queryKeys.projects.all(userId))).toEqual([existingProject]);
  });

  it("returns null and shows the destructive toast on a mutation error", async () => {
    setNextResult({ data: null, error: { code: "42501", message: "permission denied" } });
    const qc = seededClient();
    const { result } = renderProjects(qc);

    let returned: Project | null = { ...existingProject };
    await act(async () => {
      returned = await result.current.createProject("Brand New");
    });

    expect(returned).toBeNull();
    expect(mockToast).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Error creating project", variant: "destructive" }),
    );
    // No cache corruption: nothing was appended for a row that does not exist.
    expect(qc.getQueryData<Project[]>(queryKeys.projects.all(userId))).toEqual([existingProject]);
  });

  it("returns null on a unique-violation (23505) and keeps the non-destructive toast", async () => {
    setNextResult({ data: null, error: { code: "23505", message: "duplicate key" } });
    const qc = seededClient();
    const { result } = renderProjects(qc);

    let returned: Project | null = { ...existingProject };
    await act(async () => {
      returned = await result.current.createProject("Race Condition");
    });

    expect(returned).toBeNull();
    const call = mockToast.mock.calls.at(-1)?.[0] as { title?: string; variant?: string };
    expect(call.title).toBe("Project exists");
    expect(call.variant).toBeUndefined();
    expect(qc.getQueryData<Project[]>(queryKeys.projects.all(userId))).toEqual([existingProject]);
  });

  it("returns null without touching Supabase when there is no userId", async () => {
    const qc = seededClient();
    const { result } = renderHook(
      () => useProjectMutations(undefined, [existingProject], filters, sort),
      { wrapper: wrapperFor(qc) },
    );

    let returned: Project | null = { ...existingProject };
    await act(async () => {
      returned = await result.current.createProject("Anything");
    });

    expect(returned).toBeNull();
    expect(mockFrom).not.toHaveBeenCalled();
  });
});

describe("createTag", () => {
  it("returns the created Tag and caches it", async () => {
    const created: Tag = {
      id: "tag-new",
      user_id: userId,
      name: "older-adults",
      color: "#444",
      created_at: "2026-01-01",
    };
    setNextResult({ data: created, error: null });
    const qc = seededClient();
    const { result } = renderTags(qc);

    let returned: Tag | null = null;
    await act(async () => {
      returned = await result.current.createTag("older-adults");
    });

    expect(returned).toEqual(created);
    expect(qc.getQueryData<Tag[]>(queryKeys.tags.all(userId))).toEqual([existingTag, created]);
    expect(insertCalls[0]).toEqual({
      table: "tags",
      row: { user_id: userId, name: "older-adults" },
    });
  });

  it("short-circuits on a deterministic in-memory duplicate and returns it", async () => {
    const qc = seededClient();
    const { result } = renderTags(qc);

    let returned: Tag | null = null;
    await act(async () => {
      returned = await result.current.createTag("rct");
    });

    expect(mockInsert).not.toHaveBeenCalled();
    expect(mockToast).toHaveBeenCalledWith(expect.objectContaining({ title: "Tag exists" }));
    expect(returned).toEqual(existingTag);
    expect(qc.getQueryData<Tag[]>(queryKeys.tags.all(userId))).toEqual([existingTag]);
  });

  it("returns null and does not corrupt the cache on a mutation error", async () => {
    setNextResult({ data: null, error: { code: "42501", message: "permission denied" } });
    const qc = seededClient();
    const { result } = renderTags(qc);

    let returned: Tag | null = { ...existingTag };
    await act(async () => {
      returned = await result.current.createTag("Brand New");
    });

    expect(returned).toBeNull();
    expect(mockToast).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Error creating tag", variant: "destructive" }),
    );
    expect(qc.getQueryData<Tag[]>(queryKeys.tags.all(userId))).toEqual([existingTag]);
  });

  it("returns null without touching Supabase when there is no userId", async () => {
    const qc = seededClient();
    const { result } = renderHook(() => useTagMutations(undefined, [existingTag], filters, sort), {
      wrapper: wrapperFor(qc),
    });

    let returned: Tag | null = { ...existingTag };
    await act(async () => {
      returned = await result.current.createTag("Anything");
    });

    expect(returned).toBeNull();
    expect(mockFrom).not.toHaveBeenCalled();
  });
});
