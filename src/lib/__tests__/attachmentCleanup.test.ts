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
  interface Row { id: string; file_path: string }
  const queueState = {
    /**
     * The queue itself, oldest first — a real list, not a script of canned
     * pages. Acknowledgement removes from it, which is what makes the drain
     * advance, and lets a test act as a second consumer mutating it mid-pass.
     */
    rows: [] as Row[],
    /** Errors to return instead of a read, in order; the last one repeats. */
    readErrors: [] as unknown[],
    /** How many head reads the drain issued. */
    reads: 0,
    /** The `.limit(n)` each read asked for. */
    limitCalls: [] as number[],
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
    /**
     * Runs after each head read, before the drain acts on it. A test uses this
     * to be the OTHER tab: another consumer of the same queue, acknowledging
     * rows this pass is about to look at or has not reached yet.
     */
    onRead: null as null | ((rows: Row[]) => void),
  };

  const mockStorageRemove = vi.fn(
    async (_paths: string[]): Promise<{ data: unknown; error: unknown }> => ({ data: null, error: null }),
  );

  const mockFrom = vi.fn((table: string) => {
    queueState.tables.push(table);
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
      // The head of the queue, exactly as PostgREST would answer it: the first
      // `n` rows in the current order, whatever the queue currently holds.
      limit: async (n: number) => {
        queueState.limitCalls.push(n);
        const error =
          queueState.readErrors[Math.min(queueState.reads, queueState.readErrors.length - 1)] ?? null;
        queueState.reads += 1;
        if (error) return { data: null, error };
        const page = queueState.rows.slice(0, n);
        queueState.onRead?.(queueState.rows);
        return { data: page, error: null };
      },
      delete: () => chain,
      in: async (column: string, values: string[]) => {
        queueState.ackCalls.push({ eq: pendingAck.eq, in: [column, values] });
        const result =
          queueState.ackResults[Math.min(queueState.ackCalls.length - 1, queueState.ackResults.length - 1)];
        // A real acknowledgement removes exactly the rows it names, and naming a
        // row another consumer already removed is a no-op — not an error.
        if (!result.error) {
          const ids = new Set(values);
          queueState.rows = queueState.rows.filter((row) => !ids.has(row.id));
        }
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
      queueState.rows = [];
      queueState.readErrors = [];
      queueState.reads = 0;
      queueState.limitCalls = [];
      queueState.selectEqCalls = [];
      queueState.orderCalls = [];
      queueState.selectColumns = [];
      queueState.ackCalls = [];
      queueState.ackResults = [{ error: null }];
      queueState.tables = [];
      queueState.onRead = null;
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
  CLEANUP_MAX_PAGES,
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
    queueState.rows = [job("j1", ownedPath("a.pdf"))];

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

  it("consumes the queue in windows rather than assuming one response is all of it", async () => {
    queueState.rows = Array.from({ length: CLEANUP_QUEUE_PAGE_SIZE + 1 }, (_, i) =>
      job(`j${i}`, ownedPath(`f${i}.pdf`)),
    );

    const result = await drainAttachmentCleanupQueue(USER);

    // Two reads, and BOTH ask for the head — never an offset. The second read
    // sees different rows only because the first window's rows were
    // acknowledged out of the queue.
    expect(queueState.limitCalls).toEqual([CLEANUP_QUEUE_PAGE_SIZE, CLEANUP_QUEUE_PAGE_SIZE]);
    expect(result).toEqual({ status: "completed", removed: CLEANUP_QUEUE_PAGE_SIZE + 1, pending: 0 });
    expect(queueState.rows).toEqual([]);
  });

  it("does nothing at all when the queue is empty", async () => {
    queueState.rows = [];

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
    queueState.readErrors = [
      {
        code: "PGRST205",
        message: "Could not find the table 'public.attachment_cleanup_queue' in the schema cache",
      },
    ];

    const result = await drainAttachmentCleanupQueue(USER);

    expect(result).toEqual({ status: "unavailable", removed: 0, pending: null });
    expect(mockStorageRemove).not.toHaveBeenCalled();
    // No retry loop, no second read: one refusal ends the pass.
    expect(queueState.reads).toBe(1);
  });

  it("does NOT classify an unrelated read failure as a pre-migration database", async () => {
    queueState.readErrors = [
      { code: "42501", message: "permission denied for table attachment_cleanup_queue" },
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
// The page bound, and what a bounded pass is allowed to CLAIM
// ══════════════════════════════════════════════════════════════════════════

describe("drainAttachmentCleanupQueue — the window bound is honest", () => {
  /** A queue of `n` distinct, safe jobs. */
  const queueOf = (n: number) =>
    Array.from({ length: n }, (_, i) => job(`q${i}`, ownedPath(`q${i}.pdf`)));

  it("completes when the LAST permitted window comes back short", async () => {
    // The bound is reached, but a short window is the end of the queue: nothing
    // is unseen, so `completed` is earned rather than assumed.
    queueState.rows = queueOf(CLEANUP_QUEUE_PAGE_SIZE * (CLEANUP_MAX_PAGES - 1) + 1);

    const result = await drainAttachmentCleanupQueue(USER);

    expect(queueState.reads).toBe(CLEANUP_MAX_PAGES);
    expect(result).toEqual({
      status: "completed",
      removed: CLEANUP_QUEUE_PAGE_SIZE * (CLEANUP_MAX_PAGES - 1) + 1,
      pending: 0,
    });
  });

  it("does NOT report completion when the last permitted window comes back full", async () => {
    // The defect this test exists for: every job the pass fetched was removed
    // and acknowledged, so the old code called that `completed` — while the
    // queue had never been enumerated to its end.
    queueState.rows = queueOf(CLEANUP_QUEUE_PAGE_SIZE * CLEANUP_MAX_PAGES + 1);

    const result = await drainAttachmentCleanupQueue(USER);

    expect(result.status).toBe("pending");
    expect(result.removed).toBe(CLEANUP_QUEUE_PAGE_SIZE * CLEANUP_MAX_PAGES);
    // Truthfully: one row is still queued, and this pass never saw it.
    expect(queueState.rows).toHaveLength(1);
  });

  it("reports the unseen remainder as unknown rather than fabricating a count", async () => {
    queueState.rows = queueOf(CLEANUP_QUEUE_PAGE_SIZE * CLEANUP_MAX_PAGES + 1);

    const result = await drainAttachmentCleanupQueue(USER);

    // `0` would be a lie and any number would be a guess: the pass never saw the
    // end of the queue, so the only truthful answer is "unknown".
    expect(result.pending).toBeNull();
  });

  it("never reads past its bound, however long the queue is", async () => {
    // The bound is a real bound. It is not raised to avoid the pending status —
    // one session start must not become an unbounded walk.
    queueState.rows = queueOf(CLEANUP_QUEUE_PAGE_SIZE * (CLEANUP_MAX_PAGES + 5));

    await drainAttachmentCleanupQueue(USER);

    expect(queueState.reads).toBe(CLEANUP_MAX_PAGES);
    // Every read asked for the head, never an offset.
    expect(queueState.limitCalls).toEqual(
      Array.from({ length: CLEANUP_MAX_PAGES }, () => CLEANUP_QUEUE_PAGE_SIZE),
    );
  });

  it("still reports a truthful count when the walk ended before the bound", async () => {
    // A full window is the only thing that erases the count. A Storage failure
    // inside a window that IS the whole queue still knows exactly what remains.
    queueState.rows = [job("j1", ownedPath("a.pdf")), job("j2", ownedPath("b.pdf"))];
    mockStorageRemove.mockResolvedValue({ data: null, error: { message: "storage unavailable" } });

    const result = await drainAttachmentCleanupQueue(USER);

    expect(result).toEqual({ status: "pending", removed: 0, pending: 2 });
  });

  it("stops instead of spinning when nothing in the window can be acted on", async () => {
    // Unsafe rows are filtered, never removed, so re-reading would return the
    // same window forever. One read, then an honest pending.
    queueState.rows = [
      job("bad1", `${OTHER}/${PAPER}/theirs.pdf`),
      job("bad2", `${USER}/../escape.pdf`),
    ];

    const result = await drainAttachmentCleanupQueue(USER);

    expect(queueState.reads).toBe(1);
    expect(mockStorageRemove).not.toHaveBeenCalled();
    expect(result).toEqual({ status: "pending", removed: 0, pending: 2 });
  });
});

// ══════════════════════════════════════════════════════════════════════════
// Two tabs draining the same queue
// ══════════════════════════════════════════════════════════════════════════

describe("drainAttachmentCleanupQueue — concurrent consumers", () => {
  it("cannot skip a job because another consumer removed rows ahead of it", async () => {
    // The defect offsets had. With `.range(page * size, …)`, reading page 0,
    // then having another tab acknowledge rows out of the front, then reading
    // page 1 would step straight over the rows that slid down into page 0's
    // range — and a short page 1 would then be read as "the queue is empty".
    //
    // Here the queue is two full windows plus one row. After the FIRST read,
    // another consumer acknowledges the last two rows of the queue — rows this
    // pass has not reached yet. Nothing this pass has not already handled may be
    // skipped, and the queue must end up empty.
    const total = CLEANUP_QUEUE_PAGE_SIZE * 2 + 1;
    queueState.rows = Array.from({ length: total }, (_, i) => job(`j${i}`, ownedPath(`f${i}.pdf`)));

    let interfered = false;
    queueState.onRead = (rows) => {
      if (interfered) return;
      interfered = true;
      // The other tab finishes the tail while this pass is still on the head.
      rows.splice(total - 2, 2);
    };

    const result = await drainAttachmentCleanupQueue(USER);

    expect(interfered).toBe(true);
    // Nothing is left behind, and nothing was stepped over.
    expect(queueState.rows).toEqual([]);
    expect(result.status).toBe("completed");
    // This pass removed everything that was still there when it looked.
    expect(result.removed).toBe(total - 2);
    const removedPaths = mockStorageRemove.mock.calls.flatMap((call) => call[0]);
    expect(new Set(removedPaths).size).toBe(total - 2);
  });

  it("is idempotent when both consumers acknowledge the same rows", async () => {
    // Overlapping tabs will remove the same object and delete the same row.
    // Removing an already-absent object is a Supabase no-op and acknowledging an
    // already-deleted row affects zero rows — neither is an error, and neither
    // may turn into a claim that something else was cleaned.
    queueState.rows = [job("j1", ownedPath("a.pdf")), job("j2", ownedPath("b.pdf"))];
    queueState.onRead = (rows) => {
      // The other tab acknowledged BOTH rows between our read and our
      // acknowledgement, so ours will match nothing.
      rows.splice(0, rows.length);
    };

    const result = await drainAttachmentCleanupQueue(USER);

    expect(result.status).toBe("completed");
    expect(queueState.rows).toEqual([]);
    // It still reports only what it actually did, and the queue really is empty.
    expect(result.pending).toBe(0);
  });

  it("does not let a failing consumer claim the queue was cleared", async () => {
    // One tab's Storage call fails while another tab is succeeding. The failing
    // pass must report pending — it did not clean what it fetched — even though
    // the queue may well be emptied by the other one a moment later.
    queueState.rows = [job("j1", ownedPath("a.pdf"))];
    mockStorageRemove.mockResolvedValue({ data: null, error: { message: "storage unavailable" } });

    const result = await drainAttachmentCleanupQueue(USER);

    expect(result.status).toBe("pending");
    expect(result.removed).toBe(0);
    expect(queueState.ackCalls).toEqual([]);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// Removing and acknowledging
// ══════════════════════════════════════════════════════════════════════════

describe("drainAttachmentCleanupQueue — removing and acknowledging", () => {
  it("removes one object and acknowledges exactly its row", async () => {
    queueState.rows = [job("j1", ownedPath("a.pdf"))];

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
    queueState.rows = jobs;

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
    queueState.rows = [job("j1", ownedPath("a.pdf"))];
    mockStorageRemove.mockResolvedValue({ data: null, error: { message: "storage unavailable" } });

    const result = await drainAttachmentCleanupQueue(USER);

    expect(queueState.ackCalls).toEqual([]);
    expect(result).toEqual({ status: "pending", removed: 0, pending: 1 });
  });

  it("keeps the queue rows when Storage throws", async () => {
    queueState.rows = [job("j1", ownedPath("a.pdf"))];
    mockStorageRemove.mockRejectedValue(new TypeError("Failed to fetch"));

    const result = await drainAttachmentCleanupQueue(USER);

    expect(queueState.ackCalls).toEqual([]);
    expect(result).toEqual({ status: "pending", removed: 0, pending: 1 });
  });

  it("stops at the first failing batch instead of hammering a refusing Storage", async () => {
    // Two batches' worth, in a window short enough to be the whole queue — so
    // the count this reports is one it can actually know.
    const total = CLEANUP_REMOVE_BATCH_SIZE + 50;
    queueState.rows = Array.from({ length: total }, (_, i) => job(`j${i}`, ownedPath(`f${i}.pdf`)));
    mockStorageRemove.mockResolvedValue({ data: null, error: { message: "storage unavailable" } });

    const result = await drainAttachmentCleanupQueue(USER);

    // The second batch is never attempted: when Storage is refusing, continuing
    // turns one user action into a run of doomed requests.
    expect(mockStorageRemove).toHaveBeenCalledTimes(1);
    expect(queueState.ackCalls).toEqual([]);
    expect(result).toEqual({ status: "pending", removed: 0, pending: total });
  });

  it("keeps the batches it did finish and counts the rest truthfully", async () => {
    const total = CLEANUP_REMOVE_BATCH_SIZE + 50;
    queueState.rows = Array.from({ length: total }, (_, i) => job(`j${i}`, ownedPath(`f${i}.pdf`)));
    mockStorageRemove
      .mockResolvedValueOnce({ data: null, error: null })
      .mockResolvedValue({ data: null, error: { message: "storage unavailable" } });

    const result = await drainAttachmentCleanupQueue(USER);

    expect(mockStorageRemove).toHaveBeenCalledTimes(2);
    // The finished batch really is gone from the queue; the rest really is not.
    expect(queueState.rows).toHaveLength(50);
    expect(result).toEqual({
      status: "pending",
      removed: CLEANUP_REMOVE_BATCH_SIZE,
      pending: 50,
    });
  });

  it("does not convert a physical success into job success when acknowledgement fails", async () => {
    queueState.rows = [job("j1", ownedPath("a.pdf"))];
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
    queueState.rows = [job("j1", ownedPath("gone.pdf"))];
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
    queueState.rows = [job("j1", `${OTHER}/${PAPER}/theirs.pdf`)];

    const result = await drainAttachmentCleanupQueue(USER);

    expect(mockStorageRemove).not.toHaveBeenCalled();
    // The row is NOT acknowledged either: refusing to act on it is safe, but
    // deleting the row would discard the evidence that it existed.
    expect(queueState.ackCalls).toEqual([]);
    expect(result).toEqual({ status: "pending", removed: 0, pending: 1 });
  });

  it("fails closed on a malformed path while still finishing the safe ones", async () => {
    queueState.rows = [
      job("bad", `${USER}/../escape.pdf`),
      job("good", ownedPath("fine.pdf")),
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
    queueState.rows = [job("j1", ownedPath("private-thesis.pdf"))];
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
    queueState.rows = [job("j1", ownedPath("a.pdf"))];

    await drainAttachmentCleanupQueue(USER);

    expect(warnSpy).not.toHaveBeenCalled();
  });
});
