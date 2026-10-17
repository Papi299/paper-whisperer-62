// @vitest-environment node
import { describe, expect, it, vi } from "vitest";

import {
  EVIDENCE_FIELD_LIMITS,
  isPreparedFieldRequest,
  prepareRebaseSource,
  prepareReviewField,
  prepareSaveChanges,
  type RebaseSourceRequest,
  type ReviewFieldRequest,
  type SaveChange,
  type SaveChangesRequest,
} from "../fieldRequests";
import { createEvidenceLifecycleClient, type EvidenceRpcClient, type EvidenceRpcResponse } from "../lifecycleClient";
import { cp, readRepoFile } from "./fixtures/vectors";

/**
 * The PR-A3 requests (EVIDENCE-RECORDS-001A3) and the adapter's three new
 * methods, against a test double of the Supabase client. The wire format is
 * checked against the migration's own key lists, so a renamed or added key on
 * either side fails here, before the server ever refuses it.
 */

const MIGRATION = "supabase/migrations/20261017155445_add_evidence_records_field_review_rebase_rpcs.sql";
const STUDY = "50000000-0000-4000-8000-000000000001";
const PAPER = "a0000000-0000-4000-8000-000000000001";
const PAPER_2 = "a0000000-0000-4000-8000-000000000002";
const COPY = "c0000000-0000-4000-8000-000000000001";
const COPY_2 = "c0000000-0000-4000-8000-000000000002";
const ARM = "a1000000-0000-4000-8000-000000000001";
const ARM_2 = "a1000000-0000-4000-8000-000000000002";
const OUTCOME = "0c000000-0000-4000-8000-000000000001";
const VALUE = "e0000000-0000-4000-8000-000000000001";
const ANCHOR = "ac000000-0000-4000-8000-000000000001";
const REQUEST = "f0000000-0000-4000-8000-000000000001";
const SHA = "a".repeat(64);

function fakeClient(...responses: (EvidenceRpcResponse | Error)[]) {
  const calls: { fn: string; args: unknown }[] = [];
  const rpc = vi.fn(async (fn: string, args: unknown) => {
    calls.push({ fn, args: structuredClone(args) });
    const next = responses.shift() ?? { data: null, error: { message: "no response scripted" }, status: 500 };
    if (next instanceof Error) throw next;
    return next;
  });
  const client = new Proxy({ rpc } as object, {
    get(target, property) {
      if (property === "rpc") return rpc;
      if (property === "then") return undefined;
      throw new Error(`the client touched .${String(property)}`);
    },
  }) as EvidenceRpcClient;
  return { client, calls, rpc };
}

const ok = (data: unknown, status = 200): EvidenceRpcResponse => ({ data, error: null, status });
const refusal = (code: string, message: string, details: string | null = null, status = 400): EvidenceRpcResponse => ({
  data: null,
  error: { code, message, details, hint: null },
  status,
});

const ALL_OPS: SaveChange[] = [
  { op: "add_arm", ref: "g1", armRole: "intervention", displayLabel: "Metformin", position: 0 },
  { op: "update_arm", armId: ARM, armRole: "comparator", displayLabel: "Placebo", position: 1 },
  { op: "remove_arm", armId: ARM_2 },
  { op: "add_outcome", ref: "o1", displayLabel: "HbA1c at 24 weeks", position: 0 },
  { op: "update_outcome", outcomeId: OUTCOME, displayLabel: "Weight", position: 1 },
  {
    op: "set_value",
    target: { scope: "study" },
    fieldKey: "n_randomized",
    expectedValueVersion: null,
    state: "reported",
    stateReason: null,
    content: { shape: "integer_with_reported_text", reportedText: "120", value: 120 },
    note: null,
    references: [
      { purpose: "supports", sourceKind: "abstract", paperId: PAPER, snapshotId: COPY, quoteText: "were randomized (n = 120)", occurrence: null, expectedMatchCount: null },
      { purpose: "supports", sourceKind: "full_text", paperId: PAPER, locator: { kind: "table", text: "Table 1" } },
      { anchorId: ANCHOR },
    ],
  },
  {
    op: "set_value",
    target: { scope: "arm", armRef: "g1" },
    fieldKey: "description",
    expectedValueVersion: 2,
    state: "not_reported",
    stateReason: null,
    content: null,
    note: null,
    references: [
      { purpose: "examined", sourceKind: "abstract", paperId: PAPER, snapshotId: COPY },
      { purpose: "examined", sourceKind: "full_text", paperId: PAPER_2, locator: null },
      { purpose: "unavailable", sourceKind: "full_text", paperId: PAPER },
    ],
  },
  { op: "clear_value", target: { scope: "outcome", outcomeId: OUTCOME }, fieldKey: "outcome_definition", expectedValueVersion: 3 },
];

const save = (changes: SaveChange[] = ALL_OPS) => prepareSaveChanges({ studyId: STUDY, expectedVersion: 7, changes, requestId: REQUEST });
const saved = (changes?: SaveChange[]): SaveChangesRequest => {
  const prepared = save(changes);
  if (!prepared.ok) throw new Error(`fixture: ${JSON.stringify(prepared.issues)}`);
  return prepared.request;
};
const review = (action: "confirm" | "flag" = "confirm", note: string | null = null) =>
  prepareReviewField({ studyId: STUDY, expectedVersion: 7, valueId: VALUE, expectedValueVersion: 4, action, note, requestId: REQUEST });
const reviewed = (action: "confirm" | "flag" = "confirm", note: string | null = action === "flag" ? "Wrong arm" : null): ReviewFieldRequest => {
  const prepared = review(action, note);
  if (!prepared.ok) throw new Error("fixture");
  return prepared.request;
};
const rebase = (sha: string = SHA) => prepareRebaseSource({ studyId: STUDY, paperId: PAPER, expectedVersion: 7, expectedAbstractSha256: sha, requestId: REQUEST });
const rebased = (): RebaseSourceRequest => {
  const prepared = rebase();
  if (!prepared.ok) throw new Error("fixture");
  return prepared.request;
};
const codes = (prepared: { ok: boolean; issues?: readonly { code: string; path: readonly (string | number)[] }[] }) =>
  prepared.ok ? [] : prepared.issues!.map((i) => `${i.code}@${i.path.join(".")}`);

// ── The migration's own key lists ────────────────────────────────────────────

const sql = readRepoFile(MIGRATION);
const keysOf = (array: string) => Array.from(array.matchAll(/'([a-z_]+)'/g), (m) => m[1]).sort();
const opKeys = new Map(Array.from(sql.matchAll(/WHEN '([a-z_]+)'\s+THEN ARRAY\[([^\]]+)\]/g), (m) => [m[1], keysOf(m[2])] as const));
const matrix = sql.slice(sql.indexOf("-- The PR-A1 matrix (FK-PROOF-001 section J): what each purpose and kind carries."));
const referenceKeys = Array.from(matrix.slice(0, matrix.indexOf("END;")).matchAll(/ARRAY\[([^\]]+)\]/g), (m) => keysOf(m[1]));

describe("the wire format is the server's", () => {
  const wire = saved().args.p_changes as Record<string, unknown>[];

  it("parses the migration's key lists", () => {
    for (const op of ["add_arm", "update_arm", "remove_arm", "add_outcome", "update_outcome", "remove_outcome", "set_value", "clear_value"]) {
      expect(opKeys.get(op), op).toBeDefined();
    }
    expect(referenceKeys).toHaveLength(4);
  });

  it("gives every change exactly the keys its operation requires", () => {
    for (const change of wire) expect(Object.keys(change).sort(), String(change.op)).toEqual(opKeys.get(String(change.op)));
  });

  it("gives every new reference exactly the keys its purpose and kind carry, and a kept one only its id", () => {
    const refs = (wire[5].references as Record<string, unknown>[]).concat(wire[6].references as Record<string, unknown>[]);
    const [abstractQuote, fullTextQuote, kept, examinedAbstract, examinedFullText, unavailable] = refs;
    expect(Object.keys(abstractQuote).sort()).toEqual(referenceKeys[0]);
    expect(Object.keys(fullTextQuote).sort()).toEqual(referenceKeys[1]);
    expect(Object.keys(examinedFullText).sort()).toEqual(referenceKeys[1]);
    expect(Object.keys(examinedAbstract).sort()).toEqual(referenceKeys[2]);
    expect(Object.keys(unavailable).sort()).toEqual(referenceKeys[3]);
    expect(kept).toEqual({ anchor_id: ANCHOR });
  });

  it("gives content the keys of its shape", () => {
    const shapes = new Map(Array.from(sql.matchAll(/WHEN '(text|code|integer_with_reported_text|text_list)' THEN ARRAY\[([^\]]+)\]/g), (m) => [m[1], keysOf(m[2])] as const));
    expect(Object.keys(wire[5].content as object).sort()).toEqual(shapes.get("integer_with_reported_text"));
    const text = saved([{ op: "set_value", target: { scope: "study" }, fieldKey: "setting", expectedValueVersion: null, state: "reported", stateReason: null, content: { shape: "text", text: "Two clinics" }, note: null, references: [] }]);
    expect(Object.keys((text.args.p_changes as Record<string, Record<string, unknown>>[])[0].content).sort()).toEqual(shapes.get("text"));
  });

  it("writes JSON null for an absent locator, occurrence and expected value version", () => {
    expect(wire[6]).toMatchObject({ expected_value_version: 2, target: { scope: "arm", arm_ref: "g1" } });
    expect((wire[5].references as Record<string, unknown>[])[0]).toMatchObject({ occurrence: null, expected_match_count: null });
    expect((wire[6].references as Record<string, unknown>[])[1]).toMatchObject({ locator_kind: null, locator_text: null });
    expect(wire[5].expected_value_version).toBeNull();
  });

  it("has no key for anything the server computes", () => {
    const text = JSON.stringify(saved().args);
    for (const key of ["match_start", "match_end", "match_occurrence", "match_count", "matched_at", "normalization_version", "reviewed_at", "reviewed_version", "review_status", "user_id", "payload_sha256", "value_version"]) {
      expect(text, key).not.toContain(`"${key}"`);
    }
  });
});

describe("preparing a save", () => {
  it("builds the exact arguments, the refs it adds, frozen through and through", () => {
    const request = saved();
    expect(request).toMatchObject({ op: "save_changes", functionName: "evidence_save_changes", studyId: STUDY, expectedVersion: 7, requestId: REQUEST, armRefs: ["g1"], outcomeRefs: ["o1"] });
    expect(Object.keys(request.args).sort()).toEqual(["p_changes", "p_expected_version", "p_request_id", "p_study_id"]);
    expect((request.args.p_changes as unknown[])[0]).toEqual({ op: "add_arm", ref: "g1", arm_role: "intervention", display_label: "Metformin", position: 0 });
    expect(Object.isFrozen(request)).toBe(true);
    expect(Object.isFrozen((request.args.p_changes as object[])[5])).toBe(true);
    expect(Object.isFrozen(((request.args.p_changes as Record<string, object[]>[])[5].references)[0])).toBe(true);
  });

  it("stores no text but as written: labels, quotes and values are never trimmed", () => {
    const request = saved([
      { op: "add_outcome", ref: "o1", displayLabel: " HbA1c ", position: 0 },
      { op: "set_value", target: { scope: "study" }, fieldKey: "setting", expectedValueVersion: null, state: "reported", stateReason: null, content: { shape: "text", text: "  Two clinics" }, note: "  checked ", references: [] },
    ]);
    const [outcome, value] = request.args.p_changes as Record<string, unknown>[];
    expect(outcome.display_label).toBe(" HbA1c ");
    expect(value).toMatchObject({ content: { text: "  Two clinics" }, note: "  checked " });
  });

  it("needs 1 to 200 changes", () => {
    expect(codes(save([]))).toEqual(["request.changes_empty@changes"]);
    const many = Array.from({ length: EVIDENCE_FIELD_LIMITS.changesPerSave + 1 }, (_, i): SaveChange => ({ op: "add_outcome", ref: `o${i}`, displayLabel: "x", position: i % 100 }));
    expect(codes(save(many))).toEqual(["request.too_many_changes@changes"]);
    expect(save(many.slice(0, 200)).ok).toBe(true);
    expect(codes(save("x" as never))).toEqual(["request.changes_not_list@changes"]);
  });

  it("refuses a bad envelope with stable codes", () => {
    const bad = prepareSaveChanges({ studyId: "study-1", expectedVersion: 0, changes: ALL_OPS, requestId: "" });
    expect(codes(bad)).toEqual(["request.study_id_invalid@studyId", "request.expected_version_invalid@expectedVersion", "request.request_id_invalid@requestId"]);
  });

  it.each<[string, SaveChange, string]>([
    ["an unknown operation", { op: "add_value" } as never, "request.change_invalid@changes.0"],
    ["an extra key", { op: "remove_arm", armId: ARM, userId: PAPER } as never, "request.change_invalid@changes.0"],
    ["a missing key", { op: "add_arm", ref: "g1", armRole: "intervention", displayLabel: "x" } as never, "request.change_invalid@changes.0"],
    ["a bad ref", { op: "add_arm", ref: "g 1", armRole: "intervention", displayLabel: "x", position: 0 }, "request.change_invalid@changes.0.ref"],
    ["a bad role", { op: "add_arm", ref: "g1", armRole: "control" as never, displayLabel: "x", position: 0 }, "request.change_invalid@changes.0.armRole"],
    ["a blank group label", { op: "add_arm", ref: "g1", armRole: "intervention", displayLabel: ` ${cp(0x200b)} `, position: 0 }, "arm.label_required@changes.0.displayLabel"],
    ["a long group label", { op: "add_arm", ref: "g1", armRole: "intervention", displayLabel: "x".repeat(121), position: 0 }, "arm.label_too_long@changes.0.displayLabel"],
    ["a long outcome label", { op: "add_outcome", ref: "o1", displayLabel: "x".repeat(201), position: 0 }, "outcome.label_too_long@changes.0.displayLabel"],
    ["a position out of range", { op: "add_outcome", ref: "o1", displayLabel: "x", position: 100 }, "request.change_invalid@changes.0.position"],
    ["a fractional position", { op: "update_outcome", outcomeId: OUTCOME, displayLabel: "x", position: 1.5 }, "request.change_invalid@changes.0.position"],
    ["a bad id", { op: "remove_outcome", outcomeId: "outcome-1" }, "request.change_invalid@changes.0.outcomeId"],
    ["an unknown field", { op: "clear_value", target: { scope: "study" }, fieldKey: "dose" as never, expectedValueVersion: 1 }, "field.unknown@changes.0.fieldKey"],
    ["a field of another scope", { op: "clear_value", target: { scope: "study" }, fieldKey: "description", expectedValueVersion: 1 }, "field.wrong_scope@changes.0.fieldKey"],
    ["a clear without a version", { op: "clear_value", target: { scope: "study" }, fieldKey: "setting", expectedValueVersion: null as never }, "request.expected_value_version_invalid@changes.0.expectedValueVersion"],
    ["a target with both an id and a ref", { op: "clear_value", target: { scope: "arm", armId: ARM, armRef: "g1" } as never, fieldKey: "description", expectedValueVersion: 1 }, "request.change_invalid@changes.0.target"],
  ])("refuses %s", (_label, change, expected) => {
    expect(codes(save([change]))).toContain(expected);
  });

  it("refuses what spans the batch: duplicates, unknown refs and changes to what it removes", () => {
    const set = (target: Record<string, unknown>): SaveChange =>
      ({ op: "set_value", target, fieldKey: "description", expectedValueVersion: null, state: "not_applicable", stateReason: null, content: null, note: "Not a drug arm", references: [] }) as unknown as SaveChange;
    expect(codes(save([{ op: "remove_arm", armId: ARM }, { op: "update_arm", armId: ARM, armRole: "comparator", displayLabel: "x", position: 0 }]))).toEqual(["request.change_invalid@changes.1.armId"]);
    expect(codes(save([{ op: "add_arm", ref: "x", armRole: "intervention", displayLabel: "x", position: 0 }, { op: "add_outcome", ref: "x", displayLabel: "x", position: 0 }]))).toEqual(["request.change_invalid@changes.1.ref"]);
    expect(codes(save([set({ scope: "arm", armRef: "nowhere" })]))).toEqual(["request.change_invalid@changes.0.target"]);
    // The removal may come after the value change: a batch is a set, not a script.
    expect(codes(save([set({ scope: "arm", armId: ARM }), { op: "remove_arm", armId: ARM }]))).toEqual(["request.change_invalid@changes.0.target"]);
    expect(codes(save([set({ scope: "arm", armId: ARM }), set({ scope: "arm", armId: ARM.toUpperCase() })]))).toEqual(["request.change_invalid@changes.1.target"]);
  });

  it("checks a value's state, reason and content shape, and leaves study-dependent rules to the server", () => {
    const value = (patch: Record<string, unknown>): SaveChange =>
      ({ op: "set_value", target: { scope: "study" }, fieldKey: "n_randomized", expectedValueVersion: null, state: "reported", stateReason: null, content: { shape: "integer_with_reported_text", reportedText: "120", value: 120 }, note: null, references: [], ...patch }) as SaveChange;
    expect(codes(save([value({ state: "done" })]))).toEqual(["state.unknown@changes.0.state"]);
    expect(codes(save([value({ state: "unclear", content: null })]))).toEqual(["state_reason.required@changes.0.stateReason"]);
    expect(codes(save([value({ stateReason: "ambiguous" })]))).toEqual(["state_reason.not_allowed@changes.0.stateReason"]);
    expect(codes(save([value({ content: { shape: "text", text: "120" } })]))).toEqual(["value.wrong_shape@changes.0.content"]);
    expect(codes(save([value({ content: { shape: "integer_with_reported_text", reported_text: "120", value: 120 } })]))).toEqual(["value.wrong_shape@changes.0.content"]);
    expect(codes(save([value({ state: "not_reported" })]))).toEqual(["value.not_allowed@changes.0.content"]);
    expect(codes(save([value({ references: "none" })]))).toEqual(["references.not_list@changes.0.references"]);
    // A Reported value without a source may be sent: the server saves it ("No source given").
    expect(save([value({})]).ok).toBe(true);
  });

  it("refuses a reference that names a server-computed field, by its exact keys", () => {
    const quote = { purpose: "supports", sourceKind: "abstract", paperId: PAPER, snapshotId: COPY, quoteText: "were randomized", occurrence: null, expectedMatchCount: null };
    const withRefs = (references: unknown[]): SaveChange =>
      ({ op: "set_value", target: { scope: "study" }, fieldKey: "setting", expectedValueVersion: null, state: "reported", stateReason: null, content: { shape: "text", text: "x" }, note: null, references }) as SaveChange;
    expect(save([withRefs([quote])]).ok).toBe(true);
    for (const forged of [{ ...quote, matchStart: 0 }, { ...quote, matchedAt: "2026-10-17T00:00:00Z" }, { anchorId: ANCHOR, matchCount: 1 }]) {
      expect(codes(save([withRefs([forged])]))).toEqual(["request.change_invalid@changes.0.references.0"]);
    }
  });

  it("pairs a chosen occurrence with the count the user saw", () => {
    const quote = (occurrence: unknown, expectedMatchCount: unknown): SaveChange =>
      ({
        op: "set_value",
        target: { scope: "study" },
        fieldKey: "setting",
        expectedValueVersion: null,
        state: "reported",
        stateReason: null,
        content: { shape: "text", text: "x" },
        note: null,
        references: [{ purpose: "supports", sourceKind: "abstract", paperId: PAPER, snapshotId: COPY, quoteText: "received drug X", occurrence, expectedMatchCount }],
      }) as SaveChange;
    expect(save([quote(2, 3)]).ok).toBe(true);
    expect(save([quote(null, null)]).ok).toBe(true);
    for (const [occurrence, count] of [[2, null], [null, 3], [4, 3], [0, 3], [1.5, 3]]) {
      expect(codes(save([quote(occurrence, count)])), `${occurrence}/${count}`).toEqual(["reference.occurrence_out_of_range@changes.0.references.0.occurrence"]);
    }
  });

  it("recognizes only what prepareSaveChanges built", () => {
    const request = saved();
    expect(isPreparedFieldRequest(request)).toBe(true);
    const changes = request.args.p_changes as Record<string, unknown>[];
    const forged = (patch: Record<string, unknown>) => ({ ...request, args: { ...request.args, ...patch } });
    expect(isPreparedFieldRequest(forged({ p_user_id: PAPER }))).toBe(false);
    expect(isPreparedFieldRequest(forged({ p_changes: [{ ...changes[0], match_start: 0 }, ...changes.slice(1)] }))).toBe(false);
    expect(isPreparedFieldRequest(forged({ p_changes: [{ ...changes[0], display_label: "   " }, ...changes.slice(1)] }))).toBe(false);
    expect(isPreparedFieldRequest({ ...request, armRefs: [] })).toBe(false);
    expect(isPreparedFieldRequest({ ...request, op: "review_fields" })).toBe(false);
    expect(isPreparedFieldRequest(null)).toBe(false);
  });
});

describe("preparing a review and a rebase", () => {
  it("binds one value at one version: there is no list", () => {
    expect(reviewed().args).toEqual({ p_study_id: STUDY, p_expected_version: 7, p_value_id: VALUE, p_expected_value_version: 4, p_action: "confirm", p_note: null, p_request_id: REQUEST });
    expect(Object.keys(reviewed("flag").args)).not.toContain("p_value_ids");
  });

  it("takes an optional Confirm note and requires a Flag note of 3 characters", () => {
    expect(review("confirm", "Checked against Table 2").ok).toBe(true);
    expect(codes(review("confirm", ` ${cp(0x00a0)} `))).toEqual(["note.blank@note"]);
    expect(codes(review("flag", null))).toEqual(["review.flag_note_required@note"]);
    expect(codes(review("flag", "ab "))).toEqual(["review.flag_note_required@note"]);
    expect(codes(review("flag", "x".repeat(2001)))).toEqual(["note.too_long@note"]);
    const noNote = prepareReviewField({ studyId: STUDY, expectedVersion: 7, valueId: VALUE, expectedValueVersion: 4, action: "confirm", note: undefined as never, requestId: REQUEST });
    expect(codes(noNote)).toEqual(["request.review_note_missing@note"]);
    expect(codes(review("approve" as never, null))).toEqual(["request.review_action_invalid@action"]);
    expect(codes(prepareReviewField({ studyId: STUDY, expectedVersion: 7, valueId: "v", expectedValueVersion: 0, action: "confirm", note: null, requestId: REQUEST }))).toEqual([
      "request.value_id_invalid@valueId",
      "request.expected_value_version_invalid@expectedValueVersion",
    ]);
  });

  it("sends the displayed abstract's SHA-256 as lowercase hex", () => {
    expect(rebased().args).toEqual({ p_study_id: STUDY, p_paper_id: PAPER, p_expected_version: 7, p_expected_abstract_sha256: SHA, p_request_id: REQUEST });
    for (const sha of ["A".repeat(64), "a".repeat(63), "", "g".repeat(64)]) expect(codes(rebase(sha))).toEqual(["request.abstract_sha256_invalid@expectedAbstractSha256"]);
  });

  it("recognizes only what the prepare functions built", () => {
    expect(isPreparedFieldRequest(reviewed())).toBe(true);
    expect(isPreparedFieldRequest(rebased())).toBe(true);
    expect(isPreparedFieldRequest({ ...reviewed(), args: { ...reviewed().args, p_reviewed_at: "now" } })).toBe(false);
    expect(isPreparedFieldRequest({ ...reviewed(), action: "flag" })).toBe(false);
    expect(isPreparedFieldRequest({ ...rebased(), args: { ...rebased().args, p_expected_abstract_sha256: "x" } })).toBe(false);
  });
});

const applied = { status: "applied", study_id: STUDY, study_version: 8, arm_ids: { g1: ARM }, outcome_ids: { o1: OUTCOME } };

describe("sending — the three new methods", () => {

  it("calls nothing on creation and exactly the matching RPC on send, with the prepared arguments", async () => {
    const { client, calls, rpc } = fakeClient(
      ok(applied),
      ok({ status: "applied", study_id: STUDY, study_version: 8, value_id: VALUE, value_version: 4, review_status: "user_reviewed" }),
      ok({ status: "applied", study_id: STUDY, study_version: 8, paper_id: PAPER, snapshot_id: COPY_2, previous_snapshot_id: COPY, seq: 2, rematched: 3, not_found: 1, ambiguous: 0, needs_rereview: 2 }),
    );
    const evidence = createEvidenceLifecycleClient(client);
    expect(rpc).not.toHaveBeenCalled();
    await evidence.saveChanges(saved());
    await evidence.reviewField(reviewed());
    await evidence.rebaseSource(rebased());
    expect(calls.map((c) => c.fn)).toEqual(["evidence_save_changes", "evidence_review_fields", "evidence_rebase_source"]);
    expect(calls[0].args).toEqual(saved().args);
  });

  it("resends the SAME request after a lost answer, and reports the replay", async () => {
    const { client, calls } = fakeClient(new Error("network down"), ok({ ...applied, status: "replayed" }));
    const evidence = createEvidenceLifecycleClient(client);
    const request = saved();
    expect(await evidence.saveChanges(request)).toMatchObject({ ok: false, error: { kind: "transport_uncertain", applied: "unknown", retry: "same_request" } });
    expect(await evidence.saveChanges(request)).toEqual({
      ok: true,
      result: { status: "replayed", studyId: STUDY, studyVersion: 8, armIds: { g1: ARM }, outcomeIds: { o1: OUTCOME } },
    });
    expect(calls[0].args).toEqual(calls[1].args);
  });

  it("refuses a hand-built or mismatched request without calling anything", async () => {
    const { client, rpc } = fakeClient();
    const evidence = createEvidenceLifecycleClient(client);
    const request = saved();
    const forged = { ...request, args: { ...request.args, p_changes: [] } } as SaveChangesRequest;
    expect(await evidence.saveChanges(forged)).toMatchObject({ ok: false, error: { kind: "invalid_request", applied: "no" } });
    expect(await evidence.reviewField(rebased() as unknown as ReviewFieldRequest)).toMatchObject({ ok: false, error: { kind: "invalid_request" } });
    expect(rpc).not.toHaveBeenCalled();
  });
});

describe("answers, checked against the request", () => {
  const run = async <R,>(response: EvidenceRpcResponse | Error, send: (l: ReturnType<typeof createEvidenceLifecycleClient>) => Promise<R>) =>
    send(createEvidenceLifecycleClient(fakeClient(response).client));
  const values = (): SaveChange[] => [ALL_OPS[5]];

  it("save: applied or replayed at the next version with the new ids; unchanged at the expected one", async () => {
    expect(await run(ok({ status: "applied", study_id: STUDY, study_version: 8, arm_ids: { g1: ARM }, outcome_ids: { o1: OUTCOME } }), (l) => l.saveChanges(saved()))).toMatchObject({
      ok: true,
      result: { status: "applied", studyVersion: 8, armIds: { g1: ARM }, outcomeIds: { o1: OUTCOME } },
    });
    expect(await run(ok({ status: "unchanged", study_id: STUDY, study_version: 7, arm_ids: {}, outcome_ids: {} }), (l) => l.saveChanges(saved(values())))).toEqual({
      ok: true,
      result: { status: "unchanged", studyId: STUDY, studyVersion: 7, armIds: {}, outcomeIds: {} },
    });
  });

  it("review: the status its action leads to, at the value version reviewed", async () => {
    expect(await run(ok({ status: "applied", study_id: STUDY, study_version: 8, value_id: VALUE, value_version: 4, review_status: "disputed" }), (l) => l.reviewField(reviewed("flag")))).toEqual({
      ok: true,
      result: { status: "applied", studyId: STUDY, studyVersion: 8, valueId: VALUE, valueVersion: 4, reviewStatus: "disputed" },
    });
    expect(await run(ok({ status: "unchanged", study_id: STUDY, study_version: 7, value_id: VALUE, value_version: 4, review_status: "user_reviewed" }), (l) => l.reviewField(reviewed()))).toMatchObject({
      ok: true,
      result: { status: "unchanged", studyVersion: 7 },
    });
  });

  it("rebase: a new copy with its re-match counts; a first capture; the same text unchanged", async () => {
    const answer = { status: "applied", study_id: STUDY, study_version: 8, paper_id: PAPER, snapshot_id: COPY_2, previous_snapshot_id: COPY, seq: 2, rematched: 3, not_found: 1, ambiguous: 1, needs_rereview: 2 };
    expect(await run(ok(answer), (l) => l.rebaseSource(rebased()))).toEqual({
      ok: true,
      result: { status: "applied", studyId: STUDY, studyVersion: 8, paperId: PAPER, snapshotId: COPY_2, previousSnapshotId: COPY, seq: 2, rematched: 3, notFound: 1, ambiguous: 1, needsRereview: 2 },
    });
    expect(await run(ok({ ...answer, previous_snapshot_id: null, seq: 1, rematched: 0, not_found: 0, ambiguous: 0 }), (l) => l.rebaseSource(rebased()))).toMatchObject({ ok: true, result: { seq: 1, previousSnapshotId: null } });
    expect(await run(ok({ ...answer, status: "unchanged", study_version: 7, previous_snapshot_id: null, rematched: 0, not_found: 0, ambiguous: 0, needs_rereview: 0 }), (l) => l.rebaseSource(rebased()))).toMatchObject({
      ok: true,
      result: { status: "unchanged", studyVersion: 7, snapshotId: COPY_2 },
    });
  });

  const rebaseAnswer = { status: "applied", study_id: STUDY, study_version: 8, paper_id: PAPER, snapshot_id: COPY_2, previous_snapshot_id: COPY, seq: 2, rematched: 0, not_found: 0, ambiguous: 0, needs_rereview: 0 };
  const reviewAnswer = { status: "applied", study_id: STUDY, study_version: 8, value_id: VALUE, value_version: 4, review_status: "user_reviewed" };
  it.each<[string, EvidenceRpcResponse, (l: ReturnType<typeof createEvidenceLifecycleClient>) => Promise<unknown>]>([
    ["a save with an extra key", ok({ ...applied, user_id: PAPER }), (l) => l.saveChanges(saved())],
    ["a save missing a new group's id", ok({ ...applied, arm_ids: {} }), (l) => l.saveChanges(saved())],
    ["a save naming a group it did not add", ok({ ...applied, arm_ids: { g1: ARM, g2: ARM_2 } }), (l) => l.saveChanges(saved())],
    [
      "a save giving two new groups one id",
      ok({ ...applied, arm_ids: { g1: ARM, g2: ARM }, outcome_ids: {} }),
      (l) => l.saveChanges(saved([ALL_OPS[0], { op: "add_arm", ref: "g2", armRole: "comparator", displayLabel: "Placebo", position: 1 }])),
    ],
    ["an unchanged save that added a group", ok({ ...applied, status: "unchanged", study_version: 7, arm_ids: {}, outcome_ids: {} }), (l) => l.saveChanges(saved())],
    ["a save at a version that does not follow", ok({ ...applied, study_version: 9 }), (l) => l.saveChanges(saved())],
    ["another study's save", ok({ ...applied, study_id: PAPER }), (l) => l.saveChanges(saved())],
    ["a review of another value", ok({ ...reviewAnswer, value_id: ANCHOR }), (l) => l.reviewField(reviewed())],
    ["a review that moved the value version", ok({ ...reviewAnswer, value_version: 5 }), (l) => l.reviewField(reviewed())],
    ["a Confirm answered as a Flag", ok({ ...reviewAnswer, review_status: "disputed" }), (l) => l.reviewField(reviewed())],
    ["a rebase of another paper", ok({ ...rebaseAnswer, paper_id: PAPER_2 }), (l) => l.rebaseSource(rebased())],
    ["a rebase replacing itself", ok({ ...rebaseAnswer, previous_snapshot_id: COPY_2 }), (l) => l.rebaseSource(rebased())],
    ["a later copy that replaced nothing", ok({ ...rebaseAnswer, previous_snapshot_id: null }), (l) => l.rebaseSource(rebased())],
    ["a first copy that replaced one", ok({ ...rebaseAnswer, seq: 1 }), (l) => l.rebaseSource(rebased())],
    ["a copy past the limit", ok({ ...rebaseAnswer, seq: 21 }), (l) => l.rebaseSource(rebased())],
    ["a negative count", ok({ ...rebaseAnswer, rematched: -1 }), (l) => l.rebaseSource(rebased())],
    ["an unchanged rebase that moved something", ok({ ...rebaseAnswer, status: "unchanged", study_version: 7, previous_snapshot_id: null, needs_rereview: 1 }), (l) => l.rebaseSource(rebased())],
    ["no body", ok(null), (l) => l.rebaseSource(rebased())],
  ])("fails closed on %s", async (_label, response, send) => {
    expect(await run(response, send)).toMatchObject({ ok: false, error: { kind: "malformed_response", applied: "unknown" } });
  });

  it("classifies a refusal, with where it points and what to do next", async () => {
    expect(await run(refusal("22023", "evidence_invalid_input", "p_changes[5].references[0].snapshot_id: not_current"), (l) => l.saveChanges(saved()))).toMatchObject({
      ok: false,
      error: { kind: "invalid_input", applied: "no", retry: "none", detail: { parameter: "changes", path: [5, "references", 0, "snapshot_id"], rules: ["not_current"] } },
    });
    expect(await run(refusal("P0001", "evidence_quote_not_found", "p_changes[5].references[0]"), (l) => l.saveChanges(saved()))).toMatchObject({ ok: false, error: { kind: "quote_not_found" } });
    expect(await run(refusal("P0001", "evidence_confirm_blocked", "no_current_support"), (l) => l.reviewField(reviewed()))).toMatchObject({
      ok: false,
      error: { kind: "confirm_blocked", blocks: ["no_current_support"] },
    });
    expect(await run(refusal("P0001", "evidence_source_changed_again"), (l) => l.rebaseSource(rebased()))).toMatchObject({
      ok: false,
      error: { kind: "source_changed_again", retry: "new_request_after_reload" },
    });
    expect(await run(refusal("P0001", "evidence_snapshot_limit"), (l) => l.rebaseSource(rebased()))).toMatchObject({ ok: false, error: { kind: "snapshot_limit", category: "limit" } });
  });
});
