import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, posix, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, it, expect } from "vitest";

/**
 * Architecture-fitness guard for the comparison UI (EVIDENCE-MATRIX-001B).
 *
 * The read-only contract of the read model (`paperComparisonReadOnlyBoundary`)
 * only holds if the UI on top of it cannot route around it. The UI may reach
 * data through `usePaperComparison` alone, so this suite parses every UI
 * module with the TypeScript parser — a forbidden name in a comment or string
 * can neither hide nor fake a match — and fails on:
 *   * a module reference (`import`, `export … from`, dynamic `import()`,
 *     `require`, `import x = require`) outside a short allow-list. Relative
 *     paths are resolved first, so they may name only the comparison UI's own
 *     modules — no climbing to the Supabase client, no sibling dialog. That
 *     keeps out the client, React Query (a second comparison cache), auth,
 *     routing (the URL), the error classes (whose messages carry reason
 *     codes), mutation and AI hooks, Edge helpers and the HTML-entity decoders;
 *   * `fetch`, `XMLHttpRequest`, `WebSocket`, `EventSource`, browser storage,
 *     `caches`, `history` or `location` — as a bare name, or reached through
 *     `window`, `globalThis`, `self` or `document` (dot or bracket) — plus
 *     `open`, `cookie` and the storage/history methods reached that way;
 *   * HTML injection: a `dangerouslySetInnerHTML` attribute or an
 *     `innerHTML`/`outerHTML`/`insertAdjacentHTML` member;
 *   * a URL built in the UI: `href` must be a `const` initialised by
 *     `toSafeExternalHref(...)` (the app's allowlist over the read model's
 *     derived link), or by a same-file function that calls it;
 *     `src`/`srcSet`/`action`/`formAction` are not allowed at
 *     all, and no attributes are spread onto an `a`, `img`, `form` or
 *     `iframe`.
 *
 * Like the read-model guard, this is a review-time tripwire, not the
 * enforcement: RLS and the grants are what refuse a write. It reads source
 * text only, so a determined bypass (for example a value laundered through
 * several aliases) is out of its reach; review remains the backstop.
 */

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const UI_DIRECTORY = "src/components/papers/comparison";
const UI_SINGLE_FILES = ["src/components/papers/PaperComparisonDialog.tsx", "src/hooks/usePaperComparisonSession.ts"];

const UI_ALLOWED_IMPORTS = new Set([
  "react",
  "lucide-react",
  "@/components/ui/button",
  "@/components/ui/dialog",
  "@/components/ui/tabs",
  "@/lib/utils",
  "@/lib/externalUrl",
  "@/hooks/use-mobile",
  "@/hooks/usePaperComparison",
  "@/lib/paperComparison/types",
  "@/lib/paperComparison/sort",
  "@/lib/paperComparison/constants",
  "@/lib/paperComparison/request",
]);

/** Reached as a bare name, or through a global object. */
const FORBIDDEN_GLOBALS = new Set([
  "fetch",
  "XMLHttpRequest",
  "WebSocket",
  "EventSource",
  "localStorage",
  "sessionStorage",
  "indexedDB",
  "caches",
  "history",
  "location",
]);
/** Forbidden on any object. */
const FORBIDDEN_MEMBERS = new Set([
  "localStorage",
  "sessionStorage",
  "indexedDB",
  "pushState",
  "replaceState",
  "sendBeacon",
  "innerHTML",
  "outerHTML",
  "insertAdjacentHTML",
]);
/** Forbidden when reached through `window`, `globalThis`, `self` or `document`. */
const FORBIDDEN_GLOBAL_MEMBERS = new Set([...FORBIDDEN_GLOBALS, "open", "cookie"]);
const GLOBAL_OBJECTS = new Set(["window", "globalThis", "self", "document"]);
const URL_ATTRIBUTES = new Set(["src", "srcSet", "action", "formAction"]);
const URL_ELEMENTS = new Set(["a", "img", "form", "iframe"]);

interface Violation {
  file: string;
  line: number;
  rule: string;
}

/**
 * Whether `file` may reference `specifier`. A relative specifier is resolved
 * against `file`'s directory and must land on a comparison UI module.
 */
function isAllowedSpecifier(file: string, specifier: string): boolean {
  if (UI_ALLOWED_IMPORTS.has(specifier)) return true;
  if (!specifier.startsWith(".")) return false;
  const target = posix.normalize(posix.join(posix.dirname(file), specifier));
  return target.startsWith(`${UI_DIRECTORY}/`) || UI_SINGLE_FILES.some((single) => single.replace(/\.tsx?$/, "") === target);
}

/** Whether `node` is used as a value, rather than naming a property, a type or a binding. */
function isValueReference(node: ts.Identifier): boolean {
  const parent = node.parent;
  if (ts.isPropertyAccessExpression(parent) && parent.name === node) return false;
  if (ts.isQualifiedName(parent) && parent.right === node) return false;
  if (ts.isJsxAttribute(parent)) return false;
  if (
    (ts.isPropertyAssignment(parent) ||
      ts.isPropertySignature(parent) ||
      ts.isVariableDeclaration(parent) ||
      ts.isParameter(parent) ||
      ts.isBindingElement(parent) ||
      ts.isFunctionDeclaration(parent) ||
      ts.isTypeAliasDeclaration(parent) ||
      ts.isInterfaceDeclaration(parent)) &&
    parent.name === node
  ) {
    return false;
  }
  return !ts.isTypeReferenceNode(parent) && !ts.isImportSpecifier(parent) && !ts.isImportClause(parent);
}

/** The JSX element name an attribute belongs to, e.g. "a". */
function elementNameOf(attribute: ts.Node): string | null {
  const element = attribute.parent?.parent;
  if (element && (ts.isJsxOpeningElement(element) || ts.isJsxSelfClosingElement(element))) {
    return element.tagName.getText();
  }
  return null;
}

/** Whether `node` contains a call to `toSafeExternalHref`. */
function callsAllowlist(node: ts.Node, sourceFile: ts.SourceFile): boolean {
  let found = false;
  const visit = (child: ts.Node) => {
    if (ts.isCallExpression(child) && child.expression.getText(sourceFile) === "toSafeExternalHref") found = true;
    if (!found) ts.forEachChild(child, visit);
  };
  visit(node);
  return found;
}

/**
 * The `const`s an `href` may use: initialised by a call to
 * `toSafeExternalHref`, or to a function declared in the same file whose body
 * calls it.
 */
function safeHrefConstants(sourceFile: ts.SourceFile): Set<string> {
  const allowlistFunctions = new Set(["toSafeExternalHref"]);
  for (const statement of sourceFile.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name && statement.body && callsAllowlist(statement.body, sourceFile)) {
      allowlistFunctions.add(statement.name.text);
    }
  }
  const names = new Set<string>();
  const visit = (node: ts.Node) => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      ts.isCallExpression(node.initializer) &&
      ts.isIdentifier(node.initializer.expression) &&
      allowlistFunctions.has(node.initializer.expression.text) &&
      ts.isVariableDeclarationList(node.parent) &&
      (node.parent.flags & ts.NodeFlags.Const) !== 0
    ) {
      names.add(node.name.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return names;
}

export function scanUiSource(file: string, source: string): Violation[] {
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const violations: Violation[] = [];
  const report = (node: ts.Node, rule: string) =>
    violations.push({ file, line: sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1, rule });
  const safeHrefs = safeHrefConstants(sourceFile);
  const checkSpecifier = (node: ts.Node, specifier: string) => {
    if (!isAllowedSpecifier(file, specifier)) report(node, `module "${specifier}"`);
  };

  const visit = (node: ts.Node) => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) {
      if (ts.isStringLiteral(node.moduleSpecifier)) checkSpecifier(node, node.moduleSpecifier.text);
      else report(node, "computed module specifier");
    }
    if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      report(node, "import = require");
    }
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const isImport = callee.kind === ts.SyntaxKind.ImportKeyword;
      const isRequire = ts.isIdentifier(callee) && callee.text === "require";
      if (isImport || isRequire) report(node, isImport ? "dynamic import" : "require");
    }

    let member: string | null = null;
    let object: ts.Expression | null = null;
    if (ts.isPropertyAccessExpression(node)) {
      member = node.name.text;
      object = node.expression;
    } else if (ts.isElementAccessExpression(node) && ts.isStringLiteralLike(node.argumentExpression)) {
      member = node.argumentExpression.text;
      object = node.expression;
    }
    if (member !== null && object !== null) {
      if (FORBIDDEN_MEMBERS.has(member)) report(node, `member .${member}`);
      if (ts.isIdentifier(object) && GLOBAL_OBJECTS.has(object.text) && FORBIDDEN_GLOBAL_MEMBERS.has(member)) {
        report(node, `${object.text}.${member}`);
      }
    }

    if (ts.isIdentifier(node) && FORBIDDEN_GLOBALS.has(node.text) && isValueReference(node)) {
      report(node, `global ${node.text}`);
    }

    if (ts.isJsxSpreadAttribute(node) && URL_ELEMENTS.has(elementNameOf(node) ?? "")) {
      report(node, `spread attributes on <${elementNameOf(node)}>`);
    }
    // URL rules apply to DOM elements; a component's own props (for example
    // a `href` handed to a value renderer) are checked where it renders the
    // element.
    const onDomElement = /^[a-z]/.test(elementNameOf(node) ?? "");
    if (ts.isJsxAttribute(node) && ts.isIdentifier(node.name) && onDomElement) {
      const name = node.name.text;
      if (name === "dangerouslySetInnerHTML") report(node, "dangerouslySetInnerHTML");
      if (URL_ATTRIBUTES.has(name)) report(node, `${name} attribute`);
      if (name === "href") {
        const initializer = node.initializer;
        const expression = initializer && ts.isJsxExpression(initializer) ? initializer.expression : undefined;
        if (!expression || !ts.isIdentifier(expression) || !safeHrefs.has(expression.text)) {
          report(node, "href not from toSafeExternalHref");
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return violations;
}

function isTestPath(path: string): boolean {
  return /(^|\/)__tests__\//.test(path) || /\.(test|spec)\.[cm]?[jt]sx?$/.test(path);
}

function listFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...listFiles(full));
    else if (/\.(ts|tsx)$/.test(entry) && !entry.endsWith(".d.ts")) out.push(full);
  }
  return out;
}

const scannedFiles = [...listFiles(join(ROOT, UI_DIRECTORY)), ...UI_SINGLE_FILES.map((file) => join(ROOT, file))]
  .map((full) => relative(ROOT, full).split("\\").join("/"))
  .filter((path) => !isTestPath(path))
  .sort();

describe("comparison UI read-only boundary — the real modules", () => {
  it("scans every comparison UI module", () => {
    expect(scannedFiles).toEqual([
      "src/components/papers/PaperComparisonDialog.tsx",
      "src/components/papers/comparison/ComparisonLayouts.tsx",
      "src/components/papers/comparison/ComparisonValue.tsx",
      "src/components/papers/comparison/comparisonFields.ts",
      "src/hooks/usePaperComparisonSession.ts",
    ]);
  });

  it("reaches data only through usePaperComparison, injects no HTML, builds no URL and persists nothing", () => {
    const violations = scannedFiles.flatMap((file) => scanUiSource(file, readFileSync(join(ROOT, file), "utf8")));
    expect(violations).toEqual([]);
  });
});

describe("comparison UI read-only boundary — negative controls", () => {
  const DIALOG = "src/components/papers/PaperComparisonDialog.tsx";
  const VALUE = "src/components/papers/comparison/ComparisonValue.tsx";

  it("accepts the shapes the real modules use, and ignores names in comments, strings, types and attribute names", () => {
    const harmless = `
      import { ComparisonValue } from "./ComparisonValue";
      import { COMPARISON_GROUPS } from "./comparisonFields";
      // import { supabase } from "@/integrations/supabase/client"; fetch("x"); localStorage.setItem("k", "v");
      /* <div dangerouslySetInnerHTML={{ __html: abstract }} /> window.open(url) document.cookie */
      const copy = "history location fetch innerHTML caches";
      type location = { history: string };
      const safeHref = toSafeExternalHref(href);
      const link = <a href={safeHref} target="_blank">PubMed</a>;
      const props = { open: true, location: "x" };
      const isOpen = props.open;
    `;
    expect(scanUiSource(VALUE, harmless)).toEqual([]);
    expect(scanUiSource(DIALOG, `import { ComparisonCards } from "./comparison/ComparisonLayouts";`)).toEqual([]);
  });

  it("flags a sibling dialog imported next to PaperComparisonDialog", () => {
    expect(scanUiSource(DIALOG, `import { EditPaperDialog } from "./EditPaperDialog";`).length).toBeGreaterThan(0);
    expect(scanUiSource(DIALOG, `import { usePapers } from "../../hooks/usePapers";`).length).toBeGreaterThan(0);
  });

  it("checks URL rules on DOM elements, not on a component's own props", () => {
    expect(scanUiSource(VALUE, `const x = <IdentifierValue href={content.href} />;`)).toEqual([]);
  });

  it.each([
    ["the Supabase client", `import { supabase } from "@/integrations/supabase/client";`],
    ["the client by climbing a relative path", `import { supabase } from "./../../integrations/supabase/client";`],
    ["a re-export", `export { supabase } from "@/integrations/supabase/client";`],
    ["a star re-export", `export * from "@/integrations/supabase/client";`],
    ["a second cache", `import { useQuery } from "@tanstack/react-query";`],
    ["auth", `import { useAuth } from "@/hooks/useAuth";`],
    ["routing", `import { useSearchParams } from "react-router";`],
    ["the error classes", `import { ComparisonIntegrityError } from "@/lib/paperComparison/errors";`],
    ["the raw query", `import { buildComparisonQuery } from "@/lib/paperComparison/query";`],
    ["an HTML decoder", `import { decodeHTMLEntities } from "@/lib/decodeHTMLEntities";`],
    ["an AI hook", `import { usePaperAnalysisActions } from "@/hooks/usePaperAnalysisActions";`],
    ["a dynamic import", `const client = await import("@/integrations/supabase/client");`],
    ["require", `const client = require("@/integrations/supabase/client");`],
    ["a direct network call", `fetch("https://example.invalid");`],
    ["fetch through globalThis", `globalThis.fetch(url);`],
    ["fetch through window by key", `window["fetch"](url);`],
    ["browser storage", `sessionStorage.setItem("ids", value);`],
    ["browser storage via window", `window.localStorage.setItem("ids", value);`],
    ["a cookie", `document.cookie = "ids=" + ids;`],
    ["the cache API", `caches.open("comparison");`],
    ["a URL change", `history.replaceState({}, "", "?compare=1");`],
    ["a URL change via window", `window.history.pushState({}, "", "?compare=1");`],
    ["a location change", `document.location.href = "?compare=" + ids;`],
    ["a location hash", `window.location.hash = ids;`],
    ["a new window", `window.open(url);`],
    ["a new window by key", `window["open"](url);`],
    ["a new window via globalThis", `globalThis.open(url);`],
    ["HTML injection", `<p dangerouslySetInnerHTML={{ __html: abstract }} />`],
    ["innerHTML", `element.innerHTML = abstract;`],
    ["a literal href", `<a href="https://pubmed.ncbi.nlm.nih.gov/1/">x</a>`],
    ["a templated href", "<a href={`https://doi.org/${doi}`}>x</a>"],
    ["a concatenated href", `<a href={"https://doi.org/" + doi}>x</a>`],
    ["an href in a local template", "const u = `https://doi.org/${doi}`; const x = <a href={u}>x</a>;"],
    ["an unchecked derived href", `const x = <a href={row.links.value.doi}>x</a>;`],
    ["an href from a function that skips the allowlist", "function link(d) { return `https://doi.org/${d}`; } const h = link(doi); const x = <a href={h}>x</a>;"],
    ["a reassignable href", "let h = toSafeExternalHref(url); h = `https://x/${id}`; const x = <a href={h}>x</a>;"],
    ["a spread onto a link", `const x = <a {...linkProps}>x</a>;`],
    ["an image source", "const x = <img src={`https://t.invalid/${paperId}`} />;"],
    ["a form action", `const x = <form action={endpoint} />;`],
  ])("flags %s", (_label, source) => {
    expect(scanUiSource(VALUE, source).length).toBeGreaterThan(0);
  });
});
