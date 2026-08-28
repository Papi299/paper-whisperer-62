/**
 * Remote-reference detection for the extension's markup.
 *
 * This lives in its own module, outside any `*.test.ts` file, for one reason:
 * the previous version of this check was written inline in
 * `sourceBoundary.test.ts` and was silently ineffective for HTML, and nothing
 * could have caught that, because there was no way to feed it a hostile example
 * without editing the production popup. Test logic that guards a security
 * boundary needs its own tests, so the logic is exported here and
 * `remoteReferences.test.ts` exercises it against fixture strings.
 *
 * ## The defect this replaces
 *
 * The old check ran HTML through a helper that strips quoted string literals
 * before applying `/(?:src|href)\s*=\s*["']https?:/i`. Quoted string literals
 * are exactly where an HTML attribute value lives, so
 * `<script src="https://evil.example/x.js"></script>` became
 * `<script src=""></script>` and the assertion passed. The extension contained
 * no remote asset either way — this was a regression test that could not
 * regress, not a missed vulnerability.
 *
 * The fix is not a better regex; it is inspecting the right text. Comments are
 * removed so that documentation examples do not cause false positives, and
 * nothing else is removed at all.
 *
 * `__tests__/` is skipped by the source scan in `sourceBoundary.test.ts` and
 * this file is not matched by the Vitest include glob, so it is neither
 * inspected as extension source nor collected as a suite.
 */

/**
 * Which comment syntax applies to the text being inspected.
 *
 * Deliberately not "strip both": applying CSS block-comment stripping to HTML
 * would let a crafted attribute value open a comment that swallows a later real
 * reference, which is the same shape of mistake as the defect above. Each file
 * kind gets only its own comment syntax.
 */
export type MarkupKind = "html" | "css";

/** What kind of remote reference was found, for a legible failure message. */
export type RemoteReferenceKind = "attribute" | "css-url" | "css-import";

export interface RemoteReference {
  readonly kind: RemoteReferenceKind;
  /** The matched text, so a failure names what it found rather than only that it found something. */
  readonly match: string;
}

/**
 * A remote `src` / `href` attribute.
 *
 * Quoted values are matched by their own quote character so a `'` inside a
 * double-quoted URL cannot terminate it early. The unquoted alternative is new:
 * the old pattern required a quote, so `src=https://evil.example/x.js` — valid
 * HTML — would have slipped through even once the input text was fixed. Adding
 * it strengthens the assertion and cannot weaken it.
 */
const REMOTE_ATTRIBUTE_PATTERN =
  /\b(?:src|href)\s*=\s*(?:"https?:\/\/[^"]*"|'https?:\/\/[^']*'|https?:\/\/[^\s>]+)/gi;

/** A remote `url(...)` in a stylesheet or an inline `<style>` block. */
const REMOTE_CSS_URL_PATTERN =
  /url\(\s*(?:"https?:\/\/[^"]*"|'https?:\/\/[^']*'|https?:\/\/[^)\s]*)/gi;

/**
 * Any `@import`, remote or not — the same total prohibition the previous check
 * applied. A local `@import` would be a second stylesheet the manifest test
 * knows nothing about, so it is reported rather than allowed.
 */
const CSS_IMPORT_PATTERN = /@import[^;{]*/gi;

/**
 * Remove comments, and only comments.
 *
 * Nothing else is stripped. In particular quoted values are preserved, which is
 * the whole correction: an attribute value is a quoted string, and a checker
 * that removes quoted strings cannot see one.
 */
export function withoutComments(source: string, kind: MarkupKind): string {
  return kind === "html"
    ? source.replace(/<!--[\s\S]*?-->/g, " ")
    : source.replace(/\/\*[\s\S]*?\*\//g, " ");
}

/**
 * Find every remote reference in markup.
 *
 * All three patterns run against both kinds: an HTML file may carry a `<style>`
 * block containing `url()` or `@import`, so restricting those to `.css` files
 * would open a gap. Only the comment syntax differs by kind.
 *
 * @returns Every finding, in source order per pattern. Empty means clean.
 */
export function findRemoteReferences(
  source: string,
  kind: MarkupKind,
): RemoteReference[] {
  const text = withoutComments(source, kind);

  const findings: RemoteReference[] = [];
  const patterns: readonly (readonly [RemoteReferenceKind, RegExp])[] = [
    ["attribute", REMOTE_ATTRIBUTE_PATTERN],
    ["css-url", REMOTE_CSS_URL_PATTERN],
    ["css-import", CSS_IMPORT_PATTERN],
  ];

  for (const [referenceKind, pattern] of patterns) {
    // The patterns are module-level and `g`-flagged, so `lastIndex` persists
    // between calls. `matchAll` requires `g` and resets it itself, which is why
    // it is used here rather than a `while (pattern.exec(...))` loop.
    for (const match of text.matchAll(pattern)) {
      findings.push({ kind: referenceKind, match: match[0].trim() });
    }
  }

  return findings;
}
