// @vitest-environment node
//
// Node rather than jsdom: this suite reads committed files from disk, and under
// jsdom `import.meta.url` is an `http://` URL that `fileURLToPath` refuses. The
// same reason the Edge handler suites opt in — `src/test/setup.ts` is already
// guarded for the no-`window` case.
/**
 * The extension's source-level boundaries: no network, and no Chrome API beyond
 * the two this phase declared.
 *
 * These read the committed extension source and assert properties of it. That is
 * a coarse instrument — it inspects text, not behaviour — but it is the right
 * instrument for these two claims, because both are claims about what the code
 * *does not contain*. A behavioural test can only show that the paths it
 * exercised made no request; this shows there is no request to make.
 *
 * ## What the two behaviour changes did *not* change
 *
 * The extension can open `https://app.paperlume.app/extension-import` in a new
 * tab (001C2). That is a browser navigating a tab, not the extension reaching
 * the network, so nothing below is relaxed for it: `fetch`, XHR, `WebSocket`,
 * `EventSource` and `sendBeacon` are as absent as they were, and the extension
 * still cannot see a response.
 *
 * The extension can read a page's DOI metadata (001E2-CORRECTION-01). That
 * widens exactly one line in this file — `ALLOWED_CHROME_APIS` gains
 * `chrome.scripting.executeScript` — and nothing else. In particular the
 * markup-sink rule matters *more* now, not less: a DOI can arrive from a
 * publisher's `<meta>` tag rather than only from a URL the user navigated to,
 * so "the popup never builds markup from a value" is now a rule about
 * third-party page content.
 *
 * The origin itself is deliberately *not* pinned here. `executableText` strips
 * string literals, so a check written in this file would be inspecting text with
 * the very string removed from it — the same shape of vacuous assertion that
 * `support/remoteReferences.ts` exists to document. It is pinned instead by a
 * direct unit assertion on the exported constant, in
 * `paperLumeHandoff.test.ts`, where the value can actually be compared.
 *
 * Every check skips comments before matching, so prose that names `fetch` or a
 * URL — and the module comments deliberately do name them, to explain why they
 * are absent — cannot fail the build. What is skipped *besides* comments differs
 * by what is being looked for, and getting that wrong is how the previous
 * remote-reference check came to be ineffective: see `executableText` below and
 * `support/remoteReferences.ts`.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, it, expect } from "vitest";

import { findRemoteReferences } from "./support/remoteReferences";

const EXTENSION_DIR = fileURLToPath(new URL("../..", import.meta.url));

/** Every committed extension file, excluding this test directory and its support code. */
function extensionSourceFiles(dir: string = EXTENSION_DIR): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      return entry === "__tests__" ? [] : extensionSourceFiles(full);
    }
    return /\.(ts|js|mjs|html|css|json)$/.test(entry) ? [full] : [];
  });
}

/**
 * Strip comments and string literals, leaving executable text.
 *
 * String literals go too, so a URL written as data — which this phase has none
 * of, and which the manifest test separately forbids — could not satisfy a
 * check here by hiding in one. The result is not valid syntax and is only ever
 * substring-matched.
 *
 * **Never use this on markup.** It is right for the checks below, which look
 * for *code* — a `fetch(` call, a `chrome.` member, an `innerHTML` assignment —
 * where a matching string literal would be a false positive. It is wrong for
 * HTML and CSS, where the interesting value IS a quoted string: an earlier
 * version of the remote-reference check ran markup through here first and could
 * therefore never see `src="https://…"`. That check now lives in
 * `support/remoteReferences.ts`, which removes comments and nothing else.
 */
function executableText(source: string): string {
  return source
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1 ")
    .replace(/"(?:[^"\\\n]|\\.)*"/g, '""')
    .replace(/'(?:[^'\\\n]|\\.)*'/g, "''")
    .replace(/`(?:[^`\\]|\\.)*`/g, "``");
}

const SOURCE_FILES = extensionSourceFiles();

/** Every way extension code could reach the network. */
const NETWORK_PRIMITIVES = [
  "fetch(",
  "XMLHttpRequest",
  "WebSocket",
  "EventSource",
  "sendBeacon",
  "importScripts",
  "navigator.serviceWorker",
  "RTCPeerConnection",
] as const;

/**
 * The complete set of Chrome APIs this extension is allowed to call.
 *
 * Kept in step with `extension/src/chrome.d.ts`, which declares the same three
 * members. Adding an API means editing both, which is the point.
 *
 * `chrome.tabs.create` joined the list in CHROME-EXTENSION-IMPORT-001C2, which
 * is the whole of what "the popup can now open PaperLume" cost in privilege:
 * neither `tabs` member needs the `tabs` permission, and the manifest was
 * unchanged.
 *
 * `chrome.scripting.executeScript` joined in
 * CHROME-EXTENSION-IMPORT-001E2-CORRECTION-01 and did cost something: the
 * `scripting` permission, asserted in `manifest.test.ts`. It is the whole of
 * what the DOI metadata read cost, and it is worth noting what it did *not*
 * cost — no host permission, no content script, no background context, so the
 * injection can still only happen for a tab the user invoked the action on.
 *
 * The assertion is an exact set comparison rather than a deny-list, so the next
 * API — `storage`, `identity`, `chrome.scripting.insertCSS`, anything — fails
 * here until someone writes it down.
 */
const ALLOWED_CHROME_APIS = [
  "chrome.tabs.query",
  "chrome.tabs.create",
  "chrome.scripting.executeScript",
] as const;

describe("extension source — files under test", () => {
  it("finds the extension source", () => {
    // Guards against a refactor that moves the source and leaves every
    // assertion below iterating an empty list — a green suite proving nothing.
    expect(SOURCE_FILES.length).toBeGreaterThan(0);
    expect(SOURCE_FILES.some((file) => file.endsWith("popup.ts"))).toBe(true);
    expect(SOURCE_FILES.some((file) => file.endsWith("popupView.ts"))).toBe(true);
    expect(SOURCE_FILES.some((file) => file.endsWith("detectPaperFromUrl.ts"))).toBe(true);
    expect(SOURCE_FILES.some((file) => file.endsWith("detectPaperFromMetadata.ts"))).toBe(true);
    expect(SOURCE_FILES.some((file) => file.endsWith("classifyActiveTab.ts"))).toBe(true);
    expect(SOURCE_FILES.some((file) => file.endsWith("paperLumeHandoff.ts"))).toBe(true);
    expect(SOURCE_FILES.some((file) => file.endsWith("popup.html"))).toBe(true);
  });
});

describe("extension source — no network behaviour", () => {
  it.each(NETWORK_PRIMITIVES)("contains no use of %s", (primitive) => {
    for (const file of SOURCE_FILES) {
      const code = executableText(readFileSync(file, "utf-8"));
      expect(
        code.includes(primitive),
        `${path.relative(EXTENSION_DIR, file)} uses ${primitive}`,
      ).toBe(false);
    }
  });

  it("loads no remote script, stylesheet, font or image", () => {
    // Detection lives in `support/remoteReferences.ts` and has its own suite.
    // It used to be inline here, running markup through `executableText` first
    // — which strips quoted string literals, and an HTML attribute value *is* a
    // quoted string literal, so `src="https://evil.example/x.js"` became
    // `src=""` and the assertion could never fail. Markup must be inspected
    // with its attribute values intact; only comments are removed.
    const inspected: string[] = [];

    for (const file of SOURCE_FILES) {
      const kind = file.endsWith(".html") ? "html" : file.endsWith(".css") ? "css" : null;
      if (!kind) continue;

      inspected.push(file);
      const findings = findRemoteReferences(readFileSync(file, "utf-8"), kind);
      expect(
        findings,
        `${path.relative(EXTENSION_DIR, file)} references ${findings
          .map((finding) => `${finding.kind} ${finding.match}`)
          .join(", ")}`,
      ).toEqual([]);
    }

    // The loop above skips every non-markup file, so without this the check
    // would pass by inspecting nothing at all if the popup were ever renamed.
    expect(inspected.some((file) => file.endsWith(".html"))).toBe(true);
    expect(inspected.some((file) => file.endsWith(".css"))).toBe(true);
  });
});

describe("extension source — Chrome API surface", () => {
  it("calls only the APIs this phase declared", () => {
    const used = new Set<string>();

    for (const file of SOURCE_FILES) {
      const code = executableText(readFileSync(file, "utf-8"));
      for (const match of code.matchAll(/\bchrome(?:\.[A-Za-z_$][\w$]*)+/g)) {
        used.add(match[0]);
      }
    }

    // `chrome.d.ts` declares the namespace, so its own `declare namespace
    // chrome` text is not a call; only member paths are collected, and the
    // declaration file contributes none because its members are declared, not
    // referenced through `chrome.`.
    expect([...used].sort()).toEqual([...ALLOWED_CHROME_APIS].sort());
  });

  it("never builds markup from a value", () => {
    // Every value shown in the popup originated either in a URL the user
    // navigated to or, since 001E2-CORRECTION-01, in a publisher's `<meta>`
    // content. `textContent` is the only way one reaches the document, and this
    // keeps it that way without relying on review.
    for (const file of SOURCE_FILES) {
      const code = executableText(readFileSync(file, "utf-8"));
      for (const sink of ["innerHTML", "outerHTML", "insertAdjacentHTML", "document.write"]) {
        expect(
          code.includes(sink),
          `${path.relative(EXTENSION_DIR, file)} uses ${sink}`,
        ).toBe(false);
      }
    }
  });

  it("evaluates no code from a string", () => {
    for (const file of SOURCE_FILES) {
      const code = executableText(readFileSync(file, "utf-8"));
      expect(/\beval\s*\(/.test(code)).toBe(false);
      expect(/new\s+Function\s*\(/.test(code)).toBe(false);
    }
  });
});
