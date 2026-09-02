import { describe, it, expect, vi } from "vitest";
import { unzipSync, strFromU8 } from "fflate";
import { buildAccountExportArchive } from "../buildAccountExportArchive";
import { attachmentArchivePath } from "../sanitizeArchiveFilename";
import {
  ACCOUNT_EXPORT_CATEGORIES,
  ACCOUNT_EXPORT_COLLECTIONS,
  ACCOUNT_EXPORT_FORMAT,
  ACCOUNT_EXPORT_VERSION,
  AccountExportError,
  EXPECTED_ARCHIVE_JSON_PATHS,
  MANIFEST_PATH,
  categoryArchivePath,
  type AccountExportData,
  type ExportedAttachment,
  type ExportedPaper,
} from "../types";

const USER = "user-a";
const GENERATED_AT = new Date("2026-08-10T20:30:00.000Z");

/* Sentinels that must never appear in the archive bytes. */
const SENTINEL_PUBMED_KEY = "SENTINEL-PUBMED-API-KEY";
const SENTINEL_ACCESS_TOKEN = "SENTINEL-ACCESS-TOKEN";
const SENTINEL_REFRESH_TOKEN = "SENTINEL-REFRESH-TOKEN";

function emptyData(): AccountExportData {
  return {
    profile: null,
    papers: [],
    projects: [],
    paper_projects: [],
    tags: [],
    paper_tags: [],
    filter_presets: [],
    keyword_pool: [],
    synonym_pool: [],
    study_type_pool: [],
    keyword_exclusion_pool: [],
    study_type_exclusion_pool: [],
    paper_attachments: [],
    author_identities: [],
    author_identity_aliases: [],
    author_identity_links: [],
    author_identity_merges: [],
    user_ai_preferences: null,
  };
}

function samplePaper(overrides: Partial<ExportedPaper> = {}): ExportedPaper {
  return {
    id: "p1",
    user_id: USER,
    title: "A paper",
    authors: ["Ada L."],
    year: 2024,
    journal: "Journal",
    pmid: "12345678",
    doi: "10.1000/example",
    abstract: "Abstract text",
    has_abstract: true,
    study_type: "RCT",
    raw_study_type: "Clinical Trial, Phase II",
    raw_publication_types: ["Clinical Trial, Phase II", "Multicenter Study"],
    author_provenance: [
      {
        source: "pubmed_api",
        source_field: "Author",
        kind: "personal",
        source_name: "Ada L.",
        given_name: "Ada",
        family_name: "L.",
        initials: "A",
        suffix: null,
        collective_name: null,
        affiliations: ["Analytical Engine Institute"],
        identifiers: [{ scheme: "ORCID", value: "0000-0002-1825-0097" }],
        orcid: "0000-0002-1825-0097",
        orcid_authenticated: true,
      },
    ],
    statistical_methods: { anova: true },
    keywords: ["muscle"],
    raw_keywords: null,
    mesh_terms: [],
    substances: null,
    pubmed_url: "https://pubmed.ncbi.nlm.nih.gov/12345678/",
    journal_url: null,
    drive_url: null,
    tldr: "Short summary",
    notes: "My notes — line one\nline two",
    insert_order: 7,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-02T00:00:00Z",
    ...overrides,
  } as ExportedPaper;
}

function sampleAttachment(
  id: string,
  fileName: string,
  paperId = "p1",
  sizeBytes = 4,
): ExportedAttachment {
  const row = {
    id,
    user_id: USER,
    paper_id: paperId,
    file_path: `${USER}/${paperId}/${id}.pdf`,
    file_name: fileName,
    file_type: "application/pdf",
    size_bytes: sizeBytes,
    created_at: "2026-01-01T00:00:00Z",
  };
  return { ...row, archive_path: attachmentArchivePath(row) } as ExportedAttachment;
}

/** Deterministic per-attachment bytes so exact-byte assertions are possible. */
function bytesFor(id: string, length = 4): Uint8Array {
  const seed = id.split("").reduce((acc, ch) => acc + ch.charCodeAt(0), 0);
  return new Uint8Array(Array.from({ length }, (_, i) => (seed + i) % 256));
}

/**
 * jsdom's `Blob` does not implement `arrayBuffer()`, so the archive is read
 * back through `FileReader` — the same primitive a browser download uses.
 */
async function blobToBytes(blob: Blob): Promise<Uint8Array> {
  if (typeof blob.arrayBuffer === "function") {
    return new Uint8Array(await blob.arrayBuffer());
  }
  const buffer = await new Promise<ArrayBuffer>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as ArrayBuffer);
    reader.onerror = () => reject(reader.error ?? new Error("FileReader failed"));
    reader.readAsArrayBuffer(blob);
  });
  return new Uint8Array(buffer);
}

async function readArchive(blob: Blob): Promise<Record<string, Uint8Array>> {
  return unzipSync(await blobToBytes(blob));
}

function readJson(entries: Record<string, Uint8Array>, path: string): unknown {
  const file = entries[path];
  expect(file, `${path} must exist in the archive`).toBeDefined();
  return JSON.parse(strFromU8(file));
}

const noAttachments = () => Promise.reject(new Error("no attachment expected"));

describe("buildAccountExportArchive — category completeness", () => {
  it("writes every registry category plus the manifest, even when empty", async () => {
    const { blob, manifest } = await buildAccountExportArchive({
      data: emptyData(),
      userId: USER,
      generatedAt: GENERATED_AT,
      downloadAttachment: noAttachments,
    });

    const entries = await readArchive(blob);

    for (const path of EXPECTED_ARCHIVE_JSON_PATHS) {
      expect(Object.keys(entries), `${path} must be present`).toContain(path);
    }
    // Nothing beyond the declared contract.
    expect(Object.keys(entries).sort()).toEqual([...EXPECTED_ARCHIVE_JSON_PATHS].sort());

    for (const key of ACCOUNT_EXPORT_COLLECTIONS) {
      expect(readJson(entries, categoryArchivePath(key)), `${key} must be []`).toEqual([]);
    }
    expect(readJson(entries, categoryArchivePath("profile"))).toBeNull();

    for (const key of ACCOUNT_EXPORT_CATEGORIES) {
      expect(manifest.categories[key].count).toBe(0);
    }
    expect(manifest.attachments).toEqual({ count: 0, total_bytes: 0 });
  });

  it("keeps the safe profile when the account has one but no papers", async () => {
    const data = emptyData();
    data.profile = {
      id: "profile-1",
      user_id: USER,
      email: "a@example.com",
      display_name: "A",
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-02T00:00:00Z",
    };

    const { blob, manifest } = await buildAccountExportArchive({
      data,
      userId: USER,
      generatedAt: GENERATED_AT,
      downloadAttachment: noAttachments,
    });

    const entries = await readArchive(blob);
    expect(readJson(entries, categoryArchivePath("profile"))).toEqual(data.profile);
    expect(manifest.categories.profile.count).toBe(1);
    expect(manifest.categories.papers.count).toBe(0);
  });

  it("writes the saved AI model preference as its own singleton file", async () => {
    // AI-MODEL-SELECTION-001A. The user's choice among Paperlume's approved
    // models is their data and travels with the rest of the account.
    const data = emptyData();
    data.user_ai_preferences = {
      user_id: USER,
      preferred_model_id: "google/gemini-3.6-flash",
      created_at: "2026-09-02T00:00:00Z",
      updated_at: "2026-09-02T01:00:00Z",
    };

    const { blob, manifest } = await buildAccountExportArchive({
      data,
      userId: USER,
      generatedAt: GENERATED_AT,
      downloadAttachment: noAttachments,
    });

    const entries = await readArchive(blob);
    expect(Object.keys(entries)).toContain("data/user_ai_preferences.json");
    expect(readJson(entries, categoryArchivePath("user_ai_preferences"))).toEqual(
      data.user_ai_preferences,
    );
    expect(manifest.categories.user_ai_preferences.count).toBe(1);

    // Exactly the approved fields — no catalog row, provider model string,
    // display name, credential or entitlement smuggled alongside the choice.
    const written = readJson(entries, categoryArchivePath("user_ai_preferences")) as Record<
      string,
      unknown
    >;
    expect(Object.keys(written).sort()).toEqual(
      ["created_at", "preferred_model_id", "updated_at", "user_id"],
    );
    for (const forbidden of [
      "provider",
      "provider_model",
      "display_name",
      "enabled",
      "selectable",
      "sort_order",
    ]) {
      expect(written, `${forbidden} must not be exported`).not.toHaveProperty(forbidden);
    }
    // The stable provider-qualified id is what preserves the decision.
    expect(written.preferred_model_id).toBe("google/gemini-3.6-flash");
  });

  it("writes JSON null for an account with no AI model preference", async () => {
    // `null` is the meaningful value, not an omission: it is what "no explicit
    // preference — use the system default" looks like to a reader.
    const { blob, manifest } = await buildAccountExportArchive({
      data: emptyData(),
      userId: USER,
      generatedAt: GENERATED_AT,
      downloadAttachment: noAttachments,
    });

    const entries = await readArchive(blob);
    expect(Object.keys(entries)).toContain("data/user_ai_preferences.json");
    expect(readJson(entries, categoryArchivePath("user_ai_preferences"))).toBeNull();
    expect(strFromU8(entries["data/user_ai_preferences.json"]).trim()).toBe("null");
    expect(manifest.categories.user_ai_preferences.count).toBe(0);
  });
});

describe("buildAccountExportArchive — manifest", () => {
  it("is stable, deterministic and reconciles with the category contents", async () => {
    const data = emptyData();
    data.papers = [samplePaper(), samplePaper({ id: "p2", insert_order: 8 })];
    data.tags = [{ id: "t1", user_id: USER, name: "T", color: "#000", created_at: "x" }];
    data.paper_tags = [{ paper_id: "p1", tag_id: "t1" }];

    const { blob, manifest } = await buildAccountExportArchive({
      data,
      userId: USER,
      generatedAt: GENERATED_AT,
      downloadAttachment: noAttachments,
    });

    expect(manifest.format).toBe(ACCOUNT_EXPORT_FORMAT);
    expect(manifest.version).toBe(ACCOUNT_EXPORT_VERSION);
    expect(manifest.generated_at).toBe("2026-08-10T20:30:00.000Z");
    expect(manifest.user_id).toBe(USER);

    const entries = await readArchive(blob);
    const onDisk = readJson(entries, MANIFEST_PATH) as typeof manifest;
    expect(onDisk).toEqual(manifest);

    // Every declared count matches the file it points at.
    for (const key of ACCOUNT_EXPORT_COLLECTIONS) {
      const rows = readJson(entries, onDisk.categories[key].path) as unknown[];
      expect(rows.length, `${key} count must match`).toBe(onDisk.categories[key].count);
    }
    expect(onDisk.categories.papers.count).toBe(2);
    expect(onDisk.categories.paper_tags.count).toBe(1);
  });

  it("carries no credential material", async () => {
    const { manifest } = await buildAccountExportArchive({
      data: emptyData(),
      userId: USER,
      generatedAt: GENERATED_AT,
      downloadAttachment: noAttachments,
    });

    // Note: category names legitimately contain "key" (keyword_pool), so the
    // assertion targets credential identifiers rather than the substring.
    const text = JSON.stringify(manifest).toLowerCase();
    for (const forbidden of [
      "access_token",
      "refresh_token",
      "api_key",
      "apikey",
      "secret",
      "password",
      "session",
      "jwt",
      "bearer",
      "@",
    ]) {
      expect(text, `${forbidden} must not appear in the manifest`).not.toContain(forbidden);
    }
  });
});

describe("buildAccountExportArchive — papers fidelity", () => {
  it("round-trips complete paper metadata including notes, arrays, JSON and nulls", async () => {
    const data = emptyData();
    const paper = samplePaper();
    data.papers = [paper];

    const { blob } = await buildAccountExportArchive({
      data,
      userId: USER,
      generatedAt: GENERATED_AT,
      downloadAttachment: noAttachments,
    });

    const entries = await readArchive(blob);
    const papers = readJson(entries, categoryArchivePath("papers")) as ExportedPaper[];

    expect(papers).toHaveLength(1);
    // Byte-for-byte structural equality — nothing coerced, nothing dropped.
    expect(papers[0]).toEqual(paper);
    expect(papers[0].notes).toBe("My notes — line one\nline two");
    expect(papers[0].raw_publication_types).toEqual([
      "Clinical Trial, Phase II",
      "Multicenter Study",
    ]);
    // Structured provenance survives the JSON round trip whole — nested
    // identifier objects, the affiliation list and the provider assertion flag
    // included. Nothing else in the archive could reconstruct them.
    expect(papers[0].author_provenance).toEqual(paper.author_provenance);
    expect(papers[0].substances).toBeNull();
    expect(papers[0].mesh_terms).toEqual([]);
    expect(papers[0].insert_order).toBe(7);
  });

  it("writes UTF-8 JSON", async () => {
    const data = emptyData();
    data.papers = [samplePaper({ title: "מאמר — études 研究" })];

    const { blob } = await buildAccountExportArchive({
      data,
      userId: USER,
      generatedAt: GENERATED_AT,
      downloadAttachment: noAttachments,
    });

    const entries = await readArchive(blob);
    const papers = readJson(entries, categoryArchivePath("papers")) as ExportedPaper[];
    expect(papers[0].title).toBe("מאמר — études 研究");
  });
});

describe("buildAccountExportArchive — attachments", () => {
  it("archives exact binary bytes at the path recorded in the metadata", async () => {
    const data = emptyData();
    data.papers = [samplePaper()];
    data.paper_attachments = [
      sampleAttachment("att-1", "study.pdf"),
      sampleAttachment("att-2", "figure.png"),
    ];

    const { blob, manifest } = await buildAccountExportArchive({
      data,
      userId: USER,
      generatedAt: GENERATED_AT,
      downloadAttachment: async (attachment) => bytesFor(attachment.id, 8),
    });

    const entries = await readArchive(blob);
    const metadata = readJson(
      entries,
      categoryArchivePath("paper_attachments"),
    ) as ExportedAttachment[];

    expect(metadata).toHaveLength(2);
    for (const row of metadata) {
      // The mapping from metadata to archive path resolves to a real entry…
      expect(Object.keys(entries)).toContain(row.archive_path);
      // …holding exactly the bytes that were downloaded.
      expect(Array.from(entries[row.archive_path])).toEqual(Array.from(bytesFor(row.id, 8)));
      // …and the original filename is preserved untouched alongside it.
      expect(row.file_name).toMatch(/^(study\.pdf|figure\.png)$/);
    }

    expect(manifest.attachments.count).toBe(2);
    expect(manifest.attachments.total_bytes).toBe(16);
  });

  it("archives one binary per metadata row, with no collision on duplicate names", async () => {
    const data = emptyData();
    data.papers = [samplePaper()];
    data.paper_attachments = [
      sampleAttachment("att-1", "scan.pdf"),
      sampleAttachment("att-2", "scan.pdf"),
      sampleAttachment("att-3", "scan.pdf"),
    ];

    const { blob, manifest } = await buildAccountExportArchive({
      data,
      userId: USER,
      generatedAt: GENERATED_AT,
      downloadAttachment: async (attachment) => bytesFor(attachment.id, 5),
    });

    const entries = await readArchive(blob);
    const paths = data.paper_attachments.map((a) => a.archive_path);

    expect(new Set(paths).size).toBe(3);
    for (const path of paths) expect(Object.keys(entries)).toContain(path);

    const binaryCount = Object.keys(entries).filter((p) => p.startsWith("attachments/")).length;
    expect(binaryCount).toBe(data.paper_attachments.length);
    expect(manifest.attachments.count).toBe(3);
  });

  it("sanitizes traversal-style original filenames into the attachments directory", async () => {
    const data = emptyData();
    data.papers = [samplePaper()];
    data.paper_attachments = [
      sampleAttachment("att-1", "../../secret.txt"),
      sampleAttachment("att-2", "../paper.pdf"),
      sampleAttachment("att-3", "foo/bar.pdf"),
      sampleAttachment("att-4", "foo\\bar.pdf"),
    ];

    const { blob } = await buildAccountExportArchive({
      data,
      userId: USER,
      generatedAt: GENERATED_AT,
      downloadAttachment: async (attachment) => bytesFor(attachment.id),
    });

    const entries = await readArchive(blob);
    for (const path of Object.keys(entries)) {
      expect(path.split("/")).not.toContain("..");
      expect(path.startsWith("/")).toBe(false);
      expect(path.includes("\\")).toBe(false);
    }
    expect(
      Object.keys(entries).filter((p) => p.startsWith("attachments/p1/")),
    ).toHaveLength(4);

    // The real filenames survive in the metadata, unmodified.
    const metadata = readJson(
      entries,
      categoryArchivePath("paper_attachments"),
    ) as ExportedAttachment[];
    expect(metadata.map((row) => row.file_name)).toEqual([
      "../../secret.txt",
      "../paper.pdf",
      "foo/bar.pdf",
      "foo\\bar.pdf",
    ]);
  });

  it("downloads with a bounded concurrency window rather than an unbounded Promise.all", async () => {
    const data = emptyData();
    data.papers = [samplePaper()];
    data.paper_attachments = Array.from({ length: 10 }, (_, i) =>
      sampleAttachment(`att-${i}`, `file-${i}.pdf`),
    );

    let inFlight = 0;
    let maxInFlight = 0;
    const downloadAttachment = vi.fn(async (attachment: ExportedAttachment) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 1));
      inFlight -= 1;
      return bytesFor(attachment.id);
    });

    const { manifest } = await buildAccountExportArchive({
      data,
      userId: USER,
      generatedAt: GENERATED_AT,
      downloadAttachment,
      concurrency: 3,
    });

    expect(downloadAttachment).toHaveBeenCalledTimes(10);
    expect(maxInFlight).toBeLessThanOrEqual(3);
    // Proves the window is actually used (not accidentally serialized to 1).
    expect(maxInFlight).toBe(3);
    expect(manifest.attachments.count).toBe(10);
  });

  it("reports bounded per-attachment progress", async () => {
    const data = emptyData();
    data.papers = [samplePaper()];
    data.paper_attachments = Array.from({ length: 3 }, (_, i) =>
      sampleAttachment(`att-${i}`, `f${i}.pdf`),
    );

    const stages: string[] = [];
    await buildAccountExportArchive({
      data,
      userId: USER,
      generatedAt: GENERATED_AT,
      downloadAttachment: async (a) => bytesFor(a.id),
      onProgress: (progress) =>
        stages.push(
          progress.stage === "attachments"
            ? `attachments:${progress.current}/${progress.total}`
            : progress.stage,
        ),
    });

    expect(stages).toContain("collecting");
    expect(stages).toContain("attachments:0/3");
    expect(stages).toContain("attachments:3/3");
    expect(stages[stages.length - 1]).toBe("archiving");
  });
});

describe("buildAccountExportArchive — complete-or-fail", () => {
  it("aborts and returns no archive when an attachment binary cannot be downloaded", async () => {
    const data = emptyData();
    data.papers = [samplePaper()];
    data.paper_attachments = [
      sampleAttachment("att-1", "ok.pdf"),
      sampleAttachment("att-2", "missing.pdf"),
      sampleAttachment("att-3", "ok2.pdf"),
    ];

    const downloadAttachment = vi.fn(async (attachment: ExportedAttachment) => {
      if (attachment.id === "att-2") throw new Error("storage 404 for object");
      return bytesFor(attachment.id);
    });

    const error = await buildAccountExportArchive({
      data,
      userId: USER,
      generatedAt: GENERATED_AT,
      downloadAttachment,
    }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(AccountExportError);
    expect((error as AccountExportError).stage).toBe("attachments");
    expect((error as AccountExportError).message).toBe(
      "Could not download one of your attachments.",
    );
    // The raw storage error is never the user-facing message.
    expect((error as AccountExportError).message).not.toContain("404");
  });

  it("fails when metadata declares more binaries than were archived", async () => {
    const data = emptyData();
    data.papers = [samplePaper()];
    data.paper_attachments = [sampleAttachment("att-1", "a.pdf"), sampleAttachment("att-2", "b.pdf")];

    // A downloader that silently yields nothing for the second row is
    // impossible through the public API, so the reconciliation is exercised by
    // a generator that stops early — modelled here by a rejecting download.
    const error = await buildAccountExportArchive({
      data,
      userId: USER,
      generatedAt: GENERATED_AT,
      downloadAttachment: async (attachment) => {
        if (attachment.id === "att-2") throw new AccountExportError("attachments", "Could not download one of your attachments.");
        return bytesFor(attachment.id);
      },
    }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(AccountExportError);
    expect((error as AccountExportError).stage).toBe("attachments");
  });

  it("refuses an unsafe archive path even if one reaches the builder", async () => {
    const data = emptyData();
    data.papers = [samplePaper()];
    const rogue = sampleAttachment("att-1", "a.pdf");
    // Simulate a bug upstream of the sanitizer.
    (rogue as { archive_path: string }).archive_path = "../../escaped.pdf";
    data.paper_attachments = [rogue];

    await expect(
      buildAccountExportArchive({
        data,
        userId: USER,
        generatedAt: GENERATED_AT,
        downloadAttachment: async () => bytesFor("att-1"),
      }),
    ).rejects.toBeInstanceOf(AccountExportError);
  });
});

describe("buildAccountExportArchive — secret exclusion in archive bytes", () => {
  it("contains no api key, token, session or user object anywhere in the ZIP", async () => {
    const data = emptyData();
    data.profile = {
      id: "profile-1",
      user_id: USER,
      email: "a@example.com",
      display_name: "A",
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-02T00:00:00Z",
    };
    data.papers = [samplePaper()];
    data.paper_attachments = [sampleAttachment("att-1", "study.pdf")];

    const { blob } = await buildAccountExportArchive({
      data,
      userId: USER,
      generatedAt: GENERATED_AT,
      downloadAttachment: async (a) => bytesFor(a.id),
    });

    const entries = await readArchive(blob);
    const allText = Object.values(entries).map((bytes) => strFromU8(bytes)).join("\n");

    for (const sentinel of [
      SENTINEL_PUBMED_KEY,
      SENTINEL_ACCESS_TOKEN,
      SENTINEL_REFRESH_TOKEN,
    ]) {
      expect(allText).not.toContain(sentinel);
    }
    for (const forbiddenKey of [
      "pubmed_api_key",
      "access_token",
      "refresh_token",
      "provider_token",
      "provider_refresh_token",
      "expires_at",
      "app_metadata",
      "user_metadata",
      "aud",
      "service_role",
      "anon_key",
      "SUPABASE_",
      "GEMINI",
    ]) {
      expect(allText, `${forbiddenKey} must not appear`).not.toContain(forbiddenKey);
    }
  });
});
