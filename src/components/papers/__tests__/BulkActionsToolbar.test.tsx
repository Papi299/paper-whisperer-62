import { describe, it, expect, vi } from "vitest";
import { useState } from "react";
import { render, screen, fireEvent, waitFor, within, act } from "@testing-library/react";
import { BulkActionsToolbar } from "../BulkActionsToolbar";
import type { Project, Tag } from "@/types/database";

/**
 * BULK-TOOLBAR-CONTAINMENT-001 — the toolbar's behaviour contract.
 *
 * The responsive layout itself is proven in a real browser by
 * `e2e/bulk-actions.spec.ts`: jsdom has no layout, so nothing here asserts
 * geometry or class names. This suite pins what must NOT have changed — every
 * action still reaches its existing handler exactly once, through the same
 * confirmations — plus the disclosure semantics and the focus hand-back the
 * containment work added.
 */

const PROJECT: Project = {
  id: "project-1",
  user_id: "user-1",
  name: "Project One",
  description: null,
  color: "#ff0000",
  created_at: "2026-01-01T00:00:00Z",
};

const TAG: Tag = {
  id: "tag-1",
  user_id: "user-1",
  name: "Tag One",
  color: "#00ff00",
  created_at: "2026-01-01T00:00:00Z",
};

/** The existing actions, in their existing order. */
const ACTION_NAMES = [
  "AI Analyze (3)",
  "Delete",
  "Set Project",
  "Clear Projects",
  "Set Tags",
  "Clear Tags",
  "Clear Selection",
];

function renderToolbar(overrides: Partial<Parameters<typeof BulkActionsToolbar>[0]> = {}) {
  const props = {
    selectedCount: 3,
    onClearSelection: vi.fn(),
    onBulkDelete: vi.fn().mockResolvedValue(undefined),
    onBulkSetProjects: vi.fn().mockResolvedValue(undefined),
    onBulkSetTags: vi.fn().mockResolvedValue(undefined),
    onBulkAnalyze: vi.fn().mockResolvedValue(undefined),
    projects: [PROJECT],
    tags: [TAG],
    ...overrides,
  };
  return { props, ...render(<BulkActionsToolbar {...props} />) };
}

function toolbar() {
  return screen.getByRole("region", { name: "Bulk actions" });
}

function disclosure() {
  return within(toolbar()).getByRole("button", { name: /^(More|Fewer) actions$/ });
}

/** The element the disclosure controls, resolved through `aria-controls`. */
function controlledList() {
  const id = disclosure().getAttribute("aria-controls");
  expect(id, "the disclosure names the element it controls").toBeTruthy();
  const list = document.getElementById(id!);
  expect(list, "aria-controls resolves to an element").not.toBeNull();
  return list!;
}

describe("BulkActionsToolbar — structure", () => {
  it("renders nothing while no paper is selected", () => {
    renderToolbar({ selectedCount: 0 });
    expect(screen.queryByRole("region", { name: "Bulk actions" })).toBeNull();
    expect(screen.queryByText(/selected/i)).toBeNull();
  });

  it("renders every existing action exactly once, in the existing order, inside the controlled list", () => {
    renderToolbar();
    const list = controlledList();
    const names = within(list)
      .getAllByRole("button")
      .map((button) => button.textContent?.trim());
    expect(names).toEqual(ACTION_NAMES);
    for (const name of ACTION_NAMES) {
      expect(screen.getAllByRole("button", { name }), `"${name}" is rendered once`).toHaveLength(1);
    }
  });

  it("omits AI Analyze, and only AI Analyze, when no bulk analysis handler is provided", () => {
    renderToolbar({ onBulkAnalyze: undefined });
    const names = within(controlledList())
      .getAllByRole("button")
      .map((button) => button.textContent?.trim());
    expect(names).toEqual(ACTION_NAMES.slice(1));
  });

  it("keeps Delete inside the selected-count badge's parent div (the E2E cleanup contract)", () => {
    renderToolbar();
    const parent = screen.getByText(/\d+\s+selected/i).parentElement!;
    expect(parent.tagName).toBe("DIV");
    expect(within(parent).getAllByRole("button", { name: /delete/i })).toHaveLength(1);
  });
});

describe("BulkActionsToolbar — narrow-screen disclosure", () => {
  it("starts collapsed and flips aria-expanded and its label together", () => {
    renderToolbar();
    expect(disclosure()).toHaveAccessibleName("More actions");
    expect(disclosure()).toHaveAttribute("aria-expanded", "false");

    fireEvent.click(disclosure());
    expect(disclosure()).toHaveAccessibleName("Fewer actions");
    expect(disclosure()).toHaveAttribute("aria-expanded", "true");

    fireEvent.click(disclosure());
    expect(disclosure()).toHaveAccessibleName("More actions");
    expect(disclosure()).toHaveAttribute("aria-expanded", "false");
  });

  it("collapsing moves focus off the action it is about to hide and onto the toggle", () => {
    renderToolbar();
    fireEvent.click(disclosure());
    const setTags = within(controlledList()).getByRole("button", { name: "Set Tags" });
    act(() => setTags.focus());
    expect(setTags).toHaveFocus();

    // `fireEvent.click` does not move focus, exactly like a pointer press in a
    // browser that never focuses buttons on click.
    fireEvent.click(disclosure());
    expect(disclosure()).toHaveAttribute("aria-expanded", "false");
    expect(disclosure()).toHaveFocus();
  });

  it("a new selection starts collapsed again", () => {
    const { rerender, props } = renderToolbar();
    fireEvent.click(disclosure());
    expect(disclosure()).toHaveAttribute("aria-expanded", "true");

    rerender(<BulkActionsToolbar {...props} selectedCount={0} />);
    rerender(<BulkActionsToolbar {...props} selectedCount={1} />);
    expect(disclosure()).toHaveAttribute("aria-expanded", "false");
  });

  it("the disclosure stays usable while the actions are busy", () => {
    renderToolbar({ bulkAnalyzing: true, bulkAnalyzeProgress: { current: 1, total: 3 } });
    expect(disclosure()).toBeEnabled();
  });
});

describe("BulkActionsToolbar — every action keeps its existing handler", () => {
  it("AI Analyze and Clear Selection call their handler once per press", () => {
    const { props } = renderToolbar();
    fireEvent.click(screen.getByRole("button", { name: "AI Analyze (3)" }));
    expect(props.onBulkAnalyze).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Clear Selection" }));
    expect(props.onClearSelection).toHaveBeenCalledTimes(1);
  });

  it("Delete confirms first; Cancel and Escape close without deleting; Delete deletes once", async () => {
    const { props } = renderToolbar();

    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    let dialog = await screen.findByRole("dialog", { name: "Delete 3 papers?" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    dialog = await screen.findByRole("dialog", { name: "Delete 3 papers?" });
    fireEvent.keyDown(dialog, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(props.onBulkDelete).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    dialog = await screen.findByRole("dialog", { name: "Delete 3 papers?" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(props.onBulkDelete).toHaveBeenCalledTimes(1);
  });

  it("Set Project applies the chosen projects once", async () => {
    const { props } = renderToolbar();
    fireEvent.click(screen.getByRole("button", { name: "Set Project" }));
    const dialog = await screen.findByRole("dialog", { name: "Set Projects for 3 papers" });
    fireEvent.click(within(dialog).getByRole("checkbox"));
    fireEvent.click(within(dialog).getByRole("button", { name: "Apply" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(props.onBulkSetProjects).toHaveBeenCalledTimes(1);
    expect(props.onBulkSetProjects).toHaveBeenCalledWith([PROJECT.id]);
  });

  it("Clear Projects confirms, then clears once", async () => {
    const { props } = renderToolbar();
    fireEvent.click(screen.getByRole("button", { name: "Clear Projects" }));
    const dialog = await screen.findByRole("dialog", { name: "Clear projects from 3 papers?" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Clear Projects" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(props.onBulkSetProjects).toHaveBeenCalledTimes(1);
    expect(props.onBulkSetProjects).toHaveBeenCalledWith([]);
  });

  it("Set Tags applies the chosen tags once", async () => {
    const { props } = renderToolbar();
    fireEvent.click(screen.getByRole("button", { name: "Set Tags" }));
    const dialog = await screen.findByRole("dialog", { name: "Set Tags for 3 papers" });
    fireEvent.click(within(dialog).getByRole("checkbox"));
    fireEvent.click(within(dialog).getByRole("button", { name: "Apply" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(props.onBulkSetTags).toHaveBeenCalledTimes(1);
    expect(props.onBulkSetTags).toHaveBeenCalledWith([TAG.id]);
  });

  it("Clear Tags confirms, then clears once", async () => {
    const { props } = renderToolbar();
    fireEvent.click(screen.getByRole("button", { name: "Clear Tags" }));
    const dialog = await screen.findByRole("dialog", { name: "Clear tags from 3 papers?" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Clear Tags" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(props.onBulkSetTags).toHaveBeenCalledTimes(1);
    expect(props.onBulkSetTags).toHaveBeenCalledWith([]);
  });
});

describe("BulkActionsToolbar — busy states", () => {
  it("shows bulk-analysis progress and disables every action while it runs", () => {
    renderToolbar({ bulkAnalyzing: true, bulkAnalyzeProgress: { current: 2, total: 5 } });
    const list = controlledList();
    expect(within(list).getByRole("button", { name: "Analyzing 2 of 5..." })).toBeDisabled();
    for (const button of within(list).getAllByRole("button")) {
      expect(button, `${button.textContent} is disabled`).toBeDisabled();
    }
  });

  it("disables every action while a confirmed bulk delete is in flight", async () => {
    let finish!: () => void;
    const onBulkDelete = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
    renderToolbar({ onBulkDelete });
    // Resolved up front: the open modal hides the toolbar from the
    // accessibility tree, which is also why the queries below pass
    // `hidden: true`.
    const list = controlledList();

    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    const dialog = await screen.findByRole("dialog", { name: "Delete 3 papers?" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));

    await waitFor(() => {
      for (const button of within(list).getAllByRole("button", { hidden: true })) {
        expect(button, `${button.textContent} is disabled`).toBeDisabled();
      }
    });

    await act(async () => finish());
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    for (const button of within(list).getAllByRole("button")) {
      expect(button, `${button.textContent} is enabled again`).toBeEnabled();
    }
    expect(onBulkDelete).toHaveBeenCalledTimes(1);
  });
});

/**
 * A minimal stand-in for the Dashboard: a row control the selection came from,
 * the table's Select all checkbox, and a toolbar whose bulk actions really
 * clear the selection (and, for Delete, remove the row).
 */
function SelectionHarness() {
  const [count, setCount] = useState(2);
  const [rowPresent, setRowPresent] = useState(true);
  return (
    <>
      {rowPresent && <button type="button">Row checkbox</button>}
      <button type="button" role="checkbox" aria-checked="false" aria-label="Select all" />
      <button type="button" onClick={() => setCount(0)}>
        Elsewhere
      </button>
      <BulkActionsToolbar
        selectedCount={count}
        onClearSelection={() => setCount(0)}
        onBulkDelete={async () => {
          setRowPresent(false);
          setCount(0);
        }}
        onBulkSetProjects={async () => setCount(0)}
        onBulkSetTags={async () => setCount(0)}
        projects={[PROJECT]}
        tags={[TAG]}
      />
    </>
  );
}

describe("BulkActionsToolbar — focus when the toolbar disappears", () => {
  it("returns focus to the control it came from after Clear Selection", () => {
    render(<SelectionHarness />);
    const row = screen.getByRole("button", { name: "Row checkbox" });
    const clear = screen.getByRole("button", { name: "Clear Selection" });
    act(() => row.focus());
    act(() => clear.focus());

    fireEvent.click(clear);
    expect(screen.queryByRole("region", { name: "Bulk actions" })).toBeNull();
    expect(row).toHaveFocus();
  });

  it("falls back to Select all when the control it came from was deleted with the selection", async () => {
    render(<SelectionHarness />);
    const row = screen.getByRole("button", { name: "Row checkbox" });
    const toolbarDelete = screen.getByRole("button", { name: "Delete" });
    act(() => row.focus());
    act(() => toolbarDelete.focus());

    fireEvent.click(toolbarDelete);
    const dialog = await screen.findByRole("dialog", { name: "Delete 2 papers?" });
    await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true));
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(screen.queryByRole("button", { name: "Row checkbox" })).toBeNull();
    expect(screen.getByRole("checkbox", { name: "Select all" })).toHaveFocus();
  });

  it("never moves focus that sits on a real control", () => {
    render(<SelectionHarness />);
    const row = screen.getByRole("button", { name: "Row checkbox" });
    act(() => row.focus());

    fireEvent.click(screen.getByRole("button", { name: "Elsewhere" }));
    expect(screen.queryByRole("region", { name: "Bulk actions" })).toBeNull();
    expect(row).toHaveFocus();
  });

  // The two cases below leave focus on <body> on purpose: neither one is focus
  // the toolbar dropped, so claiming it would be a surprise jump.

  it("does not claim focus that was never in the toolbar", () => {
    render(<SelectionHarness />);
    expect(document.activeElement).toBe(document.body);

    fireEvent.click(screen.getByRole("button", { name: "Elsewhere" }));
    expect(screen.queryByRole("region", { name: "Bulk actions" })).toBeNull();
    expect(document.activeElement).toBe(document.body);
  });

  it("does not claim focus the user had already moved out of the toolbar", () => {
    render(<SelectionHarness />);
    const row = screen.getByRole("button", { name: "Row checkbox" });
    const elsewhere = screen.getByRole("button", { name: "Elsewhere" });
    act(() => row.focus());
    act(() => screen.getByRole("button", { name: "Set Tags" }).focus());
    act(() => elsewhere.focus());
    act(() => elsewhere.blur());

    fireEvent.click(elsewhere);
    expect(screen.queryByRole("region", { name: "Bulk actions" })).toBeNull();
    expect(document.activeElement).toBe(document.body);
  });
});
