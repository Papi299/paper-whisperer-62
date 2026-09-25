/**
 * AI organization suggestions × the hardened junction grants —
 * DB-JUNCTION-DML-GRANT-HARDENING-001 (C48).
 *
 * After migration 20260925134526 the browser may READ `paper_projects` /
 * `paper_tags` but not write them; assignment goes through `set_paper_projects`
 * / `set_paper_tags`. The Projects and Tags themselves stay user-writable. This
 * suite proves the AI flow lives entirely inside that boundary, end to end in
 * the client:
 *
 *   suggest → (Select | Create & select) → Save
 *     → Create & select inserts the ENTITY into `projects` / `tags`
 *     → Save assigns through the setter RPCs
 *     → nothing ever writes a junction directly
 *
 * Unlike the component suite next to it, nothing between the click and the
 * network is mocked: the real `EditPaperDialog`, the real `createProject` /
 * `createTag` mutations and the real `updatePaper` run exactly as Dashboard
 * wires them. Only the Supabase client is replaced, by a fake that ENFORCES the
 * post-migration Data API grants — a junction INSERT/UPSERT/UPDATE/DELETE is
 * recorded and answered with the same 42501 PostgREST would return. So if any
 * link in the chain were changed to write a junction itself, these tests fail
 * twice over: the write is recorded, and the refused write breaks the flow.
 */

import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { PaperWithTags, Project, Tag } from "@/types/database";
import type { AiQuotaStatus } from "@/hooks/useAiQuota";
import type { OrganizationSuggestions } from "@/lib/suggestPaperOrganizationEdge";

// ── A Supabase client that enforces the C48 grants ─────────────────────

const { fake, mockSuggest, mockToast } = vi.hoisted(() => {
  type Result = { data: unknown; error: { code: string; message: string } | null };
  type Write = { table: string; op: string; payload: unknown };

  const JUNCTIONS = new Set(["paper_projects", "paper_tags"]);
  const ENTITY_DEFAULTS: Record<string, Record<string, unknown>> = {
    projects: { description: null, color: "#6366f1" },
    tags: { color: "#10b981" },
  };

  const writes: Write[] = [];
  const rpcs: Array<{ name: string; args: Record<string, unknown> }> = [];
  let seq = 0;

  /** A PostgREST-style builder: every filter chains, awaiting resolves. */
  function chain(result: Result) {
    const c: Record<string, unknown> = {};
    for (const m of ["select", "eq", "neq", "in", "is", "not", "or", "order", "limit", "range", "filter", "match"]) {
      c[m] = () => c;
    }
    c.single = () => Promise.resolve(result);
    c.maybeSingle = () => Promise.resolve(result);
    c.then = (ok: (r: Result) => unknown, err: (e: unknown) => unknown) => Promise.resolve(result).then(ok, err);
    return c;
  }

  function write(table: string, op: string, payload: unknown) {
    writes.push({ table, op, payload });
    if (JUNCTIONS.has(table)) {
      // Exactly what PostgREST answers once `authenticated` holds SELECT only.
      return chain({ data: null, error: { code: "42501", message: `permission denied for table ${table}` } });
    }
    if (op === "insert" && table in ENTITY_DEFAULTS) {
      seq += 1;
      const row = {
        ...ENTITY_DEFAULTS[table],
        ...(payload as Record<string, unknown>),
        id: `${table}-created-${seq}`,
        created_at: "2026-09-25T00:00:00Z",
      };
      return chain({ data: row, error: null });
    }
    return chain({ data: null, error: null });
  }

  const client = {
    from: (table: string) => ({
      select: () => chain({ data: [], error: null }),
      insert: (payload: unknown) => write(table, "insert", payload),
      upsert: (payload: unknown) => write(table, "upsert", payload),
      update: (payload: unknown) => write(table, "update", payload),
      delete: () => write(table, "delete", null),
    }),
    rpc: (name: string, args: Record<string, unknown>) => {
      rpcs.push({ name, args });
      return Promise.resolve({ data: null, error: null });
    },
    functions: { invoke: vi.fn() },
    auth: { getSession: async () => ({ data: { session: { access_token: "t" } } }) },
  };

  return {
    fake: {
      client,
      writes,
      rpcs,
      junctionWrites: () => writes.filter((w) => JUNCTIONS.has(w.table)),
      reset: () => {
        writes.length = 0;
        rpcs.length = 0;
        seq = 0;
      },
    },
    mockSuggest: vi.fn(),
    mockToast: vi.fn(),
  };
});

vi.mock("@/integrations/supabase/client", () => ({ supabase: fake.client }));

vi.mock("@/lib/suggestPaperOrganizationEdge", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/suggestPaperOrganizationEdge")>();
  return { ...actual, suggestPaperOrganization: mockSuggest };
});

vi.mock("@/hooks/useAttachments", () => ({
  useAttachments: () => ({
    attachments: [],
    loading: false,
    uploading: false,
    uploadAttachments: vi.fn(),
    deleteAttachment: vi.fn(),
    refetch: vi.fn(),
  }),
}));

vi.mock("@/hooks/useAbstract", () => ({
  useAbstract: () => ({ data: undefined, isLoading: false }),
}));

vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: mockToast }),
  toast: mockToast,
}));

import { EditPaperDialog } from "../EditPaperDialog";
import { useProjectMutations } from "@/hooks/papers/useProjectMutations";
import { useTagMutations } from "@/hooks/papers/useTagMutations";
import { usePaperMutations } from "@/hooks/papers/usePaperMutations";
import { supabase } from "@/integrations/supabase/client";
import type { ServerFilterParams, ServerSortParams } from "@/hooks/papers/types";

beforeAll(() => {
  const proto = Element.prototype as unknown as Record<string, unknown>;
  proto.hasPointerCapture = () => false;
  proto.setPointerCapture = () => {};
  proto.releasePointerCapture = () => {};
  proto.scrollIntoView = () => {};
  if (!("ResizeObserver" in globalThis)) {
    (globalThis as unknown as Record<string, unknown>).ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
  }
});

// ── Fixtures ───────────────────────────────────────────────────────────

const USER = "u1";
const FILTERS: ServerFilterParams = {
  filterPaperIds: null,
  yearFrom: null,
  yearTo: null,
  studyTypes: [],
  notesPresence: "all",
};
const SORT: ServerSortParams = { sortColumn: "insert_order", sortAscending: false };

const EXISTING_PROJECT: Project = {
  id: "proj-existing",
  user_id: USER,
  name: "Sarcopenia",
  description: null,
  color: "#111111",
  created_at: "2026-01-01T00:00:00Z",
};
const EXISTING_TAG: Tag = {
  id: "tag-existing",
  user_id: USER,
  name: "RCT",
  color: "#222222",
  created_at: "2026-01-01T00:00:00Z",
};

const PAPER = {
  id: "paper-1",
  user_id: USER,
  title: "Resistance training in older adults",
  authors: ["Author A"],
  year: 2024,
  journal: "J Test",
  pmid: null,
  doi: null,
  has_abstract: true,
  abstract: "A randomised trial of resistance training.",
  study_type: null,
  raw_study_type: null,
  statistical_methods: null,
  keywords: ["sarcopenia"],
  raw_keywords: null,
  mesh_terms: [],
  substances: [],
  pubmed_url: null,
  journal_url: null,
  drive_url: null,
  tldr: null,
  notes: null,
  insert_order: 1,
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
  tags: [],
  projects: [],
} as unknown as PaperWithTags;

const QUOTA: AiQuotaStatus = {
  allowed: true,
  reason: "ok",
  plan: "free",
  planStatus: "active",
  periodType: "lifetime",
  used: 3,
  quota: 15,
  remaining: 12,
  resetAt: null,
  isExempt: false,
};

function suggestions(over: Partial<OrganizationSuggestions> = {}): OrganizationSuggestions {
  return { existingProjects: [], existingTags: [], newProjects: [], newTags: [], ...over };
}

/**
 * Edit Paper wired the way Dashboard wires it: `onCreateProject` /
 * `onCreateTag` are the real entity mutations, and `onSave` forwards the
 * dialog's payload to the real `updatePaper` and its boolean back
 * (Dashboard.handleSavePaper, minus the synonym canonicalization that does not
 * touch assignments).
 */
function Harness({ onOpenChange }: { onOpenChange: (open: boolean) => void }) {
  const projects = [EXISTING_PROJECT];
  const tags = [EXISTING_TAG];
  const { createProject } = useProjectMutations(USER, projects, FILTERS, SORT);
  const { createTag } = useTagMutations(USER, tags, FILTERS, SORT);
  const { updatePaper } = usePaperMutations(USER, [PAPER], projects, tags, undefined, FILTERS, SORT);
  return (
    <EditPaperDialog
      paper={PAPER}
      projects={projects}
      tags={tags}
      open
      onOpenChange={onOpenChange}
      onSave={(updates) => updatePaper(PAPER.id, updates)}
      userId={USER}
      aiQuotaStatus={QUOTA}
      onAiQuotaRefresh={() => {}}
      onCreateProject={createProject}
      onCreateTag={createTag}
    />
  );
}

function renderHarness() {
  const onOpenChange = vi.fn();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <Harness onOpenChange={onOpenChange} />
    </QueryClientProvider>,
  );
  return { onOpenChange };
}

async function generate() {
  fireEvent.click(screen.getByRole("button", { name: /Suggest Projects & Tags/ }));
  await waitFor(() => expect(mockSuggest).toHaveBeenCalledTimes(1));
}

const rpcArgs = (name: string) => fake.rpcs.filter((r) => r.name === name).map((r) => r.args);

beforeEach(() => {
  fake.reset();
  mockSuggest.mockReset();
  mockToast.mockReset();
});

// ── The fake is a real boundary, not a formality ───────────────────────

describe("the ACL-enforcing client used by this suite", () => {
  it("refuses a direct junction write with 42501 and records it, like PostgREST after C48", async () => {
    const { error } = await supabase.from("paper_projects").insert({ paper_id: "p", project_id: "x" });
    expect(error).toEqual({ code: "42501", message: "permission denied for table paper_projects" });
    const del = await supabase.from("paper_tags").delete().eq("paper_id", "p");
    expect(del.error?.code).toBe("42501");
    expect(fake.junctionWrites().map((w) => `${w.op} ${w.table}`)).toEqual([
      "insert paper_projects",
      "delete paper_tags",
    ]);
  });

  it("still lets a Project or Tag be created", async () => {
    const { data, error } = await supabase.from("projects").insert({ user_id: USER, name: "X" }).select().single();
    expect(error).toBeNull();
    expect(data).toMatchObject({ id: "projects-created-1", name: "X" });
  });
});

// ── The AI flow, end to end in the client ──────────────────────────────

describe("AI suggestion → Create & select → Save, under SELECT-only junctions", () => {
  it("creates the proposed Project and Tag as entities, then assigns them only through the setter RPCs", async () => {
    mockSuggest.mockResolvedValue(
      suggestions({
        newProjects: [{ name: "Resistance Training", description: "Strength work.", reason: "Recurring theme." }],
        newTags: [{ name: "older-adults", reason: "The cohort is 65+." }],
      }),
    );
    const { onOpenChange } = renderHarness();
    await generate();

    // ── Create & select: the ENTITY rows are written immediately ──
    fireEvent.click(
      await screen.findByRole("button", { name: 'Create project "Resistance Training" and select it for this paper' }),
    );
    await screen.findByText("1 project selected");
    fireEvent.click(screen.getByRole("button", { name: 'Create tag "older-adults" and select it for this paper' }));
    await screen.findByText("1 tag selected");

    expect(fake.writes.map((w) => `${w.op} ${w.table}`)).toEqual(["insert projects", "insert tags"]);
    expect(fake.writes[0].payload).toEqual({ user_id: USER, name: "Resistance Training", description: "Strength work." });
    expect(fake.writes[1].payload).toEqual({ user_id: USER, name: "older-adults" });
    // Nothing is assigned before Save.
    expect(fake.rpcs).toEqual([]);

    // ── Save: the assignment goes through the reviewed RPCs ──
    fireEvent.click(screen.getByRole("button", { name: "Save Changes" }));
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));

    expect(rpcArgs("set_paper_projects")).toEqual([
      { p_paper_id: PAPER.id, p_project_ids: ["projects-created-1"] },
    ]);
    expect(rpcArgs("set_paper_tags")).toEqual([{ p_paper_id: PAPER.id, p_tag_ids: ["tags-created-2"] }]);

    // ── …and nothing, at any step, touched a junction directly ──
    expect(fake.junctionWrites()).toEqual([]);
    expect(mockToast).not.toHaveBeenCalledWith(expect.objectContaining({ variant: "destructive" }));
  });

  it("assigns accepted EXISTING suggestions through the setter RPCs, creating nothing", async () => {
    mockSuggest.mockResolvedValue(
      suggestions({
        existingProjects: [{ id: EXISTING_PROJECT.id, name: EXISTING_PROJECT.name, reason: "Matches the cohort." }],
        existingTags: [{ id: EXISTING_TAG.id, name: EXISTING_TAG.name, reason: "Randomised design." }],
      }),
    );
    const { onOpenChange } = renderHarness();
    await generate();

    fireEvent.click(
      await screen.findByRole("button", { name: `Select project "${EXISTING_PROJECT.name}" for this paper` }),
    );
    fireEvent.click(screen.getByRole("button", { name: `Select tag "${EXISTING_TAG.name}" for this paper` }));
    await screen.findByText("1 project selected");
    await screen.findByText("1 tag selected");

    fireEvent.click(screen.getByRole("button", { name: "Save Changes" }));
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));

    expect(rpcArgs("set_paper_projects")).toEqual([{ p_paper_id: PAPER.id, p_project_ids: [EXISTING_PROJECT.id] }]);
    expect(rpcArgs("set_paper_tags")).toEqual([{ p_paper_id: PAPER.id, p_tag_ids: [EXISTING_TAG.id] }]);
    // No entity was created, and no junction was written.
    expect(fake.writes.filter((w) => w.op === "insert")).toEqual([]);
    expect(fake.junctionWrites()).toEqual([]);
  });

  it("mixes both: one existing and one created Project are assigned together in a single setter call", async () => {
    mockSuggest.mockResolvedValue(
      suggestions({
        existingProjects: [{ id: EXISTING_PROJECT.id, name: EXISTING_PROJECT.name, reason: "Matches the cohort." }],
        newProjects: [{ name: "Resistance Training", description: null, reason: "Recurring theme." }],
      }),
    );
    const { onOpenChange } = renderHarness();
    await generate();

    fireEvent.click(
      await screen.findByRole("button", { name: `Select project "${EXISTING_PROJECT.name}" for this paper` }),
    );
    fireEvent.click(screen.getByRole("button", { name: 'Create project "Resistance Training" and select it for this paper' }));
    await screen.findByText("2 projects selected");

    fireEvent.click(screen.getByRole("button", { name: "Save Changes" }));
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));

    expect(rpcArgs("set_paper_projects")).toEqual([
      { p_paper_id: PAPER.id, p_project_ids: [EXISTING_PROJECT.id, "projects-created-1"] },
    ]);
    expect(fake.junctionWrites()).toEqual([]);
  });

  it("cancelling after Create & select keeps the new entity and assigns nothing", async () => {
    mockSuggest.mockResolvedValue(suggestions({ newTags: [{ name: "older-adults", reason: "The cohort is 65+." }] }));
    const { onOpenChange } = renderHarness();
    await generate();

    fireEvent.click(
      await screen.findByRole("button", { name: 'Create tag "older-adults" and select it for this paper' }),
    );
    await screen.findByText("1 tag selected");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));

    expect(fake.writes.map((w) => `${w.op} ${w.table}`)).toEqual(["insert tags"]);
    expect(fake.rpcs).toEqual([]);
    expect(fake.junctionWrites()).toEqual([]);
  });
});
