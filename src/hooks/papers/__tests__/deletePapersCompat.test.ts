import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * The pre-migration paper-deletion path.
 *
 * It is reached only while Production has the new frontend and not yet the
 * cleanup migration, and it deliberately keeps the old, lossy sequence: read the
 * attachment paths, delete the papers, then ask Storage to remove the objects. A
 * client cannot make that durable against a schema with no queue in it, and
 * pretending otherwise would be worse than saying so.
 *
 * One thing here is a genuine fix rather than a preserved limitation. The
 * original wrote:
 *
 *     try { await supabase.storage.from("attachments").remove(paths); }
 *     catch (e) { console.warn("Storage cleanup failed (non-critical):", e); }
 *
 * Supabase Storage reports most failures by RETURNING `{ error }`, so that
 * `catch` almost never fired and almost every real cleanup failure was recorded
 * as a success. Both shapes now count, which is what lets the caller tell the
 * user that files remain.
 */

const { mockFrom, mockStorageRemove, state, resetSupabase } = vi.hoisted(() => {
  const state = {
    attachmentsResult: { data: [] as { file_path: string }[] | null, error: null as unknown },
    deleteResult: { error: null as unknown },
    selectInCalls: [] as [string, unknown][],
    deleteInCalls: [] as [string, unknown][],
    deleteEqCalls: [] as [string, unknown][],
  };

  const mockStorageRemove = vi.fn(async (_paths: string[]) => ({ data: null, error: null as unknown }));

  const mockFrom = vi.fn((table: string) => {
    if (table === "paper_attachments") {
      const chain = {
        select: () => chain,
        in: async (column: string, values: unknown) => {
          state.selectInCalls.push([column, values]);
          return state.attachmentsResult;
        },
      };
      return chain;
    }
    const deleteChain = {
      in: (column: string, values: unknown) => {
        state.deleteInCalls.push([column, values]);
        return deleteChain;
      },
      eq: (column: string, value: unknown) => {
        state.deleteEqCalls.push([column, value]);
        return deleteChain;
      },
      then: (onF: (v: unknown) => unknown, onR?: (r: unknown) => unknown) =>
        Promise.resolve(state.deleteResult).then(onF, onR),
    };
    return { delete: () => deleteChain };
  });

  return {
    mockFrom,
    mockStorageRemove,
    state,
    resetSupabase: () => {
      state.attachmentsResult = { data: [], error: null };
      state.deleteResult = { error: null };
      state.selectInCalls = [];
      state.deleteInCalls = [];
      state.deleteEqCalls = [];
    },
  };
});

vi.mock("@/integrations/supabase/client", () => ({
  supabase: { from: mockFrom, storage: { from: () => ({ remove: mockStorageRemove }) } },
}));

import { legacyDeletePapersWithBestEffortCleanup } from "../deletePapersCompat";

const USER = "user-1";
const PATHS = [`${USER}/paper-1/a.pdf`, `${USER}/paper-2/b.pdf`];

beforeEach(() => {
  vi.clearAllMocks();
  resetSupabase();
  mockStorageRemove.mockResolvedValue({ data: null, error: null });
});

describe("legacyDeletePapersWithBestEffortCleanup", () => {
  it("reads the attachment paths BEFORE deleting, then removes them", async () => {
    state.attachmentsResult = { data: PATHS.map((file_path) => ({ file_path })), error: null };

    const result = await legacyDeletePapersWithBestEffortCleanup(USER, ["paper-1", "paper-2"]);

    // Order is load-bearing: the metadata rows cascade away with the papers, so
    // a read afterwards would return nothing and the binaries would be lost.
    expect(state.selectInCalls).toEqual([["paper_id", ["paper-1", "paper-2"]]]);
    expect(mockStorageRemove).toHaveBeenCalledWith(PATHS);
    expect(result).toEqual({ ok: true, message: "", cleanupFailed: false });
  });

  it("scopes the delete by both row ids and user_id", async () => {
    await legacyDeletePapersWithBestEffortCleanup(USER, ["paper-1"]);

    expect(state.deleteInCalls).toEqual([["id", ["paper-1"]]]);
    expect(state.deleteEqCalls).toEqual([["user_id", USER]]);
  });

  it("makes no Storage call when the papers have no attachments", async () => {
    const result = await legacyDeletePapersWithBestEffortCleanup(USER, ["paper-1"]);

    expect(mockStorageRemove).not.toHaveBeenCalled();
    expect(result.cleanupFailed).toBe(false);
  });

  it("reports a RETURNED Storage error as a cleanup failure", async () => {
    state.attachmentsResult = { data: [{ file_path: PATHS[0] }], error: null };
    mockStorageRemove.mockResolvedValue({ data: null, error: { message: "storage unavailable" } });

    const result = await legacyDeletePapersWithBestEffortCleanup(USER, ["paper-1"]);

    // The papers ARE deleted — that part committed — but the files remain, and
    // this is the flag that stops the caller claiming otherwise.
    expect(result).toEqual({ ok: true, message: "", cleanupFailed: true });
  });

  it("reports a THROWN Storage error as a cleanup failure too", async () => {
    state.attachmentsResult = { data: [{ file_path: PATHS[0] }], error: null };
    mockStorageRemove.mockRejectedValue(new TypeError("Failed to fetch"));

    const result = await legacyDeletePapersWithBestEffortCleanup(USER, ["paper-1"]);

    expect(result.cleanupFailed).toBe(true);
  });

  it("fails without deleting when the attachment read fails", async () => {
    // Deleting now would destroy the only record of paths we could not read.
    state.attachmentsResult = { data: null, error: { message: "permission denied" } };

    const result = await legacyDeletePapersWithBestEffortCleanup(USER, ["paper-1"]);

    expect(state.deleteInCalls).toEqual([]);
    expect(result).toEqual({ ok: false, message: "permission denied", cleanupFailed: false });
  });

  it("fails without touching Storage when the paper delete fails", async () => {
    state.attachmentsResult = { data: [{ file_path: PATHS[0] }], error: null };
    state.deleteResult = { error: { message: "permission denied" } };

    const result = await legacyDeletePapersWithBestEffortCleanup(USER, ["paper-1"]);

    // The papers still exist, so their attachments are still reachable and must
    // not be removed.
    expect(mockStorageRemove).not.toHaveBeenCalled();
    expect(result).toEqual({ ok: false, message: "permission denied", cleanupFailed: false });
  });
});
