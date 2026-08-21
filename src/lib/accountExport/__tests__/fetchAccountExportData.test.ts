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
    author_provenance: null,
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

  it("exports structured author provenance losslessly, nested objects included", () => {
    // Portability is the contract: an ORCID, an affiliation list and the
    // identifier array it was derived from must all survive the round trip
    // exactly, because nothing else in the archive can reconstruct them.
    const provenance = [
      {
        source: "pubmed_api",
        source_field: "Author",
        kind: "personal",
        source_name: "Ricardo Soto-Rifo",
        given_name: "Ricardo",
        family_name: "Soto-Rifo",
        initials: "R",
        suffix: null,
        collective_name: null,
        affiliations: ["Universidad de Chile", "Millennium Institute"],
        identifiers: [{ scheme: "ORCID", value: "0000-0003-0945-2970" }],
        orcid: "0000-0003-0945-2970",
        orcid_authenticated: null,
      },
    ];
    install(
      createSupabaseMock({
        tables: baseTables({
          papers: [
            paper("p1", { authors: ["Ricardo Soto-Rifo"], author_provenance: provenance }),
          ],
        }),
      }),
    );

    return fetchAccountExportData(USER).then((data) => {
      const exported = data.papers[0] as unknown as Record<string, unknown>;
      expect(exported.author_provenance).toEqual(provenance);
    });
  });

  it("exports a legacy paper's NULL provenance as null, not as an omission", async () => {
    // NULL is the truthful state for every row predating the column, and a
    // reader must be able to tell it apart from a field that was dropped.
    install(createSupabaseMock({ tables: baseTables({ papers: [paper("p1")] }) }));

    const data = await fetchAccountExportData(USER);
    const exported = data.papers[0] as unknown as Record<string, unknown>;

    expect("author_provenance" in exported).toBe(true);
    expect(exported.author_provenance).toBeNull();
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

/* ═══════════════════════════════════════════════════════════════════════════
 * AUTHOR-IDENTITY-RESOLUTION-001C — exporting across the rollout window
 *
 * The 001C migration reaches Production separately from, and before, the code
 * that uses it. In between — and on every Vercel Preview built from this branch
 * while Production is still behind — the four identity tables do not exist.
 *
 * A user asking for all of their data during that window must get all of their
 * data. What they must NOT get is an archive that quietly omits decisions they
 * made because a read failed for some other reason, so the tolerance here is
 * one specific, verifiable condition and nothing else.
 * ══════════════════════════════════════════════════════════════════════════ */

const IDENTITY_TABLES = [
  "author_identities",
  "author_identity_aliases",
  "author_identity_links",
  "author_identity_merges",
] as const;

/** A PostgREST "no such table" error, exactly as the client surfaces one. */
function missingTable(table: string): Error {
  return Object.assign(
    new Error(
      `Could not find the table 'public.${table}' in the schema cache`,
    ),
    { code: "PGRST205", details: null, hint: null },
  );
}

/** Every identity table absent — the real pre-migration state. */
function missingIdentitySchema(): Record<string, Error> {
  return Object.fromEntries(
    IDENTITY_TABLES.map((table) => [table, missingTable(table)]),
  );
}

function identityTables() {
  return {
    author_identities: [
      {
        id: "id-1",
        user_id: USER,
        preferred_name: "Stuart M Phillips",
        created_at: "2026-02-01T00:00:00Z",
        updated_at: "2026-02-01T00:00:00Z",
      },
    ],
    author_identity_aliases: [
      {
        id: "al-1",
        user_id: USER,
        identity_id: "id-1",
        alias: "S M Phillips",
        created_at: "2026-02-01T00:00:00Z",
      },
    ],
    author_identity_links: [
      {
        id: "ln-1",
        user_id: USER,
        identity_id: "id-1",
        paper_id: "p1",
        author_index: 0,
        author_name_snapshot: "Author A",
        resolution_basis: "manual",
        created_at: "2026-02-01T00:00:00Z",
      },
    ],
    author_identity_merges: [],
  };
}

describe("fetchAccountExportData — 001C pre-migration compatibility", () => {
  it("exports successfully when the identity schema is absent", async () => {
    install(
      createSupabaseMock({ tables: baseTables(), errors: missingIdentitySchema() }),
    );

    const data = await fetchAccountExportData(USER);

    // Present but empty, never absent: the archive keeps all four categories so
    // its shape does not depend on which side of the migration it was made on.
    for (const table of IDENTITY_TABLES) {
      expect(data[table]).toEqual([]);
    }
  });

  it("leaves every other category completely intact", async () => {
    install(
      createSupabaseMock({ tables: baseTables(), errors: missingIdentitySchema() }),
    );

    const data = await fetchAccountExportData(USER);

    expect(data.profile).not.toBeNull();
    expect(data.papers).toHaveLength(2);
    expect(data.paper_projects).toEqual([{ paper_id: "p1", project_id: "proj-1" }]);
    expect(data.paper_tags).toEqual([{ paper_id: "p2", tag_id: "tag-1" }]);
    expect(data.paper_attachments).toHaveLength(1);
    for (const key of ACCOUNT_EXPORT_COLLECTIONS) {
      expect(Array.isArray(data[key]), `${key} must still be an array`).toBe(true);
    }
  });

  it("exports identity rows losslessly once the schema is installed", async () => {
    install(createSupabaseMock({ tables: { ...baseTables(), ...identityTables() } }));

    const data = await fetchAccountExportData(USER);

    expect(data.author_identities).toHaveLength(1);
    expect(data.author_identities[0].preferred_name).toBe("Stuart M Phillips");
    expect(data.author_identity_aliases[0].alias).toBe("S M Phillips");
    expect(data.author_identity_links[0].resolution_basis).toBe("manual");
    expect(data.author_identity_links[0].author_name_snapshot).toBe("Author A");
    expect(data.author_identity_merges).toEqual([]);
  });
});

describe("fetchAccountExportData — 001C compatibility stays narrow", () => {
  /** Every one of these must still fail the whole export. */
  const realFailures: [string, Error][] = [
    [
      "permission denied on an identity table",
      Object.assign(new Error("permission denied for table author_identities"), {
        code: "42501",
      }),
    ],
    [
      "an RLS refusal",
      Object.assign(
        new Error("new row violates row-level security policy for table \"author_identities\""),
        { code: "42501" },
      ),
    ],
    ["a network failure", new TypeError("Failed to fetch")],
    [
      "a malformed identity query",
      Object.assign(new Error("column author_identities.nope does not exist"), {
        code: "42703",
      }),
    ],
  ];

  for (const [description, error] of realFailures) {
    it(`still fails the export on ${description}`, async () => {
      install(
        createSupabaseMock({
          tables: { ...baseTables(), ...identityTables() },
          errors: { author_identities: error },
        }),
      );

      await expect(fetchAccountExportData(USER)).rejects.toBeInstanceOf(AccountExportError);
    });
  }

  it("still fails when an UNRELATED table is missing", async () => {
    // Same SQLSTATE family, different object. Treating this as "identities are
    // not installed" would hide a genuine schema problem in the user's papers.
    install(
      createSupabaseMock({
        tables: baseTables(),
        errors: { papers: missingTable("papers") },
      }),
    );

    await expect(fetchAccountExportData(USER)).rejects.toBeInstanceOf(AccountExportError);
  });

  it("fails closed on a PARTIALLY installed identity schema", async () => {
    // The migration creates all four tables in one transaction, so a real
    // environment has all four or none. One missing while another answers is a
    // broken installation — exporting it as empty would hand the user an
    // archive that silently drops decisions they made.
    install(
      createSupabaseMock({
        tables: { ...baseTables(), ...identityTables() },
        errors: { author_identity_links: missingTable("author_identity_links") },
      }),
    );

    await expect(fetchAccountExportData(USER)).rejects.toBeInstanceOf(AccountExportError);
  });

  it("fails on an identity row belonging to another account", async () => {
    install(
      createSupabaseMock({
        tables: {
          ...baseTables(),
          ...identityTables(),
          author_identities: [
            {
              id: "id-x",
              user_id: OTHER_USER,
              preferred_name: "Someone Else",
              created_at: "2026-02-01T00:00:00Z",
              updated_at: "2026-02-01T00:00:00Z",
            },
          ],
        },
        leakTables: ["author_identities"],
      }),
    );

    await expect(fetchAccountExportData(USER)).rejects.toBeInstanceOf(AccountExportError);
  });

  it("fails when a link references a paper outside the account", async () => {
    install(
      createSupabaseMock({
        tables: {
          ...baseTables(),
          ...identityTables(),
          author_identity_links: [
            {
              id: "ln-x",
              user_id: USER,
              identity_id: "id-1",
              paper_id: "paper-of-another-user",
              author_index: 0,
              author_name_snapshot: "Author A",
              resolution_basis: "manual",
              created_at: "2026-02-01T00:00:00Z",
            },
          ],
        },
      }),
    );

    await expect(fetchAccountExportData(USER)).rejects.toBeInstanceOf(AccountExportError);
  });
});
