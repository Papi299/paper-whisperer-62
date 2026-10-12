import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { createSupabaseMock } from "@/lib/accountExport/__tests__/supabaseMock";

/**
 * EVIDENCE-RECORDS-001A1 review fix, through the hook the Settings button uses.
 *
 * Unlike `useAccountExport.test.ts`, the REAL read layer runs here, against the
 * behavioural PostgREST double. Only the archive builder, the download trigger
 * and the toast are doubles. An export the study-records gate refuses must never
 * reach the builder or the download, and must never be announced as a success.
 */

const { mockFrom, mockToast, mockBuildArchive, mockTriggerDownload } = vi.hoisted(() => ({
  mockFrom: vi.fn(),
  mockToast: vi.fn(),
  mockBuildArchive: vi.fn(),
  mockTriggerDownload: vi.fn(),
}));

vi.mock("@/integrations/supabase/client", () => ({
  supabase: { from: mockFrom, storage: { from: vi.fn() } },
}));
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: mockToast }) }));
vi.mock("@/lib/accountExport/buildAccountExportArchive", () => ({
  buildAccountExportArchive: mockBuildArchive,
}));
vi.mock("@/lib/accountExport/downloadAccountExport", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/accountExport/downloadAccountExport")>();
  return { ...actual, triggerArchiveDownload: mockTriggerDownload };
});

import { useAccountExport } from "../useAccountExport";

const USER = "user-a";
const T = "2026-10-12T00:00:00Z";

const EVIDENCE_TABLES = [
  "evidence_studies",
  "evidence_study_reports",
  "evidence_source_snapshots",
  "evidence_arms",
  "evidence_outcomes",
  "evidence_field_values",
  "evidence_field_anchors",
  "evidence_events",
] as const;

/** A one-paper account whose only study-record row is a link to that paper. */
function account() {
  return {
    profiles: [{ id: "profile-1", user_id: USER, email: "a@example.com", display_name: "A", created_at: T, updated_at: T }],
    papers: [{ id: "p1", user_id: USER, title: "Paper p1", insert_order: 1, created_at: T, updated_at: T }],
    evidence_study_reports: [
      { id: "lk-1", user_id: USER, study_id: "st-1", paper_id: "p1", link_status: "user_confirmed", link_basis: "created_from_paper", created_at: T, updated_at: T },
    ],
  };
}

function missingTable(table: string): Error {
  return Object.assign(new Error(`Could not find the table 'public.${table}' in the schema cache`), {
    code: "PGRST205",
    details: null,
    hint: null,
  });
}

async function runExport() {
  const { result } = renderHook(() => useAccountExport(USER));
  await act(async () => {
    await result.current.exportAccountData();
  });
  return result;
}

function expectRefusedWithoutDownload() {
  expect(mockBuildArchive).not.toHaveBeenCalled();
  expect(mockTriggerDownload).not.toHaveBeenCalled();
  expect(mockToast).toHaveBeenCalledExactlyOnceWith({
    title: "Export failed",
    description: "Could not read your account data.",
    variant: "destructive",
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockBuildArchive.mockResolvedValue({ blob: new Blob(["zip"]), manifest: { version: 3 } });
});

describe("useAccountExport — the study-records gate, end to end", () => {
  it("downloads nothing and reports failure when evidence_studies is missing but a sibling holds a row", async () => {
    mockFrom.mockImplementation(
      createSupabaseMock({
        tables: account(),
        errors: { evidence_studies: missingTable("evidence_studies") },
      }).from,
    );

    const result = await runExport();

    expectRefusedWithoutDownload();
    expect(result.current.isExporting).toBe(false);
  });

  it("downloads nothing and reports failure when evidence_studies is missing and a sibling read is denied", async () => {
    mockFrom.mockImplementation(
      createSupabaseMock({
        tables: account(),
        errors: {
          ...Object.fromEntries(EVIDENCE_TABLES.map((table) => [table, missingTable(table)])),
          evidence_arms: Object.assign(new Error("permission denied for table evidence_arms"), { code: "42501" }),
        },
      }).from,
    );

    await runExport();

    expectRefusedWithoutDownload();
  });

  it("still exports, with eight empty categories, when all eight tables are genuinely absent", async () => {
    // Positive control: the rollout window keeps working.
    const { profiles, papers } = account();
    mockFrom.mockImplementation(
      createSupabaseMock({
        tables: { profiles, papers },
        errors: Object.fromEntries(EVIDENCE_TABLES.map((table) => [table, missingTable(table)])),
      }).from,
    );

    await runExport();

    expect(mockBuildArchive).toHaveBeenCalledTimes(1);
    const { data } = mockBuildArchive.mock.calls[0][0];
    for (const table of EVIDENCE_TABLES) {
      expect(data[table]).toEqual([]);
    }
    expect(data.papers).toHaveLength(1);
    expect(mockTriggerDownload).toHaveBeenCalledTimes(1);
    expect(mockToast).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ title: "Account data exported" }),
    );
  });
});
