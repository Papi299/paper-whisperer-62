import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const { mockFrom } = vi.hoisted(() => ({ mockFrom: vi.fn() }));

vi.mock("@/integrations/supabase/client", () => ({ supabase: { from: mockFrom } }));

// Both presentations fail to render, with stored text in the error: the
// boundary must show its generic copy and never the error's own message.
vi.mock("../comparison/ComparisonLayouts", () => ({
  ComparisonMatrix: () => {
    throw new Error("render failed near stored text: Synthetic secret abstract");
  },
  ComparisonCards: () => {
    throw new Error("render failed near stored text: Synthetic secret abstract");
  },
}));

import { PaperComparisonDialog } from "../PaperComparisonDialog";
import { buildComparisonRequest } from "@/lib/paperComparison/request";
import type { ComparisonRequest } from "@/lib/paperComparison/types";
import { OWNER_ID, makePaperRow, paperId } from "@/lib/paperComparison/__tests__/fixtures";

/**
 * EVIDENCE-MATRIX-001B — a render failure inside the comparison fails closed
 * like an integrity failure: generic copy, nothing from the error, the status
 * region silenced, and a way back to the library.
 */

let respond: (response: { data: unknown; error: unknown; status: number }) => void;

/** React's development build re-throws a caught render error once; jsdom would print it. */
function swallowExpectedRenderError(event: ErrorEvent) {
  if (String(event.error?.message ?? "").startsWith("render failed near stored text")) event.preventDefault();
}

beforeEach(() => {
  mockFrom.mockImplementation(() => {
    const response = new Promise((resolve) => {
      respond = resolve;
    });
    const builder = { select: () => builder, in: () => builder, eq: () => builder, abortSignal: () => response };
    return builder;
  });
  // React logs the caught error; the assertion below is about what the page shows.
  vi.spyOn(console, "error").mockImplementation(() => {});
  window.addEventListener("error", swallowExpectedRenderError);
});

afterEach(() => {
  window.removeEventListener("error", swallowExpectedRenderError);
  vi.restoreAllMocks();
});

function makeRequest(): ComparisonRequest {
  const outcome = buildComparisonRequest({ ownerUserId: OWNER_ID, selectedIds: [paperId(1), paperId(2)] });
  if (!outcome.ok) throw new Error("fixture request refused");
  return outcome.request;
}

describe("PaperComparisonDialog — a render failure", () => {
  it("shows generic copy only, silences the status region and can be closed", async () => {
    const onClose = vi.fn();
    const queryClient = new QueryClient();
    render(
      <QueryClientProvider client={queryClient}>
        <PaperComparisonDialog request={makeRequest()} currentUserId={OWNER_ID} onClose={onClose} />
      </QueryClientProvider>,
    );
    const dialog = screen.getByRole("dialog", { name: "Compare papers" });
    await waitFor(() => expect(within(dialog).getByRole("status")).toHaveTextContent("Loading 2 papers…"));

    await act(async () => {
      respond({
        data: [
          makePaperRow(paperId(1), { title: "Synthetic paper 1", abstract: "Synthetic secret abstract" }),
          makePaperRow(paperId(2), { title: "Synthetic paper 2" }),
        ],
        error: null,
        status: 200,
      });
    });

    const alert = await within(dialog).findByRole("alert");
    expect(alert).toHaveTextContent(/did not pass a consistency check\. Nothing from it is displayed\./);
    expect(dialog).not.toHaveTextContent(/render failed|Synthetic secret abstract|Synthetic paper/);
    expect(within(dialog).getByRole("status")).toHaveTextContent("");

    fireEvent.click(within(dialog).getByRole("button", { name: "Return to library" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
