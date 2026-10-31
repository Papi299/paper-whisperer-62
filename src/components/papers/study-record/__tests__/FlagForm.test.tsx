import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import type { RecordedValue } from "@/lib/evidence/types";
import { assemble, fullRows, valueRow, VALUE_CONDITION } from "@/lib/studyRecord/__tests__/fixtures";
import { FlagForm } from "../FlagForm";

/**
 * The Flag note (EVIDENCE-RECORDS-001C2A): checked as the server checks it —
 * PR-B's `checkFlag`, at least 3 characters after trimming spaces, not blank
 * after normalization v1, at most 2,000 code points, well formed — with every
 * problem in words, linked to the field, and nothing sent until it is right.
 * The note is the editor's since C2C-B (G3): the form shows and changes the
 * note it is given, here held by a stand-in for the editor's store.
 */

const cp = (code: number) => String.fromCodePoint(code);
const ASTRAL = cp(0x1d6fc); // MATHEMATICAL ITALIC SMALL ALPHA: one code point, two UTF-16 units
const ZWSP = cp(0x200b);
const NBSP = cp(0x00a0);

function value(overrides: Parameters<typeof valueRow>[0] = {}): RecordedValue {
  const rows = fullRows();
  rows.values = [valueRow({ id: VALUE_CONDITION, ...overrides })];
  return assemble(rows).values[0];
}

/** The editor's note store, reduced to one note: it starts as the editor's `openFlag` starts it. */
function Controlled({
  saved,
  start,
  autoFocus = true,
  heldReason = null,
  onSubmit,
  onCancel,
}: {
  readonly saved: RecordedValue;
  readonly start?: string;
  readonly autoFocus?: boolean;
  readonly heldReason?: string | null;
  readonly onSubmit: (note: string) => void;
  readonly onCancel: () => void;
}) {
  const [note, setNote] = useState(start ?? (saved.review.status === "disputed" ? saved.review.note ?? "" : ""));
  return <FlagForm id="flag" value={saved} note={note} onNoteChange={setNote} autoFocus={autoFocus} working={false} heldReason={heldReason} onSubmit={onSubmit} onCancel={onCancel} />;
}

function renderForm(saved: RecordedValue = value()) {
  const onSubmit = vi.fn();
  const onCancel = vi.fn();
  render(<Controlled saved={saved} onSubmit={onSubmit} onCancel={onCancel} />);
  const note = screen.getByLabelText("What's wrong with this value?");
  const submit = () => fireEvent.click(screen.getByRole("button", { name: /^(Flag|Update flag)$/ }));
  const type = (text: string) => fireEvent.change(note, { target: { value: text } });
  return { note, submit, type, onSubmit, onCancel };
}

const error = () => screen.queryByRole("alert")?.textContent ?? null;

describe("the Flag note", () => {
  it("refuses two characters and sends three, measured after trimming spaces", () => {
    const form = renderForm();
    form.type("  ab  ");
    form.submit();
    expect(error()).toBe("Say what's wrong, in at least 3 characters.");
    expect(form.note).toHaveAttribute("aria-invalid", "true");
    expect(form.note.getAttribute("aria-describedby")).toContain(screen.getByRole("alert").id);
    expect(form.onSubmit).not.toHaveBeenCalled();

    form.type("abc");
    expect(error()).toBeNull();
    expect(form.note).not.toHaveAttribute("aria-invalid");
    form.submit();
    expect(form.onSubmit).toHaveBeenCalledWith("abc");
  });

  it("refuses a note that is only white space or invisible characters — blank after normalization", () => {
    for (const blank of ["     ", `${ZWSP}${ZWSP}${ZWSP}`, `${NBSP}${NBSP}${NBSP}${NBSP}`, `${ZWSP}${NBSP}${ZWSP}${NBSP}`]) {
      const form = renderForm();
      form.type(blank);
      form.submit();
      expect(error(), JSON.stringify(blank)).toBe("Say what's wrong, in at least 3 characters.");
      expect(form.onSubmit).not.toHaveBeenCalled();
      document.body.innerHTML = "";
    }
  });

  it("allows 2,000 code points and refuses 2,001, counting an astral character once", () => {
    const form = renderForm();
    form.type(ASTRAL.repeat(2000));
    expect(screen.getByText("2,000 of 2,000 characters")).toBeInTheDocument();
    expect(error()).toBeNull();
    form.submit();
    expect(form.onSubmit).toHaveBeenCalledWith(ASTRAL.repeat(2000));

    form.onSubmit.mockClear();
    form.type(`${ASTRAL.repeat(2000)}a`);
    expect(screen.getByText("2,001 of 2,000 characters")).toBeInTheDocument();
    // Too long is said at once, before any submit.
    expect(error()).toBe("Flag notes can be up to 2,000 characters.");
    form.submit();
    expect(form.onSubmit).not.toHaveBeenCalled();
  });

  it("refuses text that can't be stored (a lone surrogate), in words", () => {
    const form = renderForm();
    form.type(`Check ${String.fromCharCode(0xd800)} this`);
    expect(error()).toBe("This note contains characters that can't be saved.");
    form.submit();
    expect(form.onSubmit).not.toHaveBeenCalled();
  });

  it("starts from the flag's note, waits for a change, and then updates it", () => {
    const form = renderForm(value({ review_status: "disputed", review_note: "Check the methods" }));
    expect(form.note).toHaveValue("Check the methods");
    const update = screen.getByRole("button", { name: "Update flag" });
    expect(update).toBeDisabled();
    expect(screen.getByText("Change the note to update the flag.")).toBeInTheDocument();
    expect(form.note.getAttribute("aria-describedby")).toContain(screen.getByText("Change the note to update the flag.").id);
    form.submit();
    expect(form.onSubmit).not.toHaveBeenCalled();

    form.type("Check the methods and Table 1");
    expect(update).toBeEnabled();
    form.submit();
    expect(form.onSubmit).toHaveBeenCalledWith("Check the methods and Table 1");
  });

  it("is labelled, says its rule and its count, takes focus, and cancels on Escape without sending", () => {
    const form = renderForm();
    expect(form.note).toHaveFocus();
    expect(form.note.getAttribute("aria-describedby")!.split(" ").map((id) => document.getElementById(id)?.textContent)).toEqual([
      "At least 3 characters. Your note is saved with the flag; flagging doesn't change the value.",
      "0 of 2,000 characters",
    ]);
    form.type("Something");
    fireEvent.keyDown(form.note, { key: "Escape" });
    expect(form.onCancel).toHaveBeenCalledTimes(1);
    expect(form.onSubmit).not.toHaveBeenCalled();
    // The form says so to the dialog: Escape here is the form's, not the dialog's.
    expect(screen.getByTestId("flag-form")).toHaveAttribute("data-escape-closes-form");
  });

  it("sends nothing while the card's actions wait, and says why", () => {
    const onSubmit = vi.fn();
    render(<Controlled saved={value()} heldReason="Wait for the current action to finish." onSubmit={onSubmit} onCancel={vi.fn()} />);
    fireEvent.change(screen.getByLabelText("What's wrong with this value?"), { target: { value: "Check the table" } });
    fireEvent.click(screen.getByRole("button", { name: "Flag" }));
    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByText("Wait for the current action to finish.")).toBeInTheDocument();
  });

  it("shows the note it is given — an unfinished one kept by the editor — and reports each change instead of keeping its own (G3)", () => {
    const onNoteChange = vi.fn();
    const { rerender } = render(
      <FlagForm id="flag" value={value()} note="Half a thou" onNoteChange={onNoteChange} autoFocus={false} working={false} heldReason={null} onSubmit={vi.fn()} onCancel={vi.fn()} />,
    );
    const note = screen.getByLabelText("What's wrong with this value?");
    expect(note).toHaveValue("Half a thou");
    fireEvent.change(note, { target: { value: "Half a thought" } });
    expect(onNoteChange).toHaveBeenCalledWith("Half a thought");
    // Not the form's to change: until the editor changes it, the note is as given.
    expect(note).toHaveValue("Half a thou");
    rerender(<FlagForm id="flag" value={value()} note="Half a thought" onNoteChange={onNoteChange} autoFocus={false} working={false} heldReason={null} onSubmit={vi.fn()} onCancel={vi.fn()} />);
    expect(note).toHaveValue("Half a thought");
  });

  it("takes focus only when the user opened it — not when its card comes back into view with the note still open (G3)", () => {
    const button = document.createElement("button");
    document.body.appendChild(button);
    button.focus();
    render(<Controlled saved={value()} start="Kept while hidden" autoFocus={false} onSubmit={vi.fn()} onCancel={vi.fn()} />);
    expect(screen.getByLabelText("What's wrong with this value?")).toHaveValue("Kept while hidden");
    expect(button).toHaveFocus();
    button.remove();
  });
});
