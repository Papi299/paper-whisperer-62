import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, it, expect } from "vitest";

/**
 * Architecture-fitness guard for the comparison read model (EVIDENCE-MATRIX-001A).
 *
 * The comparison is read-only by contract: one SELECT on `papers` (with its
 * embedded relationships), no write, no RPC, no Edge Function (so no AI
 * provider and no quota), no Storage (so no signed URL and no attachment
 * contents), no other network call, and nothing persisted to browser storage
 * or the URL. This suite parses the comparison modules' source with the
 * TypeScript parser — so a forbidden name inside a comment or a string can
 * neither hide nor fake a match — and fails on:
 *   * a call to a write or side-effect method (`insert`, `update`, `upsert`,
 *     `delete`, `rpc`, `invoke`, `upload`, signed-URL creation, …), by name
 *     or through a string-keyed element access; a call through a computed
 *     member it cannot name fails closed;
 *   * any use of the client's `storage`, `functions`, `auth` or `realtime`
 *     members, or of browser storage / history members;
 *   * a bare reference to `fetch`, `XMLHttpRequest`, `WebSocket`,
 *     `EventSource`, `localStorage`, `sessionStorage`, `indexedDB`,
 *     `history` or `location`;
 *   * a `.from(...)` whose table is not the literal "papers" (`Array.from`
 *     excepted), and any number of `papers` reads other than exactly one;
 *   * an import from outside a short allow-list, so no AI, mutation or Edge
 *     helper can be pulled in.
 *
 * It is a review-time tripwire like `junctionWriteBoundary.test.ts`, not the
 * enforcement: RLS and the table grants are what refuse a write. It does not
 * follow calls into the allowed helper modules, which are themselves pure.
 */

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const MODULE_DIR = "src/lib/paperComparison";
const HOOK_FILE = "src/hooks/usePaperComparison.ts";

const FORBIDDEN_CALLS = new Set([
  "insert",
  "upsert",
  "update",
  "delete",
  "rpc",
  "invoke",
  "channel",
  "upload",
  "download",
  "createSignedUrl",
  "createSignedUrls",
  "getPublicUrl",
]);
const FORBIDDEN_MEMBERS = new Set([
  "storage",
  "functions",
  "auth",
  "realtime",
  "localStorage",
  "sessionStorage",
  "indexedDB",
  "pushState",
  "replaceState",
  "sendBeacon",
]);
const FORBIDDEN_GLOBALS = new Set([
  "fetch",
  "XMLHttpRequest",
  "WebSocket",
  "EventSource",
  "localStorage",
  "sessionStorage",
  "indexedDB",
  "history",
  "location",
]);
const ALLOWED_IMPORTS = new Set([
  "react",
  "@tanstack/react-query",
  "@supabase/supabase-js",
  "@/integrations/supabase/client",
  "@/lib/queryKeys",
  "@/lib/doiIdentifiers",
  "@/lib/pubmedIdentifiers",
  "@/lib/statisticalMethods",
]);
const COMPUTED = "<computed member>";

interface Violation {
  file: string;
  line: number;
  rule: string;
}

interface ScanResult {
  violations: Violation[];
  /** `.from("papers")` call sites. */
  papersReads: number;
}

function isAllowedImport(specifier: string): boolean {
  return ALLOWED_IMPORTS.has(specifier) || specifier.startsWith("./") || specifier.startsWith("@/lib/paperComparison/");
}

/** Whether `node` is used as a value, rather than naming a property or declaring a binding. */
function isValueReference(node: ts.Identifier): boolean {
  const parent = node.parent;
  if (ts.isPropertyAccessExpression(parent) && parent.name === node) return false;
  if (
    (ts.isPropertyAssignment(parent) ||
      ts.isPropertySignature(parent) ||
      ts.isPropertyDeclaration(parent) ||
      ts.isMethodDeclaration(parent) ||
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

export function scanSource(file: string, source: string): ScanResult {
  const sourceFile = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const violations: Violation[] = [];
  let papersReads = 0;
  const report = (node: ts.Node, rule: string) =>
    violations.push({ file, line: sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1, rule });

  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      if (!isAllowedImport(node.moduleSpecifier.text)) report(node, `import "${node.moduleSpecifier.text}"`);
    }

    let member: string | null = null;
    if (ts.isPropertyAccessExpression(node)) member = node.name.text;
    if (ts.isElementAccessExpression(node)) {
      member = ts.isStringLiteralLike(node.argumentExpression) ? node.argumentExpression.text : COMPUTED;
    }
    if (member !== null && (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node))) {
      const call = ts.isCallExpression(node.parent) && node.parent.expression === node ? node.parent : null;
      if (FORBIDDEN_MEMBERS.has(member)) report(node, `member .${member}`);
      if (call && FORBIDDEN_CALLS.has(member)) report(node, `call .${member}()`);
      if (call && member === COMPUTED) report(node, "call through a computed member");
      if (call && member === "from") {
        const receiver = node.expression;
        if (!(ts.isIdentifier(receiver) && receiver.text === "Array")) {
          const table = call.arguments[0];
          if (table && ts.isStringLiteralLike(table) && table.text === "papers") papersReads += 1;
          else report(node, ".from() on anything but the literal \"papers\"");
        }
      }
    }

    if (ts.isIdentifier(node) && FORBIDDEN_GLOBALS.has(node.text) && isValueReference(node)) {
      report(node, `global ${node.text}`);
    }

    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return { violations, papersReads };
}

function isTestPath(path: string): boolean {
  return /(^|\/)__tests__\//.test(path) || /\.(test|spec)\.[cm]?[jt]sx?$/.test(path);
}

function listModuleFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...listModuleFiles(full));
    else if (/\.(ts|tsx)$/.test(entry) && !entry.endsWith(".d.ts")) out.push(full);
  }
  return out;
}

const scannedFiles = [...listModuleFiles(join(ROOT, MODULE_DIR)), join(ROOT, HOOK_FILE)]
  .map((full) => relative(ROOT, full))
  .filter((path) => !isTestPath(path))
  .sort();

describe("comparison read-only boundary — the real modules", () => {
  it("scans every comparison module and the hook", () => {
    for (const expected of [
      `${MODULE_DIR}/constants.ts`,
      `${MODULE_DIR}/errors.ts`,
      `${MODULE_DIR}/fields.ts`,
      `${MODULE_DIR}/mapRow.ts`,
      `${MODULE_DIR}/query.ts`,
      `${MODULE_DIR}/request.ts`,
      `${MODULE_DIR}/result.ts`,
      `${MODULE_DIR}/sort.ts`,
      `${MODULE_DIR}/types.ts`,
      HOOK_FILE,
    ]) {
      expect(scannedFiles).toContain(expected);
    }
  });

  it("contains no write, RPC, Edge Function, Storage, network or persistence call, and only allowed imports", () => {
    const violations = scannedFiles.flatMap((file) => scanSource(file, readFileSync(join(ROOT, file), "utf8")).violations);
    expect(violations).toEqual([]);
  });

  it("reads papers at exactly one call site", () => {
    const reads = scannedFiles.reduce(
      (total, file) => total + scanSource(file, readFileSync(join(ROOT, file), "utf8")).papersReads,
      0,
    );
    expect(reads).toBe(1);
  });
});

describe("comparison read-only boundary — negative controls", () => {
  it("is not fooled by forbidden names in comments, strings or harmless code", () => {
    const harmless = `
      // supabase.rpc("search_papers"); supabase.storage.from("attachments").upload(file);
      /* client.from("papers").update({ title: "x" }); fetch("https://example.invalid"); */
      const sql = "update papers set title = 'x'; delete from paper_tags; insert into tags";
      const note = \`supabase.functions.invoke("analyze-paper") and localStorage.setItem\`;
      const ids = Array.from(new Set(["a", "b"]));
      const actions = { insert: 1, update: 2, delete: 3 };
      const update = actions.update;
      type history = { location: string };
    `;
    expect(scanSource("harmless.ts", harmless)).toEqual({ violations: [], papersReads: 0 });
  });

  it.each([
    ["an UPDATE", `client.from("papers").update({ title: "x" });`],
    ["a DELETE", `client.from("papers").delete().eq("id", id);`],
    ["an UPSERT", `client.from("papers").upsert(row);`],
    ["an INSERT", `client.from("papers").insert(row);`],
    ["an RPC", `client.rpc("search_papers", {});`],
    ["an Edge Function", `client.functions.invoke("analyze-paper");`],
    ["a Storage read", `client.storage.from("attachments").createSignedUrl(path, 60);`],
    ["another table", `client.from("paper_tags").select("*");`],
    ["a table it cannot resolve", `const table = "papers"; client.from(table).select("id");`],
    ["a direct network call", `fetch("https://example.invalid");`],
    ["browser storage via window", `window.localStorage.setItem("k", "v");`],
    ["browser storage", `sessionStorage.setItem("k", "v");`],
    ["a URL change", `history.pushState({}, "", "?ids=1");`],
    ["a string-keyed write", `client["insert"](row);`],
    ["a computed-member call", `client[method](row);`],
    ["an auth call", `client.auth.signOut();`],
    ["a disallowed import", `import { usePaperMutations } from "@/hooks/papers/usePaperMutations";`],
  ])("flags %s", (_label, source) => {
    expect(scanSource("dirty.ts", source).violations.length).toBeGreaterThan(0);
  });

  it("counts every papers read, so a second read site is caught", () => {
    const twoReads = `client.from("papers").select("id"); client.from("papers").select("title");`;
    expect(scanSource("two.ts", twoReads)).toEqual({ violations: [], papersReads: 2 });
  });
});
