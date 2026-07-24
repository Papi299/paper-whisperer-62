import { useState } from "react";
import { describe, it, expect, beforeAll } from "vitest";
import { render, screen, within, fireEvent } from "@testing-library/react";
import {
  SearchableEntityMultiFilter,
  type EntityFilterItem,
} from "../SearchableEntityMultiFilter";
import type { EntityMatchMode } from "@/lib/filterSets";

// Radix Popover + cmdk rely on a few DOM APIs jsdom does not implement.
// Polyfill them locally (not in the shared setup) so this component test can
// open the popover and drive interactions deterministically.
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

const LONG_NAME =
  "Nutrition Strategies and Specific Nutrients for Cardiometabolic Health";

const PROJECTS: EntityFilterItem[] = [
  { id: "p1", name: "Alpha", color: "#f00" },
  { id: "p2", name: "Beta", color: "#0f0" },
  { id: "p3", name: "Gamma", color: "#00f" },
  { id: "p4", name: LONG_NAME, color: "#abc" },
];

/**
 * Stateful harness that mirrors the real dashboard wiring: `onToggle` uses the
 * exact add/remove semantics of `useFilterState.handleProjectToggle`, and the
 * current selection is surfaced via a hidden testid so assertions can inspect
 * it (and prove no duplicates ever accumulate).
 */
function Harness({
  items = PROJECTS,
  withMode = true,
}: {
  items?: EntityFilterItem[];
  withMode?: boolean;
}) {
  const [selected, setSelected] = useState<string[]>([]);
  const [mode, setMode] = useState<EntityMatchMode>("any");
  const toggle = (id: string) =>
    setSelected((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  const modeProps = withMode
    ? {
        matchMode: mode,
        onMatchModeChange: setMode,
        matchModeGroupLabel: "Match projects",
        matchAnyDescription: "Match papers in at least one selected project",
        matchAllDescription: "Match papers in every selected project",
      }
    : {};
  return (
    <>
      <SearchableEntityMultiFilter
        items={items}
        selectedIds={selected}
        onToggle={toggle}
        onClear={() => setSelected([])}
        allLabel="All Projects"
        nounSingular="Project"
        nounPlural="Projects"
        searchPlaceholder="Search projects..."
        emptyMessage="No projects found."
        ariaLabel="Filter by project"
        {...modeProps}
      />
      <div data-testid="selection">{JSON.stringify(selected)}</div>
      <div data-testid="mode">{mode}</div>
    </>
  );
}

function selection(): string[] {
  return JSON.parse(screen.getByTestId("selection").textContent || "[]");
}

function currentMode(): string {
  return screen.getByTestId("mode").textContent || "";
}

// The trigger and cmdk's search input both expose role="combobox"; the trigger
// is disambiguated by its stable aria-label prefix.
function trigger(): HTMLElement {
  return screen.getByRole("combobox", { name: /Filter by project/i });
}

async function openPopover() {
  fireEvent.click(trigger());
  // Search box is only present once the popover content mounts.
  await screen.findByPlaceholderText("Search projects...");
}

function option(re: RegExp) {
  return screen.getByRole("option", { name: re });
}

function search(value: string) {
  fireEvent.change(screen.getByPlaceholderText("Search projects..."), {
    target: { value },
  });
}

// The Any/All controls are single-mode ToggleGroup items → role="radio",
// named by their category-specific aria-label description.
function modeRadio(re: RegExp) {
  return screen.getByRole("radio", { name: re });
}

async function selectTwo() {
  await openPopover();
  fireEvent.click(option(/Alpha/));
  fireEvent.click(option(/Beta/));
}

describe("SearchableEntityMultiFilter", () => {
  it("shows the zero-selection label", () => {
    render(<Harness />);
    expect(trigger()).toHaveTextContent("All Projects");
  });

  it("shows the single selected item name in the trigger", async () => {
    render(<Harness />);
    await openPopover();
    fireEvent.click(option(/Alpha/));
    const el = trigger();
    expect(el).toHaveTextContent("Alpha");
    expect(el).not.toHaveTextContent("All Projects");
    expect(selection()).toEqual(["p1"]);
  });

  it("shows a compact count with the active mode for multiple selections", async () => {
    render(<Harness />);
    await openPopover();
    fireEvent.click(option(/Alpha/));
    fireEvent.click(option(/Beta/));
    expect(trigger()).toHaveTextContent("2 Projects · Any");
    expect(selection()).toEqual(["p1", "p2"]);
  });

  it("renders the multi-selection count and mode exactly once (no duplicate badge)", async () => {
    render(<Harness />);
    await openPopover();
    fireEvent.click(option(/Alpha/));
    fireEvent.click(option(/Beta/));
    const el = trigger();
    // Normalized trigger text is exactly "2 Projects · Any" — no "2 Projects 2"
    // and no doubled mode word ("Any Any").
    expect(el.textContent?.replace(/\s+/g, " ").trim()).toBe("2 Projects · Any");
    // The numeric count appears exactly once.
    expect((el.textContent?.match(/2/g) || []).length).toBe(1);
    // The mode word appears exactly once.
    expect((el.textContent?.match(/Any/g) || []).length).toBe(1);
    expect(el).not.toHaveTextContent("2 Projects 2");
  });

  it("shows count-only (no mode) when the category has no mode wired in", async () => {
    render(<Harness withMode={false} />);
    await openPopover();
    fireEvent.click(option(/Alpha/));
    fireEvent.click(option(/Beta/));
    const el = trigger();
    expect(el.textContent?.replace(/\s+/g, " ").trim()).toBe("2 Projects");
    expect(el).not.toHaveTextContent("·");
  });

  it("filters the list by a case-insensitive substring search", async () => {
    render(<Harness />);
    await openPopover();
    search("GAMM");
    expect(option(/Gamma/)).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: /Alpha/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("option", { name: /Beta/ })).not.toBeInTheDocument();
  });

  it("keeps selection available while a search is active", async () => {
    render(<Harness />);
    await openPopover();
    search("beta");
    fireEvent.click(option(/Beta/));
    // Search text persists and the popover stays open for further selection.
    expect(screen.getByPlaceholderText("Search projects...")).toHaveValue("beta");
    expect(selection()).toEqual(["p2"]);
  });

  it("deselects a single item when toggled again", async () => {
    render(<Harness />);
    await openPopover();
    fireEvent.click(option(/Alpha/));
    expect(selection()).toEqual(["p1"]);
    fireEvent.click(option(/Alpha/));
    expect(selection()).toEqual([]);
    expect(trigger()).toHaveTextContent("All Projects");
  });

  it("never accumulates duplicate ids when an item is clicked repeatedly", async () => {
    render(<Harness />);
    await openPopover();
    fireEvent.click(option(/Alpha/)); // select
    fireEvent.click(option(/Alpha/)); // deselect
    fireEvent.click(option(/Alpha/)); // select again
    expect(selection()).toEqual(["p1"]);
    expect(new Set(selection()).size).toBe(selection().length);
  });

  it("clears all selections via the clear button", async () => {
    render(<Harness />);
    await openPopover();
    fireEvent.click(option(/Alpha/));
    fireEvent.click(option(/Beta/));
    expect(selection()).toEqual(["p1", "p2"]);
    fireEvent.click(screen.getByRole("button", { name: /Clear projects/i }));
    expect(selection()).toEqual([]);
    expect(trigger()).toHaveTextContent("All Projects");
  });

  it("shows the empty-results message when nothing matches", async () => {
    render(<Harness />);
    await openPopover();
    search("zzzzz-none");
    expect(screen.getByText("No projects found.")).toBeInTheDocument();
    expect(screen.queryByRole("option")).not.toBeInTheDocument();
  });

  it("renders a long single selection on one line with the full name in title/aria", async () => {
    render(<Harness />);
    await openPopover();
    fireEvent.click(option(new RegExp(LONG_NAME.slice(0, 20))));

    const el = trigger();
    // Full name exposed to assistive tech even though the visible text truncates.
    expect(el).toHaveAttribute("aria-label", expect.stringContaining(LONG_NAME));
    // The visible name span uses one-line truncation and carries the full title.
    const nameSpan = within(el).getByText(LONG_NAME);
    expect(nameSpan).toHaveClass("truncate");
    expect(nameSpan).toHaveAttribute("title", LONG_NAME);
  });

  it("exposes an accessible combobox with expanded state", async () => {
    render(<Harness />);
    const el = trigger();
    expect(el).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(el);
    expect(el).toHaveAttribute("aria-expanded", "true");
  });

  // ── Match-mode selector ──

  it("does not show the mode selector below two selected items", async () => {
    render(<Harness />);
    await openPopover();
    // Zero selected — no mode selector.
    expect(screen.queryByRole("radio")).not.toBeInTheDocument();
    fireEvent.click(option(/Alpha/));
    // One selected — Any/All is a no-op, still no selector.
    expect(screen.queryByRole("radio")).not.toBeInTheDocument();
  });

  it("shows the mode selector once two items are selected", async () => {
    render(<Harness />);
    await selectTwo();
    expect(screen.getByText("Match selected")).toBeInTheDocument();
    expect(modeRadio(/at least one selected project/i)).toBeInTheDocument();
    expect(modeRadio(/every selected project/i)).toBeInTheDocument();
  });

  it("defaults to Any", async () => {
    render(<Harness />);
    await selectTwo();
    expect(modeRadio(/at least one selected project/i)).toHaveAttribute("aria-checked", "true");
    expect(modeRadio(/every selected project/i)).toHaveAttribute("aria-checked", "false");
    expect(currentMode()).toBe("any");
  });

  it("switches to All without closing the popover", async () => {
    render(<Harness />);
    await selectTwo();
    fireEvent.click(modeRadio(/every selected project/i));
    expect(currentMode()).toBe("all");
    // Popover still open: the search box is still mounted.
    expect(screen.getByPlaceholderText("Search projects...")).toBeInTheDocument();
    expect(modeRadio(/every selected project/i)).toHaveAttribute("aria-checked", "true");
  });

  it("exposes category-specific accessible descriptions on both options", async () => {
    render(<Harness />);
    await selectTwo();
    expect(modeRadio(/Match papers in at least one selected project/i)).toBeInTheDocument();
    expect(modeRadio(/Match papers in every selected project/i)).toBeInTheDocument();
  });

  it("shows the active mode in the closed trigger (2 Projects · All)", async () => {
    render(<Harness />);
    await selectTwo();
    fireEvent.click(modeRadio(/every selected project/i));
    // Close the popover.
    fireEvent.keyDown(document.body, { key: "Escape" });
    fireEvent.click(trigger()); // re-open to read trigger text deterministically
    const el = trigger();
    expect(el).toHaveTextContent("2 Projects · All");
    expect((el.textContent?.match(/All/g) || []).length).toBe(1);
  });

  it("exposes the mode options as focusable native radio buttons (keyboard-operable)", async () => {
    render(<Harness />);
    await selectTwo();
    const any = modeRadio(/at least one selected project/i);
    const all = modeRadio(/every selected project/i);
    // Real <button> elements with radio semantics — not clickable <div>s — so
    // they are in the tab order and respond to Enter/Space in a real browser.
    expect(any.tagName).toBe("BUTTON");
    expect(all.tagName).toBe("BUTTON");
    any.focus();
    expect(any).toHaveFocus();
    all.focus();
    expect(all).toHaveFocus();
  });

  it("resets to the zero-selection label when all items are cleared", async () => {
    render(<Harness />);
    await selectTwo();
    fireEvent.click(screen.getByRole("button", { name: /Clear projects/i }));
    expect(selection()).toEqual([]);
    expect(trigger()).toHaveTextContent("All Projects");
    // No mode selector once empty.
    expect(screen.queryByRole("radio")).not.toBeInTheDocument();
  });
});
