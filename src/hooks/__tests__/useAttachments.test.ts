import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";

/**
 * ATTACHMENT-ORPHAN-CLEANUP-HARDENING-001 — the attachment hook's two
 * cross-system paths.
 *
 * Both used to lose information on failure, in mirror-image ways:
 *
 *  * **Upload compensation** removed the just-written Storage object with a
 *    fire-and-forget `remove()`. Its failure was invisible, and — worse — it
 *    acted on the browser's belief that the metadata insert had failed, which a
 *    lost response can make wrong.
 *  * **Deletion** removed the Storage object first and the metadata row second,
 *    so a failed metadata delete left a row and a quota charge pointing at a
 *    file that was already gone.
 *
 * The assertions below are about the two things that replaced them: cleanup
 * intent that survives, and a UI that says what actually happened.
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
    /** Result of the metadata INSERT. */
    insertResult: { data: null as unknown, error: null as unknown },
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
      insert: () => ({
        select: () => ({ single: async () => state.insertResult }),
      }),
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
      range: async () => {
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
// Upload compensation
// ══════════════════════════════════════════════════════════════════════════

describe("uploadAttachments — compensation when the metadata insert fails", () => {
  beforeEach(() => {
    state.insertResult = { data: null, error: { message: "quota exceeded" } };
  });

  it("records durable cleanup intent through the RPC and drains it immediately", async () => {
    mockRpc.mockResolvedValue({ data: "queued", error: null });
    const { result } = await renderAttachments();

    await act(async () => {
      await result.current.uploadAttachments([makeFile()]);
    });

    const [fn, args] = mockRpc.mock.calls[0] as [string, { p_paper_id: string; p_file_path: string }];
    expect(fn).toBe("queue_untracked_attachment_cleanup");
    expect(args.p_paper_id).toBe(PAPER);
    // The path handed to the RPC is the one just uploaded, inside this user's
    // and this paper's namespace — which is exactly what the RPC re-validates.
    expect(args.p_file_path.startsWith(`${USER}/${PAPER}/`)).toBe(true);
    expect(args.p_file_path).toBe(
      (mockStorageUpload.mock.calls[0] as unknown[])[0] as string,
    );
    // Queued, so the drain runs now rather than waiting for the next session.
    expect(mockStorageRemove).toHaveBeenCalledTimes(0);
    expect(mockFrom).toHaveBeenCalledWith("attachment_cleanup_queue");
  });

  it("reports pending cleanup truthfully when the immediate drain cannot finish", async () => {
    mockRpc.mockResolvedValue({ data: "queued", error: null });
    state.cleanupPages = [
      { data: [{ id: "job-1", file_path: `${USER}/${PAPER}/orphan.pdf` }], error: null },
    ];
    mockStorageRemove.mockResolvedValue({ data: null, error: { message: "storage unavailable" } });
    const { result } = await renderAttachments();

    await act(async () => {
      await result.current.uploadAttachments([makeFile()]);
    });

    const failure = toastWith('Failed to save');
    expect(failure?.variant).toBe("destructive");
    expect(failure?.description).toMatch(/cleanup will retry automatically/i);
  });

  it("does NOT delete the object when the RPC proves the metadata row exists", async () => {
    // The ambiguous case: the browser saw an error, the insert committed anyway.
    // Deleting here would destroy a valid, quota-charged attachment.
    mockRpc.mockResolvedValue({ data: "metadata_present", error: null });
    const { result } = await renderAttachments();

    await act(async () => {
      await result.current.uploadAttachments([makeFile()]);
    });

    expect(mockStorageRemove).not.toHaveBeenCalled();
    // The list is reconciled against the server rather than patched from a
    // belief the server has just contradicted.
    expect(state.listCalls).toBeGreaterThan(1);
    const saved = toastWith("\"scan.pdf\" was saved");
    expect(saved).toBeDefined();
    expect(saved?.variant).toBeUndefined();
  });

  it("falls back to an immediate Storage removal when the RPC does not exist yet", async () => {
    mockRpc.mockResolvedValue({ data: null, error: missingRpcError("queue_untracked_attachment_cleanup(p_paper_id, p_file_path)") });
    const { result } = await renderAttachments();

    await act(async () => {
      await result.current.uploadAttachments([makeFile()]);
    });

    expect(mockStorageRemove).toHaveBeenCalledTimes(1);
    // Cleanup succeeded, so the user is told about the save failure and nothing
    // more — which is the whole truth on this path.
    const failure = toastWith('Failed to save');
    expect(failure?.description).toBe("quota exceeded");
  });

  it("observes a RETURNED Storage error on the fallback path", async () => {
    mockRpc.mockResolvedValue({ data: null, error: missingRpcError("queue_untracked_attachment_cleanup(p_paper_id, p_file_path)") });
    mockStorageRemove.mockResolvedValue({ data: null, error: { message: "storage unavailable" } });
    const { result } = await renderAttachments();

    await act(async () => {
      await result.current.uploadAttachments([makeFile()]);
    });

    const failure = toastWith('Failed to save');
    expect(failure?.description).toMatch(/could not be removed and may still be stored/i);
  });

  it("does not silently swallow a double failure", async () => {
    // Neither the database nor Storage will accept anything. Nothing can persist
    // the intent, and the message must not imply otherwise.
    mockRpc.mockResolvedValue({ data: null, error: { code: "42501", message: "permission denied" } });
    mockStorageRemove.mockResolvedValue({ data: null, error: { message: "storage unavailable" } });
    const { result } = await renderAttachments();

    await act(async () => {
      await result.current.uploadAttachments([makeFile()]);
    });

    const failure = toastWith('Failed to save');
    expect(failure?.variant).toBe("destructive");
    expect(failure?.description).toMatch(/cleanup could not be recorded/i);
  });

  it("still attempts immediate removal when the RPC fails for an unrelated reason", async () => {
    mockRpc.mockResolvedValue({ data: null, error: { code: "42501", message: "permission denied" } });
    const { result } = await renderAttachments();

    await act(async () => {
      await result.current.uploadAttachments([makeFile()]);
    });

    // The durable path is the preference, not the only option: a last immediate
    // compensation still beats leaving the object with nothing recorded.
    expect(mockStorageRemove).toHaveBeenCalledTimes(1);
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
