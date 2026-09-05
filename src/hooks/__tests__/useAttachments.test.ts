import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";

/**
 * ATTACHMENT-ORPHAN-CLEANUP-HARDENING-001 (+ CORRECTION-01) — the attachment
 * hook's two cross-system paths.
 *
 * Both used to lose information on failure, in mirror-image ways:
 *
 *  * **Upload** inserted metadata from the browser and, if that LOOKED like it
 *    failed, removed the just-written Storage object. The removal's own failure
 *    was invisible, and the decision rested on this tab's belief — which a lost
 *    response makes wrong, so a valid attachment's binary could be destroyed.
 *  * **Deletion** removed the Storage object first and the metadata row second,
 *    so a failed metadata delete left a row and a quota charge pointing at a
 *    file that was already gone.
 *
 * Upload is now one server-authoritative call. The assertions below are mostly
 * about what the browser must NOT do: it does not insert metadata, does not
 * decide that an object is garbage, and never deletes on a guess when the
 * database did not answer.
 */

const {
  mockFrom,
  mockRpc,
  mockStorageUpload,
  mockStorageRemove,
  mockCreateSignedUrl,
  mockCreateSignedUrls,
  state,
  resetSupabase,
} = vi.hoisted(() => {
  const state = {
    /** Rows `fetchAttachments` returns, per call. The last entry repeats. */
    listPages: [[]] as unknown[][],
    listCalls: 0,
    /** Result of the metadata INSERT, and how many times it was attempted. */
    insertResult: { data: null as unknown, error: null as unknown },
    insertCalls: 0,
    /** Result of the legacy metadata DELETE. */
    deleteResult: { error: null as unknown },
    /** Predicates the legacy metadata DELETE carried. */
    deleteEqCalls: [] as [string, unknown][],
    /** Pages the cleanup drain reads. */
    cleanupPages: [{ data: [] as unknown[], error: null as unknown }],
    cleanupCursor: 0,
  };

  const mockStorageUpload = vi.fn(async () => ({ data: { path: "p" }, error: null as unknown }));
  const mockStorageRemove = vi.fn(async (_paths: string[]) => ({ data: null, error: null as unknown }));
  const mockCreateSignedUrl = vi.fn(async () => ({ data: { signedUrl: "https://signed/one" }, error: null }));
  const mockCreateSignedUrls = vi.fn(async (paths: string[]) => ({
    data: paths.map(() => ({ signedUrl: "https://signed/many" })),
    error: null,
  }));
  const mockRpc = vi.fn();

  const attachmentsChain = () => {
    const chain = {
      select: () => chain,
      eq: (column: string, value: unknown) => {
        state.deleteEqCalls.push([column, value]);
        return chain;
      },
      order: async () => {
        const page = state.listPages[Math.min(state.listCalls, state.listPages.length - 1)];
        state.listCalls += 1;
        return { data: page, error: null };
      },
      insert: () => {
        state.insertCalls += 1;
        return { select: () => ({ single: async () => state.insertResult }) };
      },
      delete: () => deleteChain(),
    };
    return chain;
  };

  const deleteChain = () => {
    const chain = {
      eq: (column: string, value: unknown) => {
        state.deleteEqCalls.push([column, value]);
        return chain;
      },
      then: (onF: (v: unknown) => unknown, onR?: (r: unknown) => unknown) =>
        Promise.resolve(state.deleteResult).then(onF, onR),
    };
    return chain;
  };

  const cleanupChain = () => {
    const chain = {
      select: () => chain,
      eq: () => chain,
      order: () => chain,
      limit: async () => {
        const page = state.cleanupPages[Math.min(state.cleanupCursor, state.cleanupPages.length - 1)];
        state.cleanupCursor += 1;
        return page;
      },
      delete: () => chain,
      in: async () => ({ error: null }),
    };
    return chain;
  };

  const mockFrom = vi.fn((table: string) => {
    if (table === "attachment_cleanup_queue") return cleanupChain();
    return attachmentsChain();
  });

  return {
    mockFrom,
    mockRpc,
    mockStorageUpload,
    mockStorageRemove,
    mockCreateSignedUrl,
    mockCreateSignedUrls,
    state,
    resetSupabase: () => {
      state.listPages = [[]];
      state.listCalls = 0;
      state.insertResult = { data: null, error: null };
      state.insertCalls = 0;
      state.deleteResult = { error: null };
      state.deleteEqCalls = [];
      state.cleanupPages = [{ data: [], error: null }];
      state.cleanupCursor = 0;
    },
  };
});

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    from: mockFrom,
    rpc: mockRpc,
    storage: {
      from: () => ({
        upload: mockStorageUpload,
        remove: mockStorageRemove,
        createSignedUrl: mockCreateSignedUrl,
        createSignedUrls: mockCreateSignedUrls,
      }),
    },
  },
}));

const mockToast = vi.fn();
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: mockToast }) }));

import { useAttachments, type Attachment } from "../useAttachments";
import { resetAttachmentCleanupAvailabilityForTests } from "@/lib/attachmentCleanupAvailability";

const USER = "11111111-1111-1111-1111-111111111111";
const PAPER = "33333333-3333-3333-3333-333333333333";

/** PostgREST's answer on a database that predates the cleanup migration. */
const missingRpcError = (fn: string) => ({
  code: "PGRST202",
  message: `Could not find the function public.${fn} in the schema cache`,
});

function makeFile(name = "scan.pdf") {
  return new File([new Uint8Array([1, 2, 3])], name, { type: "application/pdf" });
}

function attachment(overrides: Partial<Attachment> = {}): Attachment {
  return {
    id: "att-1",
    paper_id: PAPER,
    user_id: USER,
    file_path: `${USER}/${PAPER}/one.pdf`,
    file_name: "one.pdf",
    file_type: "application/pdf",
    size_bytes: 10,
    created_at: "2026-09-04T00:00:00Z",
    publicUrl: "https://signed/one",
    ...overrides,
  };
}

async function renderAttachments() {
  const rendered = renderHook(() => useAttachments(PAPER, USER));
  await waitFor(() => expect(rendered.result.current.loading).toBe(false));
  return rendered;
}

/** The toast whose title starts with `prefix`, or undefined. */
function toastWith(prefix: string) {
  const call = mockToast.mock.calls.find(
    (c) => typeof (c[0] as { title?: string })?.title === "string"
      && (c[0] as { title: string }).title.startsWith(prefix),
  );
  return call?.[0] as { title: string; description?: string; variant?: string } | undefined;
}

beforeEach(() => {
  vi.clearAllMocks();
  resetSupabase();
  resetAttachmentCleanupAvailabilityForTests();
  mockRpc.mockResolvedValue({ data: null, error: null });
  mockStorageUpload.mockResolvedValue({ data: { path: "p" }, error: null });
  mockStorageRemove.mockResolvedValue({ data: null, error: null });
});

// ══════════════════════════════════════════════════════════════════════════
// Upload finalization
// ══════════════════════════════════════════════════════════════════════════

/** One row as `finalize_attachment_upload` returns it. */
function finalizeRow(status: string, path: string) {
  return {
    status,
    attachment_id: "att-new",
    attachment_paper_id: PAPER,
    attachment_user_id: USER,
    attachment_file_path: path,
    attachment_file_name: "scan.pdf",
    attachment_file_type: "application/pdf",
    attachment_size_bytes: 3,
    attachment_created_at: "2026-09-04T00:00:00Z",
  };
}

/** The cleanup answer carries a status and nothing else. */
const CLEANUP_QUEUED_ROW = {
  status: "cleanup_queued",
  attachment_id: null,
  attachment_paper_id: null,
  attachment_user_id: null,
  attachment_file_path: null,
  attachment_file_name: null,
  attachment_file_type: null,
  attachment_size_bytes: null,
  attachment_created_at: null,
};

/** The path the hook generated for the object it just uploaded. */
function uploadedPath() {
  return (mockStorageUpload.mock.calls[0] as unknown[])[0] as string;
}

describe("uploadAttachments — server-authoritative finalization", () => {
  it("uploads the binary, then finalizes it through the RPC — never inserting metadata itself", async () => {
    mockRpc.mockImplementation(async (_fn: string, args: { p_file_path: string }) => ({
      data: [finalizeRow("metadata_committed", args.p_file_path)],
      error: null,
    }));
    const { result } = await renderAttachments();

    await act(async () => {
      await result.current.uploadAttachments([makeFile()]);
    });

    const [fn, args] = mockRpc.mock.calls[0] as [string, Record<string, unknown>];
    expect(fn).toBe("finalize_attachment_upload");
    expect(args.p_paper_id).toBe(PAPER);
    expect(args.p_file_path).toBe(uploadedPath());
    // The path handed to the RPC is inside this user's and this paper's
    // namespace — exactly what the RPC re-validates before it writes anything.
    expect((args.p_file_path as string).startsWith(`${USER}/${PAPER}/`)).toBe(true);
    expect(args.p_file_name).toBe("scan.pdf");
    expect(args.p_file_type).toBe("application/pdf");
    expect(args.p_size_bytes).toBe(3);

    // The browser writes no metadata of its own on this schema, so it can never
    // hold a belief about the insert that the server has to be asked about.
    expect(state.insertCalls).toBe(0);
    expect(mockStorageRemove).not.toHaveBeenCalled();
    expect(result.current.attachments).toHaveLength(1);
    expect(result.current.attachments[0].publicUrl).toBe("https://signed/one");
    expect(toastWith("Attachment uploaded")).toBeDefined();
  });

  it("reconciles an ambiguous RETURNED error by repeating the idempotent call", async () => {
    // The first call's response is lost. Its transaction may well have
    // committed, so the only safe move is to ask again — never to delete.
    mockRpc
      .mockResolvedValueOnce({ data: null, error: { message: "network error" } })
      .mockImplementation(async (_fn: string, args: { p_file_path: string }) => ({
        data: [finalizeRow("metadata_present", args.p_file_path)],
        error: null,
      }));
    const { result } = await renderAttachments();

    await act(async () => {
      await result.current.uploadAttachments([makeFile()]);
    });

    expect(mockRpc).toHaveBeenCalledTimes(2);
    // The retry is the SAME finalization, not a new one — that is what makes it
    // safe to repeat.
    expect(mockRpc.mock.calls[1][1]).toEqual(mockRpc.mock.calls[0][1]);
    expect(mockStorageRemove).not.toHaveBeenCalled();
    expect(result.current.attachments).toHaveLength(1);
    expect(toastWith("Attachment uploaded")).toBeDefined();
  });

  it("reconciles a THROWN transport failure the same way, and deletes nothing", async () => {
    mockRpc
      .mockRejectedValueOnce(new Error("connection reset"))
      .mockImplementation(async (_fn: string, args: { p_file_path: string }) => ({
        data: [finalizeRow("metadata_present", args.p_file_path)],
        error: null,
      }));
    const { result } = await renderAttachments();

    await act(async () => {
      await result.current.uploadAttachments([makeFile()]);
    });

    // The exact failure this correction exists for: the old code took a thrown
    // or returned error as proof the insert had failed and removed the object.
    expect(mockStorageRemove).not.toHaveBeenCalled();
    expect(result.current.attachments).toHaveLength(1);
  });

  it("treats a rejected metadata insert as durable cleanup state, not as a guess", async () => {
    mockRpc.mockResolvedValue({ data: [CLEANUP_QUEUED_ROW], error: null });
    state.cleanupPages = [
      { data: [{ id: "job-1", file_path: `${USER}/${PAPER}/orphan.pdf` }], error: null },
    ];
    const { result } = await renderAttachments();

    await act(async () => {
      await result.current.uploadAttachments([makeFile()]);
    });

    // The server committed the intent; the browser only executes it.
    expect(state.insertCalls).toBe(0);
    expect(mockFrom).toHaveBeenCalledWith("attachment_cleanup_queue");
    expect(result.current.attachments).toHaveLength(0);
  });

  it("drains the queued cleanup immediately, in the same user action", async () => {
    mockRpc.mockResolvedValue({ data: [CLEANUP_QUEUED_ROW], error: null });
    state.cleanupPages = [
      { data: [{ id: "job-1", file_path: `${USER}/${PAPER}/orphan.pdf` }], error: null },
    ];
    const { result } = await renderAttachments();

    await act(async () => {
      await result.current.uploadAttachments([makeFile()]);
    });

    expect(mockStorageRemove).toHaveBeenCalledWith([`${USER}/${PAPER}/orphan.pdf`]);
    const failure = toastWith("Failed to save");
    expect(failure?.variant).toBe("destructive");
    expect(failure?.description).toMatch(/has been removed/i);
  });

  it("reports pending cleanup truthfully when the immediate drain cannot finish", async () => {
    mockRpc.mockResolvedValue({ data: [CLEANUP_QUEUED_ROW], error: null });
    state.cleanupPages = [
      { data: [{ id: "job-1", file_path: `${USER}/${PAPER}/orphan.pdf` }], error: null },
    ];
    mockStorageRemove.mockResolvedValue({ data: null, error: { message: "storage unavailable" } });
    const { result } = await renderAttachments();

    await act(async () => {
      await result.current.uploadAttachments([makeFile()]);
    });

    const failure = toastWith("Failed to save");
    expect(failure?.variant).toBe("destructive");
    expect(failure?.description).toMatch(/cleanup will retry automatically/i);
  });

  it("claims nothing when the database never answers at all", async () => {
    mockRpc.mockRejectedValue(new Error("connection reset"));
    const { result } = await renderAttachments();

    await act(async () => {
      await result.current.uploadAttachments([makeFile()]);
    });

    // Bounded: exactly the permitted attempts, no timer, no backoff.
    expect(mockRpc).toHaveBeenCalledTimes(2);
    // Nothing is known, so the object stays and no cleanup is claimed. Account
    // deletion's independent Storage sweep remains the backstop.
    expect(mockStorageRemove).not.toHaveBeenCalled();
    expect(mockFrom).not.toHaveBeenCalledWith("attachment_cleanup_queue");
    const failure = toastWith("Failed to save");
    expect(failure?.variant).toBe("destructive");
    expect(failure?.description).toMatch(/could not be confirmed/i);
    expect(failure?.description).not.toMatch(/removed|cleanup/i);
  });

  it("falls back to the pre-migration insert when the RPC does not exist yet", async () => {
    mockRpc.mockResolvedValue({
      data: null,
      error: missingRpcError("finalize_attachment_upload(p_paper_id, p_file_path, p_file_name, p_file_type, p_size_bytes)"),
    });
    state.insertResult = {
      data: {
        id: "att-legacy",
        paper_id: PAPER,
        user_id: USER,
        file_path: `${USER}/${PAPER}/legacy.pdf`,
        file_name: "scan.pdf",
        file_type: "application/pdf",
        size_bytes: 3,
        created_at: "2026-09-04T00:00:00Z",
      },
      error: null,
    };
    const { result } = await renderAttachments();

    await act(async () => {
      await result.current.uploadAttachments([makeFile()]);
    });

    // One attempt only: a missing function answers the same way every time.
    expect(mockRpc).toHaveBeenCalledTimes(1);
    expect(state.insertCalls).toBe(1);
    expect(result.current.attachments).toHaveLength(1);
    expect(toastWith("Attachment uploaded")).toBeDefined();
  });

  it("observes a RETURNED Storage error on the pre-migration compensation", async () => {
    mockRpc.mockResolvedValue({
      data: null,
      error: missingRpcError("finalize_attachment_upload(p_paper_id, p_file_path, p_file_name, p_file_type, p_size_bytes)"),
    });
    state.insertResult = { data: null, error: { message: "quota exceeded" } };
    mockStorageRemove.mockResolvedValue({ data: null, error: { message: "storage unavailable" } });
    const { result } = await renderAttachments();

    await act(async () => {
      await result.current.uploadAttachments([makeFile()]);
    });

    expect(mockStorageRemove).toHaveBeenCalledTimes(1);
    const failure = toastWith("Failed to save");
    expect(failure?.description).toMatch(/could not be removed and may still be stored/i);
  });

  it("does not treat an unrelated RPC failure as old-schema compatibility", async () => {
    mockRpc.mockResolvedValue({ data: null, error: { code: "42501", message: "permission denied" } });
    const { result } = await renderAttachments();

    await act(async () => {
      await result.current.uploadAttachments([makeFile()]);
    });

    // A permission failure is a REAL fault. Dropping to the pre-migration path
    // would silently serve the lossier protocol; deleting the object would
    // destroy a file whose fate is unknown. Neither happens.
    expect(state.insertCalls).toBe(0);
    expect(mockStorageRemove).not.toHaveBeenCalled();
    expect(toastWith("Failed to save")?.description).toMatch(/could not be confirmed/i);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// Direct attachment deletion
// ══════════════════════════════════════════════════════════════════════════

describe("deleteAttachment", () => {
  beforeEach(() => {
    state.listPages = [[
      {
        id: "att-1",
        paper_id: PAPER,
        user_id: USER,
        file_path: `${USER}/${PAPER}/one.pdf`,
        file_name: "one.pdf",
        file_type: "application/pdf",
        size_bytes: 10,
        created_at: "2026-09-04T00:00:00Z",
      },
    ]];
  });

  it("deletes through the atomic RPC and then drains the queue", async () => {
    const { result } = await renderAttachments();
    await waitFor(() => expect(result.current.attachments).toHaveLength(1));

    await act(async () => {
      await result.current.deleteAttachment(attachment());
    });

    expect(mockRpc).toHaveBeenCalledWith("delete_attachment_with_cleanup", {
      p_attachment_id: "att-1",
    });
    // No client-side Storage call and no client-side metadata DELETE: the RPC
    // owns both halves, in one transaction.
    expect(state.deleteEqCalls).not.toContainEqual(["id", "att-1"]);
    expect(result.current.attachments).toHaveLength(0);
    expect(toastWith("Attachment deleted")?.description).toBeUndefined();
  });

  it("keeps the attachment out of the UI even when Storage cleanup fails", async () => {
    state.cleanupPages = [
      { data: [{ id: "job-1", file_path: `${USER}/${PAPER}/one.pdf` }], error: null },
    ];
    mockStorageRemove.mockResolvedValue({ data: null, error: { message: "storage unavailable" } });
    const { result } = await renderAttachments();
    await waitFor(() => expect(result.current.attachments).toHaveLength(1));

    await act(async () => {
      await result.current.deleteAttachment(attachment());
    });

    // The metadata row is genuinely gone. Restoring the card would show the user
    // an attachment their database no longer has.
    expect(result.current.attachments).toHaveLength(0);
    const toast = toastWith("Attachment deleted");
    expect(toast?.description).toMatch(/cleanup is pending and will retry automatically/i);
    expect(toast?.variant).toBeUndefined();
  });

  it("keeps the attachment visible when the RPC fails for an unrelated reason", async () => {
    mockRpc.mockResolvedValue({ data: null, error: { code: "P0001", message: "Attachment not found" } });
    const { result } = await renderAttachments();
    await waitFor(() => expect(result.current.attachments).toHaveLength(1));

    await act(async () => {
      await result.current.deleteAttachment(attachment());
    });

    // Nothing committed, so nothing may disappear.
    expect(result.current.attachments).toHaveLength(1);
    expect(mockStorageRemove).not.toHaveBeenCalled();
    expect(toastWith("Delete failed")?.variant).toBe("destructive");
  });

  it("takes the pre-migration path when the RPC does not exist", async () => {
    mockRpc.mockResolvedValue({ data: null, error: missingRpcError("delete_attachment_with_cleanup(p_attachment_id)") });
    const { result } = await renderAttachments();
    await waitFor(() => expect(result.current.attachments).toHaveLength(1));

    await act(async () => {
      await result.current.deleteAttachment(attachment());
    });

    // Storage first, then the metadata row, scoped by id AND user_id.
    expect(mockStorageRemove).toHaveBeenCalledWith([`${USER}/${PAPER}/one.pdf`]);
    expect(state.deleteEqCalls).toContainEqual(["id", "att-1"]);
    expect(state.deleteEqCalls).toContainEqual(["user_id", USER]);
    expect(result.current.attachments).toHaveLength(0);
    expect(toastWith("Attachment deleted")).toBeDefined();
  });

  it("observes a RETURNED Storage error on the pre-migration path and deletes nothing", async () => {
    mockRpc.mockResolvedValue({ data: null, error: missingRpcError("delete_attachment_with_cleanup(p_attachment_id)") });
    mockStorageRemove.mockResolvedValue({ data: null, error: { message: "storage unavailable" } });
    const { result } = await renderAttachments();
    await waitFor(() => expect(result.current.attachments).toHaveLength(1));

    await act(async () => {
      await result.current.deleteAttachment(attachment());
    });

    // On this path Storage-first is what PREVENTS an orphan, so a Storage
    // failure means the delete genuinely did not happen — and the metadata row
    // must survive to say so.
    expect(state.deleteEqCalls).not.toContainEqual(["id", "att-1"]);
    expect(result.current.attachments).toHaveLength(1);
    expect(toastWith("Delete failed")?.variant).toBe("destructive");
  });

  it("does nothing at all without a signed-in user", async () => {
    const { result } = renderHook(() => useAttachments(PAPER, undefined));

    await act(async () => {
      await result.current.deleteAttachment(attachment());
    });

    expect(mockRpc).not.toHaveBeenCalled();
    expect(mockStorageRemove).not.toHaveBeenCalled();
  });
});
