import { describe, it, expect, vi } from "vitest";
import { render, fireEvent, within } from "@testing-library/react";
import type { ComponentProps } from "react";

import { PaperListEmptyState } from "../PaperListEmptyState";
import { ACCEPTED_FILE_EXTENSIONS } from "../AddPaperDialog";

/**
 * PFA-C06. Two things are under test and they are easy to conflate:
 *
 *  1. the first-run surface actually coaches a new user (import methods,
 *     organization, taxonomy, a CTA that opens the real Add dialog), and
 *  2. that coaching is shown *only* to a genuinely empty library — the old
 *     `No papers yet` message was also reachable with a full library behind an
 *     unlucky filter, which is what made it wrong rather than merely thin.
 *
 * Assertions stay at the concept level (regex over visible text) so ordinary
 * copy polish does not break the suite. Every query is scoped to the render's
 * own container rather than `document.body`, so a test can never read leftover
 * markup from the previous one.
 */
function renderEmptyState(
  props: Partial<ComponentProps<typeof PaperListEmptyState>> = {},
) {
  const onAddPapers = vi.fn();
  const onClearFilters = vi.fn();
  const { container } = render(
    <PaperListEmptyState
      totalCount={0}
      isTotalCountAuthoritative={true}
      hasActiveFilters={false}
      onAddPapers={onAddPapers}
      onClearFilters={onClearFilters}
      {...props}
    />,
  );
  return {
    onAddPapers,
    onClearFilters,
    ui: within(container),
    /** All visible text in this render, lowercased. */
    text: () => (container.textContent ?? "").toLowerCase(),
  };
}

describe("PaperListEmptyState — genuinely empty library (totalCount === 0)", () => {
  it("renders the first-run heading as a real heading element", () => {
    const { ui } = renderEmptyState();
    expect(
      ui.getByRole("heading", { name: /build your research library/i }),
    ).toBeInTheDocument();
  });

  it("names all three import methods the Add dialog actually exposes", () => {
    const { text } = renderEmptyState();
    // 1. identifier import
    expect(text()).toMatch(/pmid/);
    expect(text()).toMatch(/doi/);
    // 2. file import — the gap the audit called out explicitly
    expect(text()).toMatch(/reference file/);
    // 3. manual entry
    expect(text()).toMatch(/manual/);
  });

  it("names every reference format the importer actually parses", () => {
    const { text } = renderEmptyState();
    // Driven off the importer's own constant rather than a hand-copied list, so
    // a newly supported (or dropped) parser fails here instead of silently
    // leaving the onboarding copy stale.
    for (const ext of ACCEPTED_FILE_EXTENSIONS) {
      expect(text()).toContain(ext);
    }
  });

  it("points at Projects and Tags for organizing the library", () => {
    const { text } = renderEmptyState();
    expect(text()).toMatch(/projects/);
    expect(text()).toMatch(/tags/);
  });

  it("hints at the taxonomy pools and where they live", () => {
    const { text } = renderEmptyState();
    expect(text()).toMatch(/keyword/);
    expect(text()).toMatch(/study type/);
    expect(text()).toMatch(/sidebar/);
  });

  it("presents the three onboarding steps as a semantic list", () => {
    const { ui } = renderEmptyState();
    expect(ui.getAllByRole("listitem")).toHaveLength(3);
    expect(ui.getByRole("heading", { name: /^add$/i })).toBeInTheDocument();
    expect(ui.getByRole("heading", { name: /^organize$/i })).toBeInTheDocument();
    expect(ui.getByRole("heading", { name: /^refine$/i })).toBeInTheDocument();
  });

  it("offers the primary CTA as a real button and calls onAddPapers exactly once", () => {
    const { ui, onAddPapers, onClearFilters } = renderEmptyState();

    const cta = ui.getByRole("button", { name: /add your first papers/i });
    expect(cta.tagName).toBe("BUTTON");
    fireEvent.click(cta);

    expect(onAddPapers).toHaveBeenCalledTimes(1);
    expect(onClearFilters).not.toHaveBeenCalled();
  });

  it("does not offer clear-filters when the library is simply empty", () => {
    const { ui } = renderEmptyState();
    expect(ui.queryByRole("button", { name: /clear filters/i })).toBeNull();
  });

  it("does not steal focus when it mounts", () => {
    renderEmptyState();
    // No autofocus: the user chooses the CTA. Focus stays on <body>.
    expect(document.activeElement).toBe(document.body);
  });
});

describe("PaperListEmptyState — filtered zero results (totalCount > 0, filters active)", () => {
  it("says the filters matched nothing, not that the library is empty", () => {
    const { ui, text } = renderEmptyState({ totalCount: 120, hasActiveFilters: true });
    expect(
      ui.getByRole("heading", { name: /no papers match your current filters/i }),
    ).toBeInTheDocument();
    expect(text()).not.toMatch(/no papers yet/);
  });

  it("offers Clear filters and invokes the provided callback", () => {
    const { ui, onClearFilters, onAddPapers } = renderEmptyState({
      totalCount: 120,
      hasActiveFilters: true,
    });

    fireEvent.click(ui.getByRole("button", { name: /clear filters/i }));

    expect(onClearFilters).toHaveBeenCalledTimes(1);
    expect(onAddPapers).not.toHaveBeenCalled();
  });

  it("shows no first-run coaching to a user who already owns papers", () => {
    const { ui, text } = renderEmptyState({ totalCount: 120, hasActiveFilters: true });

    expect(text()).not.toMatch(/build your research library/);
    expect(text()).not.toMatch(/add your first papers/);
    // The three-step tutorial must not appear either.
    expect(ui.queryAllByRole("listitem")).toHaveLength(0);
    expect(ui.queryByRole("button", { name: /add your first papers/i })).toBeNull();
  });
});

describe("PaperListEmptyState — defensive fallback (totalCount > 0, no active filters)", () => {
  it("renders a neutral message instead of claiming the library is empty", () => {
    const { ui, text } = renderEmptyState({ totalCount: 120, hasActiveFilters: false });

    expect(ui.getByRole("heading", { name: /no papers to display/i })).toBeInTheDocument();
    expect(text()).not.toMatch(/no papers yet/);
    expect(text()).not.toMatch(/build your research library/);
  });

  it("offers no clear-filters action when nothing is filtering", () => {
    const { ui } = renderEmptyState({ totalCount: 120, hasActiveFilters: false });
    expect(ui.queryByRole("button", { name: /clear filters/i })).toBeNull();
  });
});

/**
 * The count query can fail. When it does, `usePapers` still has to return a
 * number for display, so the component is handed the `papers.length` fallback —
 * which is `0` precisely when this component renders. `isTotalCountAuthoritative`
 * is what stops that fabricated zero from selecting first-run onboarding.
 */
describe("PaperListEmptyState — unknown library size (count not authoritative)", () => {
  it("shows no first-run coaching even though totalCount reads as zero", () => {
    const { ui, text } = renderEmptyState({
      totalCount: 0,
      isTotalCountAuthoritative: false,
    });

    expect(text()).not.toMatch(/build your research library/);
    expect(text()).not.toMatch(/add your first papers/);
    expect(ui.queryByRole("button", { name: /add your first papers/i })).toBeNull();
    expect(ui.queryAllByRole("listitem")).toHaveLength(0);
  });

  it("renders the neutral message and claims nothing about library size", () => {
    const { ui, text } = renderEmptyState({
      totalCount: 0,
      isTotalCountAuthoritative: false,
    });

    expect(ui.getByRole("heading", { name: /no papers to display/i })).toBeInTheDocument();
    // Not "you have papers" and not "you have none".
    expect(text()).not.toMatch(/your library has papers/);
    expect(text()).not.toMatch(/no papers yet/);
  });

  it("does not blame the filters for the empty view", () => {
    const { ui } = renderEmptyState({
      totalCount: 0,
      isTotalCountAuthoritative: false,
      hasActiveFilters: true,
    });

    // Saying the filters matched nothing asserts the library is non-empty, which
    // is exactly what is unknown here.
    expect(ui.queryByRole("heading", { name: /no papers match your current filters/i })).toBeNull();
    expect(ui.getByRole("heading", { name: /no papers to display/i })).toBeInTheDocument();
  });

  it("still offers Clear filters while filters are narrowing the view", () => {
    const { ui, onClearFilters } = renderEmptyState({
      totalCount: 0,
      isTotalCountAuthoritative: false,
      hasActiveFilters: true,
    });

    fireEvent.click(ui.getByRole("button", { name: /clear filters/i }));
    expect(onClearFilters).toHaveBeenCalledTimes(1);
  });
});
