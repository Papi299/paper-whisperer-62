import { describe, it, expect } from "vitest";
import { buildAccountExportManifest } from "../buildAccountExportManifest";
import {
  ACCOUNT_EXPORT_CATEGORIES,
  ACCOUNT_EXPORT_COLLECTIONS,
  ACCOUNT_EXPORT_FORMAT,
  ACCOUNT_EXPORT_VERSION,
  categoryArchivePath,
  type AccountExportData,
} from "../types";

const USER = "user-a";

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
  };
}

const NO_ATTACHMENTS = { count: 0, totalBytes: 0 };

describe("buildAccountExportManifest", () => {
  it("pins the format name and version", () => {
    const manifest = buildAccountExportManifest(emptyData(), {
      userId: USER,
      generatedAt: new Date("2026-08-10T20:30:00.000Z"),
      archivedAttachments: NO_ATTACHMENTS,
    });

    expect(manifest.format).toBe("paperlume-account-export");
    expect(manifest.format).toBe(ACCOUNT_EXPORT_FORMAT);
    // Literal on purpose, so a version change has to be made deliberately here
    // rather than tracking the constant silently. 2 since papers gained the
    // persisted `author_provenance` field — a reshape of an existing archive
    // file, which a reader must be able to notice.
    expect(manifest.version).toBe(2);
    expect(manifest.version).toBe(ACCOUNT_EXPORT_VERSION);
  });

  it("is deterministic under a fixed clock", () => {
    const at = new Date("2026-08-10T20:30:00.000Z");
    const first = buildAccountExportManifest(emptyData(), {
      userId: USER,
      generatedAt: at,
      archivedAttachments: NO_ATTACHMENTS,
    });
    const second = buildAccountExportManifest(emptyData(), {
      userId: USER,
      generatedAt: at,
      archivedAttachments: NO_ATTACHMENTS,
    });

    expect(first.generated_at).toBe("2026-08-10T20:30:00.000Z");
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });

  it("declares every registry category with its archive path", () => {
    const manifest = buildAccountExportManifest(emptyData(), {
      userId: USER,
      generatedAt: new Date("2026-08-10T20:30:00.000Z"),
      archivedAttachments: NO_ATTACHMENTS,
    });

    expect(Object.keys(manifest.categories).sort()).toEqual(
      [...ACCOUNT_EXPORT_CATEGORIES].sort(),
    );
    for (const key of ACCOUNT_EXPORT_CATEGORIES) {
      expect(manifest.categories[key].path).toBe(categoryArchivePath(key));
      expect(manifest.categories[key].count).toBe(0);
    }
  });

  it("counts collection rows and the profile singleton", () => {
    const data = emptyData();
    data.profile = {
      id: "profile-1",
      user_id: USER,
      email: null,
      display_name: null,
      created_at: "x",
      updated_at: "y",
    };
    data.papers = [{ id: "p1" }, { id: "p2" }, { id: "p3" }] as AccountExportData["papers"];
    data.tags = [{ id: "t1" }] as AccountExportData["tags"];

    const manifest = buildAccountExportManifest(data, {
      userId: USER,
      generatedAt: new Date("2026-08-10T20:30:00.000Z"),
      archivedAttachments: { count: 2, totalBytes: 4096 },
    });

    expect(manifest.categories.profile.count).toBe(1);
    expect(manifest.categories.papers.count).toBe(3);
    expect(manifest.categories.tags.count).toBe(1);
    expect(manifest.categories.projects.count).toBe(0);
    expect(manifest.attachments).toEqual({ count: 2, total_bytes: 4096 });
  });

  it("identifies the account by opaque user id only", () => {
    const data = emptyData();
    data.profile = {
      id: "profile-1",
      user_id: USER,
      email: "someone@example.com",
      display_name: "Someone",
      created_at: "x",
      updated_at: "y",
    };

    const manifest = buildAccountExportManifest(data, {
      userId: USER,
      generatedAt: new Date("2026-08-10T20:30:00.000Z"),
      archivedAttachments: NO_ATTACHMENTS,
    });

    expect(manifest.user_id).toBe(USER);
    // The profile's email belongs in data/profile.json, not the manifest.
    expect(JSON.stringify(manifest)).not.toContain("someone@example.com");
  });

  it("covers every collection key with no extras", () => {
    const manifest = buildAccountExportManifest(emptyData(), {
      userId: USER,
      generatedAt: new Date("2026-08-10T20:30:00.000Z"),
      archivedAttachments: NO_ATTACHMENTS,
    });

    for (const key of ACCOUNT_EXPORT_COLLECTIONS) {
      expect(manifest.categories, `${key} must be declared`).toHaveProperty(key);
    }
    expect(Object.keys(manifest.categories)).toHaveLength(
      ACCOUNT_EXPORT_COLLECTIONS.length + 1,
    );
  });
});
