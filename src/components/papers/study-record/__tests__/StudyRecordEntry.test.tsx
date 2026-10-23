import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fakeSupabase } from "@/lib/studyRecord/__tests__/fakeSupabase";
import { PAPER_ID, STUDY_ID, USER, uuid } from "@/lib/studyRecord/__tests__/fixtures";

/**
 * "Study records — None / 1 / 2" in a paper's expanded details and in Edit
 * Paper (EVIDENCE-RECORDS-001C1). Who sees what follows the owner-only pilot:
 * the owner can start a record; anyone holding records can open them; a
 * manager is not an owner; a failed read is said, never shown as "None".
 */

const db = vi.hoisted(() => ({ current: null as unknown as ReturnType<typeof import("@/lib/studyRecord/__tests__/fakeSupabase").fakeSupabase> }));
const access = vi.hoisted(() => ({ role: "owner", isLoading: false, isError: false }));

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    from: (table: string) => (db.current.client.from as unknown as (name: string) => unknown)(table),
    rpc: () => {
      throw new Error("the entry point must not call an RPC");
    },
  },
}));
vi.mock("@/hooks/useCurrentUserAccess", () => ({
  useCurrentUserAccess: () => ({ access: { role: access.role }, isLoading: access.isLoading, isError: access.isError }),
}));

import { StudyRecordEntry } from "../StudyRecordEntry";

const link = (studyId: string) => ({ user_id: USER, paper_id: PAPER_ID, study_id: studyId, link_status: "user_confirmed" });
const study = (id: string, label: string) => ({ id, user_id: USER, label, design_profile: "rct_parallel", created_at: "2026-10-20T00:00:00Z" });

function withStudies(count: number) {
  const ids = Array.from({ length: count }, (_, i) => (i === 0 ? STUDY_ID : uuid("5", i + 1)));
  db.current = fakeSupabase({
    tables: { evidence_study_reports: ids.map(link), evidence_studies: ids.map((id, i) => study(id, `Study ${i + 1}`)) },
  });
}

function renderEntry(props: Partial<React.ComponentProps<typeof StudyRecordEntry>> = {}) {
  const onOpen = vi.fn();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <StudyRecordEntry userId={USER} paperId={PAPER_ID} enabled onOpen={onOpen} {...props} />
    </QueryClientProvider>,
  );
  return { onOpen };
}

const status = () => screen.getByTestId("study-record-entry-status");

beforeEach(() => {
  access.role = "owner";
  access.isLoading = false;
  access.isError = false;
  withStudies(0);
});

describe("StudyRecordEntry", () => {
  it("offers the owner a way to start a record when the paper has none", async () => {
    const { onOpen } = renderEntry();
    await waitFor(() => expect(status()).toHaveTextContent("Study records — None"));
    fireEvent.click(screen.getByRole("button", { name: "Start a study record" }));
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("button", { name: "Open study record" })).toBeNull();
  });

  it.each([1, 2])("shows the owner how many records the paper has (%i) and opens them", async (count) => {
    withStudies(count);
    const { onOpen } = renderEntry();
    await waitFor(() => expect(status()).toHaveTextContent(`Study records — ${count}`));
    fireEvent.click(screen.getByRole("button", { name: "Open study record" }));
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it("shows a manager nothing for a paper without records — a manager is not an owner", async () => {
    access.role = "manager";
    renderEntry();
    await waitFor(() => expect(db.current.requests.length).toBeGreaterThan(0));
    expect(screen.queryByTestId("study-record-entry")).toBeNull();
  });

  it("shows an ordinary user nothing for a paper without records", async () => {
    access.role = "user";
    renderEntry();
    await waitFor(() => expect(db.current.requests.length).toBeGreaterThan(0));
    expect(screen.queryByTestId("study-record-entry")).toBeNull();
  });

  it("keeps View for a former owner who still holds records, without offering to start one", async () => {
    access.role = "user";
    withStudies(1);
    const { onOpen } = renderEntry();
    await waitFor(() => expect(status()).toHaveTextContent("Study records — 1"));
    fireEvent.click(screen.getByRole("button", { name: "Open study record" }));
    expect(onOpen).toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Start a study record" })).toBeNull();
  });

  it("offers nothing to start while the role is still loading, or after the lookup failed", async () => {
    access.isLoading = true;
    renderEntry();
    await waitFor(() => expect(db.current.requests.length).toBeGreaterThan(0));
    expect(screen.queryByRole("button", { name: "Start a study record" })).toBeNull();
  });

  it("says a failed read plainly — never 'None' — and lets the user try again", async () => {
    access.role = "user";
    db.current = fakeSupabase({ tables: {}, failures: { evidence_study_reports: { error: { code: "42501", message: "permission denied" }, status: 403 } } });
    renderEntry();
    await waitFor(() => expect(status()).toHaveTextContent("Study records — Couldn't load"));
    expect(screen.queryByText(/None/)).toBeNull();
    db.current = fakeSupabase({ tables: { evidence_study_reports: [] } });
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(screen.queryByTestId("study-record-entry")).toBeNull());
  });

  it("reads nothing and shows nothing for a signed-out user", () => {
    renderEntry({ userId: null });
    expect(screen.queryByTestId("study-record-entry")).toBeNull();
    expect(db.current.requests).toHaveLength(0);
  });

  it("reads nothing until it is on screen", () => {
    renderEntry({ enabled: false });
    expect(db.current.requests).toHaveLength(0);
  });

  it("shows its note (Edit Paper closes first) only when it shows an action", async () => {
    renderEntry({ note: "Opening the study record closes Edit Paper." });
    await waitFor(() => expect(screen.getByText("Opening the study record closes Edit Paper.")).toBeInTheDocument());
  });
});
