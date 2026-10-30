// @vitest-environment node
import { describe, expect, it } from "vitest";
import { DIFF_MAX_EDITS, diffSourceText, readBackSide, tokenizeSource, type DiffSegment, type SourceDiff } from "../sourceDiff";

/**
 * The Source pane's comparison (EVIDENCE-RECORDS-001C2C-A): exact read-back of
 * both texts, the shortest edit, and the budget past which it gives up.
 */

const cp = (...points: number[]) => String.fromCodePoint(...points);
const NBSP = cp(0x00a0);
const THIN = cp(0x2009);
const SOFT_HYPHEN = cp(0x00ad);
const ZWSP = cp(0x200b);
const ACUTE = cp(0x0301);
const E_ACUTE = cp(0x00e9);

const changes = (diff: SourceDiff) => (diff.kind === "changes" ? diff.segments.filter((segment): segment is Extract<DiffSegment, { kind: "change" }> => segment.kind === "change") : []);

function expectReadsBack(saved: string, library: string, diff = diffSourceText(saved, library)) {
  if (diff.kind !== "changes") throw new Error(`expected changes, got ${diff.kind}`);
  expect(readBackSide(diff.segments, "saved")).toBe(saved);
  expect(readBackSide(diff.segments, "library")).toBe(library);
  return diff;
}

/** A deterministic generator (mulberry32), so a failure can be replayed. */
function random(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The fewest tokens inserted and deleted to turn one token list into the other: n + m − 2·LCS, by dynamic programming. */
function editDistance(a: readonly string[], b: readonly string[]): number {
  const row = new Array<number>(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    let diagonal = 0;
    for (let j = 1; j <= b.length; j++) {
      const above = row[j];
      row[j] = a[i - 1] === b[j - 1] ? diagonal + 1 : Math.max(row[j], row[j - 1]);
      diagonal = above;
    }
  }
  return a.length + b.length - 2 * row[b.length];
}

describe("tokenizeSource", () => {
  it("joins back to the text exactly, whatever it holds", () => {
    const texts = [
      "",
      "Adults (n = 120) were randomized 1:1.",
      `BMI ${cp(0x2265)}30${THIN}kg/m${cp(0x00b2)}; p${THIN}<${THIN}0.001`,
      `cafe${ACUTE} ${E_ACUTE}tude in${SOFT_HYPHEN}formation ${ZWSP}x${cp(0x2060)}y${cp(0xfeff)}`,
      `line one\r\nline two\n\n\tindented${NBSP}${cp(0x202f)}${cp(0x3000)}end`,
      `${cp(0x1f600)}${cp(0x1f600)} emoji ${cp(0x4e2d)}${cp(0x6587)} ${cp(0x0627)}${cp(0x0644)}`,
      `${ACUTE}leading mark, ${ACUTE}${ACUTE} two marks, ${cp(0x2014)}${ACUTE} a dash with one`,
    ];
    for (const text of texts) expect(tokenizeSource(text).join("")).toBe(text);
  });

  it("keeps a combining mark with its letter, and splits white space, words and other characters apart", () => {
    expect(tokenizeSource(`cafe${ACUTE} au lait.`)).toEqual([`cafe${ACUTE}`, " ", "au", " ", "lait", "."]);
    expect(tokenizeSource(`p<0.05,${NBSP}n=12`)).toEqual(["p", "<", "0", ".", "05", ",", NBSP, "n", "=", "12"]);
    expect(tokenizeSource(`in${SOFT_HYPHEN}formation`)).toEqual(["in", SOFT_HYPHEN, "formation"]);
  });

  it("joins back random text over every kind of character", () => {
    const alphabet = ["a", "Z", "7", " ", "\n", "\t", NBSP, THIN, SOFT_HYPHEN, ZWSP, ACUTE, E_ACUTE, ".", "(", cp(0x2013), cp(0x201c), cp(0x1f600), cp(0x4e2d), "_"];
    const next = random(1);
    for (let round = 0; round < 300; round++) {
      const length = Math.floor(next() * 40);
      const text = Array.from({ length }, () => alphabet[Math.floor(next() * alphabet.length)]).join("");
      expect(tokenizeSource(text).join("")).toBe(text);
    }
  });
});

describe("diffSourceText", () => {
  it("says identical texts are identical, and nothing else is", () => {
    expect(diffSourceText("same text", "same text")).toEqual({ kind: "identical" });
    expect(diffSourceText("", "")).toEqual({ kind: "identical" });
    expect(diffSourceText("a", "a ").kind).toBe("changes");
  });

  it("shows a changed number as one change, the rest unchanged", () => {
    const diff = expectReadsBack("Methods: 120 participants were randomized.", "Methods: 118 participants were randomized.");
    expect(diff.segments).toEqual([
      { kind: "same", text: "Methods: " },
      { kind: "change", index: 0, removed: "120", added: "118" },
      { kind: "same", text: " participants were randomized." },
    ]);
    expect(diff).toMatchObject({ changeCount: 1, removedWords: 1, addedWords: 1 });
  });

  it("shows insertions and deletions at the start, the middle and the end", () => {
    expect(changes(expectReadsBack("weeks of metformin", "Twelve weeks of metformin"))).toEqual([{ kind: "change", index: 0, removed: "", added: "Twelve " }]);
    expect(changes(expectReadsBack("weeks of metformin daily", "weeks of metformin"))).toEqual([{ kind: "change", index: 0, removed: " daily", added: "" }]);
    expect(changes(expectReadsBack("a b c d", "a c d"))).toEqual([{ kind: "change", index: 0, removed: "b ", added: "" }]);
    expect(changes(expectReadsBack("", "Now an abstract."))).toEqual([{ kind: "change", index: 0, removed: "", added: "Now an abstract." }]);
    expect(changes(expectReadsBack("Once an abstract.", ""))).toEqual([{ kind: "change", index: 0, removed: "Once an abstract.", added: "" }]);
  });

  it("joins two changes that only a run of white space separates, keeping it on both sides", () => {
    const diff = expectReadsBack("the cat sat on the mat", "a dog sat on the mat");
    expect(changes(diff)).toEqual([{ kind: "change", index: 0, removed: "the cat", added: "a dog" }]);
    // A word between them keeps them apart.
    expect(changes(expectReadsBack("one red fish two", "one blue fish three"))).toEqual([
      { kind: "change", index: 0, removed: "red", added: "blue" },
      { kind: "change", index: 1, removed: "two", added: "three" },
    ]);
  });

  it("shows typography-only differences as changes of their own, character for character", () => {
    expect(changes(expectReadsBack("12-14 weeks", `12${cp(0x2013)}14 weeks`))).toEqual([{ kind: "change", index: 0, removed: "-", added: cp(0x2013) }]);
    expect(changes(expectReadsBack("10 mg", `10${NBSP}mg`))).toEqual([{ kind: "change", index: 0, removed: " ", added: NBSP }]);
    expect(changes(expectReadsBack(`caf${E_ACUTE}`, `cafe${ACUTE}`))).toEqual([{ kind: "change", index: 0, removed: `caf${E_ACUTE}`, added: `cafe${ACUTE}` }]);
    expect(changes(expectReadsBack("information", `in${SOFT_HYPHEN}formation`))).toEqual([{ kind: "change", index: 0, removed: "information", added: `in${SOFT_HYPHEN}formation` }]);
    expect(changes(expectReadsBack("line one\nline two", "line one line two"))).toEqual([{ kind: "change", index: 0, removed: "\n", added: " " }]);
  });

  it("counts words, not white space or punctuation", () => {
    const diff = expectReadsBack("(n = 120)", "(n = 120, 60 per group)");
    expect(diff).toMatchObject({ changeCount: 1, removedWords: 0, addedWords: 3 });
  });

  it("reads both texts back and finds the shortest edit, for random pairs (checked against an LCS)", () => {
    const words = ["the", "a", "trial", "of", "120", "adults", "metformin", "placebo", "weeks", ".", ",", "(", ")"];
    const spaces = [" ", " ", " ", "\n", NBSP];
    const next = random(42);
    const build = (length: number) => Array.from({ length }, (_, i) => (i % 2 === 1 ? spaces[Math.floor(next() * spaces.length)] : words[Math.floor(next() * words.length)])).join("");
    const mutate = (text: string) => {
      const tokens = tokenizeSource(text);
      const edits = Math.floor(next() * 6);
      for (let e = 0; e < edits; e++) {
        const at = Math.floor(next() * (tokens.length + 1));
        const choice = next();
        if (choice < 0.34 && tokens.length > 0) tokens.splice(Math.min(at, tokens.length - 1), 1);
        else if (choice < 0.67) tokens.splice(at, 0, words[Math.floor(next() * words.length)]);
        else if (tokens.length > 0) tokens[Math.min(at, tokens.length - 1)] = words[Math.floor(next() * words.length)];
      }
      return tokens.join("");
    };
    for (let round = 0; round < 400; round++) {
      const saved = build(Math.floor(next() * 30));
      const library = next() < 0.5 ? mutate(saved) : build(Math.floor(next() * 30));
      const diff = diffSourceText(saved, library);
      if (saved === library) {
        expect(diff).toEqual({ kind: "identical" });
        continue;
      }
      expectReadsBack(saved, library, diff);
      // Minimal: within exactly the shortest edit's budget it succeeds; one token less and it gives up.
      const distance = editDistance(tokenizeSource(saved), tokenizeSource(library));
      expect(diffSourceText(saved, library, { maxEdits: distance, maxSteps: Infinity }).kind).toBe("changes");
      expect(diffSourceText(saved, library, { maxEdits: distance - 1, maxSteps: Infinity })).toEqual({ kind: "too_different" });
    }
  });

  it("gives up past its edit budget, and past its work budget, rather than run on", () => {
    const words = (prefix: string, count: number) => Array.from({ length: count }, (_, i) => `${prefix}${i}`).join(" ");
    // Two unrelated texts: every token differs.
    expect(diffSourceText(words("alpha", 2_000), words("omega", 2_000))).toEqual({ kind: "too_different" });
    // Just inside the edit budget the same kind of input is still compared.
    const small = DIFF_MAX_EDITS / 4;
    expectReadsBack(words("alpha", small), words("omega", small));
    // A tiny work budget stops a comparison the edit budget alone would allow.
    expect(diffSourceText(words("alpha", 50), words("omega", 50), { maxEdits: DIFF_MAX_EDITS, maxSteps: 100 })).toEqual({ kind: "too_different" });
  });

  it("compares two 50,000-character abstracts that differ in a few places, and gives up on two that share nothing", () => {
    const sentence = (i: number) => `Sentence ${i}: participants (n = ${100 + (i % 50)}) received metformin or placebo for ${i % 24} weeks.`;
    const base = Array.from({ length: 600 }, (_, i) => sentence(i)).join(" ").slice(0, 50_000);
    const edited = base.replace("Sentence 10:", "Sentence ten:").replace("Sentence 300:", "Sentence 3OO:").replace(/ for 5 weeks/g, " for five weeks");
    const diff = expectReadsBack(base, edited);
    expect(diff.changeCount).toBeGreaterThanOrEqual(3);
    // Repeated passages: the same sentence 400 times, one copy of it changed.
    const repeated = Array.from({ length: 400 }, () => "Body weight was measured at baseline and at week 12.").join(" ");
    const once = repeated.replace(/week 12\.( Body weight was measured at baseline and at week 12\.){200}$/, (match) => match.replace("week 12.", "week 13."));
    expect(changes(expectReadsBack(repeated, once))).toHaveLength(1);
    // Unrelated texts of the same length.
    const other = Array.from({ length: 600 }, (_, i) => `Zeile ${i}: Teilnehmende bekamen ${i} Tabletten.`).join(" ").slice(0, 50_000);
    expect(diffSourceText(base, other)).toEqual({ kind: "too_different" });
  });
});
