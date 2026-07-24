import { useState } from "react";
import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { render, screen, within, fireEvent, waitFor, act } from "@testing-library/react";
import type { Project, Tag } from "@/types/database";

// The parser is mocked so file-import tests are deterministic and never depend
// on real BibTeX/RIS/CSV parsing. The FileReader (jsdom-provided) still runs, so
// the component's read → parse → preview pipeline is exercised end to end.
const parseFileMock = vi.fn();
vi.mock("@/lib/importParsers", () => ({
  parseFile: (...args: unknown[]) => parseFileMock(...args),
}));

import { AddPaperDialog } from "../AddPaperDialog";

// Radix Dialog/Popover + cmdk rely on a few DOM APIs jsdom does not implement.
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

const PROJECTS: Project[] = [
  { id: "p1", user_id: "u", name: "Alpha", description: null, color: "#f00", created_at: "" },
  { id: "p2", user_id: "u", name: "Beta", description: null, color: "#0f0", created_at: "" },
];

const TAGS: Tag[] = [
  { id: "t1", user_id: "u", name: "Omega", color: "#00f", created_at: "" },
  { id: "t2", user_id: "u", name: "Sigma", color: "#0ac", created_at: "" },
];

// ── Deterministic import-callback mocks ──────────────────────────────────

/** Resolve a bulk import by driving progress to completion with the given ids. */
function makeBulkImport(
  outcome: (ids: string[]) => { addedIds: string[]; skippedIds: string[]; failedIds: string[] } = (
    ids,
  ) => ({ addedIds: ids, skippedIds: [], failedIds: [] }),
) {
  return vi.fn(
    async (
      ids: string[],
      onProgress?: (
        current: number,
        total: number,
        addedIds: string[],
        skippedIds: string[],
        failedIds: string[],
      ) => void,
    ) => {
      const { addedIds, skippedIds, failedIds } = outcome(ids);
      onProgress?.(ids.length, ids.length, addedIds, skippedIds, failedIds);
    },
  );
}

function makeFileImport(added = 1, skipped = 0, failed = 0) {
  return vi.fn(
    async (
      papers: unknown[],
      onProgress?: (
        current: number,
        total: number,
        added: number,
        skipped: number,
        failed: number,
      ) => void,
    ) => {
      onProgress?.(papers.length, papers.length, added, skipped, failed);
    },
  );
}

// ── Query helpers (user-event is not a dependency — use fireEvent) ────────

/** The Project/Tag popover triggers carry visible text ("Projects"/"1 project");
 *  the icon-only remove buttons have empty textContent, so filtering on
 *  textContent disambiguates the trigger from the badge remove controls. */
function triggerButton(re: RegExp): HTMLElement {
  const btn = screen
    .getAllByRole("button")
    .find((b) => re.test(b.textContent || ""));
  if (!btn) throw new Error(`No trigger button matching ${re}`);
  return btn;
}

async function selectFromPopover(
  triggerRe: RegExp,
  placeholder: string,
  names: string[],
) {
  fireEvent.click(triggerButton(triggerRe));
  await screen.findByPlaceholderText(placeholder);
  for (const name of names) {
    fireEvent.click(screen.getByRole("option", { name: new RegExp(name) }));
  }
  // The popover is modal — while open it aria-hides the dialog's own controls,
  // so close it (Escape) and wait for it to unmount before the next interaction.
  fireEvent.keyDown(document.activeElement || document.body, { key: "Escape" });
  await waitFor(() =>
    expect(screen.queryByPlaceholderText(placeholder)).toBeNull(),
  );
}

/** Radix Tabs activate on mouse-down (primary button), not click. */
function switchTab(re: RegExp) {
  const tab = screen.getByRole("tab", { name: re });
  fireEvent.mouseDown(tab, { button: 0 });
  fireEvent.click(tab);
}

/** The dialog renders a built-in top-right "Close" control whose accessible name
 *  collides with the footer Close button. Scope to the footer (found via the
 *  primary action that always shares its container) to target the footer one. */
function footerCloseButton(primaryName: RegExp | string): HTMLElement {
  const footer = screen.getByRole("button", { name: primaryName }).parentElement!;
  return within(footer).getByRole("button", { name: "Close" });
}

const selectProjects = (...names: string[]) =>
  selectFromPopover(/projects?/i, "Search projects...", names);
const selectTags = (...names: string[]) =>
  selectFromPopover(/tags?/i, "Search tags...", names);

function idTextarea(): HTMLTextAreaElement {
  return screen.getByLabelText(
    "Paste PMIDs or DOIs, or drop a .txt/.csv file",
  ) as HTMLTextAreaElement;
}

function typeIdentifiers(text: string) {
  fireEvent.change(idTextarea(), { target: { value: text } });
}

/** Load a file through the hidden input, letting FileReader + the mocked
 *  parser populate the preview. Resolves once the preview is visible. */
async function loadFile(name = "refs.ris", content = "dummy") {
  await screen.findByText(/Drop a file or click to browse/i);
  const input = document.getElementById("file-import-input") as HTMLInputElement;
  const file = new File([content], name, { type: "text/plain" });
  fireEvent.change(input, { target: { files: [file] } });
  await screen.findByText(/Found \d+ paper/i);
}

function renderDialog(overrides: Partial<Parameters<typeof AddPaperDialog>[0]> = {}) {
  const onOpenChange = vi.fn();
  const onBulkImport = overrides.onBulkImport ?? makeBulkImport();
  const onFileImport = overrides.onFileImport ?? makeFileImport();
  render(
    <AddPaperDialog
      open
      onOpenChange={onOpenChange}
      onBulkImport={onBulkImport}
      onFileImport={onFileImport}
      projects={PROJECTS}
      tags={TAGS}
      {...overrides}
    />,
  );
  return {
    onOpenChange,
    onBulkImport: vi.mocked(onBulkImport),
    onFileImport: vi.mocked(onFileImport),
  };
}

beforeEach(() => {
  parseFileMock.mockReset();
  parseFileMock.mockReturnValue({
    papers: [{ title: "Paper A", authors: ["Smith J"], year: 2024 }],
    warnings: [],
  });
});

// ── Controlled-parent harness for close/reopen (full-reset) tests ─────────

/** Renders the dialog under a parent that owns `open`, plus a "reopen" button.
 *  Closing through the dialog's own controls drives `onOpenChange(false)` and
 *  the internal full reset; "reopen" re-mounts the content to inspect state. */
function renderControlled() {
  function Controlled() {
    const [open, setOpen] = useState(true);
    return (
      <>
        <button onClick={() => setOpen(true)}>reopen</button>
        <AddPaperDialog
          open={open}
          onOpenChange={setOpen}
          onBulkImport={makeBulkImport()}
          onFileImport={makeFileImport()}
          projects={PROJECTS}
          tags={TAGS}
        />
      </>
    );
  }
  render(<Controlled />);
}

const reopen = () => fireEvent.click(screen.getByRole("button", { name: "reopen" }));

/** Trigger the dialog's full close/reset. The dialog's built-in top-right Close
 *  and any footer Close both route through `resetAndClose`; the first match
 *  suffices, and `hidden: true` still finds it when a modal popover is open. */
function fullClose() {
  const closes = screen.getAllByRole("button", { name: "Close", hidden: true });
  fireEvent.click(closes[0]);
}

const fileDropzone = () =>
  screen.getByRole("button", { name: "Choose a file to import" });

// ══════════════════════════════════════════════════════════════════════════
// Identifier-import continuation
// ══════════════════════════════════════════════════════════════════════════

describe("AddPaperDialog — identifier import", () => {
  it("14.1 passes selected Project/Tag IDs alongside identifiers", async () => {
    const { onBulkImport } = renderDialog();

    await selectProjects("Alpha");
    await selectTags("Omega");
    typeIdentifiers("111\n222");

    fireEvent.click(screen.getByRole("button", { name: /Import 2 Papers/i }));

    await screen.findByText("Import Results Summary");
    expect(onBulkImport).toHaveBeenCalledTimes(1);
    const [ids, , options] = onBulkImport.mock.calls[0];
    expect(ids).toEqual(["111", "222"]);
    expect(options).toEqual({ targetProjectIds: ["p1"], targetTagIds: ["t1"] });
  });

  it("14.2 keeps assignment controls accessible after completion", async () => {
    renderDialog();
    await selectProjects("Alpha");
    typeIdentifiers("111");
    fireEvent.click(screen.getByRole("button", { name: /Import 1 Paper/i }));

    await screen.findByText("Import Results Summary");
    expect(screen.getByText("Added (1)")).toBeInTheDocument();
    expect(screen.getByText("Assignments for next import")).toBeInTheDocument();
    expect(
      screen.getByText(/apply to the next batch, not the completed import/i),
    ).toBeInTheDocument();
    // Project + Tag controls remain reachable (triggers still rendered).
    expect(triggerButton(/projects?/i)).toBeInTheDocument();
    expect(triggerButton(/tags?/i)).toBeInTheDocument();
    // Continuation + Close present; no re-runnable Import action for old input.
    expect(screen.getByRole("button", { name: "Import More" })).toBeInTheDocument();
    expect(footerCloseButton("Import More")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Import 1 Paper/i })).toBeNull();
  });

  it("14.3 Import More resets the run without closing and preserves selections", async () => {
    const { onOpenChange, onBulkImport } = renderDialog();
    await selectProjects("Alpha");
    typeIdentifiers("111");
    fireEvent.click(screen.getByRole("button", { name: /Import 1 Paper/i }));
    await screen.findByText("Import Results Summary");

    onBulkImport.mockClear();
    fireEvent.click(screen.getByRole("button", { name: "Import More" }));

    // Summary gone, ready state back, dialog still open.
    expect(screen.queryByText("Import Results Summary")).toBeNull();
    expect(idTextarea()).toHaveValue("");
    expect(screen.getByRole("button", { name: /Import Papers/i })).toBeInTheDocument();
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(onBulkImport).not.toHaveBeenCalled();
    // Selection preserved.
    expect(screen.getByLabelText("Remove project Alpha")).toBeInTheDocument();
  });

  it("14.4 second batch sends only the new identifiers with current selections", async () => {
    const { onBulkImport } = renderDialog();
    await selectProjects("Alpha");
    typeIdentifiers("111");
    fireEvent.click(screen.getByRole("button", { name: /Import 1 Paper/i }));
    await screen.findByText("Import Results Summary");

    fireEvent.click(screen.getByRole("button", { name: "Import More" }));
    // Change the next-batch selection: add a tag.
    await selectTags("Omega");
    typeIdentifiers("999");
    fireEvent.click(screen.getByRole("button", { name: /Import 1 Paper/i }));
    await screen.findByText("Import Results Summary");

    expect(onBulkImport).toHaveBeenCalledTimes(2);
    const [ids, , options] = onBulkImport.mock.calls[1];
    expect(ids).toEqual(["999"]);
    expect(options).toEqual({ targetProjectIds: ["p1"], targetTagIds: ["t1"] });
  });

  it("14.5 completed state exposes no button that re-imports the old batch", async () => {
    const { onBulkImport } = renderDialog();
    typeIdentifiers("111\n222");
    fireEvent.click(screen.getByRole("button", { name: /Import 2 Papers/i }));
    await screen.findByText("Import Results Summary");

    // No enabled Import action remains; only Import More (a local reset).
    expect(screen.queryByRole("button", { name: /Import 2 Papers/i })).toBeNull();
    onBulkImport.mockClear();
    fireEvent.click(screen.getByRole("button", { name: "Import More" }));
    expect(onBulkImport).not.toHaveBeenCalled();
    // Fresh ready state: Import is disabled until new identifiers are entered.
    expect(screen.getByRole("button", { name: /Import Papers/i })).toBeDisabled();
  });

  it.each([
    ["all added", (ids: string[]) => ({ addedIds: ids, skippedIds: [], failedIds: [] }), "Added (2)"],
    ["all skipped", (ids: string[]) => ({ addedIds: [], skippedIds: ids, failedIds: [] }), /Skipped/i],
    ["all failed", (ids: string[]) => ({ addedIds: [], skippedIds: [], failedIds: ids }), "Failed (2)"],
  ])("14.6 reaches the continuation state for %s", async (_label, outcome, marker) => {
    renderDialog({ onBulkImport: makeBulkImport(outcome as never) });
    typeIdentifiers("111\n222");
    fireEvent.click(screen.getByRole("button", { name: /Import 2 Papers/i }));
    await screen.findByText("Import Results Summary");
    expect(screen.getByText(marker)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Import More" })).toBeInTheDocument();
  });

  it("14.13 running state hides continuation, disables tabs, hides assignment", async () => {
    let resolveRun: (() => void) | undefined;
    const onBulkImport = vi.fn(
      (
        ids: string[],
        onProgress?: (
          c: number,
          t: number,
          a: string[],
          s: string[],
          f: string[],
        ) => void,
      ) => {
        onProgress?.(0, ids.length, [], [], []); // started, not yet complete
        return new Promise<void>((r) => {
          resolveRun = r;
        });
      },
    );
    renderDialog({ onBulkImport });
    typeIdentifiers("111\n222");
    fireEvent.click(screen.getByRole("button", { name: /Import 2 Papers/i }));

    await screen.findByText(/Processing 0 of 2/i);
    expect(screen.queryByRole("button", { name: "Import More" })).toBeNull();
    expect(screen.getByRole("tab", { name: /Import File/i })).toBeDisabled();
    expect(screen.queryByText("Assign on Import")).toBeNull();

    // Resolve so the pending run settles without leaking act warnings.
    await act(async () => {
      resolveRun?.();
      await Promise.resolve();
    });
  });
});

// ══════════════════════════════════════════════════════════════════════════
// File-import continuation
// ══════════════════════════════════════════════════════════════════════════

describe("AddPaperDialog — file import", () => {
  it("14.7 passes selected Project/Tag IDs alongside parsed papers", async () => {
    const { onFileImport } = renderDialog();
    switchTab(/Import File/i);
    await loadFile();
    await selectProjects("Alpha");
    await selectTags("Omega");

    fireEvent.click(screen.getByRole("button", { name: /Import 1 Paper/i }));
    await screen.findByText("File Import Results");

    expect(onFileImport).toHaveBeenCalledTimes(1);
    const [papers, , options] = onFileImport.mock.calls[0];
    expect(papers).toHaveLength(1);
    expect(options).toEqual({ targetProjectIds: ["p1"], targetTagIds: ["t1"] });
  });

  it("14.8 keeps assignment controls accessible after completion", async () => {
    renderDialog();
    switchTab(/Import File/i);
    await loadFile();
    fireEvent.click(screen.getByRole("button", { name: /Import 1 Paper/i }));
    await screen.findByText("File Import Results");

    expect(screen.getByText(/1 added/i)).toBeInTheDocument();
    expect(screen.getByText("Assignments for next import")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Import Another File" })).toBeInTheDocument();
    expect(footerCloseButton("Import Another File")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Import 1 Paper/i })).toBeNull();
  });

  it("14.9 Import Another File clears the file run and preserves selections", async () => {
    const { onOpenChange, onFileImport } = renderDialog();
    switchTab(/Import File/i);
    await loadFile("first.ris");
    await selectProjects("Alpha"); // assignment section is shown in the preview
    fireEvent.click(screen.getByRole("button", { name: /Import 1 Paper/i }));
    await screen.findByText("File Import Results");

    onFileImport.mockClear();
    fireEvent.click(screen.getByRole("button", { name: "Import Another File" }));

    // Back to the dropzone; previous parse/results cleared; dialog still open.
    expect(screen.queryByText("File Import Results")).toBeNull();
    expect(screen.queryByText("first.ris")).toBeNull();
    expect(screen.getByText(/Drop a file or click to browse/i)).toBeInTheDocument();
    expect(onFileImport).not.toHaveBeenCalled();
    expect(onOpenChange).not.toHaveBeenCalled();
    // Selection preserved across the file-run reset: it reappears in the next
    // preview (the empty dropzone deliberately hides the assignment section).
    await loadFile("second.ris");
    expect(screen.getByLabelText("Remove project Alpha")).toBeInTheDocument();
  });

  it("14.10 next file uses the preserved selections", async () => {
    const { onFileImport } = renderDialog();
    switchTab(/Import File/i);
    await loadFile("first.ris");
    await selectProjects("Alpha");
    fireEvent.click(screen.getByRole("button", { name: /Import 1 Paper/i }));
    await screen.findByText("File Import Results");

    fireEvent.click(screen.getByRole("button", { name: "Import Another File" }));
    await loadFile("second.ris");
    fireEvent.click(screen.getByRole("button", { name: /Import 1 Paper/i }));
    await screen.findByText("File Import Results");

    expect(onFileImport).toHaveBeenCalledTimes(2);
    const [, , options] = onFileImport.mock.calls[1];
    expect(options).toEqual({ targetProjectIds: ["p1"] });
  });
});

// ══════════════════════════════════════════════════════════════════════════
// Shared assignment state, reset boundaries, safety
// ══════════════════════════════════════════════════════════════════════════

describe("AddPaperDialog — shared state and resets", () => {
  it("14.11 assignment selections survive tab changes", async () => {
    renderDialog();
    // Select on the Import IDs tab (its ready state shows the assignment section).
    await selectProjects("Alpha");
    await selectTags("Omega");

    // Manual always shows the assignment section — selections persist there.
    switchTab(/Manual/i);
    expect(screen.getByLabelText("Remove project Alpha")).toBeInTheDocument();
    expect(screen.getByLabelText("Remove tag Omega")).toBeInTheDocument();

    // The File tab surfaces the shared selection once a file is previewed.
    switchTab(/Import File/i);
    await loadFile();
    expect(screen.getByLabelText("Remove project Alpha")).toBeInTheDocument();
    expect(screen.getByLabelText("Remove tag Omega")).toBeInTheDocument();

    // Returning to Import IDs still shows them.
    switchTab(/Import IDs/i);
    expect(screen.getByLabelText("Remove project Alpha")).toBeInTheDocument();
    expect(screen.getByLabelText("Remove tag Omega")).toBeInTheDocument();
  });

  it("14.12 / 9.5 full close resets identifier, Project and Tag state on reopen", async () => {
    renderControlled();

    await selectProjects("Alpha");
    await selectTags("Omega");
    typeIdentifiers("111\n222");
    fireEvent.click(screen.getByRole("button", { name: /Import 2 Papers/i }));
    await screen.findByText("Import Results Summary");

    // Close (full reset) then reopen.
    fullClose();
    await waitFor(() =>
      expect(screen.queryByText("Import Results Summary")).toBeNull(),
    );
    reopen();

    // Import IDs is the active tab and every field/selection is cleared.
    expect(idTextarea()).toHaveValue("");
    expect(screen.queryByText("Import Results Summary")).toBeNull();
    expect(screen.queryByLabelText("Remove project Alpha")).toBeNull();
    expect(screen.queryByLabelText("Remove tag Omega")).toBeNull();
  });

  it("9.6 full close resets the manual form", async () => {
    renderControlled();
    switchTab(/Manual/i);
    fireEvent.change(screen.getByLabelText("Title *"), {
      target: { value: "My Paper" },
    });
    fireEvent.change(screen.getByLabelText("Journal"), {
      target: { value: "Journal of Tests" },
    });

    fullClose();
    reopen();

    // Active tab is back to Import IDs; the manual fields are empty.
    expect(idTextarea()).toBeInTheDocument();
    switchTab(/Manual/i);
    expect(screen.getByLabelText("Title *")).toHaveValue("");
    expect(screen.getByLabelText("Journal")).toHaveValue("");
  });

  it("9.7 full close resets file state", async () => {
    renderControlled();
    switchTab(/Import File/i);
    await loadFile("myfile.ris");
    expect(screen.getByText("myfile.ris")).toBeInTheDocument();

    fullClose();
    reopen();
    switchTab(/Import File/i);

    expect(screen.queryByText("myfile.ris")).toBeNull();
    expect(screen.queryByText(/Found \d+ paper/i)).toBeNull();
    expect(screen.getByText(/Drop a file or click to browse/i)).toBeInTheDocument();
  });

  it("9.8 full close resets identifier drag state", async () => {
    renderControlled();
    // The drop overlay lives in the textarea's wrapping drop container.
    fireEvent.dragOver(idTextarea().parentElement!);
    expect(screen.getByText("Drop .txt or .csv file")).toBeInTheDocument();

    fullClose();
    reopen();

    expect(screen.queryByText("Drop .txt or .csv file")).toBeNull();
  });

  it("9.8b full close resets file drag state", async () => {
    renderControlled();
    switchTab(/Import File/i);
    fireEvent.dragOver(fileDropzone());
    expect(screen.getByText("Drop your file here")).toBeInTheDocument();

    fullClose();
    reopen();
    switchTab(/Import File/i);

    expect(screen.queryByText("Drop your file here")).toBeNull();
    expect(screen.getByText(/Drop a file or click to browse/i)).toBeInTheDocument();
  });

  it("9.9 open assignment popover does not survive full close", async () => {
    renderControlled();
    // Open the Project popover (modal — it aria-hides the dialog's own controls).
    fireEvent.click(triggerButton(/projects?/i));
    await screen.findByPlaceholderText("Search projects...");

    // Close the dialog through its built-in Close (reachable via hidden:true),
    // then reopen: the popover must not auto-open.
    fullClose();
    reopen();

    expect(screen.queryByPlaceholderText("Search projects...")).toBeNull();
  });

  it("14.14 changing selections after completion invokes no import/db callback", async () => {
    const { onBulkImport } = renderDialog();
    typeIdentifiers("111");
    fireEvent.click(screen.getByRole("button", { name: /Import 1 Paper/i }));
    await screen.findByText("Import Results Summary");

    onBulkImport.mockClear();
    // Adjust next-import assignments while the completed summary is shown.
    await selectProjects("Beta");
    expect(screen.getByLabelText("Remove project Beta")).toBeInTheDocument();
    expect(onBulkImport).not.toHaveBeenCalled();
    // The completed summary is historical and stays put.
    expect(screen.getByText("Import Results Summary")).toBeInTheDocument();
  });
});

// ══════════════════════════════════════════════════════════════════════════
// Continuation accessibility and focus (IMPORT-CONTINUATION-WORKFLOW-001A)
// ══════════════════════════════════════════════════════════════════════════

describe("AddPaperDialog — continuation accessibility and focus", () => {
  it("9.1 Import More returns focus to the identifier textarea", async () => {
    renderDialog();
    typeIdentifiers("111");
    fireEvent.click(screen.getByRole("button", { name: /Import 1 Paper/i }));
    await screen.findByText("Import Results Summary");

    fireEvent.click(screen.getByRole("button", { name: "Import More" }));
    await waitFor(() => expect(idTextarea()).toHaveFocus());
  });

  it("9.2 Import Another File returns focus to the dropzone", async () => {
    renderDialog();
    switchTab(/Import File/i);
    await loadFile();
    fireEvent.click(screen.getByRole("button", { name: /Import 1 Paper/i }));
    await screen.findByText("File Import Results");

    fireEvent.click(screen.getByRole("button", { name: "Import Another File" }));
    const dz = await screen.findByRole("button", {
      name: "Choose a file to import",
    });
    await waitFor(() => expect(dz).toHaveFocus());
  });

  it("9.3 Enter and Space on the dropzone open the file picker", async () => {
    renderDialog();
    switchTab(/Import File/i);
    const dz = fileDropzone();
    const input = document.getElementById("file-import-input") as HTMLInputElement;
    // Spy + no-op so no real OS picker is invoked.
    const clickSpy = vi.spyOn(input, "click").mockImplementation(() => {});

    fireEvent.keyDown(dz, { key: "Enter" });
    expect(clickSpy).toHaveBeenCalledTimes(1);

    clickSpy.mockClear();
    // fireEvent returns false when the event's default action was prevented.
    const notCancelled = fireEvent.keyDown(dz, { key: " " });
    expect(clickSpy).toHaveBeenCalledTimes(1);
    expect(notCancelled).toBe(false); // Space default (page scroll) is prevented

    clickSpy.mockRestore();
  });

  it("9.4 dropzone is a semantic, keyboard-operable, visibly-focusable button", async () => {
    renderDialog();
    switchTab(/Import File/i);
    const dz = fileDropzone();

    expect(dz).toHaveAttribute("role", "button");
    expect(dz).toHaveAttribute("tabindex", "0");
    expect(dz).toHaveAccessibleName("Choose a file to import");
    // Visible focus replacement for the removed raw outline.
    expect(dz.className).toMatch(/focus-visible:ring-2/);
  });
});
