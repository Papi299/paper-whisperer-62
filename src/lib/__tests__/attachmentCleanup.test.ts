import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * The cleanup drain — the half of ATTACHMENT-ORPHAN-CLEANUP-HARDENING-001 that
 * actually removes bytes.
 *
 * Its whole reason to exist is that it can fail safely. The database has already
 * committed the logical deletion by the time this runs, so every branch below is
 * really asking the same question: after this pass, does the queue still describe
 * every object that still exists? A drain that acknowledged work it had not done
 * would recreate the exact orphan the feature was built to prevent — with the
 * added insult of having recorded the intent and then thrown it away.
 */

const {
  mockFrom,
  mockStorageRemove,
  queueState,
  resetSupabase,
} = vi.hoisted(() => {
  interface QueuePage {
    data: { id: string; file_path: string }[] | null;
    error: unknown;
  }
  const queueState = {
    /** Pages returned by successive `.range()` calls. */
    pages: [] as QueuePage[],
    /** How many pages have been served so far. */
    pageCursor: 0,
    /** Every `.range(from, to)` the drain issued. */
    rangeCalls: [] as [number, number][],
    /** Every `.eq(column, value)` on a SELECT chain. */
    selectEqCalls: [] as [string, unknown][],
    /** Every `.order(column, opts)` on a SELECT chain. */
    orderCalls: [] as [string, unknown][],
    /** The projection string. */
    selectColumns: [] as string[],
    /** Every acknowledgement: the `.eq` and `.in` predicates it carried. */
    ackCalls: [] as { eq: [string, unknown]; in: [string, string[]] }[],
    /** Result of each acknowledgement, in order; the last one repeats. */
    ackResults: [{ error: null as unknown }],
    /** Tables `from()` was called with. */
    tables: [] as string[],
  };

  const mockStorageRemove = vi.fn(
    async (_paths: string[]): Promise<{ data: unknown; error: unknown }> => ({ data: null, error: null }),
  );

  const mockFrom = vi.fn((table: string) => {
    queueState.tables.push(table);
    // The drain calls `from()` once per page, so the page cursor lives on the
    // shared state rather than on the builder — a per-builder cursor would serve
    // page 0 forever and silently turn a two-page walk into an infinite one.
    const chain = {
      select: (columns: string) => {
        queueState.selectColumns.push(columns);
        return chain;
      },
      eq: (column: string, value: unknown) => {
        queueState.selectEqCalls.push([column, value]);
        pendingAck.eq = [column, value];
        return chain;
      },
      order: (column: string, opts: unknown) => {
        queueState.orderCalls.push([column, opts]);
        return chain;
      },
      range: async (from: number, to: number) => {
        queueState.rangeCalls.push([from, to]);
        const page = queueState.pages[queueState.pageCursor] ?? { data: [], error: null };
        queueState.pageCursor += 1;
        return page;
      },
      delete: () => chain,
      in: async (column: string, values: string[]) => {
        queueState.ackCalls.push({ eq: pendingAck.eq, in: [column, values] });
        const result =
          queueState.ackResults[Math.min(queueState.ackCalls.length - 1, queueState.ackResults.length - 1)];
        return result;
      },
    };
    const pendingAck: { eq: [string, unknown] } = { eq: ["", undefined] };
    return chain;
  });

  return {
    mockFrom,
    mockStorageRemove,
    queueState,
    resetSupabase: () => {
      queueState.pages = [];
      queueState.pageCursor = 0;
      queueState.rangeCalls = [];
      queueState.selectEqCalls = [];
      queueState.orderCalls = [];
      queueState.selectColumns = [];
      queueState.ackCalls = [];
      queueState.ackResults = [{ error: null }];
      queueState.tables = [];
    },
  };
});

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    from: mockFrom,
    storage: { from: () => ({ remove: mockStorageRemove }) },
  },
}));

import {
  ATTACHMENTS_BUCKET,
  CLEANUP_QUEUE_PAGE_SIZE,
  CLEANUP_QUEUE_TABLE,
  CLEANUP_REMOVE_BATCH_SIZE,
  drainAttachmentCleanupQueue,
  isSafeCleanupPath,
} from "../attachmentCleanup";
import { resetAttachmentCleanupAvailabilityForTests } from "../attachmentCleanupAvailability";

const USER = "11111111-1111-1111-1111-111111111111";
const OTHER = "22222222-2222-2222-2222-222222222222";
const PAPER = "33333333-3333-3333-3333-333333333333";

const ownedPath = (name: string) => `${USER}/${PAPER}/${name}`;

function job(id: string, filePath: string) {
  return { id, file_path: filePath };
}

let warnSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.clearAllMocks();
  resetSupabase();
  resetAttachmentCleanupAvailabilityForTests();
  mockStorageRemove.mockResolvedValue({ data: null, error: null });
  warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  warnSpy.mockRestore();
});

// ══════════════════════════════════════════════════════════════════════════
// Path safety — the gate everything else depends on
// ══════════════════════════════════════════════════════════════════════════

describe("isSafeCleanupPath", () => {
  // Mirrors public.attachment_cleanup_path_is_safe. Any divergence means the
  // browser would hand Storage a path the database refused to record, or refuse
  // one the database considers canonical.
  it.each([
    ["the canonical product path", ownedPath("1737000000-abc.pdf"), true],
    ["a name with spaces and unicode", ownedPath("holiday photo é.png"), true],
    ["another user's namespace", `${OTHER}/${PAPER}/f.png`, false],
    ["parent traversal", `${USER}/../f.png`, false],
    ["a current-directory segment", `${USER}/./f.png`, false],
    ["an absolute path", `/${USER}/${PAPER}/f.png`, false],
    ["a collapsed empty segment", `${USER}//f.png`, false],
    ["a trailing separator", `${USER}/${PAPER}/`, false],
    ["a backslash separator trick", `${USER}/${PAPER}\\..\\f.png`, false],
    ["a newline in the key", `${USER}/${PAPER}/f\n.png`, false],
    ["a NUL byte in the key", `${USER}/${PAPER}/f\u0000.png`, false],
    ["too few segments", `${USER}/f.png`, false],
    ["too many segments", `${USER}/${PAPER}/nested/f.png`, false],
    ["the empty string", "", false],
    ["a prefix that merely starts with the user id", `${USER}x/${PAPER}/f.png`, false],
  ])("%s", (_label, path, expected) => {
    expect(isSafeCleanupPath(USER, path)).toBe(expected);
  });

  it("refuses an over-long key", () => {
    expect(isSafeCleanupPath(USER, `${USER}/${PAPER}/${"a".repeat(1024)}`)).toBe(false);
  });

  it("refuses a non-string path and a missing user id", () => {
    expect(isSafeCleanupPath(USER, undefined)).toBe(false);
    expect(isSafeCleanupPath(USER, 42)).toBe(false);
    expect(isSafeCleanupPath("", ownedPath("f.png"))).toBe(false);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// Reading the queue
// ══════════════════════════════════════════════════════════════════════════

describe("drainAttachmentCleanupQueue — reading the queue", () => {
  it("reads only the caller's own rows, oldest first, deterministically ordered", async () => {
    queueState.pages = [{ data: [job("j1", ownedPath("a.pdf"))], error: null }];

    await drainAttachmentCleanupQueue(USER);

    expect(queueState.tables).toContain(CLEANUP_QUEUE_TABLE);
    expect(queueState.selectColumns[0]).toBe("id, file_path");
    // Defense-in-depth on top of the SELECT-own policy.
    expect(queueState.selectEqCalls[0]).toEqual(["user_id", USER]);
    // `created_at` then `id`: a shared timestamp with no tie-break can repeat or
    // skip rows across a page boundary.
    expect(queueState.orderCalls).toEqual([
      ["created_at", { ascending: true }],
      ["id", { ascending: true }],
    ]);
  });

  it("paginates rather than assuming one response is the whole queue", async () => {
    const full = Array.from({ length: CLEANUP_QUEUE_PAGE_SIZE }, (_, i) =>
      job(`j${i}`, ownedPath(`f${i}.pdf`)),
    );
    queueState.pages = [
      { data: full, error: null },
      { data: [job("last", ownedPath("last.pdf"))], error: null },
    ];

    const result = await drainAttachmentCleanupQueue(USER);

    // A full page means "there may be more"; a short page ends the walk.
    expect(queueState.rangeCalls).toEqual([
      [0, CLEANUP_QUEUE_PAGE_SIZE - 1],
      [CLEANUP_QUEUE_PAGE_SIZE, CLEANUP_QUEUE_PAGE_SIZE * 2 - 1],
    ]);
    expect(result).toEqual({ status: "completed", removed: CLEANUP_QUEUE_PAGE_SIZE + 1, pending: 0 });
  });

  it("does nothing at all when the queue is empty", async () => {
    queueState.pages = [{ data: [], error: null }];

    const result = await drainAttachmentCleanupQueue(USER);

    expect(mockStorageRemove).not.toHaveBeenCalled();
    expect(queueState.ackCalls).toEqual([]);
    expect(result).toEqual({ status: "completed", removed: 0, pending: 0 });
  });

  it("does nothing when there is no signed-in user", async () => {
    const result = await drainAttachmentCleanupQueue(undefined);

    expect(mockFrom).not.toHaveBeenCalled();
    expect(mockStorageRemove).not.toHaveBeenCalled();
    expect(result).toEqual({ status: "completed", removed: 0, pending: 0 });
  });

  it("reports the feature unavailable — and touches no Storage — on a pre-migration database", async () => {
    queueState.pages = [
      {
        data: null,
        error: {
          code: "PGRST205",
          message: "Could not find the table 'public.attachment_cleanup_queue' in the schema cache",
        },
      },
    ];

    const result = await drainAttachmentCleanupQueue(USER);

    expect(result).toEqual({ status: "unavailable", removed: 0, pending: null });
    expect(mockStorageRemove).not.toHaveBeenCalled();
    // No retry loop, no second read: one refusal ends the pass.
    expect(queueState.rangeCalls).toHaveLength(1);
  });

  it("does NOT classify an unrelated read failure as a pre-migration database", async () => {
    queueState.pages = [
      { data: null, error: { code: "42501", message: "permission denied for table attachment_cleanup_queue" } },
    ];

    const result = await drainAttachmentCleanupQueue(USER);

    // `pending: null` is the honest answer: the queue could not be read, so the
    // number of remaining jobs is unknown — not zero.
    expect(result).toEqual({ status: "pending", removed: 0, pending: null });
    expect(mockStorageRemove).not.toHaveBeenCalled();
  });

  it("treats a thrown read failure the same as a returned one", async () => {
    mockFrom.mockImplementationOnce(() => {
      throw new TypeError("Failed to fetch");
    });

    const result = await drainAttachmentCleanupQueue(USER);

    expect(result.status).toBe("pending");
    expect(mockStorageRemove).not.toHaveBeenCalled();
  });
});

// ══════════════════════════════════════════════════════════════════════════
// Removing and acknowledging
// ══════════════════════════════════════════════════════════════════════════

describe("drainAttachmentCleanupQueue — removing and acknowledging", () => {
  it("removes one object and acknowledges exactly its row", async () => {
    queueState.pages = [{ data: [job("j1", ownedPath("a.pdf"))], error: null }];

    const result = await drainAttachmentCleanupQueue(USER);

    expect(mockStorageRemove).toHaveBeenCalledTimes(1);
    expect(mockStorageRemove).toHaveBeenCalledWith([ownedPath("a.pdf")]);
    expect(queueState.ackCalls).toEqual([
      { eq: ["user_id", USER], in: ["id", ["j1"]] },
    ]);
    expect(result).toEqual({ status: "completed", removed: 1, pending: 0 });
  });

  it("batches large queues at the bounded size", async () => {
    const jobs = Array.from({ length: CLEANUP_REMOVE_BATCH_SIZE + 5 }, (_, i) =>
      job(`j${i}`, ownedPath(`f${i}.pdf`)),
    );
    queueState.pages = [{ data: jobs, error: null }];

    const result = await drainAttachmentCleanupQueue(USER);

    expect(mockStorageRemove).toHaveBeenCalledTimes(2);
    expect(mockStorageRemove.mock.calls[0][0]).toHaveLength(CLEANUP_REMOVE_BATCH_SIZE);
    expect(mockStorageRemove.mock.calls[1][0]).toHaveLength(5);
    // Acknowledgement follows the same batching, so a mid-drain failure costs at
    // most one batch of progress.
    expect(queueState.ackCalls).toHaveLength(2);
    expect(result).toEqual({ status: "completed", removed: CLEANUP_REMOVE_BATCH_SIZE + 5, pending: 0 });
  });

  it("uses the private attachments bucket", async () => {
    expect(ATTACHMENTS_BUCKET).toBe("attachments");
  });

  it("keeps the queue rows when Storage RETURNS an error", async () => {
    // The shape that matters most: Supabase Storage reports most failures this
    // way, so a drain that only caught exceptions would acknowledge them all.
    queueState.pages = [{ data: [job("j1", ownedPath("a.pdf"))], error: null }];
    mockStorageRemove.mockResolvedValue({ data: null, error: { message: "storage unavailable" } });

    const result = await drainAttachmentCleanupQueue(USER);

    expect(queueState.ackCalls).toEqual([]);
    expect(result).toEqual({ status: "pending", removed: 0, pending: 1 });
  });

  it("keeps the queue rows when Storage throws", async () => {
    queueState.pages = [{ data: [job("j1", ownedPath("a.pdf"))], error: null }];
    mockStorageRemove.mockRejectedValue(new TypeError("Failed to fetch"));

    const result = await drainAttachmentCleanupQueue(USER);

    expect(queueState.ackCalls).toEqual([]);
    expect(result).toEqual({ status: "pending", removed: 0, pending: 1 });
  });

  it("stops after the first failing batch instead of hammering a refusing Storage", async () => {
    const jobs = Array.from({ length: CLEANUP_REMOVE_BATCH_SIZE * 3 }, (_, i) =>
      job(`j${i}`, ownedPath(`f${i}.pdf`)),
    );
    queueState.pages = [{ data: jobs, error: null }];
    mockStorageRemove
      .mockResolvedValueOnce({ data: null, error: null })
      .mockResolvedValue({ data: null, error: { message: "storage unavailable" } });

    const result = await drainAttachmentCleanupQueue(USER);

    // One success, one failure, and then it stops — the third batch is never
    // attempted, and is simply still queued.
    expect(mockStorageRemove).toHaveBeenCalledTimes(2);
    expect(result).toEqual({
      status: "pending",
      removed: CLEANUP_REMOVE_BATCH_SIZE,
      pending: CLEANUP_REMOVE_BATCH_SIZE * 2,
    });
  });

  it("does not convert a physical success into job success when acknowledgement fails", async () => {
    queueState.pages = [{ data: [job("j1", ownedPath("a.pdf"))], error: null }];
    queueState.ackResults = [{ error: { message: "conflict" } }];

    const result = await drainAttachmentCleanupQueue(USER);

    // The binary is gone but the row is not, which is the safe direction: the
    // next pass removes an already-absent object (a Storage no-op) and retries
    // the acknowledgement. Reporting `removed: 1` here would claim finished work
    // the queue does not agree with.
    expect(mockStorageRemove).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ status: "pending", removed: 0, pending: 1 });
  });

  it("is safe to run again over an already-absent object", async () => {
    // Supabase Storage treats removing a missing key as a no-op, so a retried
    // job simply succeeds and is acknowledged. Nothing here special-cases it —
    // which is the point: idempotence is a property of the operation, not a
    // branch in the drain.
    queueState.pages = [{ data: [job("j1", ownedPath("gone.pdf"))], error: null }];
    mockStorageRemove.mockResolvedValue({ data: [], error: null });

    const result = await drainAttachmentCleanupQueue(USER);

    expect(result).toEqual({ status: "completed", removed: 1, pending: 0 });
    expect(queueState.ackCalls).toEqual([{ eq: ["user_id", USER], in: ["id", ["j1"]] }]);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// Refusing unsafe work
// ══════════════════════════════════════════════════════════════════════════

describe("drainAttachmentCleanupQueue — unsafe paths", () => {
  it("never hands Storage a path outside the signed-in user's prefix", async () => {
    queueState.pages = [{ data: [job("j1", `${OTHER}/${PAPER}/theirs.pdf`)], error: null }];

    const result = await drainAttachmentCleanupQueue(USER);

    expect(mockStorageRemove).not.toHaveBeenCalled();
    // The row is NOT acknowledged either: refusing to act on it is safe, but
    // deleting the row would discard the evidence that it existed.
    expect(queueState.ackCalls).toEqual([]);
    expect(result).toEqual({ status: "pending", removed: 0, pending: 1 });
  });

  it("fails closed on a malformed path while still finishing the safe ones", async () => {
    queueState.pages = [
      {
        data: [
          job("bad", `${USER}/../escape.pdf`),
          job("good", ownedPath("fine.pdf")),
        ],
        error: null,
      },
    ];

    const result = await drainAttachmentCleanupQueue(USER);

    expect(mockStorageRemove).toHaveBeenCalledWith([ownedPath("fine.pdf")]);
    expect(queueState.ackCalls).toEqual([{ eq: ["user_id", USER], in: ["id", ["good"]] }]);
    expect(result).toEqual({ status: "pending", removed: 1, pending: 1 });
  });
});

// ══════════════════════════════════════════════════════════════════════════
// Logging
// ══════════════════════════════════════════════════════════════════════════

describe("drainAttachmentCleanupQueue — logging", () => {
  it("logs no path, file name, paper id or user id", async () => {
    queueState.pages = [{ data: [job("j1", ownedPath("private-thesis.pdf"))], error: null }];
    mockStorageRemove.mockResolvedValue({ data: null, error: { message: "storage unavailable" } });

    await drainAttachmentCleanupQueue(USER);

    const logged = warnSpy.mock.calls.flat().join(" ");
    expect(logged).not.toContain(USER);
    expect(logged).not.toContain(PAPER);
    expect(logged).not.toContain("private-thesis.pdf");
    // A bounded, stable line with a count is all a failure is allowed to say.
    expect(logged).toContain("attachment-cleanup");
  });

  it("says nothing at all on a clean pass", async () => {
    queueState.pages = [{ data: [job("j1", ownedPath("a.pdf"))], error: null }];

    await drainAttachmentCleanupQueue(USER);

    expect(warnSpy).not.toHaveBeenCalled();
  });
});
