import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QuickAddDriveLink } from "../QuickAddDriveLink";

// Radix Popover relies on a few DOM APIs jsdom does not implement.
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

const onSave = vi.fn(async () => {});

beforeEach(() => {
  onSave.mockClear();
});

/** Every anchor currently in the document, as raw href attributes. */
function renderedHrefs(): string[] {
  return Array.from(document.querySelectorAll("a")).map((a) => a.getAttribute("href") ?? "");
}

describe("QuickAddDriveLink — stored value rendering", () => {
  it("renders a navigable link for a safe stored https drive URL", () => {
    render(
      <QuickAddDriveLink
        paperId="p1"
        driveUrl="https://drive.google.com/file/d/1a2b3c/view"
        onSave={onSave}
      />,
    );

    const link = screen.getByTitle("Open cloud link") as HTMLAnchorElement;
    expect(link.getAttribute("href")).toBe("https://drive.google.com/file/d/1a2b3c/view");
    expect(link.protocol).toBe("https:");
    expect(link.target).toBe("_blank");
    expect(link.rel).toBe("noopener noreferrer");
  });

  it("renders a navigable link for a safe stored http drive URL", () => {
    render(<QuickAddDriveLink paperId="p1" driveUrl="http://files.example.com/a.pdf" onSave={onSave} />);

    const link = screen.getByTitle("Open cloud link") as HTMLAnchorElement;
    expect(link.protocol).toBe("http:");
  });

  const unsafeStored = [
    "javascript:alert(1)",
    "JaVaScRiPt:alert(1)",
    "  javascript:alert(1)",
    "java\tscript:alert(1)",
    "data:text/html,<h1>x</h1>",
    "vbscript:msgbox(1)",
    "file:///etc/passwd",
    "ftp://example.com/f",
    "mailto:a@b.com",
    "//example.com/path",
    "/example/path",
    "example.com/path",
    "not a url",
  ];

  it.each(unsafeStored)("does not render %s as an href", (stored) => {
    render(<QuickAddDriveLink paperId="p1" driveUrl={stored} onSave={onSave} />);

    // No "open" link at all, and nothing in the DOM carries the unsafe value.
    expect(screen.queryByTitle("Open cloud link")).toBeNull();
    for (const href of renderedHrefs()) {
      expect(href).not.toContain("javascript");
      expect(href).not.toContain("vbscript");
      expect(href).not.toContain("data:");
      expect(href).not.toContain("example.com");
      expect(href).not.toContain("etc/passwd");
    }
  });

  it("keeps the correction flow reachable when the stored value is unsafe", async () => {
    render(<QuickAddDriveLink paperId="p1" driveUrl="javascript:alert(1)" onSave={onSave} />);

    // The user is not trapped: the add/replace popover is still openable, so a
    // historical bad value can be replaced without a data migration.
    const trigger = screen.getByTitle("Replace unsafe cloud link");
    fireEvent.click(trigger);

    const input = await screen.findByPlaceholderText("Paste cloud link...");
    fireEvent.change(input, { target: { value: "https://drive.google.com/file/d/ok/view" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => {
      expect(onSave).toHaveBeenCalledWith("p1", "https://drive.google.com/file/d/ok/view");
    });
  });
});

describe("QuickAddDriveLink — write-time validation", () => {
  /** Open the popover and type `value` into the URL field. */
  async function openAndType(value: string) {
    render(<QuickAddDriveLink paperId="p1" driveUrl={null} onSave={onSave} />);
    fireEvent.click(screen.getByTitle("Add cloud link"));
    const input = await screen.findByPlaceholderText("Paste cloud link...");
    fireEvent.change(input, { target: { value } });
    return input;
  }

  it("saves a newly entered safe URL verbatim", async () => {
    const input = await openAndType("https://dropbox.com/s/abc/paper.pdf");
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => {
      // Stored exactly as typed — never rewritten or re-normalized.
      expect(onSave).toHaveBeenCalledWith("p1", "https://dropbox.com/s/abc/paper.pdf");
    });
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("trims surrounding whitespace before saving a safe URL", async () => {
    const input = await openAndType("   https://example.com/paper   ");
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => {
      expect(onSave).toHaveBeenCalledWith("p1", "https://example.com/paper");
    });
  });

  const unsafeEntered = [
    "javascript:alert(1)",
    "JAVASCRIPT:alert(1)",
    "java\tscript:alert(1)",
    "data:text/html,<h1>x</h1>",
    "vbscript:msgbox(1)",
    "file:///etc/passwd",
    "ftp://example.com/f",
    "mailto:a@b.com",
    "//example.com/path",
    "/example/path",
    "drive.google.com/file/d/1",
    "not a url",
  ];

  it.each(unsafeEntered)("refuses to save %s and shows feedback", async (entered) => {
    const input = await openAndType(entered);
    fireEvent.keyDown(input, { key: "Enter" });

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Enter a full http:// or https:// link.");
    expect(onSave).not.toHaveBeenCalled();
  });

  it("does not auto-upgrade a bare hostname to https", async () => {
    const input = await openAndType("drive.google.com/file/d/1");
    fireEvent.keyDown(input, { key: "Enter" });

    await screen.findByRole("alert");
    expect(onSave).not.toHaveBeenCalled();
  });

  it("clears the validation message once the user edits the value", async () => {
    const input = await openAndType("javascript:alert(1)");
    fireEvent.keyDown(input, { key: "Enter" });
    await screen.findByRole("alert");

    fireEvent.change(input, { target: { value: "https://example.com/ok" } });
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());

    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(onSave).toHaveBeenCalledWith("p1", "https://example.com/ok"));
  });
});
