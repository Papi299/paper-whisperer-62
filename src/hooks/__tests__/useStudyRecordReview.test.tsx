import { act, renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { toStudyId, toValueId, type ValueId } from "@/lib/evidence/ids";
import { createEvidenceLifecycleClient, type EvidenceRpcClient, type EvidenceRpcResponse } from "@/lib/evidence/lifecycleClient";
import { NOT_RECORDED_EDIT, removeArm, setValueEdit, STUDY_TARGET, updateHeader, valueKey, type StudyRecordDraft } from "@/lib/studyRecord/draft";
import type { StudyRecordData } from "@/lib/studyRecord/read";
import {
  ARM_COMPARATOR,
  assemble,
  fullRows,
  PAPER_ID,
  quoteAnchorRow,
  STUDY_ID,
  studyRow,
  USER,
  uuid,
  VALUE_COMPARATOR_TYPE,
  VALUE_CONDITION,
  VALUE_N_RANDOMIZED,
  type FixtureRows,
} from "@/lib/studyRecord/__tests__/fixtures";
import { useStudyRecordEditor, type ReviewOutcome } from "../useStudyRecordEditor";

/**
 * Review in the Study Record editor (EVIDENCE-RECORDS-001C2A), through PR-B's
 * real typed client over a scripted RPC: exactly what is sent for one Confirm
 * or Flag, what each answer does, that "Try again" resends the SAME request and
 * nothing is ever retried by itself, and that a review in flight or in doubt
 * holds every other write — and is held by theirs.
 */

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

/** What the server answers when it applies a call. */
function applied({ fn, args }: Call, status: "applied" | "replayed" = "applied"): EvidenceRpcResponse {
  const version = (args.p_expected_version as number) + 1;
  switch (fn) {
    case "evidence_review_fields":
      return {
        data: {
          status,
          study_id: args.p_study_id,
          study_version: version,
          value_id: args.p_value_id,
          value_version: args.p_expected_value_version,
          review_status: args.p_action === "confirm" ? "user_reviewed" : "disputed",
        },
        error: null,
        status: 200,
      };
    case "evidence_update_study":
      return { data: { status: "applied", study_id: args.p_study_id, study_version: version }, error: null, status: 200 };
    case "evidence_set_link":
      return {
        data: { status: "applied", study_id: args.p_study_id, study_version: version, paper_id: args.p_paper_id, link_id: uuid("b", 1), link_status: "provisional" },
        error: null,
        status: 200,
      };
    case "evidence_delete_study":
      return { data: { status: "deleted" }, error: null, status: 200 };
    default:
      return { data: { status: "applied", study_id: args.p_study_id, study_version: version, arm_ids: {}, outcome_ids: {} }, error: null, status: 200 };
  }
}

const raised = (message: string, code = "P0001", details: string | null = null, status = 400): EvidenceRpcResponse => ({
  data: null,
  error: { code, message, details, hint: null },
  status,
});

/** A promise the test settles by hand: the server's answer to a call still in flight. */
function deferred() {
  let settle!: (response: EvidenceRpcResponse | "throw") => void;
  const promise = new Promise<EvidenceRpcResponse | "throw">((resolve) => (settle = resolve));
  return { promise, settle };
}

/** The fixture record, with a quote on the comparator type too, so a group value can be confirmed. */
function reviewRows(): FixtureRows {
  const rows = fullRows();
  rows.anchors.push(
    quoteAnchorRow({ id: uuid("9", 2), value_id: VALUE_COMPARATOR_TYPE, quote_text: "metformin or placebo", match_start: 0, match_end: 20 }),
  );
  return rows;
}

const current = { base: assemble(reviewRows()) as StudyRecordData };
const refetch = vi.fn(async (): Promise<StudyRecordData | null | undefined> => current.base);
const atVersion = (version: number, rows: FixtureRows = reviewRows()) => assemble({ ...rows, study: studyRow({ row_version: version }) });

function renderEditor(canWrite = true) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  return renderHook(
    () => useStudyRecordEditor({ userId: USER, studyId: toStudyId(STUDY_ID)!, base: current.base, refetch, canWrite, client, newRequestId }),
    { wrapper },
  );
}

type Editor = ReturnType<typeof renderEditor>["result"];

const CONDITION = toValueId(VALUE_CONDITION)!;
const COMPARATOR_TYPE = toValueId(VALUE_COMPARATOR_TYPE)!;
const N_RANDOMIZED = toValueId(VALUE_N_RANDOMIZED)!;
const settingKey = valueKey(STUDY_TARGET, "setting");

async function press(result: Editor, valueId: ValueId, action: "confirm" | "flag", note: string | null = null, shownVersion?: number): Promise<ReviewOutcome> {
  const value = result.current.reviewItems.find((item) => item.value.id === valueId)?.value;
  let outcome: ReviewOutcome = { kind: "not_sent" };
  await act(async () => {
    outcome = await result.current.review({ valueId, shownVersion: shownVersion ?? value?.valueVersion ?? 1 }, action, note);
  });
  return outcome;
}

const edit = (result: Editor, change: (draft: StudyRecordDraft) => StudyRecordDraft) => act(() => result.current.update(change));
const reviewCalls = () => calls.filter((call) => call.fn === "evidence_review_fields");

beforeEach(() => {
  calls = [];
  requestCounter = 0;
  answer = (call) => applied(call);
  current.base = assemble(reviewRows());
  refetch.mockReset();
  refetch.mockImplementation(async () => current.base);
});

describe("one Confirm, exactly as prepared", () => {
  it("sends one evidence_review_fields call for one value at the version on screen, with the study version this editor knows", async () => {
    const { result } = renderEditor();
    refetch.mockImplementation(async () => (current.base = atVersion(5)));
    const outcome = await press(result, CONDITION, "confirm");

    expect(calls).toEqual([
      {
        fn: "evidence_review_fields",
        args: {
          p_study_id: STUDY_ID,
          p_expected_version: 4,
          p_value_id: VALUE_CONDITION,
          p_expected_value_version: 2,
          p_action: "confirm",
          p_note: null,
          p_request_id: uuid("7", 1),
        },
      },
    ]);
    // Nothing the server sets is sent: no status, time, version or user.
    expect(Object.keys(calls[0].args).sort()).toEqual(["p_action", "p_expected_value_version", "p_expected_version", "p_note", "p_request_id", "p_study_id", "p_value_id"]);
    expect(outcome).toEqual({ kind: "done", status: "applied", reviewStatus: "user_reviewed" });
    // Read back after the write, at the version the server answered.
    expect(refetch).toHaveBeenCalledTimes(1);
    expect(result.current.knownVersion).toBe(5);
    expect(result.current.reviewAction).toEqual({ status: "idle" });
    expect(result.current.externalChange).toBe(false);
  });

  it("sends a Confirm note as typed, and null for none", async () => {
    const { result } = renderEditor();
    await press(result, CONDITION, "confirm", "Checked against Table 1");
    expect(reviewCalls()[0].args.p_note).toBe("Checked against Table 1");
  });

  it("names the version the card showed, not a newer one the record may hold", async () => {
    const { result } = renderEditor();
    const outcome = await press(result, CONDITION, "confirm", null, 1);
    expect(outcome).toEqual({ kind: "not_sent" });
    expect(calls).toEqual([]);
    expect(result.current.reviewAction).toMatchObject({ status: "failed", valueId: CONDITION, failure: { kind: "stale_version" } });
  });

  it("treats a replayed answer as the original Confirm, and an unchanged one as already recorded", async () => {
    const { result } = renderEditor();
    answer = (call) => applied(call, "replayed");
    refetch.mockImplementation(async () => (current.base = atVersion(5)));
    expect(await press(result, CONDITION, "confirm")).toEqual({ kind: "done", status: "replayed", reviewStatus: "user_reviewed" });
    expect(result.current.knownVersion).toBe(5);

    answer = ({ args }) => ({
      data: { status: "unchanged", study_id: args.p_study_id, study_version: args.p_expected_version, value_id: args.p_value_id, value_version: args.p_expected_value_version, review_status: "disputed" },
      error: null,
      status: 200,
    });
    refetch.mockClear();
    expect(await press(result, CONDITION, "flag", "Check the methods")).toEqual({ kind: "done", status: "unchanged", reviewStatus: "disputed" });
    // Re-read at the same version: no transition is invented.
    expect(result.current.knownVersion).toBe(5);
    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it("keeps every other unsaved edit exactly as it was", async () => {
    const { result } = renderEditor();
    await edit(result, (draft) =>
      setValueEdit(result.current.baseValues, updateHeader(draft, { notes: "Unsaved study note" }), settingKey, {
        ...NOT_RECORDED_EDIT,
        state: "reported",
        content: { shape: "text", text: "Clinics (unsaved)" },
      }),
    );
    const before = result.current.draft;
    refetch.mockImplementation(async () => (current.base = atVersion(5)));
    await press(result, CONDITION, "confirm");
    expect(result.current.draft.header).toEqual(before.header);
    expect([...result.current.draft.values.entries()]).toEqual([...before.values.entries()]);
    expect(result.current.dirty).toBe(true);
  });

  it("sends one request for a double press", async () => {
    const { result } = renderEditor();
    const gate = deferred();
    answer = () => gate.promise;
    let first!: Promise<ReviewOutcome>;
    let second!: Promise<ReviewOutcome>;
    await act(async () => {
      first = result.current.review({ valueId: CONDITION, shownVersion: 2 }, "confirm", null);
      second = result.current.review({ valueId: CONDITION, shownVersion: 2 }, "confirm", null);
    });
    expect(await second).toEqual({ kind: "not_sent" });
    await act(async () => {
      gate.settle(applied(reviewCalls()[0]));
      await first;
    });
    expect(reviewCalls()).toHaveLength(1);
  });
});

describe("what is never sent", () => {
  it("sends nothing for a user the pilot does not allow", async () => {
    const { result } = renderEditor(false);
    expect(await press(result, CONDITION, "confirm")).toEqual({ kind: "not_sent" });
    expect(await press(result, CONDITION, "flag", "Check the table")).toEqual({ kind: "not_sent" });
    expect(calls).toEqual([]);
  });

  it("sends nothing for a value whose saved sources block Confirm", async () => {
    const { result } = renderEditor();
    expect(await press(result, N_RANDOMIZED, "confirm")).toEqual({ kind: "not_sent" });
    expect(calls).toEqual([]);
  });

  it("sends nothing for a value with an unsaved edit, or in a group the draft removes", async () => {
    const { result } = renderEditor();
    await edit(result, (draft) =>
      setValueEdit(result.current.baseValues, draft, valueKey(STUDY_TARGET, "condition"), { ...NOT_RECORDED_EDIT, state: "reported", content: { shape: "text", text: "T2D" } }),
    );
    expect(await press(result, CONDITION, "confirm")).toEqual({ kind: "not_sent" });
    await edit(result, (draft) => removeArm(draft, ARM_COMPARATOR));
    expect(await press(result, COMPARATOR_TYPE, "confirm")).toEqual({ kind: "not_sent" });
    expect(await press(result, COMPARATOR_TYPE, "flag", "Check the arm")).toEqual({ kind: "not_sent" });
    expect(calls).toEqual([]);
  });

  it("checks a Flag note first: too short, blank or unchanged sends nothing; a new note is sent", async () => {
    const { result } = renderEditor();
    expect(await press(result, CONDITION, "flag", "ab")).toEqual({ kind: "not_sent" });
    expect(await press(result, CONDITION, "flag", `  ${String.fromCodePoint(0x200b)}  `)).toEqual({ kind: "not_sent" });
    expect(await press(result, CONDITION, "flag", null)).toEqual({ kind: "not_sent" });
    expect(calls).toEqual([]);

    const rows = reviewRows();
    rows.values = rows.values.map((row) => (row.id === VALUE_CONDITION ? { ...row, review_status: "disputed", review_note: "Check the methods" } : row));
    refetch.mockImplementation(async () => (current.base = atVersion(5, rows)));
    await press(result, CONDITION, "flag", "abc");
    expect(reviewCalls().map((call) => [call.args.p_action, call.args.p_note])).toEqual([["flag", "abc"]]);

    // Flagged now with "Check the methods": the same note again is not sent; a different one is.
    expect(await press(result, CONDITION, "flag", "Check the methods")).toEqual({ kind: "not_sent" });
    await press(result, CONDITION, "flag", "Check the methods section");
    expect(reviewCalls().map((call) => [call.args.p_note, call.args.p_expected_version])).toEqual([
      ["abc", 4],
      ["Check the methods section", 5],
    ]);
  });
});

describe("an unknown outcome", () => {
  it("keeps the request, locks every write, and resends the SAME request on Try again — never a new id", async () => {
    const { result } = renderEditor();
    answer = () => "throw";
    expect(await press(result, CONDITION, "confirm")).toEqual({ kind: "failed" });
    expect(result.current.reviewAction).toMatchObject({ status: "uncertain", valueId: CONDITION, error: { kind: "transport_uncertain", applied: "unknown" } });
    expect(result.current.reviewPending).toBe(true);
    expect(result.current.canEdit).toBe(false);
    // Nothing is retried by itself.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(calls).toHaveLength(1);

    // Every competing write waits: an edit, a save, a link change, a deletion, another review.
    answer = (call) => applied(call);
    await edit(result, (draft) => updateHeader(draft, { label: "Other" }));
    expect(result.current.draft.header.label).toBe("Doe 2024");
    await act(async () => {
      await result.current.runSave();
      await result.current.changeLinkStatus(PAPER_ID, "mark_provisional");
      expect(await result.current.deleteStudy()).toBe(false);
    });
    expect(await press(result, COMPARATOR_TYPE, "confirm")).toEqual({ kind: "not_sent" });
    expect(calls).toHaveLength(1);

    // Try again: the identical request; the server replays the committed review.
    answer = (call) => applied(call, "replayed");
    refetch.mockImplementation(async () => (current.base = atVersion(5)));
    let retried: ReviewOutcome = { kind: "not_sent" };
    await act(async () => {
      retried = await result.current.retryReview();
    });
    expect(calls).toHaveLength(2);
    expect(calls[1]).toEqual(calls[0]);
    expect(retried).toEqual({ kind: "done", status: "replayed", reviewStatus: "user_reviewed" });
    expect(result.current.reviewAction).toEqual({ status: "idle" });
    expect(result.current.knownVersion).toBe(5);
    expect(result.current.canEdit).toBe(true);
  });

  it("treats a malformed answer as unknown too", async () => {
    const { result } = renderEditor();
    // The server says the value is flagged after a Confirm: not an answer this client trusts.
    answer = ({ args }) => ({
      data: { status: "applied", study_id: args.p_study_id, study_version: 5, value_id: args.p_value_id, value_version: 2, review_status: "disputed" },
      error: null,
      status: 200,
    });
    await press(result, CONDITION, "confirm");
    expect(result.current.reviewAction).toMatchObject({ status: "uncertain", error: { kind: "malformed_response", retry: "same_request" } });
    expect(refetch).not.toHaveBeenCalled();
  });

  it.each([
    ["the database was busy", raised("could not serialize access", "40001"), "database_busy"],
    ["the service was unavailable", { data: null, error: { message: "Too many requests" }, status: 429 } as EvidenceRpcResponse, "service_unavailable"],
    ["a gateway answered instead of the database", { data: null, error: { message: "Bad gateway" }, status: 502 } as EvidenceRpcResponse, "transport_uncertain"],
    ["the session ended", { data: null, error: { message: "JWT expired" }, status: 401 } as EvidenceRpcResponse, "auth_required"],
  ])("keeps the same request to resend when %s", async (_label, response, kind) => {
    const { result } = renderEditor();
    answer = () => response;
    await press(result, CONDITION, "confirm");
    expect(result.current.reviewAction).toMatchObject({ status: "uncertain", error: { kind } });
    answer = (call) => applied(call);
    await act(async () => {
      await result.current.retryReview();
    });
    expect(reviewCalls()).toHaveLength(2);
    expect(reviewCalls()[1]).toEqual(reviewCalls()[0]);
  });

  it("is abandoned by Reload, and the next press is a new request", async () => {
    const { result } = renderEditor();
    answer = () => "throw";
    await press(result, CONDITION, "confirm");
    refetch.mockImplementation(async () => (current.base = atVersion(4)));
    await act(async () => {
      await result.current.reload();
    });
    expect(result.current.reviewAction).toEqual({ status: "idle" });
    expect(result.current.reviewPending).toBe(false);
    // Try again has nothing left to resend.
    await act(async () => {
      expect(await result.current.retryReview()).toEqual({ kind: "not_sent" });
    });
    answer = (call) => applied(call);
    await press(result, CONDITION, "confirm");
    expect(reviewCalls().map((call) => call.args.p_request_id)).toEqual([uuid("7", 1), uuid("7", 2)]);
  });
});

describe("refusals", () => {
  it("on a version conflict, records nothing, reads nothing, and offers a reload; no review is sent against the stale version", async () => {
    const { result } = renderEditor();
    answer = () => raised("evidence_version_conflict");
    await press(result, CONDITION, "confirm");
    expect(result.current.reviewAction).toMatchObject({ status: "failed", failure: { kind: "refused", error: { kind: "version_conflict" } } });
    expect(result.current.save).toEqual({ status: "conflict", applied: 0, total: 0 });
    expect(result.current.reviewActivity).toBe("changed_elsewhere");
    expect(refetch).not.toHaveBeenCalled();
    expect(await press(result, COMPARATOR_TYPE, "confirm")).toEqual({ kind: "not_sent" });
    expect(reviewCalls()).toHaveLength(1);
  });

  it("treats a changed value version the same way", async () => {
    const { result } = renderEditor();
    answer = () => raised("evidence_version_conflict", "P0001", "p_expected_value_version");
    await press(result, CONDITION, "confirm");
    expect(result.current.reviewAction).toMatchObject({ status: "failed", failure: { error: { kind: "version_conflict", detail: { parameter: "expectedValueVersion" } } } });
    expect(result.current.save.status).toBe("conflict");
  });

  it("stops offering reviews when the pilot no longer allows them, and when the study is gone", async () => {
    const { result } = renderEditor();
    answer = () => raised("evidence_records_not_enabled", "42501", null, 403);
    await press(result, CONDITION, "confirm");
    expect(result.current.save).toEqual({ status: "not_enabled", applied: 0, total: 0 });
    expect(result.current.reviewItems.every((item) => item.confirm.kind === "none" && item.flag.kind === "none")).toBe(true);
    expect(await press(result, COMPARATOR_TYPE, "confirm")).toEqual({ kind: "not_sent" });

    const second = renderEditor();
    answer = () => raised("evidence_not_found", "P0002");
    await press(second.result, CONDITION, "confirm");
    expect(second.result.current.save).toEqual({ status: "gone" });
  });

  it("keeps the server's Confirm blocks, or none when they cannot be read", async () => {
    const { result } = renderEditor();
    answer = () => raised("evidence_confirm_blocked", "P0001", "no_current_support,note_missing");
    await press(result, CONDITION, "confirm");
    expect(result.current.reviewAction).toMatchObject({ status: "failed", failure: { error: { kind: "confirm_blocked", blocks: ["no_current_support", "note_missing"] } } });
    answer = () => raised("evidence_confirm_blocked", "P0001", "something_else");
    await press(result, CONDITION, "confirm");
    expect(result.current.reviewAction).toMatchObject({ status: "failed", failure: { error: { kind: "confirm_blocked", blocks: null } } });
    // A refusal is final for that request: each press is a new one, and nothing is resent by itself.
    expect(reviewCalls().map((call) => call.args.p_request_id)).toEqual([uuid("7", 1), uuid("7", 2)]);
    expect(result.current.save.status).toBe("idle");
  });

  it.each([
    ["a missing value", raised("evidence_target_not_found", "P0002", "p_value_id"), "target_not_found"],
    ["a reused request id", raised("evidence_request_id_reused"), "request_id_reused"],
    ["a refused note", raised("evidence_invalid_input", "22023", "p_note"), "invalid_input"],
    ["the history limit", raised("evidence_history_limit"), "history_limit"],
  ])("does not resend after %s", async (_label, response, kind) => {
    const { result } = renderEditor();
    answer = () => response;
    await press(result, CONDITION, "flag", "Check the table");
    expect(result.current.reviewAction).toMatchObject({ status: "failed", failure: { kind: "refused", error: { kind } } });
    await act(async () => {
      expect(await result.current.retryReview()).toEqual({ kind: "not_sent" });
    });
    expect(reviewCalls()).toHaveLength(1);
    act(() => result.current.clearReviewError());
    expect(result.current.reviewAction).toEqual({ status: "idle" });
  });
});

describe("other writes hold a review", () => {
  it("sends no review while a save's outcome is unknown", async () => {
    const { result } = renderEditor();
    await edit(result, (draft) => updateHeader(draft, { label: "Doe 2024 (main)" }));
    answer = () => "throw";
    await act(async () => {
      await result.current.runSave();
    });
    expect(result.current.save.status).toBe("uncertain");
    expect(result.current.reviewActivity).toBe("unresolved");
    answer = (call) => applied(call);
    expect(await press(result, CONDITION, "confirm")).toEqual({ kind: "not_sent" });
    expect(reviewCalls()).toEqual([]);
  });

  it("sends no review while a link change or a deletion is in doubt", async () => {
    const { result } = renderEditor();
    answer = () => "throw";
    await act(async () => {
      await result.current.changeLinkStatus(PAPER_ID, "mark_provisional");
    });
    expect(result.current.linkAction.status).toBe("uncertain");
    expect(await press(result, CONDITION, "confirm")).toEqual({ kind: "not_sent" });
    act(() => result.current.clearLinkError());

    await act(async () => {
      await result.current.deleteStudy();
    });
    expect(result.current.deletion.status).toBe("uncertain");
    expect(await press(result, CONDITION, "confirm")).toEqual({ kind: "not_sent" });
    expect(reviewCalls()).toEqual([]);
  });

  it("sends no review while a save is in flight, and the save waits for nothing a review holds", async () => {
    const { result } = renderEditor();
    await edit(result, (draft) => updateHeader(draft, { label: "Doe 2024 (main)" }));
    const gate = deferred();
    answer = () => gate.promise;
    let saving!: Promise<void>;
    act(() => {
      saving = result.current.runSave();
    });
    expect(result.current.reviewActivity).toBe("busy");
    expect(await press(result, CONDITION, "confirm")).toEqual({ kind: "not_sent" });
    refetch.mockImplementation(async () => (current.base = atVersion(5)));
    await act(async () => {
      gate.settle(applied(calls[0]));
      await saving;
    });
    expect(calls.map((call) => call.fn)).toEqual(["evidence_update_study"]);
  });

  it("holds every other write while a review is in flight", async () => {
    const { result } = renderEditor();
    const gate = deferred();
    answer = () => gate.promise;
    let reviewing!: Promise<ReviewOutcome>;
    act(() => {
      reviewing = result.current.review({ valueId: CONDITION, shownVersion: 2 }, "confirm", null);
    });
    expect(result.current.reviewAction).toMatchObject({ status: "working", valueId: CONDITION, action: "confirm" });
    expect(result.current.canEdit).toBe(false);
    await act(async () => {
      await result.current.runSave();
      await result.current.changeLinkStatus(PAPER_ID, "mark_provisional");
      expect(await result.current.deleteStudy()).toBe(false);
    });
    expect(await press(result, COMPARATOR_TYPE, "confirm")).toEqual({ kind: "not_sent" });
    refetch.mockImplementation(async () => (current.base = atVersion(5)));
    await act(async () => {
      gate.settle(applied(calls[0]));
      await reviewing;
    });
    expect(calls.map((call) => call.fn)).toEqual(["evidence_review_fields"]);
  });

  it("sends no review once the record is known to have changed elsewhere", async () => {
    const { result } = renderEditor();
    // A link change reads back a newer version than it wrote: another tab changed the record too.
    refetch.mockImplementation(async () => (current.base = atVersion(7)));
    await act(async () => {
      await result.current.changeLinkStatus(PAPER_ID, "mark_provisional");
    });
    expect(result.current.externalChange).toBe(true);
    expect(result.current.reviewActivity).toBe("changed_elsewhere");
    expect(await press(result, CONDITION, "confirm")).toEqual({ kind: "not_sent" });
    expect(reviewCalls()).toEqual([]);
  });
});
