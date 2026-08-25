/**
 * Tests for the remote-reference detector that `sourceBoundary.test.ts` relies
 * on.
 *
 * This suite exists because the check it replaces had no tests of its own and
 * was, as a result, ineffective for HTML without anyone noticing: it ran markup
 * through a helper that strips quoted string literals, which is precisely where
 * an attribute value lives, so `src="https://evil.example/x.js"` was reduced to
 * `src=""` before the pattern ever saw it. Every assertion below is a fixture
 * string, so the boundary logic can be proven hostile-input-safe without
 * touching the production popup — manufacturing evidence by editing the real
 * files would prove only that the files were edited.
 */

import { describe, it, expect } from "vitest";

import {
  findRemoteReferences,
  withoutComments,
  type MarkupKind,
} from "./support/remoteReferences";

/** Markup that must be reported, and why each one matters. */
const HOSTILE_HTML: ReadonlyArray<readonly [label: string, markup: string]> = [
  ["remote script", '<script src="https://evil.example/x.js"></script>'],
  ["remote stylesheet", '<link rel="stylesheet" href="https://evil.example/x.css">'],
  ["remote image over http", '<img src="http://evil.example/pixel.png">'],
  ["remote font preload", '<link rel="preload" as="font" href="https://evil.example/f.woff2">'],
  ["single-quoted value", "<script src='https://evil.example/x.js'></script>"],
  ["unquoted value", "<script src=https://evil.example/x.js></script>"],
  ["spaces around the equals sign", '<script src = "https://evil.example/x.js"></script>'],
  ["uppercase attribute and scheme", '<SCRIPT SRC="HTTPS://EVIL.EXAMPLE/X.JS"></SCRIPT>'],
  ["anchor to a remote origin", '<a href="https://evil.example/">x</a>'],
  ["inline style block with a remote url", "<style>body { background: url('https://evil.example/b.png'); }</style>"],
  ["inline style block with an import", "<style>@import url(https://evil.example/x.css);</style>"],
  ["a real reference after a decoy comment", '<!-- nothing here --><img src="https://evil.example/p.png">'],
];

/** Stylesheets that must be reported. */
const HOSTILE_CSS: ReadonlyArray<readonly [label: string, markup: string]> = [
  ["remote url, double quoted", '.a { background: url("https://evil.example/b.png"); }'],
  ["remote url, single quoted", ".a { background: url('https://evil.example/b.png'); }"],
  ["remote url, unquoted", ".a { background: url(https://evil.example/b.png); }"],
  ["remote url over http", ".a { background: url(http://evil.example/b.png); }"],
  ["remote font face", "@font-face { src: url('https://fonts.example/f.woff2'); }"],
  ["remote import", '@import url("https://evil.example/x.css");'],
  ["local import is still refused", '@import "./other.css";'],
];

/** Markup that is clean and must not be reported. */
const CLEAN: ReadonlyArray<readonly [label: string, kind: MarkupKind, markup: string]> = [
  ["a relative script", "html", '<script type="module" src="./src/popup.ts"></script>'],
  ["a root-relative script", "html", '<script type="module" src="/popup.js"></script>'],
  ["a relative stylesheet", "html", '<link rel="stylesheet" href="/popup.css">'],
  ["a local data-field attribute", "html", '<dd data-field="pmid"></dd>'],
  ["prose naming a remote origin", "html", "<p>PaperLume reads https://doi.org links.</p>"],
  ["a local css url", "css", ".a { background: url(./b.png); }"],
  ["a css variable holding a colour", "css", ":root { --pl-accent: #0e6b68; }"],
];

describe("findRemoteReferences — hostile HTML is reported", () => {
  it.each(HOSTILE_HTML)("reports %s", (_label, markup) => {
    expect(findRemoteReferences(markup, "html")).not.toEqual([]);
  });

  it("names what it found, so a failure is actionable", () => {
    const [finding] = findRemoteReferences(
      '<script src="https://evil.example/x.js"></script>',
      "html",
    );
    expect(finding.kind).toBe("attribute");
    expect(finding.match).toContain("https://evil.example/x.js");
  });
});

describe("findRemoteReferences — hostile CSS is reported", () => {
  it.each(HOSTILE_CSS)("reports %s", (_label, markup) => {
    expect(findRemoteReferences(markup, "css")).not.toEqual([]);
  });
});

describe("findRemoteReferences — clean markup is not reported", () => {
  it.each(CLEAN)("accepts %s", (_label, kind, markup) => {
    expect(findRemoteReferences(markup, kind)).toEqual([]);
  });

  it("ignores a remote reference inside an HTML comment", () => {
    // Documentation examples must not fail the build. This one is the exact
    // shape a future contributor would write to explain what is forbidden.
    const markup = '<!-- <script src="https://example.invalid/comment-only.js"></script> -->';
    expect(findRemoteReferences(markup, "html")).toEqual([]);
  });

  it("ignores a remote reference inside a CSS comment", () => {
    const markup = "/* never: .a { background: url(https://example.invalid/b.png); } */";
    expect(findRemoteReferences(markup, "css")).toEqual([]);
  });

  it("still reports a real reference that follows a comment", () => {
    // The comment strip must not swallow the rest of the file.
    const markup =
      '<!-- explanatory --><script src="https://evil.example/x.js"></script>';
    expect(findRemoteReferences(markup, "html")).not.toEqual([]);
  });

  it("does not let an HTML attribute value open a CSS comment", () => {
    // Why `withoutComments` is kind-specific rather than stripping both
    // syntaxes: if CSS block comments were stripped from HTML, the `/*` below
    // would open a comment that ran to the `*/` and hid the real reference
    // between them.
    const markup =
      '<img alt="/*"><script src="https://evil.example/x.js"></script><img alt="*/">';
    expect(findRemoteReferences(markup, "html")).not.toEqual([]);
  });
});

describe("withoutComments — the property whose absence caused the defect", () => {
  it("preserves quoted attribute values", () => {
    // This is the regression guard. The previous implementation stripped quoted
    // string literals, which erased exactly this text; reintroducing any such
    // stripping fails here rather than silently disarming the boundary test.
    const markup = '<script src="https://evil.example/x.js"></script>';
    expect(withoutComments(markup, "html")).toContain('src="https://evil.example/x.js"');
  });

  it("preserves single-quoted attribute values", () => {
    const markup = "<img src='http://evil.example/pixel.png'>";
    expect(withoutComments(markup, "html")).toContain("src='http://evil.example/pixel.png'");
  });

  it("preserves quoted CSS url values", () => {
    const markup = '.a { background: url("https://evil.example/b.png"); }';
    expect(withoutComments(markup, "css")).toContain('url("https://evil.example/b.png")');
  });

  it("removes only comments", () => {
    expect(withoutComments("<p>a</p><!-- b --><p>c</p>", "html")).toBe("<p>a</p> <p>c</p>");
    expect(withoutComments(".a{}/* b */.c{}", "css")).toBe(".a{} .c{}");
  });
});

/**
 * A direct comparison against the approach that was removed.
 *
 * `sourceBoundary.test.ts` no longer contains this logic, so without this test
 * the repository would hold no record of *why* the check changed, and a future
 * contributor could reasonably reintroduce the shorter version.
 */
describe("regression — the removed approach could not detect any of this", () => {
  /** The stripping helper the old HTML check ran its input through, verbatim. */
  function legacyExecutableText(source: string): string {
    return source
      .replace(/<!--[\s\S]*?-->/g, " ")
      .replace(/\/\*[\s\S]*?\*\//g, " ")
      .replace(/(^|[^:])\/\/[^\n]*/g, "$1 ")
      .replace(/"(?:[^"\\\n]|\\.)*"/g, '""')
      .replace(/'(?:[^'\\\n]|\\.)*'/g, "''")
      .replace(/`(?:[^`\\]|\\.)*`/g, "``");
  }

  /** The old assertion: strip first, then look for a remote src/href. */
  function legacyDetects(markup: string): boolean {
    return /(?:src|href)\s*=\s*["']https?:/i.test(legacyExecutableText(markup));
  }

  const QUOTED_HOSTILE = [
    '<script src="https://evil.example/x.js"></script>',
    '<link rel="stylesheet" href="https://evil.example/x.css">',
    '<img src="http://evil.example/pixel.png">',
    "<script src='https://evil.example/x.js'></script>",
  ] as const;

  it.each(QUOTED_HOSTILE)("the old check missed %s", (markup) => {
    expect(legacyDetects(markup)).toBe(false);
  });

  it.each(QUOTED_HOSTILE)("the current check catches %s", (markup) => {
    expect(findRemoteReferences(markup, "html")).not.toEqual([]);
  });
});
