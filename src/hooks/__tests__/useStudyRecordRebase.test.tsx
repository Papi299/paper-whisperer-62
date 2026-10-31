import { createHash } from "node:crypto";
import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Database } from "@/integrations/supabase/types";
import { toPaperId, toSnapshotId, toStudyId, toValueId, type PaperId } from "@/lib/evidence/ids";
import { createEvidenceLifecycleClient, type EvidenceRpcClient, type EvidenceRpcResponse } from "@/lib/evidence/lifecycleClient";
import { queryKeys } from "@/lib/queryKeys";
import { NOT_RECORDED_EDIT, setValueEdit, STUDY_TARGET, updateHeader, valueKey, type StudyRecordDraft } from "@/lib/studyRecord/draft";
import { assembleStudyRecord, type StudyRecordData } from "@/lib/studyRecord/read";
import type { AbstractDigest, SourceUpdateCandidate } from "@/lib/studyRecord/sourceUpdate";
import {
  ABSTRACT,
  fullRows,
  PAPER_ID,
  PAPER_TITLE,
  quoteAnchorRow,
  snapshotRow,
  SNAPSHOT_ID,
  STUDY_ID,
  studyRow,
  USER,
  uuid,
  VALUE_CONDITION,
  type FixtureRows,
} from "@/lib/studyRecord/__tests__/fixtures";
import { useStudyRecordEditor, type SourceUpdateOutcome } from "../useStudyRecordEditor";

/**
 * "Use current abstract" in the Study Record editor (EVIDENCE-RECORDS-001C2C-B),
 * through PR-B's real typed client over a scripted RPC: exactly what one
 * confirmation sends, how each answer is routed, that "Try again" resends the
 * SAME request and nothing is retried by itself, that the rebase holds every
 * other write while it is in flight or in doubt — and is held by theirs, by an
 * unsaved edit and by an open Flag note — and that a confirmed answer is read
 * back and the draft starts again from it. G3: the Flag note lives in the
 * editor.
 */

type Row<T extends keyof Database["public"]["Tables"]> = Database["public"]["Tables"][T]["Row"];

interface Call {
  readonly fn: string;
  readonly args: Record<string, unknown>;
}

let calls: Call[];
let answer: (call: Call) => EvidenceRpcResponse | "throw" | Promise<EvidenceRpcResponse | "throw">;
let requestCounter: number;
const newRequestId = () => uuid("7", ++requestCounter);

const rpcClient: EvidenceRpcClient = {
  rpc: (async (fn: string, args: Record<string, unknown>) => {
    const call = { fn, args: structuredClone(args) };
    calls.push(call);
    const response = await answer(call);
    if (response === "throw") throw new TypeError("Failed to fetch");
    return response;
  }) as EvidenceRpcClient["rpc"],
};
const client = createEvidenceLifecycleClient(rpcClient);

const REVISED = ABSTRACT.replace("120 participants", "118 participants");
const NEW_COPY = uuid("c", 2);
const PAPER = toPaperId(PAPER_ID) as PaperId;
const CONDITION = toValueId(VALUE_CONDITION)!;
const sha = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

/** Assemble rows as the read does: every copy's metadata, the text of each link's newest copy only. */
function record(rows: FixtureRows): StudyRecordData {
  const info = rows.snapshots.map(({ exact_text: _t, exact_sha256: _e, normalized_sha256: _n, ...rest }) => rest);
  const newest = new Map<string, Row<"evidence_source_snapshots">>();
  for (const snapshot of rows.snapshots) {
    const current = newest.get(snapshot.paper_id);
    if (!current || snapshot.seq > current.seq) newest.set(snapshot.paper_id, snapshot);
  }
  return assembleStudyRecord(USER, STUDY_ID, { ...rows, snapshots: info }, [...newest.values()], [{ id: PAPER_ID, user_id: USER, title: PAPER_TITLE }]);
}

/** The record before: copy 1, the condition quoted on it and reviewed. */
function beforeRows(): FixtureRows {
  const rows = fullRows();
  rows.values = rows.values.map((value) =>
    value.id === VALUE_CONDITION ? { ...value, review_status: "user_reviewed", reviewed_at: "2026-10-21T10:00:00.000Z", reviewed_version: value.value_version } : value,
  );
  return rows;
}

/** The record as the rebase leaves it: copy 2 current, the quote moved to it, the condition needing re-review, version 5. */
function afterRows(version = 5): FixtureRows {
  const rows = fullRows();
  rows.study = studyRow({ row_version: version });
  rows.snapshots = [snapshotRow(), snapshotRow({ id: NEW_COPY, seq: 2, exact_text: REVISED, char_count: Array.from(REVISED).length, captured_at: "2026-10-30T10:00:00.000Z" })];
  rows.anchors = [quoteAnchorRow({ snapshot_id: NEW_COPY })];
  rows.values = rows.values.map((value) => (value.id === VALUE_CONDITION ? { ...value, value_version: 3, review_status: "needs_rereview", review_reason: "source_changed" } : value));
  return rows;
}

/** A record created from a paper with no abstract: no copy, a condition saying the abstract couldn't be checked. */
function noCopyRows(): FixtureRows {
  const rows = fullRows();
  rows.snapshots = [];
  rows.anchors = [
    {
      ...quoteAnchorRow(),
      purpose: "unavailable",
      snapshot_id: null,
      position: null,
      quote_text: null,
      match_start: null,
      match_end: null,
      match_occurrence: null,
      match_count: null,
      normalization_version: null,
      matched_at: null,
    },
  ];
  rows.values = rows.values.map((value) => (value.id === VALUE_CONDITION ? { ...value, value_state: "not_reported", value_text: null } : value));
  return rows;
}

/** What the server answers when it applies a rebase. */
function rebased({ args }: Call, overrides: Record<string, unknown> = {}): EvidenceRpcResponse {
  return {
    data: {
      status: "applied",
      study_id: args.p_study_id,
      study_version: (args.p_expected_version as number) + 1,
      paper_id: args.p_paper_id,
      snapshot_id: NEW_COPY,
      previous_snapshot_id: SNAPSHOT_ID,
      seq: 2,
      rematched: 1,
      not_found: 0,
      ambiguous: 0,
      needs_rereview: 1,
      ...overrides,
    },
    error: null,
    status: 200,
  };
}

/** Every other write, applied. */
function applied({ fn, args }: Call): EvidenceRpcResponse {
  const version = (args.p_expected_version as number) + 1;
  if (fn === "evidence_review_fields") {
    return {
      data: {
        status: "applied",
        study_id: args.p_study_id,
        study_version: version,
        value_id: args.p_value_id,
        value_version: args.p_expected_value_version,
        review_status: args.p_action === "confirm" ? "user_reviewed" : "disputed",
      },
      error: null,
      status: 200,
    };
  }
  return { data: { status: "applied", study_id: args.p_study_id, study_version: version, arm_ids: {}, outcome_ids: {} }, error: null, status: 200 };
}

const raised = (message: string, code = "P0001", details: string | null = null, status = 400): EvidenceRpcResponse => ({
  data: null,
  error: { code, message, details, hint: null },
  status,
});

function deferred<T>() {
  let settle!: (value: T) => void;
  const promise = new Promise<T>((resolve) => (settle = resolve));
  return { promise, settle };
}

const current = { base: record(beforeRows()) };
const refetch = vi.fn(async (): Promise<StudyRecordData | null | undefined> => current.base);
let queryClient: QueryClient;

function renderEditor({ canWrite = true, digest }: { readonly canWrite?: boolean; readonly digest?: (text: string) => Promise<AbstractDigest> } = {}) {
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  return renderHook(
    ({ base }: { base: StudyRecordData }) =>
      useStudyRecordEditor({ userId: USER, studyId: toStudyId(STUDY_ID)!, base, refetch, canWrite, client, newRequestId, ...(digest ? { digest } : {}) }),
    { wrapper, initialProps: { base: current.base } },
  );
}

type Rendered = ReturnType<typeof renderEditor>;

/** The library abstract as the comparison showed it, frozen. */
const candidate = (overrides: Partial<SourceUpdateCandidate> = {}): SourceUpdateCandidate => ({
  paperId: PAPER,
  text: REVISED,
  studyVersion: 4,
  currentCopyId: toSnapshotId(SNAPSHOT_ID),
  readAt: Date.now(),
  ...overrides,
});

/** Confirm, and let the record read back reach the hook the way the dialog's query hands it on. */
async function confirm(rendered: Rendered, frozen: SourceUpdateCandidate = candidate()): Promise<SourceUpdateOutcome> {
  let outcome: SourceUpdateOutcome = { kind: "not_sent" };
  await act(async () => {
    outcome = await rendered.result.current.updateSource(frozen);
  });
  rendered.rerender({ base: current.base });
  return outcome;
}

async function retry(rendered: Rendered): Promise<SourceUpdateOutcome> {
  let outcome: SourceUpdateOutcome = { kind: "not_sent" };
  await act(async () => {
    outcome = await rendered.result.current.retrySourceUpdate();
  });
  rendered.rerender({ base: current.base });
  return outcome;
}

async function reload(rendered: Rendered) {
  await act(async () => {
    await rendered.result.current.reload();
  });
  rendered.rerender({ base: current.base });
}

const rebaseCalls = () => calls.filter((call) => call.fn === "evidence_rebase_source");
const edit = (rendered: Rendered, change: (draft: StudyRecordDraft) => StudyRecordDraft) => act(() => rendered.result.current.update(change));

beforeEach(() => {
  calls = [];
  requestCounter = 0;
  answer = (call) => (call.fn === "evidence_rebase_source" ? rebased(call) : applied(call));
  current.base = record(beforeRows());
  refetch.mockReset();
  refetch.mockImplementation(async () => current.base);
});

describe("one confirmation, one request", () => {
  it("sends the SHA-256 of the exact text shown, at the version it was shown against, with one new request id — and nothing the server sets", async () => {
    const rendered = renderEditor();
    refetch.mockImplementation(async () => (current.base = record(afterRows())));
    const outcome = await confirm(rendered);

    expect(rebaseCalls()).toEqual([
      {
        fn: "evidence_rebase_source",
        args: {
          p_study_id: STUDY_ID,
          p_paper_id: PAPER_ID,
          p_expected_version: 4,
          p_expected_abstract_sha256: sha(REVISED),
          p_request_id: uuid("7", 1),
        },
      },
    ]);
    expect(calls).toHaveLength(1);
    expect(requestCounter).toBe(1);
    expect(outcome).toEqual({ kind: "done", status: "applied" });
    expect(rendered.result.current.sourceUpdate).toMatchObject({
      status: "done",
      paperId: PAPER_ID,
      result: { status: "applied", studyVersion: 5, snapshotId: NEW_COPY, previousSnapshotId: SNAPSHOT_ID, seq: 2, rematched: 1, notFound: 0, ambiguous: 0, needsRereview: 1 },
    });
  });

  it("reads the record back, checks it against the answer, and starts the draft again from it — the new copy current, no reference to the old one", async () => {
    const rendered = renderEditor();
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");
    refetch.mockImplementation(async () => (current.base = record(afterRows())));
    await confirm(rendered);
    expect(refetch).toHaveBeenCalledTimes(1);
    // Only this user's study-record reads: summaries, history, the library abstract — never the shared abstract cache.
    expect(invalidate).toHaveBeenCalledWith({ queryKey: queryKeys.studyRecords.all(USER) });
    expect(rendered.result.current.knownVersion).toBe(5);
    expect(rendered.result.current.externalChange).toBe(false);
    expect(rendered.result.current.dirty).toBe(false);
    expect(rendered.result.current.draft.values.size).toBe(0);
    expect(rendered.result.current.reviewItems.find((item) => item.value.id === CONDITION)?.value).toMatchObject({ valueVersion: 3, review: { status: "needs_rereview" } });
    expect(rendered.result.current.reviewItems.find((item) => item.value.id === CONDITION)?.value.references[0]).toMatchObject({ snapshotId: NEW_COPY });
    // Writes are open again: an edit is taken.
    await edit(rendered, (draft) => updateHeader(draft, { label: "Doe 2024 trial" }));
    expect(rendered.result.current.draft.header.label).toBe("Doe 2024 trial");
  });

  it("saves a first copy for a record without one: no copy replaced", async () => {
    current.base = record(noCopyRows());
    const rendered = renderEditor();
    answer = (call) => rebased(call, { snapshot_id: uuid("c", 1), previous_snapshot_id: null, seq: 1, rematched: 0, needs_rereview: 0 });
    refetch.mockImplementation(async () => {
      const rows = noCopyRows();
      rows.study = studyRow({ row_version: 5 });
      rows.snapshots = [snapshotRow({ exact_text: REVISED, char_count: Array.from(REVISED).length })];
      return (current.base = record(rows));
    });
    expect(await confirm(rendered, candidate({ currentCopyId: null }))).toEqual({ kind: "done", status: "applied" });
    expect(rebaseCalls()[0].args.p_expected_abstract_sha256).toBe(sha(REVISED));
    expect(rendered.result.current.sourceUpdate).toMatchObject({ status: "done", result: { seq: 1, previousSnapshotId: null } });
  });

  it("reports an unchanged answer as such: nothing saved, the version kept", async () => {
    const rendered = renderEditor();
    answer = ({ args }) => ({
      data: {
        status: "unchanged",
        study_id: args.p_study_id,
        study_version: args.p_expected_version,
        paper_id: args.p_paper_id,
        snapshot_id: SNAPSHOT_ID,
        previous_snapshot_id: null,
        seq: 1,
        rematched: 0,
        not_found: 0,
        ambiguous: 0,
        needs_rereview: 0,
      },
      error: null,
      status: 200,
    });
    expect(await confirm(rendered)).toEqual({ kind: "done", status: "unchanged" });
    expect(rendered.result.current.knownVersion).toBe(4);
    expect(rendered.result.current.sourceUpdate).toMatchObject({ status: "done", result: { status: "unchanged", seq: 1 } });
  });

  it("sends one request for a double confirmation", async () => {
    const rendered = renderEditor();
    const gate = deferred<EvidenceRpcResponse | "throw">();
    answer = () => gate.promise;
    let first!: Promise<SourceUpdateOutcome>;
    let second!: Promise<SourceUpdateOutcome>;
    await act(async () => {
      first = rendered.result.current.updateSource(candidate());
      second = rendered.result.current.updateSource(candidate());
    });
    expect(await second).toEqual({ kind: "not_sent" });
    // The digest is the browser's own, asynchronous: wait for the one call before answering it.
    await waitFor(() => expect(rebaseCalls()).toHaveLength(1));
    refetch.mockImplementation(async () => (current.base = record(afterRows())));
    await act(async () => {
      gate.settle(rebased(rebaseCalls()[0]));
      await first;
    });
    expect(rebaseCalls()).toHaveLength(1);
    expect(requestCounter).toBe(1);
  });

  it("holds every other write while it is prepared and while it is in flight", async () => {
    const digestGate = deferred<AbstractDigest>();
    const rendered = renderEditor({ digest: () => digestGate.promise });
    const rpcGate = deferred<EvidenceRpcResponse | "throw">();
    answer = (call) => (call.fn === "evidence_rebase_source" ? rpcGate.promise : applied(call));
    let pending!: Promise<SourceUpdateOutcome>;
    await act(async () => {
      pending = rendered.result.current.updateSource(candidate());
    });
    expect(rendered.result.current.sourceUpdate).toEqual({ status: "preparing", paperId: PAPER_ID });
    expect(rendered.result.current.canEdit).toBe(false);
    expect(rendered.result.current.reviewActivity).toBe("busy");

    await act(async () => {
      digestGate.settle({ ok: true, sha256: sha(REVISED) });
    });
    expect(rendered.result.current.sourceUpdate).toEqual({ status: "working", paperId: PAPER_ID });
    // An edit, a save, a link change, a deletion and a review all wait.
    await edit(rendered, (draft) => updateHeader(draft, { label: "Other" }));
    expect(rendered.result.current.draft.header.label).toBe("Doe 2024");
    await act(async () => {
      await rendered.result.current.runSave();
      await rendered.result.current.changeLinkStatus(PAPER_ID, "mark_provisional");
      expect(await rendered.result.current.deleteStudy()).toBe(false);
      expect(await rendered.result.current.review({ valueId: toValueId(uuid("f", 2))!, shownVersion: 1 }, "confirm", null)).toEqual({ kind: "not_sent" });
    });
    expect(calls.map((call) => call.fn)).toEqual(["evidence_rebase_source"]);

    refetch.mockImplementation(async () => (current.base = record(afterRows())));
    await act(async () => {
      rpcGate.settle(rebased(rebaseCalls()[0]));
      await pending;
    });
    expect(rendered.result.current.sourceUpdate.status).toBe("done");
  });
});

describe("what is never sent", () => {
  it.each([
    ["a study version other than the editor's", { studyVersion: 3 }, "stale"],
    ["a current copy other than the link's", { currentCopyId: toSnapshotId(uuid("c", 9)) }, "stale"],
    ["a first capture for a link that has a copy", { currentCopyId: null }, "stale"],
    ["a paper the record doesn't link", { paperId: toPaperId(uuid("a", 9)) as PaperId }, "stale"],
    ["the saved copy's own text", { text: ABSTRACT }, "ineligible"],
    ["an abstract over 50,000 characters", { text: "x".repeat(50_001) }, "ineligible"],
    ["an empty abstract", { text: "   " }, "ineligible"],
  ] as const)("a candidate with %s", async (_label, overrides, reason) => {
    const rendered = renderEditor();
    expect(await confirm(rendered, candidate(overrides))).toEqual({ kind: "not_sent" });
    expect(calls).toEqual([]);
    expect(requestCounter).toBe(0);
    expect(rendered.result.current.sourceUpdate).toEqual({ status: "not_sent", paperId: "paperId" in overrides ? overrides.paperId : PAPER_ID, reason });
  });

  it("nothing, and no request id, without Web Crypto or when the digest fails — and writes open again", async () => {
    for (const [digest, reason] of [
      [async (): Promise<AbstractDigest> => ({ ok: false, reason: "unavailable" }), "digest_unavailable"],
      [async (): Promise<AbstractDigest> => ({ ok: false, reason: "failed" }), "digest_failed"],
    ] as const) {
      const rendered = renderEditor({ digest });
      expect(await confirm(rendered)).toEqual({ kind: "not_sent" });
      expect(rendered.result.current.sourceUpdate).toEqual({ status: "not_sent", paperId: PAPER_ID, reason });
      expect(rendered.result.current.canEdit).toBe(true);
      rendered.unmount();
    }
    expect(calls).toEqual([]);
    expect(requestCounter).toBe(0);
  });

  it("nothing for a user the pilot does not allow", async () => {
    const rendered = renderEditor({ canWrite: false });
    expect(rendered.result.current.sourceUpdateWritable).toBe(false);
    expect(await confirm(rendered)).toEqual({ kind: "not_sent" });
    expect(calls).toEqual([]);
  });

  it("nothing while the draft has an unsaved edit — the hold says so", async () => {
    const rendered = renderEditor();
    await edit(rendered, (draft) => updateHeader(draft, { notes: "Unsaved" }));
    expect(rendered.result.current.sourceUpdateHold).toBe("unsaved_changes");
    expect(await confirm(rendered)).toEqual({ kind: "not_sent" });
    expect(calls).toEqual([]);
    // The edit is kept: a hold never discards anything.
    expect(rendered.result.current.draft.header.notes).toBe("Unsaved");
  });

  it("nothing while a Flag note is open in Review, however far typed (G3)", async () => {
    const rendered = renderEditor();
    act(() => rendered.result.current.openFlag(CONDITION));
    expect(rendered.result.current.sourceUpdateHold).toBe("flag_open");
    expect(await confirm(rendered)).toEqual({ kind: "not_sent" });
    act(() => rendered.result.current.editFlagNote(CONDITION, "Half a note"));
    expect(await confirm(rendered)).toEqual({ kind: "not_sent" });
    expect(rendered.result.current.flagNotes.get(CONDITION)).toBe("Half a note");
    expect(calls).toEqual([]);
    act(() => rendered.result.current.closeFlag(CONDITION));
    expect(rendered.result.current.sourceUpdateHold).toBeNull();
  });

  it("nothing while a review's outcome is unknown — and the review waits for the rebase in turn", async () => {
    const rendered = renderEditor();
    answer = (call) => (call.fn === "evidence_review_fields" ? "throw" : rebased(call));
    await act(async () => {
      await rendered.result.current.review({ valueId: toValueId(uuid("f", 2))!, shownVersion: 1 }, "flag", "Check the arm");
    });
    expect(rendered.result.current.reviewAction.status).toBe("uncertain");
    expect(rendered.result.current.sourceUpdateHold).toBe("unresolved");
    expect(await confirm(rendered)).toEqual({ kind: "not_sent" });
    expect(rebaseCalls()).toEqual([]);
  });

  it.each([
    ["a link change", "evidence_set_link", false, async (rendered: Rendered) => rendered.result.current.changeLinkStatus(PAPER_ID, "mark_provisional")],
    ["a deletion", "evidence_delete_study", false, async (rendered: Rendered) => rendered.result.current.deleteStudy()],
    ["a save of the study details", "evidence_update_study", true, async (rendered: Rendered) => rendered.result.current.runSave()],
  ] as const)("nothing while %s is in flight, nor while its outcome is unknown", async (_label, fn, edited, start) => {
    const rendered = renderEditor();
    if (edited) await edit(rendered, (draft) => updateHeader(draft, { notes: "Saved" }));
    const gate = deferred<EvidenceRpcResponse | "throw">();
    answer = (call) => (call.fn === fn ? gate.promise : rebased(call));
    let pending!: Promise<unknown>;
    await act(async () => {
      pending = start(rendered);
    });
    await waitFor(() => expect(calls.map((call) => call.fn)).toContain(fn));
    expect(rendered.result.current.sourceUpdateHold).toBe("busy");
    expect(await confirm(rendered)).toEqual({ kind: "not_sent" });
    await act(async () => {
      gate.settle("throw");
      await pending;
    });
    expect(rendered.result.current.sourceUpdateHold).toBe("unresolved");
    expect(await confirm(rendered)).toEqual({ kind: "not_sent" });
    expect(rebaseCalls()).toEqual([]);
  });

  it("nothing while a save's outcome is unknown", async () => {
    const rendered = renderEditor();
    answer = (call) => (call.fn === "evidence_rebase_source" ? rebased(call) : "throw");
    await edit(rendered, (draft) =>
      setValueEdit(rendered.result.current.baseValues, draft, valueKey(STUDY_TARGET, "setting"), { ...NOT_RECORDED_EDIT, state: "reported", content: { shape: "text", text: "Clinics" } }),
    );
    await act(async () => {
      await rendered.result.current.runSave();
    });
    expect(rendered.result.current.save.status).toBe("uncertain");
    expect(rendered.result.current.sourceUpdateHold).toBe("unresolved");
    expect(await confirm(rendered)).toEqual({ kind: "not_sent" });
    expect(rebaseCalls()).toEqual([]);
  });
});

describe("an unknown outcome", () => {
  it("keeps the request and every write held, retries nothing by itself, and resends the SAME request on Try again — the server replays it", async () => {
    const rendered = renderEditor();
    answer = () => "throw";
    expect(await confirm(rendered)).toEqual({ kind: "failed" });
    expect(rendered.result.current.sourceUpdate).toMatchObject({ status: "uncertain", paperId: PAPER_ID, error: { kind: "transport_uncertain", applied: "unknown" } });
    expect(rendered.result.current.sourceUpdatePending).toBe(true);
    expect(rendered.result.current.canEdit).toBe(false);
    expect(rendered.result.current.sourceUpdateHold).toBe("unresolved");
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(calls).toHaveLength(1);

    // Every competing write waits, a new confirmation included.
    answer = (call) => applied(call);
    await edit(rendered, (draft) => updateHeader(draft, { label: "Other" }));
    expect(rendered.result.current.draft.header.label).toBe("Doe 2024");
    await act(async () => {
      await rendered.result.current.runSave();
      await rendered.result.current.changeLinkStatus(PAPER_ID, "mark_provisional");
      expect(await rendered.result.current.deleteStudy()).toBe(false);
    });
    expect(await confirm(rendered)).toEqual({ kind: "not_sent" });
    expect(calls).toHaveLength(1);

    answer = (call) => rebased(call, { status: "replayed" });
    refetch.mockImplementation(async () => (current.base = record(afterRows())));
    expect(await retry(rendered)).toEqual({ kind: "done", status: "replayed" });
    // The identical request: same id, same digest, same version.
    expect(rebaseCalls()).toHaveLength(2);
    expect(rebaseCalls()[1]).toEqual(rebaseCalls()[0]);
    expect(requestCounter).toBe(1);
    expect(rendered.result.current.sourceUpdate).toMatchObject({ status: "done", result: { status: "replayed", studyVersion: 5 } });
    expect(rendered.result.current.canEdit).toBe(true);
  });

  it.each([
    ["an answer that isn't the RPC's shape", () => ({ data: { status: "applied" }, error: null, status: 200 })],
    ["a gateway failure with no answer", () => ({ data: null, error: { message: "Bad Gateway" }, status: 502 })],
    ["a busy database", () => raised("canceling statement due to statement timeout", "57014", null, 500)],
    ["an ended session", () => ({ data: null, error: { message: "JWT expired" }, status: 401 })],
  ])("treats %s as worth resending as is: the same request, kept", async (_label, response) => {
    const rendered = renderEditor();
    answer = response as () => EvidenceRpcResponse;
    await confirm(rendered);
    expect(rendered.result.current.sourceUpdate.status).toBe("uncertain");
    answer = (call) => rebased(call);
    refetch.mockImplementation(async () => (current.base = record(afterRows())));
    await retry(rendered);
    expect(rebaseCalls()).toHaveLength(2);
    expect(rebaseCalls()[1].args).toEqual(rebaseCalls()[0].args);
  });

  it("is abandoned by a reload: the record read back says whether it was saved; a new confirmation is a new request", async () => {
    const rendered = renderEditor();
    answer = () => "throw";
    await confirm(rendered);
    current.base = record(afterRows());
    await reload(rendered);
    expect(rendered.result.current.sourceUpdate).toEqual({ status: "idle" });
    expect(rendered.result.current.sourceUpdatePending).toBe(false);
    expect(rendered.result.current.knownVersion).toBe(5);
    expect(await retry(rendered)).toEqual({ kind: "not_sent" });
    expect(rebaseCalls()).toHaveLength(1);
  });
});

describe("a refusal", () => {
  it("source_changed_again: nothing saved; a new choice needs the library read again — never the same digest resent", async () => {
    const rendered = renderEditor();
    answer = () => raised("evidence_source_changed_again");
    const shownBefore = candidate({ readAt: Date.now() - 1000 });
    expect(await confirm(rendered, shownBefore)).toEqual({ kind: "failed" });
    expect(rendered.result.current.sourceUpdate).toMatchObject({ status: "source_changed", error: { kind: "source_changed_again", applied: "no" } });
    expect(rendered.result.current.sourceUpdateHold).toBeNull();
    expect(await retry(rendered)).toEqual({ kind: "not_sent" });

    // A choice from the read made before the refusal is refused here, unsent.
    expect(await confirm(rendered, shownBefore)).toEqual({ kind: "not_sent" });
    expect(rendered.result.current.sourceUpdate).toEqual({ status: "not_sent", paperId: PAPER_ID, reason: "stale" });
    expect(rebaseCalls()).toHaveLength(1);

    // One from a read finished since: a new request, with the new text's digest.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
    });
    const reread = `${REVISED}\nConclusions: added later.`;
    answer = (call) => rebased(call);
    refetch.mockImplementation(async () => (current.base = record(afterRows())));
    expect(await confirm(rendered, candidate({ text: reread, readAt: Date.now() }))).toEqual({ kind: "done", status: "applied" });
    expect(rebaseCalls().map((call) => [call.args.p_request_id, call.args.p_expected_abstract_sha256])).toEqual([
      [uuid("7", 1), sha(REVISED)],
      [uuid("7", 2), sha(reread)],
    ]);
  });

  it("a version conflict: nothing saved, the record must be reloaded — the user's choice is never rebased onto someone else's change", async () => {
    const rendered = renderEditor();
    answer = () => raised("evidence_version_conflict");
    await confirm(rendered);
    expect(rendered.result.current.sourceUpdate).toMatchObject({ status: "conflict", error: { kind: "version_conflict" } });
    expect(rendered.result.current.save).toEqual({ status: "conflict", applied: 0, total: 0 });
    expect(rendered.result.current.sourceUpdateHold).toBe("changed_elsewhere");
    expect(await confirm(rendered)).toEqual({ kind: "not_sent" });
    expect(rebaseCalls()).toHaveLength(1);
    current.base = record({ ...beforeRows(), study: studyRow({ row_version: 6 }) });
    await reload(rendered);
    expect(rendered.result.current.sourceUpdateHold).toBeNull();
    expect(rendered.result.current.knownVersion).toBe(6);
  });

  it.each([
    ["the copy limit", "evidence_snapshot_limit", "P0001", null, "snapshot_limit"],
    ["the history limit", "evidence_history_limit", "P0001", null, "history_limit"],
    ["an abstract over 50,000 characters", "evidence_abstract_too_long", "P0001", null, "abstract_too_long"],
    ["a link that isn't there", "evidence_link_not_found", "P0002", null, "link_not_found"],
    ["an abstract empty after normalization", "evidence_invalid_input", "22023", "p_expected_abstract_sha256: source_empty", "invalid_input"],
    ["a reused request id", "evidence_request_id_reused", "P0001", null, "request_id_reused"],
  ])("%s: nothing saved, the request retired, and another attempt waits for a reload", async (_label, message, code, details, kind) => {
    const rendered = renderEditor();
    answer = () => raised(message, code, details);
    await confirm(rendered);
    expect(rendered.result.current.sourceUpdate).toMatchObject({ status: "failed", error: { kind, applied: "no" } });
    expect(rendered.result.current.sourceUpdateHold).toBe("refused");
    expect(rendered.result.current.canEdit).toBe(true);
    expect(await retry(rendered)).toEqual({ kind: "not_sent" });
    expect(await confirm(rendered)).toEqual({ kind: "not_sent" });
    act(() => rendered.result.current.clearSourceUpdate());
    expect(rendered.result.current.sourceUpdate.status).toBe("failed");
    expect(rebaseCalls()).toHaveLength(1);
    await reload(rendered);
    expect(rendered.result.current.sourceUpdate).toEqual({ status: "idle" });
    expect(rendered.result.current.sourceUpdateHold).toBeNull();
  });

  it("a lost pilot role: nothing saved, and nothing more is offered", async () => {
    const rendered = renderEditor();
    answer = () => raised("evidence_records_not_enabled", "42501", null, 403);
    await confirm(rendered);
    expect(rendered.result.current.sourceUpdate).toMatchObject({ status: "not_enabled" });
    expect(rendered.result.current.save).toEqual({ status: "not_enabled", applied: 0, total: 0 });
    expect(rendered.result.current.sourceUpdateWritable).toBe(false);
  });

  it("a study gone: the editor says so", async () => {
    const rendered = renderEditor();
    answer = () => raised("evidence_not_found", "P0002");
    await confirm(rendered);
    expect(rendered.result.current.sourceUpdate).toMatchObject({ status: "failed", error: { kind: "study_not_found" } });
    expect(rendered.result.current.save).toEqual({ status: "gone" });
  });
});

describe("a confirmed answer the record can't be read back as", () => {
  it("a failed read-back is not a failed write: the copy is saved, and a reload is offered", async () => {
    const rendered = renderEditor();
    refetch.mockImplementation(async () => undefined);
    expect(await confirm(rendered)).toEqual({ kind: "done", status: "applied" });
    expect(rendered.result.current.sourceUpdate).toMatchObject({ status: "reload_failed", result: { status: "applied", seq: 2 } });
    expect(rendered.result.current.save).toEqual({ status: "reload_failed", applied: 0, total: 0 });
    expect(rendered.result.current.sourceUpdateHold).toBe("unresolved");
    expect(rendered.result.current.canEdit).toBe(false);
    refetch.mockImplementation(async () => (current.base = record(afterRows())));
    await reload(rendered);
    expect(rendered.result.current.sourceUpdate).toEqual({ status: "idle" });
    expect(rendered.result.current.knownVersion).toBe(5);
    expect(rendered.result.current.canEdit).toBe(true);
  });

  it("a read-back at the answer's version without the answer's copy is not taken as it", async () => {
    const rendered = renderEditor();
    refetch.mockImplementation(async () => (current.base = record({ ...beforeRows(), study: studyRow({ row_version: 5 }) })));
    await confirm(rendered);
    expect(rendered.result.current.sourceUpdate.status).toBe("reload_failed");
  });

  it("a read-back at a later version: saved, and the change made elsewhere is flagged", async () => {
    const rendered = renderEditor();
    refetch.mockImplementation(async () => (current.base = record(afterRows(6))));
    await confirm(rendered);
    expect(rendered.result.current.sourceUpdate.status).toBe("done");
    expect(rendered.result.current.externalChange).toBe(true);
    expect(rendered.result.current.sourceUpdateHold).toBe("changed_elsewhere");
  });
});

describe("the Flag note lives in the editor (G3)", () => {
  it("opens from the value's own flag note, keeps what is typed, and closes on Cancel", () => {
    const rows = beforeRows();
    rows.values = rows.values.map((value) => (value.id === VALUE_CONDITION ? { ...value, review_status: "disputed", review_note: "Check the methods", reviewed_at: null, reviewed_version: null } : value));
    current.base = record(rows);
    const rendered = renderEditor();
    act(() => rendered.result.current.openFlag(CONDITION));
    expect(rendered.result.current.flagNotes.get(CONDITION)).toBe("Check the methods");
    act(() => rendered.result.current.editFlagNote(CONDITION, "Check the methods and Table 1"));
    // Opening again keeps the note as typed.
    act(() => rendered.result.current.openFlag(CONDITION));
    expect(rendered.result.current.flagNotes.get(CONDITION)).toBe("Check the methods and Table 1");
    expect(rendered.result.current.openFlagIds).toEqual([CONDITION]);
    act(() => rendered.result.current.closeFlag(CONDITION));
    expect(rendered.result.current.flagNotes.has(CONDITION)).toBe(false);
  });

  it("survives a reload, and counts only for values the record still has", async () => {
    const rendered = renderEditor();
    act(() => rendered.result.current.openFlag(CONDITION));
    act(() => rendered.result.current.editFlagNote(CONDITION, "Still typing"));
    await reload(rendered);
    expect(rendered.result.current.flagNotes.get(CONDITION)).toBe("Still typing");
    const rows = beforeRows();
    rows.values = rows.values.filter((value) => value.id !== VALUE_CONDITION);
    rows.anchors = [];
    current.base = record(rows);
    rendered.rerender({ base: current.base });
    expect(rendered.result.current.openFlagIds).toEqual([]);
    expect(rendered.result.current.sourceUpdateHold).toBeNull();
  });

  it("closes once the flag is recorded — on the first press or on Try again", async () => {
    const rendered = renderEditor();
    const value = toValueId(uuid("f", 2))!;
    act(() => rendered.result.current.openFlag(value));
    act(() => rendered.result.current.editFlagNote(value, "Check the arm"));
    answer = (call) => (call.fn === "evidence_review_fields" ? "throw" : applied(call));
    await act(async () => {
      await rendered.result.current.review({ valueId: value, shownVersion: 1 }, "flag", "Check the arm");
    });
    // In doubt: the note stays open, as typed.
    expect(rendered.result.current.flagNotes.get(value)).toBe("Check the arm");
    answer = (call) => applied(call);
    await act(async () => {
      await rendered.result.current.retryReview();
    });
    expect(rendered.result.current.flagNotes.has(value)).toBe(false);
  });

  it("an open note doesn't hold an edit, a save or a review — only the rebase", async () => {
    const rendered = renderEditor();
    act(() => rendered.result.current.openFlag(CONDITION));
    expect(rendered.result.current.canEdit).toBe(true);
    expect(rendered.result.current.reviewActivity).toBe("idle");
    await edit(rendered, (draft) => updateHeader(draft, { label: "Doe 2024 trial" }));
    expect(rendered.result.current.draft.header.label).toBe("Doe 2024 trial");
  });
});
