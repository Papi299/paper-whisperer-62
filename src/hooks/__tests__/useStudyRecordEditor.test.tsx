import { act, renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { toStudyId } from "@/lib/evidence/ids";
import { createEvidenceLifecycleClient, type EvidenceRpcClient, type EvidenceRpcResponse } from "@/lib/evidence/lifecycleClient";
import {
  addOutcome,
  NOT_RECORDED_EDIT,
  outcomeTarget,
  setValueEdit,
  STUDY_TARGET,
  updateHeader,
  valueKey,
  type StudyRecordDraft,
} from "@/lib/studyRecord/draft";
import type { StudyRecordData } from "@/lib/studyRecord/read";
import { assemble, fullRows, PAPER_ID, STUDY_ID, studyRow, USER, uuid } from "@/lib/studyRecord/__tests__/fixtures";
import { useStudyRecordEditor } from "../useStudyRecordEditor";

/**
 * The Study Record editor's writes (EVIDENCE-RECORDS-001C1), through PR-B's
 * real typed client over a scripted RPC: what is sent, in which steps, with
 * which request ids and expected versions — and what happens to the user's
 * draft when a step is refused, conflicts, or has an unknown outcome.
 */

interface Call {
  readonly fn: string;
  readonly args: Record<string, unknown>;
}

let calls: Call[];
let answer: (call: Call) => EvidenceRpcResponse | "throw";
let requestCounter: number;
const newRequestId = () => uuid("7", ++requestCounter);

const rpcClient: EvidenceRpcClient = {
  rpc: (async (fn: string, args: Record<string, unknown>) => {
    const call = { fn, args: structuredClone(args) };
    calls.push(call);
    const response = answer(call);
    if (response === "throw") throw new TypeError("Failed to fetch");
    return response;
  }) as EvidenceRpcClient["rpc"],
};
const client = createEvidenceLifecycleClient(rpcClient);

/** What the server answers when it applies a call. */
function applied({ fn, args }: Call): EvidenceRpcResponse {
  const version = (args.p_expected_version as number) + 1;
  if (fn === "evidence_update_study") return { data: { status: "applied", study_id: args.p_study_id, study_version: version }, error: null, status: 200 };
  if (fn === "evidence_delete_study") return { data: { status: "deleted" }, error: null, status: 200 };
  if (fn === "evidence_set_link") {
    return {
      data: { status: "applied", study_id: args.p_study_id, study_version: version, paper_id: args.p_paper_id, link_id: uuid("b", 1), link_status: args.p_action === "confirm" ? "user_confirmed" : "provisional" },
      error: null,
      status: 200,
    };
  }
  const changes = args.p_changes as Record<string, unknown>[];
  const ids = (op: string, prefix: string) =>
    Object.fromEntries(changes.filter((c) => c.op === op).map((c, i) => [c.ref as string, uuid(prefix, 500 + version * 100 + i)]));
  return {
    data: { status: "applied", study_id: args.p_study_id, study_version: version, arm_ids: ids("add_arm", "d"), outcome_ids: ids("add_outcome", "e") },
    error: null,
    status: 200,
  };
}

const raised = (message: string, code = "P0001", details: string | null = null): EvidenceRpcResponse => ({
  data: null,
  error: { code, message, details, hint: null },
  status: 400,
});

const current = { base: assemble() as StudyRecordData };
const refetch = vi.fn(async (): Promise<StudyRecordData | null | undefined> => current.base);

/** The record as the server would return it at `version` (contents as before; tests only need the version). */
const atVersion = (version: number, label = "Doe 2024") => assemble({ ...fullRows(), study: studyRow({ row_version: version, label }) });

function renderEditor(canWrite = true) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  return renderHook(
    () => useStudyRecordEditor({ userId: USER, studyId: toStudyId(STUDY_ID)!, base: current.base, refetch, canWrite, client, newRequestId }),
    { wrapper },
  );
}

type Editor = ReturnType<typeof renderEditor>["result"];
const edit = (result: Editor, change: (draft: StudyRecordDraft) => StudyRecordDraft) => act(() => result.current.update(change));
const save = (result: Editor) => act(async () => {
  await result.current.runSave();
});

const conditionKey = valueKey(STUDY_TARGET, "condition");
const settingKey = valueKey(STUDY_TARGET, "setting");
const reported = (text: string) => ({ ...NOT_RECORDED_EDIT, state: "reported" as const, content: { shape: "text" as const, text } });

beforeEach(() => {
  calls = [];
  requestCounter = 0;
  answer = applied;
  current.base = assemble();
  refetch.mockReset();
  refetch.mockImplementation(async () => current.base);
});

describe("Save", () => {
  it("sends one save_changes call with the versions the user started from", async () => {
    const { result } = renderEditor();
    await edit(result, (draft) => setValueEdit(result.current.baseValues, draft, conditionKey, reported("Type 2 diabetes")));
    expect(result.current.dirty).toBe(true);
    refetch.mockImplementation(async () => (current.base = atVersion(5)));

    await save(result);

    expect(calls).toEqual([
      {
        fn: "evidence_save_changes",
        args: {
          p_study_id: STUDY_ID,
          p_expected_version: 4,
          p_request_id: uuid("7", 1),
          p_changes: [
            {
              op: "set_value",
              target: { scope: "study" },
              field_key: "condition",
              expected_value_version: 2,
              value_state: "reported",
              state_reason: null,
              content: { shape: "text", text: "Type 2 diabetes" },
              note: null,
              // The edit replaced the value's sources: none are kept.
              references: [],
            },
          ],
        },
      },
    ]);
    expect(result.current.save).toEqual({ status: "saved", total: 1 });
    expect(result.current.knownVersion).toBe(5);
    expect(result.current.draft.values.size).toBe(0);
    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it("sends nothing the server generates: no offsets, counts, match times, review or extraction fields", async () => {
    const { result } = renderEditor();
    await edit(result, (draft) =>
      setValueEdit(result.current.baseValues, draft, settingKey, {
        ...reported("Outpatient clinics"),
        references: [
          {
            kind: "new",
            localId: "ref_1",
            reference: { purpose: "supports", sourceKind: "abstract", paperId: PAPER_ID as never, snapshotId: uuid("c", 1) as never, quoteText: "metformin or placebo", occurrence: null, expectedMatchCount: null },
          },
          { kind: "new", localId: "ref_2", reference: { purpose: "supports", sourceKind: "full_text", paperId: PAPER_ID as never, locator: { kind: "page", text: "p. 4" } } },
        ],
      }),
    );
    await save(result);
    const sent = JSON.stringify(calls[0].args);
    // Keys only: `expected_match_count` (the count the user saw) is the client's to send.
    expect(sent).not.toMatch(/"(match_start|match_end|match_count|match_occurrence|matched_at|normalized_[a-z_]+|normalization_version|review_[a-z_]+|reviewed_[a-z_]+|extraction_method|attestation|exact_text|value_version|anchor_id)"/);
    expect((calls[0].args.p_changes as { references: unknown[] }[])[0].references).toEqual([
      { purpose: "supports", source_kind: "abstract", paper_id: PAPER_ID, snapshot_id: uuid("c", 1), quote_text: "metformin or placebo", occurrence: null, expected_match_count: null },
      { purpose: "supports", source_kind: "full_text", paper_id: PAPER_ID, locator_kind: "page", locator_text: "p. 4" },
    ]);
  });

  it("calls only the study-record RPCs, never a paper write", async () => {
    const { result } = renderEditor();
    await edit(result, (draft) => setValueEdit(result.current.baseValues, updateHeader(draft, { label: "Doe 2024 (main)" }), conditionKey, reported("T2D")));
    refetch.mockImplementation(async () => (current.base = atVersion(6, "Doe 2024 (main)")));
    await save(result);
    expect(calls.map((call) => call.fn)).toEqual(["evidence_update_study", "evidence_save_changes"]);
  });

  it("does not send a draft the browser's checks refuse", async () => {
    const { result } = renderEditor();
    await edit(result, (draft) => updateHeader(draft, { label: "   " }));
    await save(result);
    expect(calls).toEqual([]);
    expect(result.current.save.status).toBe("invalid");
  });

  it("does not send anything, or accept edits, for a user the pilot does not allow", async () => {
    const { result } = renderEditor(false);
    await edit(result, (draft) => updateHeader(draft, { label: "Changed" }));
    expect(result.current.dirty).toBe(false);
    await save(result);
    expect(calls).toEqual([]);
  });
});

describe("an unknown outcome", () => {
  it("locks the draft and resends the SAME request on Try again — never a fresh id", async () => {
    const { result } = renderEditor();
    await edit(result, (draft) => setValueEdit(result.current.baseValues, draft, conditionKey, reported("T2D")));
    answer = () => "throw";
    await save(result);
    expect(result.current.save).toMatchObject({ status: "uncertain", applied: 0, total: 1 });
    expect(result.current.canEdit).toBe(false);
    // Nothing is retried automatically.
    expect(calls).toHaveLength(1);

    // An edit while the outcome is unknown is refused.
    await edit(result, (draft) => updateHeader(draft, { label: "Other" }));
    expect(result.current.draft.header.label).toBe("Doe 2024");

    answer = applied;
    refetch.mockImplementation(async () => (current.base = atVersion(5)));
    await save(result);
    expect(calls).toHaveLength(2);
    expect(calls[1]).toEqual(calls[0]);
    expect(result.current.save).toEqual({ status: "saved", total: 1 });
  });

  it("treats a replayed answer as success", async () => {
    const { result } = renderEditor();
    await edit(result, (draft) => setValueEdit(result.current.baseValues, draft, conditionKey, reported("T2D")));
    answer = (call) => {
      const response = applied(call);
      return { ...response, data: { ...(response.data as object), status: "replayed" } };
    };
    await save(result);
    expect(result.current.save.status).toBe("saved");
  });
});

describe("refusals", () => {
  it("keeps every edit on a version conflict and offers a reload, never an automatic rebase", async () => {
    const { result } = renderEditor();
    await edit(result, (draft) => setValueEdit(result.current.baseValues, draft, conditionKey, reported("T2D")));
    answer = () => raised("evidence_version_conflict");
    await save(result);
    expect(result.current.save).toEqual({ status: "conflict", applied: 0, total: 1 });
    expect(result.current.draft.values.get(conditionKey)?.content).toEqual({ shape: "text", text: "T2D" });
    expect(refetch).not.toHaveBeenCalled();

    refetch.mockImplementation(async () => (current.base = atVersion(7)));
    await act(async () => {
      await result.current.reload();
    });
    expect(result.current.draft.values.size).toBe(0);
    expect(result.current.knownVersion).toBe(7);
    expect(result.current.save).toEqual({ status: "idle" });
  });

  it("says the pilot no longer allows editing, distinctly, and keeps the draft", async () => {
    const { result } = renderEditor();
    await edit(result, (draft) => setValueEdit(result.current.baseValues, draft, conditionKey, reported("T2D")));
    answer = () => raised("evidence_records_not_enabled", "42501");
    await save(result);
    expect(result.current.save).toEqual({ status: "not_enabled", applied: 0, total: 1 });
    expect(result.current.canEdit).toBe(false);
    expect(result.current.draft.values.has(conditionKey)).toBe(true);
  });

  it("points a refused value at its input", async () => {
    const { result } = renderEditor();
    await edit(result, (draft) => setValueEdit(result.current.baseValues, draft, conditionKey, reported("T2D")));
    answer = () => raised("evidence_quote_not_found", "P0001", "p_changes[0].references[0].quote_text: not_found");
    await save(result);
    expect(result.current.save).toMatchObject({ status: "failed", target: { kind: "value", key: conditionKey } });
  });

  it("reports partial progress when a later step fails, and keeps what was not saved", async () => {
    const { result } = renderEditor();
    await edit(result, (draft) => setValueEdit(result.current.baseValues, updateHeader(draft, { label: "Doe 2024 (main)" }), conditionKey, reported("T2D")));
    answer = (call) => (call.fn === "evidence_update_study" ? applied(call) : raised("evidence_invalid_input", "22023", "p_changes[0].content: invalid"));
    refetch.mockImplementation(async () => (current.base = atVersion(5, "Doe 2024 (main)")));
    await save(result);

    expect(calls.map((call) => [call.fn, call.args.p_expected_version])).toEqual([
      ["evidence_update_study", 4],
      ["evidence_save_changes", 5],
    ]);
    expect(result.current.save).toMatchObject({ status: "failed", applied: 1, total: 2 });
    expect(result.current.knownVersion).toBe(5);
    expect(result.current.draft.values.has(conditionKey)).toBe(true);
    // The saved header is no longer a change.
    expect(result.current.draft.header.label).toBe(current.base.header.label);
  });

  it("knows when the study is gone", async () => {
    const { result } = renderEditor();
    await edit(result, (draft) => setValueEdit(result.current.baseValues, draft, conditionKey, reported("T2D")));
    answer = () => raised("evidence_not_found", "P0002");
    await save(result);
    expect(result.current.save).toEqual({ status: "gone" });
  });
});

describe("a save larger than one call", () => {
  it("sends several atomic batches, names groups an earlier batch created by their new ids, and never drops a change", async () => {
    const { result } = renderEditor();
    const fields = ["outcome_name_as_reported", "outcome_definition", "measurement_instrument", "outcome_designation", "time_points"] as const;
    await edit(result, (initial) => {
      let draft = initial;
      for (let n = 1; n <= 41; n += 1) {
        const added = addOutcome(draft, `Outcome ${n}`);
        draft = added.draft;
        for (const field of fields) {
          const content =
            field === "outcome_designation"
              ? { shape: "code" as const, code: "secondary" }
              : field === "time_points"
                ? { shape: "text_list" as const, entries: ["12 weeks"] }
                : { shape: "text" as const, text: `${field} ${n}` };
          draft = setValueEdit(result.current.baseValues, draft, valueKey(outcomeTarget(added.key), field), { ...NOT_RECORDED_EDIT, state: "reported", content });
        }
      }
      return draft;
    });
    refetch.mockImplementation(async () => (current.base = atVersion(6)));
    await save(result);

    expect(calls.map((call) => (call.args.p_changes as unknown[]).length)).toEqual([200, 46]);
    expect(calls.map((call) => call.args.p_expected_version)).toEqual([4, 5]);
    expect(new Set(calls.map((call) => call.args.p_request_id)).size).toBe(2);
    const second = calls[1].args.p_changes as { target: Record<string, unknown> }[];
    // Every value in the second batch names an outcome the first batch created, by id.
    const created = new Set(Object.values((applied(calls[0]).data as { outcome_ids: Record<string, string> }).outcome_ids));
    for (const change of second) {
      expect(change.target.outcome_ref).toBeUndefined();
      expect(created.has(change.target.outcome_id as string)).toBe(true);
    }
    expect(result.current.save).toEqual({ status: "saved", total: 2 });
  });

  it("stops at the failed batch, keeps the earlier one saved, and resumes with the same request", async () => {
    const { result } = renderEditor();
    await edit(result, (initial) => {
      let draft = initial;
      for (let n = 1; n <= 41; n += 1) {
        const added = addOutcome(draft, `Outcome ${n}`);
        draft = added.draft;
        for (const field of ["outcome_name_as_reported", "outcome_definition", "measurement_instrument", "time_points", "outcome_designation"] as const) {
          const content =
            field === "outcome_designation" ? { shape: "code" as const, code: "primary" } : field === "time_points" ? { shape: "text_list" as const, entries: ["6 months"] } : { shape: "text" as const, text: `x ${n}` };
          draft = setValueEdit(result.current.baseValues, draft, valueKey(outcomeTarget(added.key), field), { ...NOT_RECORDED_EDIT, state: "reported", content });
        }
      }
      return draft;
    });
    answer = (call) => (calls.length === 2 ? "throw" : applied(call));
    await save(result);
    expect(result.current.save).toMatchObject({ status: "uncertain", applied: 1, total: 2 });

    answer = applied;
    refetch.mockImplementation(async () => (current.base = atVersion(6)));
    await save(result);
    expect(calls).toHaveLength(3);
    expect(calls[2]).toEqual(calls[1]);
    expect(result.current.save).toEqual({ status: "saved", total: 2 });
  });
});

describe("Delete study record", () => {
  it("is available to a user the pilot no longer allows to edit", async () => {
    const { result } = renderEditor(false);
    let deleted = false;
    await act(async () => {
      deleted = await result.current.deleteStudy();
    });
    expect(deleted).toBe(true);
    expect(calls).toEqual([{ fn: "evidence_delete_study", args: { p_study_id: STUDY_ID, p_expected_version: 4, p_request_id: uuid("7", 1) } }]);
  });

  it("resends the same request after an unknown outcome, and accepts 'already absent'", async () => {
    const { result } = renderEditor();
    answer = () => "throw";
    await act(async () => {
      await result.current.deleteStudy();
    });
    expect(result.current.deletion.status).toBe("uncertain");
    answer = () => ({ data: { status: "already_absent" }, error: null, status: 200 });
    let deleted = false;
    await act(async () => {
      deleted = await result.current.deleteStudy();
    });
    expect(deleted).toBe(true);
    expect(calls[1]).toEqual(calls[0]);
  });

  it("keeps the record on a version conflict", async () => {
    const { result } = renderEditor();
    answer = () => raised("evidence_version_conflict");
    let deleted = true;
    await act(async () => {
      deleted = await result.current.deleteStudy();
    });
    expect(deleted).toBe(false);
    expect(result.current.deletion).toMatchObject({ status: "failed", error: { kind: "version_conflict" } });
  });
});

describe("link status", () => {
  it("confirms the link at the version on screen and reads the record back", async () => {
    const { result } = renderEditor();
    refetch.mockImplementation(async () => (current.base = atVersion(5)));
    await act(async () => {
      await result.current.changeLinkStatus(PAPER_ID, "mark_provisional");
    });
    expect(calls).toEqual([
      { fn: "evidence_set_link", args: { p_study_id: STUDY_ID, p_paper_id: PAPER_ID, p_action: "mark_provisional", p_expected_version: 4, p_request_id: uuid("7", 1) } },
    ]);
    expect(result.current.knownVersion).toBe(5);
    expect(result.current.linkAction).toEqual({ status: "idle" });
  });
});
