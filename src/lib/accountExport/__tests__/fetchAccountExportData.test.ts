import { describe, it, expect, vi, beforeEach } from "vitest";
import { createSupabaseMock, type SupabaseMock } from "./supabaseMock";

const { mockFrom } = vi.hoisted(() => ({ mockFrom: vi.fn() }));

vi.mock("@/integrations/supabase/client", () => ({
  supabase: { from: mockFrom, storage: { from: vi.fn() } },
}));

import { fetchAccountExportData, isOwnedStoragePath } from "../fetchAccountExportData";
import {
  ACCOUNT_EXPORT_COLLECTIONS,
  ACCOUNT_EXPORT_EXCLUDED_TABLES,
  EXCLUDED_PROFILE_COLUMNS,
  PAPER_EXPORT_COLUMNS,
  SAFE_PROFILE_COLUMNS,
  AccountExportError,
} from "../types";

const USER = "user-a";
const OTHER_USER = "user-b";

/** A sentinel that must never appear anywhere on the export path. */
const SENTINEL_PUBMED_KEY = "SENTINEL-PUBMED-API-KEY-DO-NOT-EXPORT";

function paper(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    user_id: USER,
    title: `Paper ${id}`,
    authors: ["Author A"],
    year: 2024,
    journal: null,
    pmid: null,
    doi: null,
    abstract: null,
    has_abstract: false,
    study_type: null,
    raw_study_type: null,
    raw_publication_types: null,
    statistical_methods: null,
    keywords: [],
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
    // A derived index artifact that must not be requested.
    search_vector: "'paper':1",
    ...overrides,
  };
}

function attachment(id: string, paperId: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    user_id: USER,
    paper_id: paperId,
    file_path: `${USER}/${paperId}/${id}.pdf`,
    file_name: "study.pdf",
    file_type: "application/pdf",
    size_bytes: 10,
    created_at: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

function baseTables(overrides: Record<string, Record<string, unknown>[]> = {}) {
  return {
    profiles: [
      {
        id: "profile-1",
        user_id: USER,
        email: "a@example.com",
        display_name: "A",
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-02T00:00:00Z",
        pubmed_api_key: SENTINEL_PUBMED_KEY,
      },
    ],
    papers: [paper("p1"), paper("p2", { insert_order: 2 })],
    projects: [{ id: "proj-1", user_id: USER, name: "P", description: null, color: "#fff", created_at: "2026-01-01T00:00:00Z" }],
    tags: [{ id: "tag-1", user_id: USER, name: "T", color: "#000", created_at: "2026-01-01T00:00:00Z" }],
    paper_projects: [{ paper_id: "p1", project_id: "proj-1" }],
    paper_tags: [{ paper_id: "p2", tag_id: "tag-1" }],
    filter_presets: [{ id: "fp-1", user_id: USER, name: "Preset", payload: { version: 3 }, created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z" }],
    keyword_pool: [{ id: "kw-1", user_id: USER, keyword: "muscle", created_at: "2026-01-01T00:00:00Z" }],
    synonym_pool: [{ id: "sy-1", user_id: USER, canonical_term: "hypertrophy", synonyms: ["growth"], created_at: "2026-01-01T00:00:00Z" }],
    study_type_pool: [{ id: "st-1", user_id: USER, study_type: "RCT", group_name: null, hierarchy_rank: 1, specificity_weight: 1, created_at: "2026-01-01T00:00:00Z" }],
    keyword_exclusion_pool: [{ id: "kx-1", user_id: USER, keyword: "mouse", created_at: "2026-01-01T00:00:00Z" }],
    study_type_exclusion_pool: [{ id: "sx-1", user_id: USER, study_type: "Editorial", created_at: "2026-01-01T00:00:00Z" }],
    paper_attachments: [attachment("att-1", "p1")],
    ...overrides,
  };
}

function install(mock: SupabaseMock) {
  mockFrom.mockImplementation((table: string) => mock.from(table));
  return mock;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("fetchAccountExportData — category coverage", () => {
  it("returns every registry collection plus the profile singleton", async () => {
    install(createSupabaseMock({ tables: baseTables() }));

    const data = await fetchAccountExportData(USER);

    for (const key of ACCOUNT_EXPORT_COLLECTIONS) {
      expect(Array.isArray(data[key]), `${key} must be an array`).toBe(true);
    }
    expect(data.profile).not.toBeNull();
    expect(data.papers).toHaveLength(2);
    expect(data.paper_projects).toEqual([{ paper_id: "p1", project_id: "proj-1" }]);
    expect(data.paper_tags).toEqual([{ paper_id: "p2", tag_id: "tag-1" }]);
    expect(data.paper_attachments[0].archive_path).toBe(
      "attachments/p1/att-1-study.pdf",
    );
  });

  it("produces empty collections and a null profile for an empty account", async () => {
    const empty = Object.fromEntries(
      Object.keys(baseTables()).map((table) => [table, []]),
    ) as Record<string, Record<string, unknown>[]>;
    install(createSupabaseMock({ tables: empty }));

    const data = await fetchAccountExportData(USER);

    expect(data.profile).toBeNull();
    for (const key of ACCOUNT_EXPORT_COLLECTIONS) {
      expect(data[key]).toEqual([]);
    }
  });
});

describe("fetchAccountExportData — S2 client scoping", () => {
  it("scopes every direct user_id table query with .eq('user_id', userId)", async () => {
    const mock = install(createSupabaseMock({ tables: baseTables() }));

    await fetchAccountExportData(USER);

    const directUserTables = [
      "profiles",
      "papers",
      "projects",
      "tags",
      "filter_presets",
      "keyword_pool",
      "synonym_pool",
      "study_type_pool",
      "keyword_exclusion_pool",
      "study_type_exclusion_pool",
      "paper_attachments",
    ];

    for (const table of directUserTables) {
      const queries = mock.queriesFor(table);
      expect(queries.length, `${table} must be queried`).toBeGreaterThan(0);
      for (const query of queries) {
        expect(
          query.eq.some(([column, value]) => column === "user_id" && value === USER),
          `${table} query must carry .eq("user_id", userId)`,
        ).toBe(true);
      }
    }
  });

  it("never issues an unrestricted whole-table read of a junction", async () => {
    const mock = install(createSupabaseMock({ tables: baseTables() }));

    await fetchAccountExportData(USER);

    for (const table of ["paper_projects", "paper_tags"]) {
      const queries = mock.queriesFor(table);
      expect(queries.length).toBeGreaterThan(0);
      for (const query of queries) {
        // Reached only through the signed-in user's own paper ids.
        expect(query.in?.[0]).toBe("paper_id");
        expect(query.in?.[1]).toEqual(["p1", "p2"]);
      }
    }
  });

  it("queries no table outside the PFA-C02 scope", async () => {
    const mock = install(createSupabaseMock({ tables: baseTables() }));

    await fetchAccountExportData(USER);

    const queried = new Set(mock.queries.map((query) => query.table));
    for (const excluded of ACCOUNT_EXPORT_EXCLUDED_TABLES) {
      expect(queried.has(excluded), `${excluded} is outside PFA-C02`).toBe(false);
    }
  });

  it.each([
    "papers",
    "projects",
    "tags",
    "filter_presets",
    "keyword_pool",
    "synonym_pool",
    "study_type_pool",
    "keyword_exclusion_pool",
    "study_type_exclusion_pool",
    "paper_attachments",
  ])("fails closed when the backend leaks another user's %s row", async (table) => {
    // A deliberately broken backend: the predicate is ignored and user B's row
    // comes back alongside user A's. The export must never archive it.
    const leakedRow = { ...baseTables()[table][0], id: "leaked", user_id: OTHER_USER };
    install(
      createSupabaseMock({
        tables: baseTables({ [table]: [...baseTables()[table], leakedRow] }),
        leakTables: [table],
      }),
    );

    await expect(fetchAccountExportData(USER)).rejects.toBeInstanceOf(AccountExportError);
  });

  it("fails closed when the backend leaks another user's profile row", async () => {
    install(
      createSupabaseMock({
        tables: baseTables({
          profiles: [{ id: "profile-b", user_id: OTHER_USER, email: "b@example.com", display_name: "B", created_at: "x", updated_at: "y", pubmed_api_key: SENTINEL_PUBMED_KEY }],
        }),
        leakTables: ["profiles"],
      }),
    );

    await expect(fetchAccountExportData(USER)).rejects.toBeInstanceOf(AccountExportError);
  });
});

describe("fetchAccountExportData — secret exclusion", () => {
  it("does not select pubmed_api_key from profiles", async () => {
    const mock = install(createSupabaseMock({ tables: baseTables() }));

    await fetchAccountExportData(USER);

    const profileQueries = mock.queriesFor("profiles");
    expect(profileQueries).toHaveLength(1);
    for (const excluded of EXCLUDED_PROFILE_COLUMNS) {
      expect(profileQueries[0].select).not.toContain(excluded);
    }
    expect(profileQueries[0].select).not.toBe("*");
    for (const column of SAFE_PROFILE_COLUMNS) {
      expect(profileQueries[0].select).toContain(column);
    }
  });

  it("keeps the sentinel key out of the returned dataset entirely", async () => {
    install(createSupabaseMock({ tables: baseTables() }));

    const data = await fetchAccountExportData(USER);

    expect(JSON.stringify(data)).not.toContain(SENTINEL_PUBMED_KEY);
    expect(data.profile).toEqual({
      id: "profile-1",
      user_id: USER,
      email: "a@example.com",
      display_name: "A",
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-02T00:00:00Z",
    });
  });

  it("selects papers by explicit column list, excluding the derived search_vector", async () => {
    const mock = install(createSupabaseMock({ tables: baseTables() }));

    const data = await fetchAccountExportData(USER);

    const papersQuery = mock.queriesFor("papers")[0];
    expect(papersQuery.select).not.toBe("*");
    expect(papersQuery.select).not.toContain("search_vector");
    for (const column of PAPER_EXPORT_COLUMNS) {
      expect(papersQuery.select).toContain(column);
    }
    // The mock returns whole fixture rows, so the guarantee proven here is the
    // request shape; the archive test proves the serialized column set.
    expect(data.papers).toHaveLength(2);
  });
});

describe("fetchAccountExportData — serialization fidelity", () => {
  it("preserves nulls, arrays, JSONB objects, notes and ordering fields verbatim", async () => {
    const rich = paper("p1", {
      notes: "Line one\nLine two — kept verbatim",
      authors: ["Ada L.", "Grace H."],
      keywords: ["a", "b"],
      raw_publication_types: ["Clinical Trial, Phase II", "Multicenter Study"],
      statistical_methods: { anova: true, nested: { p: 0.05 } },
      mesh_terms: [],
      substances: null,
      year: null,
      tldr: "Summary",
      insert_order: 42,
    });
    install(createSupabaseMock({ tables: baseTables({ papers: [rich] }) }));

    const data = await fetchAccountExportData(USER);
    const exported = data.papers[0] as unknown as Record<string, unknown>;

    expect(exported.notes).toBe("Line one\nLine two — kept verbatim");
    expect(exported.authors).toEqual(["Ada L.", "Grace H."]);
    expect(exported.raw_publication_types).toEqual([
      "Clinical Trial, Phase II",
      "Multicenter Study",
    ]);
    expect(exported.statistical_methods).toEqual({ anova: true, nested: { p: 0.05 } });
    expect(exported.mesh_terms).toEqual([]);
    expect(exported.substances).toBeNull();
    expect(exported.year).toBeNull();
    expect(exported.insert_order).toBe(42);
  });
});

describe("fetchAccountExportData — pagination", () => {
  it("returns every row past the 1000-row PostgREST boundary", async () => {
    const many = Array.from({ length: 2500 }, (_, i) =>
      paper(`p${i}`, { insert_order: i }),
    );
    const mock = install(createSupabaseMock({ tables: baseTables({ papers: many, paper_attachments: [] }) }));

    const data = await fetchAccountExportData(USER);

    expect(data.papers).toHaveLength(2500);
    expect(new Set(data.papers.map((p) => p.id)).size).toBe(2500);
    // 1000 + 1000 + 500 → the third page is short, so paging stops there.
    expect(mock.queriesFor("papers")).toHaveLength(3);
  });

  it("paginates within each junction ID chunk, not just across chunks", async () => {
    // 600 papers → two .in() chunks of 500 + 100. The first chunk alone
    // matches 1200 junction rows, which a single unpaginated request would
    // truncate at 1000.
    const papers = Array.from({ length: 600 }, (_, i) => paper(`p${i}`, { insert_order: i }));
    const projects = Array.from({ length: 2 }, (_, i) => ({
      id: `proj-${i}`,
      user_id: USER,
      name: `Project ${i}`,
      description: null,
      color: "#fff",
      created_at: "2026-01-01T00:00:00Z",
    }));
    const paperProjects = papers.flatMap((p) =>
      projects.map((project) => ({ paper_id: p.id, project_id: project.id })),
    );

    install(
      createSupabaseMock({
        tables: baseTables({
          papers,
          projects,
          paper_projects: paperProjects,
          paper_tags: [],
          paper_attachments: [],
        }),
      }),
    );

    const data = await fetchAccountExportData(USER);

    expect(data.paper_projects).toHaveLength(1200);
    expect(new Set(data.paper_projects.map((r) => `${r.paper_id}:${r.project_id}`)).size).toBe(1200);
  });
});

describe("fetchAccountExportData — junction ownership validation", () => {
  it("fails closed when a relationship names a paper outside the account", async () => {
    install(
      createSupabaseMock({
        tables: baseTables({
          paper_projects: [{ paper_id: "not-mine", project_id: "proj-1" }],
        }),
        // The backend ignores the `.in(paper_id, ownedIds)` predicate.
        leakTables: ["paper_projects"],
      }),
    );

    await expect(fetchAccountExportData(USER)).rejects.toBeInstanceOf(AccountExportError);
  });

  it("fails closed when a relationship names a project outside the account", async () => {
    install(
      createSupabaseMock({
        tables: baseTables({
          paper_projects: [{ paper_id: "p1", project_id: "foreign-project" }],
        }),
      }),
    );

    await expect(fetchAccountExportData(USER)).rejects.toMatchObject({
      name: "AccountExportError",
      stage: "collecting",
      message: "Could not read your account data.",
    });
  });

  it("fails closed when a relationship names a tag outside the account", async () => {
    install(
      createSupabaseMock({
        tables: baseTables({ paper_tags: [{ paper_id: "p1", tag_id: "foreign-tag" }] }),
      }),
    );

    await expect(fetchAccountExportData(USER)).rejects.toBeInstanceOf(AccountExportError);
  });
});

describe("fetchAccountExportData — attachment scoping", () => {
  it("rejects an attachment whose storage path is outside the user namespace", async () => {
    install(
      createSupabaseMock({
        tables: baseTables({
          paper_attachments: [
            attachment("att-1", "p1", { file_path: `${OTHER_USER}/p1/att-1.pdf` }),
          ],
        }),
      }),
    );

    await expect(fetchAccountExportData(USER)).rejects.toBeInstanceOf(AccountExportError);
  });

  it("rejects an attachment whose paper is not in the exported set", async () => {
    install(
      createSupabaseMock({
        tables: baseTables({
          paper_attachments: [attachment("att-1", "unknown-paper", {
            file_path: `${USER}/unknown-paper/att-1.pdf`,
          })],
        }),
      }),
    );

    await expect(fetchAccountExportData(USER)).rejects.toBeInstanceOf(AccountExportError);
  });
});

describe("fetchAccountExportData — required-category failure", () => {
  it.each([
    "papers",
    "projects",
    "tags",
    "filter_presets",
    "keyword_pool",
    "synonym_pool",
    "study_type_pool",
    "keyword_exclusion_pool",
    "study_type_exclusion_pool",
    "paper_attachments",
    "profiles",
  ])("aborts the whole export when %s cannot be read", async (table) => {
    install(
      createSupabaseMock({
        tables: baseTables(),
        errors: { [table]: new Error("permission denied for relation") },
      }),
    );

    const error = await fetchAccountExportData(USER).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AccountExportError);
    // The raw Postgres string never becomes the user-facing message.
    expect((error as AccountExportError).message).toBe("Could not read your account data.");
    expect((error as AccountExportError).message).not.toContain("permission denied");
  });

  it("aborts when a junction table cannot be read", async () => {
    install(
      createSupabaseMock({
        tables: baseTables(),
        errors: { paper_tags: new Error("relation does not exist") },
      }),
    );

    await expect(fetchAccountExportData(USER)).rejects.toBeInstanceOf(AccountExportError);
  });

  it("refuses to run without a signed-in user id", async () => {
    install(createSupabaseMock({ tables: baseTables() }));
    await expect(fetchAccountExportData("")).rejects.toBeInstanceOf(AccountExportError);
    expect(mockFrom).not.toHaveBeenCalled();
  });
});

describe("isOwnedStoragePath", () => {
  it("accepts only paths inside the user's own namespace", () => {
    expect(isOwnedStoragePath(`${USER}/p1/a.pdf`, USER)).toBe(true);
    expect(isOwnedStoragePath(`${OTHER_USER}/p1/a.pdf`, USER)).toBe(false);
    expect(isOwnedStoragePath(`${USER}`, USER)).toBe(false);
    expect(isOwnedStoragePath(`${USER}/`, USER)).toBe(false);
    expect(isOwnedStoragePath(`${USER}-evil/p1/a.pdf`, USER)).toBe(false);
    expect(isOwnedStoragePath(`x/${USER}/p1/a.pdf`, USER)).toBe(false);
    expect(isOwnedStoragePath(`${USER}/../${OTHER_USER}/a.pdf`, USER)).toBe(false);
    expect(isOwnedStoragePath("", USER)).toBe(false);
  });
});
