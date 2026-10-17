// @vitest-environment node
import { describe, expect, it, vi } from "vitest";

import { createEvidenceLifecycleClient, type EvidenceRpcClient, type EvidenceRpcResponse } from "../lifecycleClient";
import {
  isPreparedRequest,
  prepareCreateStudy,
  prepareDeleteStudy,
  prepareSetLink,
  prepareUpdateStudy,
  type CreateStudyRequest,
  type DeleteStudyRequest,
  type SetLinkRequest,
  type UpdateStudyRequest,
} from "../lifecycleRequests";

/**
 * The lifecycle client against a test double of the Supabase client. No
 * network, no real client: the double records every call and throws if the
 * adapter touches anything other than `rpc`.
 */

const PAPER = "a0000000-0000-4000-8000-000000000001";
const PAPER_2 = "a0000000-0000-4000-8000-000000000002";
const STUDY = "50000000-0000-4000-8000-000000000001";
const LINK = "10000000-0000-4000-8000-000000000001";
const COPY = "c0000000-0000-4000-8000-000000000001";
const REQUEST = "f0000000-0000-4000-8000-000000000001";
const REQUEST_UPPER = "F0000000-0000-4000-8000-0000000000AB";

function fakeClient(...responses: (EvidenceRpcResponse | Error)[]) {
  const calls: { fn: string; args: unknown }[] = [];
  const rpc = vi.fn(async (fn: string, args: unknown) => {
    calls.push({ fn, args: structuredClone(args) });
    const next = responses.shift() ?? { data: null, error: { message: "no response scripted" }, status: 500 };
    if (next instanceof Error) throw next;
    return next;
  });
  // Only `rpc` exists: touching `from`, `functions`, `storage`, `auth`, ... throws.
  const client = new Proxy({ rpc } as object, {
    get(target, property) {
      if (property === "rpc") return rpc;
      if (property === "then") return undefined;
      throw new Error(`the lifecycle client touched .${String(property)}`);
    },
  }) as EvidenceRpcClient;
  return { client, calls, rpc };
}

const ok = (data: unknown, status = 200): EvidenceRpcResponse => ({ data, error: null, status });
const refusal = (code: string, message: string, status = 400, details: string | null = null): EvidenceRpcResponse => ({
  data: null,
  error: { code, message, details, hint: null },
  status,
});

const create = () => {
  const prepared = prepareCreateStudy({ paperId: PAPER, label: "Smith 2021", designProfile: "rct_parallel", linkStatus: "user_confirmed", requestId: REQUEST });
  if (!prepared.ok) throw new Error("fixture");
  return prepared.request;
};
const update = (notes: string | null = null) => {
  const prepared = prepareUpdateStudy({ studyId: STUDY, expectedVersion: 3, label: "Smith 2021", designProfile: "intervention_other", notes, requestId: REQUEST });
  if (!prepared.ok) throw new Error("fixture");
  return prepared.request;
};
const setLink = (action: "confirm" | "mark_provisional" | "remove") => {
  const prepared = prepareSetLink({ studyId: STUDY, paperId: PAPER, action, expectedVersion: 3, requestId: REQUEST });
  if (!prepared.ok) throw new Error("fixture");
  return prepared.request;
};
const remove = () => {
  const prepared = prepareDeleteStudy({ studyId: STUDY, expectedVersion: 3, requestId: REQUEST });
  if (!prepared.ok) throw new Error("fixture");
  return prepared.request;
};

describe("preparing requests", () => {
  it("builds exactly the deployed arguments, request id included, frozen", () => {
    expect(create().args).toEqual({ p_paper_id: PAPER, p_label: "Smith 2021", p_design_profile: "rct_parallel", p_link_status: "user_confirmed", p_request_id: REQUEST });
    expect(update("Recruited in two waves.").args).toEqual({ p_study_id: STUDY, p_expected_version: 3, p_label: "Smith 2021", p_design_profile: "intervention_other", p_notes: "Recruited in two waves.", p_request_id: REQUEST });
    expect(setLink("confirm").args).toEqual({ p_study_id: STUDY, p_paper_id: PAPER, p_action: "confirm", p_expected_version: 3, p_request_id: REQUEST });
    expect(remove().args).toEqual({ p_study_id: STUDY, p_expected_version: 3, p_request_id: REQUEST });
    expect(Object.isFrozen(create())).toBe(true);
    expect(Object.isFrozen(create().args)).toBe(true);
  });

  it("sends null notes explicitly, as a present argument", () => {
    const args = update(null).args as Record<string, unknown>;
    expect("p_notes" in args).toBe(true);
    expect(args.p_notes).toBeNull();
    const missing = prepareUpdateStudy({ studyId: STUDY, expectedVersion: 3, label: "x", designProfile: "rct_parallel", notes: undefined as never, requestId: REQUEST });
    expect(missing).toMatchObject({ ok: false, issues: [{ code: "request.notes_missing" }] });
    expect(prepareUpdateStudy({ studyId: STUDY, expectedVersion: 3, label: "x", designProfile: "rct_parallel", notes: "", requestId: REQUEST })).toMatchObject({ ok: false, issues: [{ code: "study.notes_blank" }] });
  });

  it("requires a caller-supplied request id and never makes one up", () => {
    const bad = prepareCreateStudy({ paperId: PAPER, label: "x", designProfile: "rct_parallel", linkStatus: "provisional", requestId: "" });
    expect(bad).toMatchObject({ ok: false, issues: [{ code: "request.request_id_invalid", path: ["requestId"] }] });
    const upper = prepareCreateStudy({ paperId: PAPER, label: "x", designProfile: "rct_parallel", linkStatus: "provisional", requestId: REQUEST_UPPER });
    expect(upper.ok && upper.request.requestId).toBe(REQUEST_UPPER.toLowerCase());
  });

  it("refuses invalid input with stable codes, before anything is sent", () => {
    const result = prepareCreateStudy({ paperId: "paper-1", label: " ", designProfile: "rct" as never, linkStatus: "maybe" as never, requestId: REQUEST });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.map((i) => i.code)).toEqual(["request.paper_id_invalid", "study.label_required", "study.design_profile_required", "study.link_status_required"]);
    expect(prepareSetLink({ studyId: STUDY, paperId: PAPER, action: "add" as never, expectedVersion: 0, requestId: REQUEST })).toMatchObject({
      ok: false,
      issues: [{ code: "request.expected_version_invalid" }, { code: "request.link_action_invalid" }],
    });
    expect(prepareDeleteStudy({ studyId: STUDY, expectedVersion: 2 ** 31, requestId: REQUEST })).toMatchObject({ ok: false });
    expect(prepareUpdateStudy({ studyId: STUDY, expectedVersion: 1, label: "x".repeat(121), designProfile: "rct_parallel", notes: null, requestId: REQUEST })).toMatchObject({
      ok: false,
      issues: [{ code: "study.label_too_long" }],
    });
  });

  it("recognizes only what a prepare function built", () => {
    expect(isPreparedRequest(create())).toBe(true);
    expect(isPreparedRequest({ ...create(), args: { ...create().args, p_user_id: PAPER } })).toBe(false);
    expect(isPreparedRequest({ ...create(), args: { ...create().args, p_label: "   " } })).toBe(false);
    expect(isPreparedRequest({ ...create(), op: "delete_study" })).toBe(false);
    expect(isPreparedRequest(null)).toBe(false);
  });
});

describe("sending — nothing happens until a request is sent", () => {
  it("calls nothing on creation", () => {
    const { client, rpc } = fakeClient();
    createEvidenceLifecycleClient(client);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("calls exactly the matching RPC, by its literal name, with the prepared arguments", async () => {
    const { client, calls } = fakeClient(
      ok({ status: "applied", study_id: STUDY, study_version: 1, link_id: LINK, snapshot_id: COPY }),
      ok({ status: "applied", study_id: STUDY, study_version: 4 }),
      ok({ status: "applied", study_id: STUDY, study_version: 4, paper_id: PAPER, link_id: LINK, link_status: "user_confirmed" }),
      ok({ status: "deleted" }),
    );
    const lifecycle = createEvidenceLifecycleClient(client);
    await lifecycle.createStudyFromPaper(create());
    await lifecycle.updateStudy(update());
    await lifecycle.setLink(setLink("confirm"));
    await lifecycle.deleteStudy(remove());
    expect(calls.map((c) => c.fn)).toEqual(["evidence_create_study_from_paper", "evidence_update_study", "evidence_set_link", "evidence_delete_study"]);
    expect(calls[1].args).toEqual(update().args);
  });

  it("resends the SAME request on retry: same request id, same arguments", async () => {
    const { client, calls } = fakeClient(new Error("network down"), ok({ status: "replayed", study_id: STUDY, study_version: 1, link_id: LINK, snapshot_id: null }));
    const lifecycle = createEvidenceLifecycleClient(client);
    const request = create();
    const first = await lifecycle.createStudyFromPaper(request);
    expect(first).toMatchObject({ ok: false, error: { kind: "transport_uncertain", applied: "unknown", retry: "same_request" } });
    const second = await lifecycle.createStudyFromPaper(request);
    expect(second).toEqual({ ok: true, result: { status: "replayed", studyId: STUDY, studyVersion: 1, linkId: LINK, snapshotId: null } });
    expect(calls).toHaveLength(2);
    expect(calls[0].args).toEqual(calls[1].args);
    expect((calls[0].args as { p_request_id: string }).p_request_id).toBe(REQUEST);
  });

  it("refuses a hand-built or altered request without calling anything", async () => {
    const { client, rpc } = fakeClient();
    const lifecycle = createEvidenceLifecycleClient(client);
    const forged = { ...create(), args: { ...create().args, p_user_id: PAPER } } as unknown as CreateStudyRequest;
    expect(await lifecycle.createStudyFromPaper(forged)).toMatchObject({ ok: false, error: { kind: "invalid_request", applied: "no" } });
    expect(await lifecycle.deleteStudy(update() as unknown as DeleteStudyRequest)).toMatchObject({ ok: false, error: { kind: "invalid_request" } });
    expect(rpc).not.toHaveBeenCalled();
  });
});

describe("answers, reported as the server gave them", () => {
  const run = async <R,>(response: EvidenceRpcResponse | Error, send: (l: ReturnType<typeof createEvidenceLifecycleClient>) => Promise<R>) =>
    send(createEvidenceLifecycleClient(fakeClient(response).client));

  it("create: applied or replayed, with or without a copy", async () => {
    expect(await run(ok({ status: "applied", study_id: STUDY, study_version: 1, link_id: LINK, snapshot_id: COPY }), (l) => l.createStudyFromPaper(create()))).toEqual({
      ok: true,
      result: { status: "applied", studyId: STUDY, studyVersion: 1, linkId: LINK, snapshotId: COPY },
    });
    expect(await run(ok({ status: "applied", study_id: STUDY, study_version: 1, link_id: LINK, snapshot_id: null }), (l) => l.createStudyFromPaper(create()))).toMatchObject({
      ok: true,
      result: { snapshotId: null },
    });
  });

  it("update: applied and replayed at the next version, unchanged at the expected one", async () => {
    for (const status of ["applied", "replayed"] as const) {
      expect(await run(ok({ status, study_id: STUDY, study_version: 4 }), (l) => l.updateStudy(update()))).toEqual({ ok: true, result: { status, studyId: STUDY, studyVersion: 4 } });
    }
    expect(await run(ok({ status: "unchanged", study_id: STUDY, study_version: 3 }), (l) => l.updateStudy(update()))).toEqual({
      ok: true,
      result: { status: "unchanged", studyId: STUDY, studyVersion: 3 },
    });
  });

  it("set_link: the status each action leads to; null after a remove", async () => {
    expect(await run(ok({ status: "applied", study_id: STUDY, study_version: 4, paper_id: PAPER, link_id: LINK, link_status: null }), (l) => l.setLink(setLink("remove")))).toMatchObject({
      ok: true,
      result: { linkStatus: null, studyVersion: 4 },
    });
    expect(await run(ok({ status: "unchanged", study_id: STUDY, study_version: 3, paper_id: PAPER, link_id: LINK, link_status: "provisional" }), (l) => l.setLink(setLink("mark_provisional")))).toMatchObject({
      ok: true,
      result: { status: "unchanged", linkStatus: "provisional" },
    });
  });

  it("delete: deleted or already absent", async () => {
    expect(await run(ok({ status: "deleted" }), (l) => l.deleteStudy(remove()))).toEqual({ ok: true, result: { status: "deleted" } });
    expect(await run(ok({ status: "already_absent" }), (l) => l.deleteStudy(remove()))).toEqual({ ok: true, result: { status: "already_absent" } });
  });

  it.each<[string, EvidenceRpcResponse, (l: ReturnType<typeof createEvidenceLifecycleClient>) => Promise<unknown>]>([
    ["an extra key", ok({ status: "applied", study_id: STUDY, study_version: 1, link_id: LINK, snapshot_id: null, user_id: PAPER }), (l) => l.createStudyFromPaper(create())],
    ["a missing key", ok({ status: "applied", study_id: STUDY, study_version: 1, snapshot_id: null }), (l) => l.createStudyFromPaper(create())],
    ["an unknown status", ok({ status: "done", study_id: STUDY, study_version: 1, link_id: LINK, snapshot_id: null }), (l) => l.createStudyFromPaper(create())],
    ["a create not at version 1", ok({ status: "applied", study_id: STUDY, study_version: 2, link_id: LINK, snapshot_id: null }), (l) => l.createStudyFromPaper(create())],
    ["another study's answer", ok({ status: "applied", study_id: PAPER, study_version: 4 }), (l) => l.updateStudy(update())],
    ["a version that does not follow", ok({ status: "applied", study_id: STUDY, study_version: 5 }), (l) => l.updateStudy(update())],
    ["another paper's link", ok({ status: "applied", study_id: STUDY, study_version: 4, paper_id: PAPER_2, link_id: LINK, link_status: "user_confirmed" }), (l) => l.setLink(setLink("confirm"))],
    ["the wrong link status", ok({ status: "applied", study_id: STUDY, study_version: 4, paper_id: PAPER, link_id: LINK, link_status: "provisional" }), (l) => l.setLink(setLink("confirm"))],
    ["an unchanged remove", ok({ status: "unchanged", study_id: STUDY, study_version: 3, paper_id: PAPER, link_id: LINK, link_status: null }), (l) => l.setLink(setLink("remove"))],
    ["a delete with more", ok({ status: "deleted", study_id: STUDY }), (l) => l.deleteStudy(remove())],
    ["no body", ok(null), (l) => l.deleteStudy(remove())],
    ["an array", ok([{ status: "deleted" }]), (l) => l.deleteStudy(remove())],
  ])("fails closed on %s", async (_label, response, send) => {
    expect(await run(response, send)).toMatchObject({ ok: false, error: { kind: "malformed_response", applied: "unknown" } });
  });

  it("classifies a refusal, with what to do next", async () => {
    expect(await run(refusal("P0001", "evidence_version_conflict"), (l) => l.updateStudy(update()))).toMatchObject({
      ok: false,
      error: { kind: "version_conflict", category: "conflict", applied: "no", retry: "new_request_after_reload" },
    });
    expect(await run(refusal("P0001", "evidence_last_link"), (l) => l.setLink(setLink("remove")))).toMatchObject({ ok: false, error: { kind: "last_link" } });
    expect(await run(refusal("42501", "evidence_records_not_enabled", 403), (l) => l.createStudyFromPaper(create()))).toMatchObject({ ok: false, error: { kind: "records_not_enabled" } });
    expect(await run(refusal("P0002", "evidence_not_found", 500), (l) => l.deleteStudy(remove()))).toMatchObject({ ok: false, error: { kind: "study_not_found" } });
    expect(await run(refusal("22023", "evidence_invalid_input", 400, "p_label"), (l) => l.updateStudy(update()))).toMatchObject({ ok: false, error: { kind: "invalid_input", field: "label" } });
  });

  it("never claims success for a write whose answer was lost", async () => {
    const lost = await run({ data: null, error: { message: "TypeError: Failed to fetch", details: "", hint: "", code: "" }, status: 0 }, (l) => l.setLink(setLink("confirm")));
    expect(lost).toMatchObject({ ok: false, error: { kind: "transport_uncertain", applied: "unknown", retry: "same_request" } });
  });
});

describe("the request types are the generated ones", () => {
  it("are what each prepared request carries", () => {
    const requests: [CreateStudyRequest, UpdateStudyRequest, SetLinkRequest, DeleteStudyRequest] = [create(), update(), setLink("remove"), remove()];
    expect(requests.map((r) => r.functionName)).toEqual(["evidence_create_study_from_paper", "evidence_update_study", "evidence_set_link", "evidence_delete_study"]);
  });
});
