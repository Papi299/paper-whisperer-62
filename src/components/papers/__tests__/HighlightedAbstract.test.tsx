import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { HighlightedAbstract } from "../HighlightedAbstract";

/** Renders the highlighter and returns the text of every <mark> produced. */
function highlights(text: string, keywords: string[]): string[] {
  const { container } = render(<HighlightedAbstract text={text} keywords={keywords} />);
  return Array.from(container.querySelectorAll("mark")).map(m => m.textContent ?? "");
}

/** Renders the highlighter and returns the full visible text. */
function rendered(text: string, keywords: string[]): string {
  const { container } = render(<HighlightedAbstract text={text} keywords={keywords} />);
  return container.textContent ?? "";
}

describe("HighlightedAbstract", () => {
  const ABSTRACT = "The effects were evaluated by CT.";

  it("does not highlight a pool term inside an unrelated word", () => {
    // The reported defect: "ct" inside "effects" was wrapped in <mark>.
    expect(highlights(ABSTRACT, ["CT"])).toEqual(["CT"]);
  });

  it("highlights exactly one standalone occurrence", () => {
    const { container } = render(<HighlightedAbstract text={ABSTRACT} keywords={["CT"]} />);
    const marks = container.querySelectorAll("mark");
    expect(marks).toHaveLength(1);
    expect(marks[0].textContent).toBe("CT");
    // The highlight sits at the end of the sentence, not inside "effects".
    expect(container.innerHTML).toContain("evaluated by <mark");
    expect(container.innerHTML).toContain("effe");
    expect(container.innerHTML).not.toContain("effe<mark");
  });

  it("renders the abstract text unchanged", () => {
    expect(rendered(ABSTRACT, ["CT"])).toBe(ABSTRACT);
  });

  it("rejects the other reported false positives", () => {
    expect(highlights("Grip strength was measured.", ["TRE"])).toEqual([]);
    expect(highlights("A separate cohort was used.", ["EPA"])).toEqual([]);
    expect(highlights("Risk of bias was assessed.", ["BIA"])).toEqual([]);
  });

  it("preserves the original casing inside the highlight", () => {
    expect(highlights("A ct scan and a CT scan.", ["CT"])).toEqual(["ct", "CT"]);
  });

  it("highlights punctuation-adjacent terms", () => {
    expect(highlights("Imaging (CT) was used.", ["CT"])).toEqual(["CT"]);
    expect(highlights("Both CT/MRI were compared.", ["CT", "MRI"])).toEqual(["CT", "MRI"]);
    expect(highlights("CT-based imaging.", ["CT"])).toEqual(["CT"]);
  });

  it("highlights multi-word terms, including across a line break", () => {
    const term = "randomized controlled trial";
    expect(highlights("This randomized controlled trial ran.", [term]))
      .toEqual(["randomized controlled trial"]);
    expect(highlights("This randomized\ncontrolled trial ran.", [term]))
      .toEqual(["randomized\ncontrolled trial"]);
  });

  it("highlights a hyphenated term across dash variants without rewriting it", () => {
    expect(highlights("IL-6 increased.", ["IL-6"])).toEqual(["IL-6"]);
    expect(highlights("IL–6 increased.", ["IL-6"])).toEqual(["IL–6"]);
    expect(rendered("IL–6 increased.", ["IL-6"])).toBe("IL–6 increased.");
  });

  it("prefers the longer term and never nests highlights", () => {
    const { container } = render(
      <HighlightedAbstract text="A CT scan was performed." keywords={["CT", "CT scan"]} />,
    );
    const marks = container.querySelectorAll("mark");
    expect(marks).toHaveLength(1);
    expect(marks[0].textContent).toBe("CT scan");
    expect(marks[0].querySelector("mark")).toBeNull();
  });

  it("emits a single highlight for duplicate pool entries", () => {
    expect(highlights("CT was performed.", ["CT", "ct", "CT"])).toEqual(["CT"]);
  });

  it("highlights negated occurrences — negation is the extraction layer's job", () => {
    expect(highlights("A non-CT finding was noted.", ["CT"])).toEqual(["CT"]);
  });

  it("highlights a case-equivalent Greek term without rewriting the source", () => {
    // Pool term is uppercase; the source carries a lowercase word-final sigma.
    // The <mark> must contain the exact source spelling, not a folded form.
    const abstract = "The ος subunit was measured.";
    const { container } = render(
      <HighlightedAbstract text={abstract} keywords={["ΟΣ"]} />,
    );
    const marks = container.querySelectorAll("mark");
    expect(marks).toHaveLength(1);
    expect(marks[0].textContent).toBe("ος");
    expect(marks[0].textContent).not.toBe("οσ");
    expect(marks[0].textContent).not.toBe("ΟΣ");
    expect(container.textContent).toBe(abstract);
  });

  it("highlights every sigma form for a single pool term", () => {
    expect(highlights("Both ος and οσ and ΟΣ appear.", ["Σ"])).toEqual([]);
    expect(highlights("Forms ος, οσ, ΟΣ.", ["ΟΣ"])).toEqual(["ος", "οσ", "ΟΣ"]);
    expect(rendered("Forms ος, οσ, ΟΣ.", ["ΟΣ"])).toBe("Forms ος, οσ, ΟΣ.");
  });

  it("renders plain text when there is nothing to highlight", () => {
    expect(rendered(ABSTRACT, [])).toBe(ABSTRACT);
    expect(highlights(ABSTRACT, [])).toEqual([]);
    expect(rendered(ABSTRACT, ["asthma"])).toBe(ABSTRACT);
    expect(highlights(ABSTRACT, ["asthma"])).toEqual([]);
  });

  it("survives empty text and malformed pool entries", () => {
    expect(rendered("", ["CT"])).toBe("");
    expect(highlights(ABSTRACT, ["", "   "])).toEqual([]);
    expect(highlights(ABSTRACT, ["", "CT"])).toEqual(["CT"]);
  });

  it("treats regex-significant pool terms as literal text", () => {
    expect(highlights("Written in C++ mostly.", ["C++"])).toEqual(["C++"]);
    expect(highlights("Any text at all.", [".*"])).toEqual([]);
  });
});
