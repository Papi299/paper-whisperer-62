import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { queryKeys } from "@/lib/queryKeys";
import { fakeSupabase } from "@/lib/studyRecord/__tests__/fakeSupabase";
import { ABSTRACT, OTHER_USER, PAPER_ID, PAPER_TITLE, reportRow, SECOND_PAPER_ID, snapshotRow, studyRow, USER, uuid } from "@/lib/studyRecord/__tests__/fixtures";
import type { StudyRecordTarget } from "../StudyRecordDialog";

/**
 * C1-R1 (EVIDENCE-RECORDS-001C1-REVIEW-FIX-001): a create whose outcome is
 * unknown must survive closing and reopening the Study Record dialog, and a
 * retry must resend exactly that request — never a new request id for an
 * attempt the server may already have applied.
 *
 * Deterministic: every network outcome is scripted, and a held request waits
 * on a promise the test releases. The server here models the one rule that
 * matters (docs/evidence-records-lifecycle.md §5): the same request id with the
 * same arguments replays the original answer; a new id creates a new study.
 * Writes go through PR-B's real client; reads through a fake PostgREST over
 * the same rows the fake server writes.
 */

type Network = "deliver" | "lose" | "drop";
interface Step {
  /** deliver: committed and answered · lose: committed, answer lost · drop: never reached the server */
  readonly network: Network;
  readonly hold?: Promise<void>;
}

const state = vi.hoisted(() => ({
  db: null as unknown as { client: { from: unknown } },
  tables: {} as Record<string, Record<string, unknown>[]>,
  creates: [] as Record<string, unknown>[],
  steps: [] as { network: "deliver" | "lose" | "drop"; hold?: Promise<void> }[],
  ledger: new Map<string, { fingerprint: string; data: Record<string, unknown> }>(),
  serial: 0,
  caller: "",
  rpc: null as unknown as (fn: string, args: Record<string, unknown>) => Promise<unknown>,
  toast: vi.fn(),
}));

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    from: (table: string) => (state.db.client.from as (name: string) => unknown)(table),
    rpc: (fn: string, args: Record<string, unknown>) => state.rpc(fn, args),
  },
}));
vi.mock("@/hooks/useCurrentUserAccess", () => ({
  useCurrentUserAccess: () => ({ access: { role: "owner" }, isLoading: false, isError: false }),
}));
vi.mock("@/hooks/useAbstract", () => ({
  useAbstract: () => ({ isPending: false, isError: false, data: ABSTRACT }),
}));
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: state.toast }), toast: state.toast }));
vi.mock("@/hooks/use-mobile", () => ({ useIsMobile: () => false }));

import { StudyRecordDialog } from "../StudyRecordDialog";

const SECOND_PAPER_TITLE = "A second paper with its own study";

/** The server's side of `evidence_create_study_from_paper`, request-id replay included. */
function serverCreate(args: Record<string, unknown>) {
  const { p_request_id: requestId, ...rest } = args;
  const fingerprint = JSON.stringify(Object.keys(rest).sort().map((key) => [key, rest[key]]));
  const ledgerKey = `${state.caller}:${String(requestId)}`;
  const prior = state.ledger.get(ledgerKey);
  if (prior) {
    if (prior.fingerprint !== fingerprint) return { data: null, error: { code: "P0001", message: "evidence_request_id_reused", details: null, hint: null }, status: 400 };
    return { data: { ...prior.data, status: "replayed" }, error: null, status: 200 };
  }
  state.serial += 1;
  const studyId = uuid("5", state.serial);
  const linkId = uuid("b", state.serial);
  const snapshotId = uuid("c", state.serial);
  const owner = { user_id: state.caller, study_id: studyId, paper_id: args.p_paper_id as string };
  state.tables.evidence_studies.push(studyRow({ id: studyId, user_id: state.caller, row_version: 1, label: args.p_label as string, design_profile: args.p_design_profile as string }));
  state.tables.evidence_study_reports.push(reportRow({ ...owner, id: linkId, link_status: args.p_link_status as string }));
  state.tables.evidence_source_snapshots.push(snapshotRow({ ...owner, id: snapshotId }));
  const data = { status: "applied", study_id: studyId, study_version: 1, link_id: linkId, snapshot_id: snapshotId };
  state.ledger.set(ledgerKey, { fingerprint, data });
  return { data, error: null, status: 200 };
}

function resetServer() {
  state.tables = {
    evidence_studies: [],
    evidence_study_reports: [],
    evidence_source_snapshots: [],
    evidence_arms: [],
    evidence_outcomes: [],
    evidence_field_values: [],
    evidence_field_anchors: [],
    papers: [
      { id: PAPER_ID, user_id: USER, title: PAPER_TITLE },
      { id: SECOND_PAPER_ID, user_id: USER, title: SECOND_PAPER_TITLE },
      { id: PAPER_ID, user_id: OTHER_USER, title: PAPER_TITLE },
    ],
  };
  state.db = fakeSupabase({ tables: state.tables }) as unknown as typeof state.db;
  state.creates = [];
  state.steps = [];
  state.ledger = new Map();
  state.serial = 0;
  state.caller = USER;
  state.rpc = async (fn, args) => {
    if (fn !== "evidence_create_study_from_paper") throw new Error(`unexpected rpc ${fn}`);
    state.creates.push(structuredClone(args));
    const step = state.steps.shift() ?? { network: "deliver" };
    if (step.hold) await step.hold;
    if (step.network === "drop") throw new TypeError("Failed to fetch");
    const response = serverCreate(args);
    if (step.network === "lose") throw new TypeError("Failed to fetch");
    return response;
  };
}

/** The studies the server holds for `paperId`, for `userId`. */
const studiesOnServer = (paperId = PAPER_ID, userId = USER) =>
  state.tables.evidence_study_reports.filter((row) => row.paper_id === paperId && row.user_id === userId);

function deferred() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => (release = resolve));
  return { promise, release };
}

interface Control {
  setTarget: (target: StudyRecordTarget | null) => void;
  setUserId: (userId: string | null) => void;
}

/** The Dashboard's part: one dialog, mounted once, opened and closed by target. */
function renderDashboard(queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })) {
  const control = {} as Control;
  let session = 0;
  function Host() {
    const [target, setTarget] = useState<StudyRecordTarget | null>(null);
    const [userId, setUserId] = useState<string | null>(USER);
    control.setTarget = setTarget;
    control.setUserId = setUserId;
    return <StudyRecordDialog target={target} userId={userId} onClose={() => setTarget(null)} />;
  }
  render(
    <QueryClientProvider client={queryClient}>
      <Host />
    </QueryClientProvider>,
  );
  return {
    queryClient,
    open(paperId = PAPER_ID, paperTitle = PAPER_TITLE) {
      session += 1;
      act(() => control.setTarget({ session, paperId, paperTitle, labelSuggestion: "Doe 2024" }));
    },
    signInAs(userId: string) {
      state.caller = userId;
      act(() => control.setUserId(userId));
    },
  };
}

const dialog = () => screen.getByTestId("study-record-dialog");
/** The dialog's own close button (the X), as a user dismisses it. */
const dismiss = async () => {
  const buttons = within(dialog()).getAllByRole("button", { name: "Close" });
  fireEvent.click(buttons[buttons.length - 1]);
  await waitFor(() => expect(screen.queryByTestId("study-record-dialog")).toBeNull());
};

async function fillAndCreate(label = "Doe 2024 trial") {
  fireEvent.click(await screen.findByRole("radio", { name: /^Yes/ }));
  fireEvent.click(screen.getByRole("radio", { name: /Randomized trial, parallel groups/ }));
  fireEvent.change(screen.getByLabelText("Study name"), { target: { value: label } });
  const create = screen.getByRole("button", { name: "Create study record" });
  await waitFor(() => expect(create).toBeEnabled());
  fireEvent.click(create);
}

const recovery = () => screen.findByTestId("study-record-create-recovery");
const retryButton = async () => within(await recovery()).getByRole("button", { name: "Try again" });

/** The reopened dialog must not offer a new creation for this paper. */
async function expectRecoveryNotCreation() {
  const panel = await recovery();
  expect(screen.queryByRole("button", { name: "Create study record" })).toBeNull();
  expect(screen.queryByLabelText("Study name")).toBeNull();
  return panel;
}

beforeAll(() => {
  const proto = Element.prototype as unknown as Record<string, unknown>;
  proto.hasPointerCapture = () => false;
  proto.setPointerCapture = () => {};
  proto.releasePointerCapture = () => {};
  proto.scrollIntoView = () => {};
  if (!("ResizeObserver" in globalThis)) {
    (globalThis as unknown as Record<string, unknown>).ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
  }
});

beforeEach(() => {
  resetServer();
  state.toast.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("a create whose answer was lost (C1-R1)", () => {
  it("survives closing and reopening at once, and a retry opens the record the server already made — no second study", async () => {
    const app = renderDashboard();
    app.open();
    state.steps.push({ network: "lose" });
    await fillAndCreate();
    await screen.findByRole("button", { name: "Try again" });
    // The server committed the study; the browser never heard.
    expect(studiesOnServer()).toHaveLength(1);

    await dismiss();
    // The paper's cached list still says "none" — and is as fresh as a list can be.
    app.queryClient.setQueryData(queryKeys.studyRecords.paper(USER, PAPER_ID), []);
    expect(app.queryClient.getQueryData(queryKeys.studyRecords.paper(USER, PAPER_ID))).toEqual([]);

    app.open();
    const panel = await expectRecoveryNotCreation();
    expect(panel).toHaveTextContent("might already exist");
    expect(panel).toHaveTextContent("Trying again sends the same request");
    expect(panel).toHaveTextContent("Doe 2024 trial");
    expect(state.creates).toHaveLength(1);

    fireEvent.click(await retryButton());
    await screen.findByRole("heading", { name: "Study record: Doe 2024 trial" });
    expect(state.creates).toHaveLength(2);
    // The exact original payload, request id included.
    expect(state.creates[1]).toEqual(state.creates[0]);
    expect(studiesOnServer()).toHaveLength(1);
    expect(studiesOnServer()[0].study_id).toBe(uuid("5", 1));
  });

  it("creates exactly one record when the first attempt never reached the server, and a retry whose answer is lost too stays one", async () => {
    const app = renderDashboard();
    app.open();
    state.steps.push({ network: "drop" });
    await fillAndCreate();
    await screen.findByRole("button", { name: "Try again" });
    expect(studiesOnServer()).toHaveLength(0);
    await dismiss();

    app.open();
    await expectRecoveryNotCreation();
    state.steps.push({ network: "lose" });
    fireEvent.click(await retryButton());
    // Created now — and again the answer is lost.
    await waitFor(() => expect(studiesOnServer()).toHaveLength(1));
    await expectRecoveryNotCreation();
    await dismiss();

    app.open();
    await expectRecoveryNotCreation();
    fireEvent.click(await retryButton());
    await screen.findByRole("heading", { name: "Study record: Doe 2024 trial" });
    expect(state.creates).toHaveLength(3);
    expect(state.creates[1]).toEqual(state.creates[0]);
    expect(state.creates[2]).toEqual(state.creates[0]);
    expect(studiesOnServer()).toHaveLength(1);
  });

  it("keeps the recovery, with the same request, through a further transport failure — and never retries on its own", async () => {
    const app = renderDashboard();
    app.open();
    state.steps.push({ network: "lose" });
    await fillAndCreate();
    await screen.findByRole("button", { name: "Try again" });
    await dismiss();

    app.open();
    state.steps.push({ network: "drop" });
    fireEvent.click(await retryButton());
    const panel = await expectRecoveryNotCreation();
    await waitFor(() => expect(within(panel).getByRole("alert")).toHaveTextContent("We couldn't confirm whether your change was saved."));
    expect(state.creates).toHaveLength(2);
    await dismiss();

    app.open();
    await expectRecoveryNotCreation();
    // Nothing was sent while the user was away, or on reopening.
    expect(state.creates).toHaveLength(2);
    fireEvent.click(await retryButton());
    await screen.findByRole("heading", { name: "Study record: Doe 2024 trial" });
    expect(state.creates).toHaveLength(3);
    expect(new Set(state.creates.map((args) => args.p_request_id)).size).toBe(1);
    expect(state.creates.every((args) => JSON.stringify(args) === JSON.stringify(state.creates[0]))).toBe(true);
    expect(studiesOnServer()).toHaveLength(1);
  });

  it("lets the owner add another study once the attempt is resolved — with a new request", async () => {
    const app = renderDashboard();
    app.open();
    state.steps.push({ network: "lose" });
    await fillAndCreate();
    await screen.findByRole("button", { name: "Try again" });
    await dismiss();

    app.open();
    fireEvent.click(await retryButton());
    await screen.findByRole("heading", { name: "Study record: Doe 2024 trial" });

    fireEvent.click(screen.getAllByRole("button", { name: "All studies from this paper" })[0]);
    fireEvent.click(await screen.findByRole("button", { name: "Add another study from this paper" }));
    // A deliberate second study: the form, not the recovery — and it names what is already there.
    expect(await screen.findByTestId("study-record-existing-notice")).toHaveTextContent("Doe 2024 trial");
    expect(screen.queryByTestId("study-record-create-recovery")).toBeNull();
    await fillAndCreate("Doe 2024 extension");
    await screen.findByRole("heading", { name: "Study record: Doe 2024 extension" });

    expect(state.creates).toHaveLength(3);
    expect(state.creates[1]).toEqual(state.creates[0]);
    expect(state.creates[2].p_request_id).not.toBe(state.creates[0].p_request_id);
    expect(studiesOnServer()).toHaveLength(2);
  });

  it("does not block creation for another paper, and the first paper keeps its recovery", async () => {
    const app = renderDashboard();
    app.open();
    state.steps.push({ network: "lose" });
    await fillAndCreate();
    await screen.findByRole("button", { name: "Try again" });
    await dismiss();

    app.open(SECOND_PAPER_ID, SECOND_PAPER_TITLE);
    expect(await screen.findByRole("heading", { name: `Study record for: ${SECOND_PAPER_TITLE}` })).toBeInTheDocument();
    expect(screen.queryByTestId("study-record-create-recovery")).toBeNull();
    await fillAndCreate("Roe 2023");
    await screen.findByRole("heading", { name: "Study record: Roe 2023" });
    expect(state.creates[1].p_paper_id).toBe(SECOND_PAPER_ID);
    expect(state.creates[1].p_request_id).not.toBe(state.creates[0].p_request_id);
    await dismiss();

    app.open();
    await expectRecoveryNotCreation();
    fireEvent.click(await retryButton());
    await screen.findByRole("heading", { name: "Study record: Doe 2024 trial" });
    expect(state.creates[2]).toEqual(state.creates[0]);
    expect(studiesOnServer(PAPER_ID)).toHaveLength(1);
    expect(studiesOnServer(SECOND_PAPER_ID)).toHaveLength(1);
  });

  it("never shows one user's attempt to another — and after the account changes, a fresh read decides what is offered", async () => {
    const app = renderDashboard();
    app.open();
    state.steps.push({ network: "lose" });
    await fillAndCreate();
    await screen.findByRole("button", { name: "Try again" });
    await dismiss();

    app.signInAs(OTHER_USER);
    app.open();
    expect(await screen.findByRole("button", { name: "Create study record" })).toBeInTheDocument();
    expect(screen.queryByTestId("study-record-create-recovery")).toBeNull();
    expect(dialog()).not.toHaveTextContent("Doe 2024 trial");
    await dismiss();

    // Back as the first user: the in-memory attempt went with the account
    // change, but the dialog reads the server afresh and finds the record.
    app.signInAs(USER);
    app.open();
    await screen.findByRole("heading", { name: "Study record: Doe 2024 trial" });
    expect(screen.queryByRole("button", { name: "Create study record" })).toBeNull();
    expect(state.creates).toHaveLength(1);
    expect(studiesOnServer()).toHaveLength(1);
  });
});

describe("leaving while the outcome is unknown", () => {
  it("is allowed while the request is still on its way; the reopened dialog waits for that same request and opens its record", async () => {
    const app = renderDashboard();
    app.open();
    const held = deferred();
    state.steps.push({ network: "deliver", hold: held.promise });
    await fillAndCreate();
    await waitFor(() => expect(state.creates).toHaveLength(1));
    // Not trapped: the dialog closes while the request is in flight.
    await dismiss();
    expect(state.toast).toHaveBeenCalledWith(expect.objectContaining({ title: "This study record isn't confirmed yet" }));

    app.open();
    const panel = await expectRecoveryNotCreation();
    expect(within(panel).getByRole("status")).toHaveTextContent("Waiting for an answer");
    expect(within(panel).getByRole("button", { name: "Try again" })).toBeDisabled();

    await act(async () => held.release());
    await screen.findByRole("heading", { name: "Study record: Doe 2024 trial" });
    expect(state.creates).toHaveLength(1);
    expect(studiesOnServer()).toHaveLength(1);
  });

  it("says, on the way out, that the attempt is still open — and closing again changes nothing", async () => {
    const app = renderDashboard();
    app.open();
    state.steps.push({ network: "lose" });
    await fillAndCreate();
    await screen.findByRole("button", { name: "Try again" });
    await dismiss();
    expect(state.toast).toHaveBeenCalledTimes(1);
    expect(state.toast).toHaveBeenCalledWith({
      title: "This study record isn't confirmed yet",
      description: "PaperLume hasn't confirmed whether it was created. Open this paper's study records again to finish — trying again won't create it twice.",
    });

    app.open();
    await expectRecoveryNotCreation();
    await dismiss();
    app.open();
    await expectRecoveryNotCreation();
    expect(state.creates).toHaveLength(1);
  });

  it("keeps request material out of browser storage, cookies and the URL", async () => {
    // jsdom's stores. Node 25+ shadows `localStorage` (absent without
    // --localstorage-file) and `Storage` with its own, so each store is
    // spied on through its own prototype.
    const stores = [globalThis.localStorage, globalThis.sessionStorage].filter(
      (store): store is Storage => typeof store?.setItem === "function" && typeof store.length === "number",
    );
    expect(stores.length).toBeGreaterThan(0);
    const setItems = [...new Set(stores.map((store) => Object.getPrototypeOf(store) as Storage))].map((proto) => vi.spyOn(proto, "setItem"));
    const cookieBefore = document.cookie;
    const urlBefore = window.location.href;
    const app = renderDashboard();
    app.open();
    state.steps.push({ network: "lose" });
    await fillAndCreate();
    await screen.findByRole("button", { name: "Try again" });
    await dismiss();
    app.open();
    await screen.findByTestId("study-record-dialog");

    const requestId = String(state.creates[0].p_request_id);
    for (const setItem of setItems) expect(setItem).not.toHaveBeenCalled();
    for (const store of stores) expect(store.length).toBe(0);
    expect(document.cookie).toBe(cookieBefore);
    expect(document.cookie).not.toContain(requestId);
    expect(window.location.href).toBe(urlBefore);
  });
});

describe("after a reload, when nothing in memory knows of an earlier attempt", () => {
  function committedEarlier() {
    // The create committed in a previous page; its answer died with that page.
    serverCreate({ p_paper_id: PAPER_ID, p_label: "Doe 2024 trial", p_design_profile: "rct_parallel", p_link_status: "user_confirmed", p_request_id: uuid("7", 1) });
  }

  it("does not trust a cached 'none': it reads the paper's studies afresh and opens the record that exists", async () => {
    committedEarlier();
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    queryClient.setQueryData(queryKeys.studyRecords.paper(USER, PAPER_ID), []);
    const app = renderDashboard(queryClient);
    app.open();
    await screen.findByRole("heading", { name: "Study record: Doe 2024 trial" });
    expect(screen.queryByRole("button", { name: "Create study record" })).toBeNull();
    expect(state.creates).toHaveLength(0);
  });

  it("names the records that already exist before another is created", async () => {
    committedEarlier();
    const app = renderDashboard();
    app.open();
    await screen.findByRole("heading", { name: "Study record: Doe 2024 trial" });
    fireEvent.click(screen.getAllByRole("button", { name: "All studies from this paper" })[0]);
    fireEvent.click(await screen.findByRole("button", { name: "Add another study from this paper" }));
    const notice = await screen.findByTestId("study-record-existing-notice");
    expect(notice).toHaveTextContent("This paper already has 1 study record: Doe 2024 trial.");
    expect(notice).toHaveTextContent("Create another only if the paper reports a separate study.");
  });

  it("offers no creation while the paper's studies can't be read", async () => {
    // A refusal, not a transient failure: answered at once, never retried.
    const refused = { error: { code: "42501", message: "permission denied", details: null, hint: null }, status: 403 };
    state.db = fakeSupabase({ tables: state.tables, failures: { evidence_study_reports: refused } }) as unknown as typeof state.db;
    const app = renderDashboard();
    app.open();
    expect(await screen.findByText("Couldn't load the study records for this paper.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Create study record" })).toBeNull();
  });
});
