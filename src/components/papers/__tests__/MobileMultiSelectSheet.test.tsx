import { useRef, useState } from "react";
import { describe, it, expect, beforeAll, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import {
  MobileMultiSelectSheet,
  type MobileMultiSelectOption,
} from "../MobileMultiSelectSheet";

/**
 * ADD-PAPERS-MOBILE-SELECTORS-001 — the shared mobile selector surface.
 *
 * The *interaction* proof (real focus, real touch scrolling, keyboard-shrunk
 * viewports, nested overlays) is necessarily a browser one and lives in
 * `e2e/mobile-selectors.spec.ts`. What is worth pinning here is the contract
 * that does not need a real viewport: opening never focuses the search field,
 * options keep the caller's order, search filters without mutating selection,
 * selecting keeps the sheet open, and closing restores focus to the trigger.
 */

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

// Deliberately NOT alphabetical: the component must not re-sort.
const OPTIONS: MobileMultiSelectOption[] = [
  { value: "z", label: "Zebra", color: "#f00" },
  { value: "a", label: "Aardvark", color: "#0f0" },
  { value: "m", label: "Marmot" },
];

function Harness({
  options = OPTIONS,
  withClear = true,
}: {
  options?: MobileMultiSelectOption[];
  withClear?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const triggerRef = useRef<HTMLButtonElement>(null);

  return (
    <div>
      <button ref={triggerRef} onClick={() => setOpen(true)}>
        Open selector
      </button>
      <span data-testid="selected">{selected.join(",")}</span>
      <MobileMultiSelectSheet
        open={open}
        onOpenChange={setOpen}
        title="Select projects"
        triggerRef={triggerRef}
        options={options}
        selectedValues={selected}
        onToggle={(value) =>
          setSelected((prev) =>
            prev.includes(value) ? prev.filter((v) => v !== value) : [...prev, value],
          )
        }
        onClear={withClear ? () => setSelected([]) : undefined}
        clearLabel="Clear projects"
        searchPlaceholder="Search projects..."
        searchLabel="Search projects"
        emptyMessage="No projects found."
      />
    </div>
  );
}

const openSelector = async () => {
  fireEvent.click(screen.getByRole("button", { name: "Open selector" }));
  await screen.findByRole("dialog");
};

const search = () => screen.getByRole("textbox", { name: "Search projects" });
const optionRows = () => screen.getAllByRole("checkbox");
const selected = () => screen.getByTestId("selected").textContent;

describe("MobileMultiSelectSheet", () => {
  it("does not focus the search field when it opens", async () => {
    render(<Harness />);
    await openSelector();

    // The whole point of the task: the field is present and usable, but the
    // browser has no reason to raise a keyboard for it.
    expect(search()).toBeInTheDocument();
    expect(search()).not.toHaveFocus();
    expect(document.activeElement).not.toBe(search());
  });

  it("focuses its own title, so focus is inside the sheet and not on a text field", async () => {
    render(<Harness />);
    await openSelector();

    const title = screen.getByRole("heading", { name: "Select projects" });
    await waitFor(() => expect(title).toHaveFocus());
    expect(title).toHaveAttribute("tabindex", "-1");
    expect(document.activeElement).not.toBe(document.body);
  });

  it("keeps the caller's option order", async () => {
    render(<Harness />);
    await openSelector();
    expect(optionRows().map((o) => o.textContent)).toEqual(["Zebra", "Aardvark", "Marmot"]);
  });

  it("exposes each option as a checkbox with its own accessible name and state", async () => {
    render(<Harness />);
    await openSelector();

    const zebra = screen.getByRole("checkbox", { name: "Zebra" });
    expect(zebra).toHaveAttribute("aria-checked", "false");
    fireEvent.click(zebra);
    expect(screen.getByRole("checkbox", { name: "Zebra" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
  });

  it("stays open across selections — it is a multi-select", async () => {
    render(<Harness />);
    await openSelector();

    fireEvent.click(screen.getByRole("checkbox", { name: "Zebra" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Marmot" }));

    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(selected()).toBe("z,m");
  });

  it("filters case-insensitively without touching the selection", async () => {
    render(<Harness />);
    await openSelector();
    fireEvent.click(screen.getByRole("checkbox", { name: "Zebra" }));

    fireEvent.change(search(), { target: { value: "AARD" } });
    expect(optionRows().map((o) => o.textContent)).toEqual(["Aardvark"]);
    // Filtering is a view concern only.
    expect(selected()).toBe("z");

    fireEvent.change(search(), { target: { value: "" } });
    expect(optionRows()).toHaveLength(3);
  });

  it("shows the empty message when nothing matches", async () => {
    render(<Harness />);
    await openSelector();

    fireEvent.change(search(), { target: { value: "no-such-thing" } });
    expect(screen.getByText("No projects found.")).toBeInTheDocument();
    expect(screen.queryAllByRole("checkbox")).toHaveLength(0);
  });

  it("clears only through the caller's handler, and hides Clear when nothing is selected", async () => {
    render(<Harness />);
    await openSelector();

    expect(screen.queryByRole("button", { name: "Clear projects" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("checkbox", { name: "Zebra" }));
    fireEvent.click(screen.getByRole("button", { name: "Clear projects" }));
    expect(selected()).toBe("");
  });

  it("omits the clear action entirely when the caller has no clear semantics", async () => {
    render(<Harness withClear={false} />);
    await openSelector();
    fireEvent.click(screen.getByRole("checkbox", { name: "Zebra" }));
    expect(screen.queryByRole("button", { name: /^Clear/ })).not.toBeInTheDocument();
  });

  it("returns focus to the connected trigger when it closes", async () => {
    render(<Harness />);
    await openSelector();

    fireEvent.click(screen.getByRole("button", { name: "Done" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Open selector" })).toHaveFocus(),
    );
  });

  it("resets its search box on close, like the dropdown it replaces", async () => {
    render(<Harness />);
    await openSelector();
    fireEvent.change(search(), { target: { value: "aard" } });
    expect(search()).toHaveValue("aard");

    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());

    await openSelector();
    expect(search()).toHaveValue("");
    expect(optionRows()).toHaveLength(3);
  });

  it("renders caller-supplied supplementary controls without knowing what they mean", async () => {
    function WithExtra() {
      const [open, setOpen] = useState(true);
      const triggerRef = useRef<HTMLButtonElement>(null);
      return (
        <>
          <button ref={triggerRef}>trigger</button>
          <MobileMultiSelectSheet
            open={open}
            onOpenChange={setOpen}
            title="Select projects"
            triggerRef={triggerRef}
            options={OPTIONS}
            selectedValues={[]}
            onToggle={vi.fn()}
            searchPlaceholder="Search projects..."
            searchLabel="Search projects"
            emptyMessage="No projects found."
            headerExtra={<div data-testid="extra">Match selected</div>}
          />
        </>
      );
    }
    render(<WithExtra />);
    expect(await screen.findByTestId("extra")).toBeInTheDocument();
  });

  it("colours are decorative, never the only carrier of an option's identity", async () => {
    render(<Harness />);
    await openSelector();
    const zebra = screen.getByRole("checkbox", { name: "Zebra" });
    const swatches = zebra.querySelectorAll('[aria-hidden="true"]');
    expect(swatches.length).toBeGreaterThan(0);
    expect(zebra).toHaveAccessibleName("Zebra");
  });
});
