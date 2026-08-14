import { describe, it, expect, vi } from "vitest";
import { render, fireEvent, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { PaperWithTags } from "@/types/database";

// PaperList only touches Supabase to mint signed attachment URLs; the empty
// branch never gets that far, but the module is imported at load time.
vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    storage: { from: () => ({ createSignedUrls: async () => ({ data: [] }) }) },
    from: () => ({
      select: () => ({ eq: () => ({ eq: () => ({ single: async () => ({ data: null, error: null }) }) }) }),
    }),
  },
}));

import { PaperList } from "../PaperList";

/**
 * PFA-C06 wiring contract. `PaperListEmptyState` owns the copy (see its own
 * suite); what matters here is that PaperList reaches the empty branch with the
 * unfiltered `totalCount` intact, so an empty *page* of a non-empty library is
 * never mistaken for a first run.
 */
function renderList(
  papers: PaperWithTags[],
  opts: {
    totalCount: number;
    hasActiveFilters: boolean;
    /** Defaults to a resolved count; set false to model an unknown library size. */
    isTotalCountAuthoritative?: boolean;
  },
) {
  const onAddPapers = vi.fn();
  const onClearFilters = vi.fn();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

  const { container } = render(
    <QueryClientProvider client={client}>
      <PaperList
        papers={papers}
        userId="u1"
        onEdit={vi.fn()}
        onDelete={vi.fn()}
        findMatchingKeywords={() => []}
        visibleColumns={["title"]}
        columnWidths={{ title: 200 }}
        onColumnResize={vi.fn()}
        normalizeKeyword={(k) => k}
        excludedKeywords={new Set()}
        excludedStudyTypes={new Set()}
        onExcludeStudyType={vi.fn(async () => true)}
        onExcludeKeyword={vi.fn(async () => true)}
        onUpdateDriveUrl={vi.fn(async () => {})}
        selectedPaperIds={new Set()}
        onToggleSelect={vi.fn()}
        onToggleSelectAll={vi.fn()}
        totalCount={opts.totalCount}
        isTotalCountAuthoritative={opts.isTotalCountAuthoritative ?? true}
        hasActiveFilters={opts.hasActiveFilters}
        onAddPapers={onAddPapers}
        onClearFilters={onClearFilters}
      />
    </QueryClientProvider>,
  );

  return { ui: within(container), onAddPapers, onClearFilters };
}

describe("PaperList empty branch", () => {
  it("renders first-run onboarding for an empty library (papers=[] , totalCount=0)", () => {
    const { ui } = renderList([], { totalCount: 0, hasActiveFilters: false });

    expect(
      ui.getByRole("heading", { name: /build your research library/i }),
    ).toBeInTheDocument();
    expect(ui.getByRole("button", { name: /add your first papers/i })).toBeInTheDocument();
  });

  it("forwards the CTA to the Dashboard-supplied onAddPapers (the existing dialog)", () => {
    const { ui, onAddPapers } = renderList([], { totalCount: 0, hasActiveFilters: false });

    fireEvent.click(ui.getByRole("button", { name: /add your first papers/i }));

    expect(onAddPapers).toHaveBeenCalledTimes(1);
  });

  it("renders no-results — not onboarding — when filters hide an existing library", () => {
    const { ui, onClearFilters } = renderList([], { totalCount: 120, hasActiveFilters: true });

    expect(
      ui.getByRole("heading", { name: /no papers match your current filters/i }),
    ).toBeInTheDocument();
    expect(ui.queryByRole("button", { name: /add your first papers/i })).toBeNull();

    fireEvent.click(ui.getByRole("button", { name: /clear filters/i }));
    expect(onClearFilters).toHaveBeenCalledTimes(1);
  });

  it("forwards count authority, so an unknown library size never renders onboarding", () => {
    const { ui } = renderList([], {
      totalCount: 0,
      isTotalCountAuthoritative: false,
      hasActiveFilters: false,
    });

    // Same `totalCount: 0` as the first-run case above — only the authority flag
    // differs, so this fails if PaperList drops the prop on the way through.
    expect(ui.queryByRole("heading", { name: /build your research library/i })).toBeNull();
    expect(ui.getByRole("heading", { name: /no papers to display/i })).toBeInTheDocument();
  });

  it("never renders the retired 'No papers yet' copy in any empty state", () => {
    for (const opts of [
      { totalCount: 0, hasActiveFilters: false },
      { totalCount: 120, hasActiveFilters: true },
      { totalCount: 120, hasActiveFilters: false },
      { totalCount: 0, isTotalCountAuthoritative: false, hasActiveFilters: true },
    ]) {
      const { ui } = renderList([], opts);
      expect(ui.queryByText(/no papers yet/i)).toBeNull();
    }
  });
});
