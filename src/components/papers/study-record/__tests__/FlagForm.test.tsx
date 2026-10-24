import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { RecordedValue } from "@/lib/evidence/types";
import { assemble, fullRows, valueRow, VALUE_CONDITION } from "@/lib/studyRecord/__tests__/fixtures";
import { FlagForm } from "../FlagForm";

/**
 * The Flag note (EVIDENCE-RECORDS-001C2A): checked as the server checks it —
 * PR-B's `checkFlag`, at least 3 characters after trimming spaces, not blank
 * after normalization v1, at most 2,000 code points, well formed — with every
 * problem in words, linked to the field, and nothing sent until it is right.
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

function renderForm(saved: RecordedValue = value()) {
  const onSubmit = vi.fn();
  const onCancel = vi.fn();
  render(<FlagForm id="flag" value={saved} working={false} heldReason={null} onSubmit={onSubmit} onCancel={onCancel} />);
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
    render(<FlagForm id="flag" value={value()} working={false} heldReason="Wait for the current action to finish." onSubmit={onSubmit} onCancel={vi.fn()} />);
    fireEvent.change(screen.getByLabelText("What's wrong with this value?"), { target: { value: "Check the table" } });
    fireEvent.click(screen.getByRole("button", { name: "Flag" }));
    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByText("Wait for the current action to finish.")).toBeInTheDocument();
  });
});
