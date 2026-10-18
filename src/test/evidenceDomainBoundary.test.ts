import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

/**
 * Architecture-fitness guard for the study-record domain library
 * (EVIDENCE-RECORDS-001B, `src/lib/evidence/`).
 *
 * The library is pure by contract — deterministic, side-effect free, no
 * network, no storage, no browser globals, no AI or Edge path, no Supabase
 * client — except one module, the adapter, which may call exactly the seven
 * client RPCs (PR-A2's four lifecycle RPCs and PR-A3's three field RPCs) on
 * the client injected into it, and nothing else — never an internal helper
 * such as `evidence_normalize_v1` or `evidence_locate_quote`. This suite parses the library's source with the TypeScript parser (so a
 * forbidden name in a comment or a string can neither hide nor fake a match)
 * and fails on, in EVERY library module:
 *   * an import outside the allow-list — so no client, React, query cache,
 *     AI, Edge, Storage or comparison module can be pulled in, under any alias;
 *     the generated database types may be imported for types only;
 *   * a dynamic `import()`, `require`, `eval` or `Function` constructor;
 *   * a bare reference to a network, storage, history, location, timer,
 *     crypto, clock or reflection global (`fetch`, `localStorage`, `window`,
 *     `globalThis`, `Date`, `crypto`, `Proxy`, …) and `Math.random`;
 *   * a call to a write or side-effect method (`insert`, `update`, `upsert`,
 *     `delete`, `invoke`, `upload`, …) or any use of `storage`, `functions`,
 *     `auth`, `realtime`, `channel`; a `.from()` on anything but `Array`;
 *   * a call through a computed member, which cannot be named, fails closed;
 * and, for `rpc`:
 *   * in a pure module, ANY use of a member named `rpc` — call, alias,
 *     destructuring, `.call`/`.apply`/`.bind`;
 *   * in the adapter, anything but a direct call `client.rpc("<name>", …)` on
 *     the injected client with one of the seven approved literal names — and
 *     each of the seven exactly once.
 * Across all product sources (web app, extension, Edge Functions) it also
 * fails on any `.rpc()` naming an `evidence_` function outside the adapter, and
 * on any mutation of an evidence table through `.from()`.
 *
 * It is a review-time tripwire like `junctionWriteBoundary.test.ts` and
 * `paperComparisonReadOnlyBoundary.test.ts`, not the enforcement: the database
 * grants (SELECT-only tables, EXECUTE on seven RPCs) and the RPCs' own checks
 * are what refuse a write. It does not follow data flow across files.
 */

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const LIBRARY_DIR = "src/lib/evidence";
const ADAPTER = "src/lib/evidence/lifecycleClient.ts";
const PRODUCT_ROOTS = ["src", "extension/src", "supabase/functions"];
const APPROVED_RPCS = new Set([
  "evidence_create_study_from_paper",
  "evidence_update_study",
  "evidence_set_link",
  "evidence_delete_study",
  "evidence_save_changes",
  "evidence_review_fields",
  "evidence_rebase_source",
]);
const EVIDENCE_TABLE = /^evidence_/;

const ALLOWED_IMPORTS = new Set(["@/lib/missingDatabaseObject"]);
const TYPE_ONLY_IMPORTS = new Set(["@/integrations/supabase/types"]);
const FORBIDDEN_GLOBALS = new Set([
  "fetch", "XMLHttpRequest", "WebSocket", "EventSource", "localStorage", "sessionStorage", "indexedDB", "caches",
  "history", "location", "navigator", "document", "window", "globalThis", "self", "top", "parent", "frames",
  "crypto", "performance", "Date", "setTimeout", "setInterval", "setImmediate", "queueMicrotask",
  "requestAnimationFrame", "requestIdleCallback", "process", "require", "eval", "Function", "Proxy", "Reflect",
  "Worker", "SharedWorker", "BroadcastChannel", "postMessage", "importScripts",
]);
const FORBIDDEN_CALLS = new Set([
  "insert", "upsert", "update", "delete", "invoke", "upload", "download", "createSignedUrl", "createSignedUrls",
  "getPublicUrl", "sendBeacon", "pushState", "replaceState", "setItem", "removeItem", "random",
]);
const FORBIDDEN_MEMBERS = new Set(["storage", "functions", "auth", "realtime", "channel", "localStorage", "sessionStorage", "indexedDB"]);
const MUTATIONS = new Set(["insert", "upsert", "update", "delete"]);
const COMPUTED = "<computed member>";

interface Violation {
  readonly file: string;
  readonly line: number;
  readonly rule: string;
}

interface Scan {
  readonly violations: Violation[];
  /** Approved RPC names called in the adapter, in source order. */
  readonly rpcCalls: string[];
}

const isTestPath = (path: string) => /(^|\/)__tests__\//.test(path) || /\.(test|spec)\.[cm]?[jt]sx?$/.test(path);

function listSources(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry !== "node_modules") out.push(...listSources(full));
    } else if (/\.(ts|tsx|mts|cts)$/.test(entry) && !entry.endsWith(".d.ts")) {
      out.push(full);
    }
  }
  return out;
}

function parse(file: string, source: string): ts.SourceFile {
  return ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
}

/** Whether `node` is used as a value, rather than naming a property, a binding or a type. */
function isValueReference(node: ts.Identifier): boolean {
  const parent = node.parent;
  if ((ts.isPropertyAccessExpression(parent) || ts.isQualifiedName(parent)) && (parent as ts.PropertyAccessExpression).name === node) return false;
  if (
    (ts.isPropertyAssignment(parent) ||
      ts.isPropertySignature(parent) ||
      ts.isPropertyDeclaration(parent) ||
      ts.isMethodDeclaration(parent) ||
      ts.isMethodSignature(parent) ||
      ts.isVariableDeclaration(parent) ||
      ts.isParameter(parent) ||
      ts.isFunctionDeclaration(parent) ||
      ts.isTypeAliasDeclaration(parent) ||
      ts.isInterfaceDeclaration(parent) ||
      ts.isEnumMember(parent) ||
      ts.isGetAccessor(parent) ||
      ts.isSetAccessor(parent)) &&
    parent.name === node
  ) {
    return false;
  }
  if (ts.isBindingElement(parent) && parent.name === node && !parent.propertyName) return false;
  return !ts.isTypeReferenceNode(parent) && !ts.isImportSpecifier(parent) && !ts.isImportClause(parent) && !ts.isExportSpecifier(parent);
}

/** Same-file `const X = "literal"` bindings, to resolve a name used as an RPC or table. */
function constStrings(sf: ts.SourceFile): Map<string, string> {
  const consts = new Map<string, string>();
  const visit = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer && ts.isStringLiteralLike(node.initializer)) {
      consts.set(node.name.text, node.initializer.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return consts;
}

function staticString(node: ts.Expression | undefined, consts: Map<string, string>): string | null {
  if (!node) return null;
  if (ts.isStringLiteralLike(node)) return node.text;
  if (ts.isIdentifier(node)) return consts.get(node.text) ?? null;
  if (ts.isAsExpression(node) || ts.isParenthesizedExpression(node) || ts.isSatisfiesExpression(node)) return staticString(node.expression, consts);
  return null;
}

function memberName(node: ts.Node): string | null {
  if (ts.isPropertyAccessExpression(node)) return node.name.text;
  if (ts.isElementAccessExpression(node)) return ts.isStringLiteralLike(node.argumentExpression) ? node.argumentExpression.text : COMPUTED;
  return null;
}

const callOf = (node: ts.Node): ts.CallExpression | null =>
  node.parent && ts.isCallExpression(node.parent) && node.parent.expression === node ? node.parent : null;

/**
 * Names the file itself declares (variables, parameters, functions, classes,
 * imports). A forbidden global's name used for one of them is that local
 * binding — `function f(fetch) {}` is injection — while reaching the real
 * global needs `globalThis`, `window` or `self`, which stay forbidden.
 */
function declaredNames(sf: ts.SourceFile): Set<string> {
  const names = new Set<string>();
  const addBinding = (name: ts.BindingName) => {
    if (ts.isIdentifier(name)) names.add(name.text);
    else for (const element of name.elements) if (!ts.isOmittedExpression(element)) addBinding(element.name);
  };
  const visit = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) || ts.isParameter(node)) addBinding(node.name);
    if ((ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) && node.name) names.add(node.name.text);
    if (ts.isImportClause(node) && node.name) names.add(node.name.text);
    if (ts.isImportSpecifier(node) || ts.isNamespaceImport(node)) names.add(node.name.text);
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return names;
}

/** Scan one library module. `adapter` selects the adapter's rpc rule. */
export function scanLibraryModule(file: string, source: string, adapter: boolean): Scan {
  const sf = parse(file, source);
  const declared = declaredNames(sf);
  const violations: Violation[] = [];
  const rpcCalls: string[] = [];
  const report = (node: ts.Node, rule: string) =>
    violations.push({ file, line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1, rule });

  const checkModuleSpecifier = (node: ts.Node, specifier: string, typeOnly: boolean) => {
    if (specifier.startsWith("./") || specifier.startsWith("@/lib/evidence/")) return;
    if (ALLOWED_IMPORTS.has(specifier)) return;
    if (TYPE_ONLY_IMPORTS.has(specifier)) {
      if (!typeOnly) report(node, `value import "${specifier}" (types only)`);
      return;
    }
    report(node, `import "${specifier}"`);
  };

  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const clause = node.importClause;
      const named: readonly ts.ImportSpecifier[] =
        clause?.namedBindings && ts.isNamedImports(clause.namedBindings) ? clause.namedBindings.elements : [];
      const typeOnly = Boolean(clause?.isTypeOnly) || (Boolean(clause) && !clause?.name && named.length > 0 && named.every((e) => e.isTypeOnly));
      checkModuleSpecifier(node, node.moduleSpecifier.text, typeOnly);
    }
    if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      checkModuleSpecifier(node, node.moduleSpecifier.text, node.isTypeOnly);
    }
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) report(node, "dynamic import()");
    if (ts.isIdentifier(node) && FORBIDDEN_GLOBALS.has(node.text) && isValueReference(node) && !declared.has(node.text)) {
      report(node, `global ${node.text}`);
    }
    if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "Function") report(node, "new Function");

    // `const { rpc } = client` / `const { from } = client`: a member taken out of view.
    if (ts.isBindingElement(node)) {
      const name = node.propertyName ?? node.name;
      if (ts.isIdentifier(name) && (name.text === "rpc" || FORBIDDEN_MEMBERS.has(name.text) || FORBIDDEN_CALLS.has(name.text))) report(node, `destructured .${name.text}`);
    }

    const member = memberName(node);
    if (member !== null) {
      const access = node as ts.PropertyAccessExpression | ts.ElementAccessExpression;
      const call = callOf(node);
      if (FORBIDDEN_MEMBERS.has(member)) report(node, `member .${member}`);
      if (call && FORBIDDEN_CALLS.has(member)) report(node, `call .${member}()`);
      if (call && member === COMPUTED) report(node, "call through a computed member");
      if (member === "from") {
        const receiver = access.expression;
        if (!(ts.isIdentifier(receiver) && receiver.text === "Array" && call)) report(node, ".from() on anything but Array");
      }
      if (member === "rpc") {
        if (!adapter) {
          report(node, "rpc in a pure module");
        } else {
          const receiverOk = ts.isIdentifier(access.expression) && access.expression.text === "client";
          const name = call && ts.isStringLiteralLike(call.arguments[0] ?? ({} as ts.Expression)) ? (call.arguments[0] as ts.StringLiteral).text : null;
          if (!call) report(node, "rpc referenced without being called directly");
          else if (!receiverOk) report(node, "rpc called on something other than the injected client");
          else if (name === null) report(node, "rpc with a name that is not a string literal");
          else if (!APPROVED_RPCS.has(name)) report(node, `unapproved rpc "${name}"`);
          else rpcCalls.push(name);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return { violations, rpcCalls };
}

interface ProductFinding {
  readonly file: string;
  readonly line: number;
  readonly rule: string;
}

/** Product-wide: evidence RPCs only in the adapter; no mutation of an evidence table. */
export function scanProductSource(file: string, source: string): ProductFinding[] {
  const sf = parse(file, source);
  const consts = constStrings(sf);
  const findings: ProductFinding[] = [];
  const lineOf = (node: ts.Node) => sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node)) {
      const member = memberName(node.expression);
      if (member === "rpc") {
        const name = staticString(node.arguments[0], consts);
        if (name !== null && name.startsWith("evidence_") && (file !== ADAPTER || !APPROVED_RPCS.has(name))) {
          findings.push({ file, line: lineOf(node), rule: `rpc "${name}" outside the lifecycle adapter` });
        }
      }
      if (member === "from") {
        const table = staticString(node.arguments[0], consts);
        if (table !== null && EVIDENCE_TABLE.test(table)) {
          // Climb the builder chain: .from("evidence_x").select(...).insert(...)
          let current: ts.Node = node;
          const continuesChain = (parent: ts.Node | undefined): parent is ts.Expression =>
            !!parent &&
            (((ts.isPropertyAccessExpression(parent) || ts.isElementAccessExpression(parent)) && parent.expression === current) ||
              (ts.isCallExpression(parent) && parent.expression === current) ||
              ((ts.isNonNullExpression(parent) || ts.isParenthesizedExpression(parent) || ts.isAwaitExpression(parent)) && parent.expression === current));
          while (continuesChain(current.parent)) {
            const name = memberName(current.parent);
            if (name !== null && (MUTATIONS.has(name) || name === COMPUTED)) {
              findings.push({ file, line: lineOf(node), rule: `${name} on ${table}` });
              break;
            }
            current = current.parent;
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return findings;
}

const libraryFiles = listSources(join(ROOT, LIBRARY_DIR))
  .map((full) => relative(ROOT, full))
  .filter((path) => !isTestPath(path))
  .sort();

describe("study-record domain boundary — the real library", () => {
  it("scans every module of the library", () => {
    for (const expected of [
      "errors.ts", "fieldDictionary.ts", "fieldRequests.ts", "freeze.ts", "identity.ts", "ids.ts", "lifecycleClient.ts", "lifecycleRequests.ts",
      "matcher.ts", "normalization.ts", "numbers.ts", "records.ts", "review.ts", "sources.ts", "states.ts", "types.ts", "validation.ts",
    ]) {
      expect(libraryFiles).toContain(`${LIBRARY_DIR}/${expected}`);
    }
  });

  it("keeps every pure module pure, and the adapter to its seven RPCs", () => {
    const violations = libraryFiles.flatMap((file) => scanLibraryModule(file, readFileSync(join(ROOT, file), "utf8"), file === ADAPTER).violations);
    expect(violations).toEqual([]);
  });

  it("calls each of the seven approved RPCs exactly once, only in the adapter", () => {
    const calls = libraryFiles.flatMap((file) => scanLibraryModule(file, readFileSync(join(ROOT, file), "utf8"), file === ADAPTER).rpcCalls);
    expect(calls.sort()).toEqual([...APPROVED_RPCS].sort());
  });

  it("no product source calls an evidence RPC outside the adapter, or writes an evidence table", () => {
    const findings: ProductFinding[] = [];
    let adapterSeen = false;
    for (const root of PRODUCT_ROOTS) {
      for (const full of listSources(join(ROOT, root))) {
        const file = relative(ROOT, full);
        if (isTestPath(file)) continue;
        if (file === ADAPTER) adapterSeen = true;
        findings.push(...scanProductSource(file, readFileSync(full, "utf8")));
      }
    }
    expect(adapterSeen).toBe(true);
    expect(findings).toEqual([]);
  });

  it("is not vacuous: it sees the account export's evidence reads, and they are reads", () => {
    const source = readFileSync(join(ROOT, "src/lib/accountExport/fetchAccountExportData.ts"), "utf8");
    expect(source).toContain('"evidence_field_values"');
    expect(scanProductSource("src/lib/accountExport/fetchAccountExportData.ts", source)).toEqual([]);
  });
});

describe("study-record domain boundary — negative controls", () => {
  const pure = (source: string) => scanLibraryModule("src/lib/evidence/probe.ts", source, false).violations;
  const adapter = (source: string) => scanLibraryModule(ADAPTER, source, true);

  it("is not fooled by forbidden names in comments, strings or harmless code", () => {
    const harmless = `
      // client.rpc("evidence_set_link", args); fetch("/rest/v1"); localStorage.setItem("k", "v");
      /* supabase.from("evidence_studies").insert(row); window.location = "x"; Math.random(); */
      const note = "client.rpc(\\"evidence_update_study\\") and new Date() and crypto.randomUUID()";
      const chars = Array.from("text");
      const shapes = { insert: 1, update: 2, rpc: 3, from: 4 };
      const n = shapes.insert + shapes.update;
      type location = { history: string };
      import type { Database } from "@/integrations/supabase/types";
      const parent = { depth: 1 };
      const top = parent.depth + 1;
      function withFetch(fetch: (url: string) => void) { fetch("/injected"); }
    `;
    expect(pure(harmless)).toEqual([]);
  });

  it.each([
    ["an RPC call in a pure module", `client.rpc("evidence_create_study_from_paper", args);`],
    ["an RPC through a string-keyed member", `client["rpc"]("evidence_set_link", args);`],
    ["a call through a computed member", `const m = "rpc"; client[m]("evidence_set_link", args);`],
    ["an RPC inside a wrapper function", `const call = (name: string) => client.rpc(name, {});`],
    ["an aliased rpc member", `const r = client.rpc; r("evidence_set_link", args);`],
    ["a destructured rpc member", `const { rpc } = client; rpc("evidence_set_link", args);`],
    ["rpc through .call", `client.rpc.call(client, "evidence_set_link", args);`],
    ["the Supabase client under an alias", `import { supabase as db } from "@/integrations/supabase/client";`],
    ["supabase-js as a namespace", `import * as sb from "@supabase/supabase-js";`],
    ["React", `import { useEffect } from "react";`],
    ["the query cache", `import { useMutation } from "@tanstack/react-query";`],
    ["an Edge helper", `import { analyzePaper } from "@/lib/analyzeError";`],
    ["the generated types as values", `import { Constants } from "@/integrations/supabase/types";`],
    ["a dynamic import", `const m = await import("@/integrations/supabase/client");`],
    ["require", `const fs = require("node:fs");`],
    ["eval", `eval("client.rpc('evidence_set_link')");`],
    ["the Function constructor", `const f = new Function("return 1");`],
    ["fetch", `await fetch("/rest/v1/rpc/evidence_set_link", { method: "POST" });`],
    ["window", `window.fetch("/x");`],
    ["globalThis by string key", `globalThis["fetch"]("/x");`],
    ["self", `self.localStorage;`],
    ["browser storage", `sessionStorage.getItem("k");`],
    ["a clock", `const t = Date.now();`],
    ["randomness", `const r = Math.random();`],
    ["crypto", `const id = crypto.randomUUID();`],
    ["a timer", `setTimeout(() => {}, 1);`],
    ["reflection", `Reflect.apply(fn, client, []);`],
    ["a proxy", `const p = new Proxy({}, {});`],
    ["a table write", `client.from("evidence_studies").insert(row);`],
    ["a table read", `client.from("evidence_studies").select("*");`],
    ["an Edge Function", `client.functions.invoke("analyze-paper");`],
    ["Storage", `client.storage.from("attachments");`],
    ["auth", `client.auth.getUser();`],
    ["a destructured write method", `const { insert } = builder;`],
  ])("flags %s", (_label, source) => {
    expect(pure(source).length).toBeGreaterThan(0);
  });

  it("allows the adapter its seven literal RPC calls on the injected client, and nothing else", () => {
    expect(adapter(`async function call() { return client.rpc("evidence_update_study", request.args); }`)).toEqual({ violations: [], rpcCalls: ["evidence_update_study"] });
    expect(adapter(`client.rpc("evidence_save_changes", request.args);`)).toEqual({ violations: [], rpcCalls: ["evidence_save_changes"] });
    for (const source of [
      `client.rpc("evidence_normalize_v1", { p_text: "x" });`,
      `client.rpc("evidence_locate_quote", { p_quotes: ["x"], p_snapshot: "x" });`,
      `client.rpc("evidence_state_reference_problems", {});`,
      `client.rpc("evidence_value_digest", {});`,
      `client.rpc("evidence_records_assert_writable");`,
      `client.rpc("search_papers", {});`,
      `client.rpc(request.rpc, request.args);`,
      `const RPC = "evidence_set_link"; client.rpc(RPC, args);`,
      `supabase.rpc("evidence_set_link", args);`,
      `const r = client.rpc;`,
      `client.from("evidence_studies").select("*");`,
      `client["rpc"](name, args);`,
    ]) {
      expect(adapter(source).violations.length, source).toBeGreaterThan(0);
    }
  });

  it("flags an evidence RPC or table write anywhere in the product", () => {
    expect(scanProductSource("src/components/X.tsx", `await supabase.rpc("evidence_set_link", args);`)).toHaveLength(1);
    expect(scanProductSource("src/hooks/useX.ts", `const FN = "evidence_delete_study";\nawait supabase.rpc(FN, args);`)).toHaveLength(1);
    expect(scanProductSource(ADAPTER, `client.rpc("evidence_normalize_v1", {});`)).toHaveLength(1);
    expect(scanProductSource(ADAPTER, `client.rpc("evidence_locate_quote", {});`)).toHaveLength(1);
    expect(scanProductSource("src/hooks/useX.ts", `await supabase.rpc("evidence_review_fields", args);`)).toHaveLength(1);
    expect(scanProductSource("src/hooks/useX.ts", `await supabase.from("evidence_field_values").update({ value_text: "x" }).eq("id", id);`)).toHaveLength(1);
    expect(scanProductSource("src/hooks/useX.ts", `const T = "evidence_events";\nawait supabase.from(T).delete();`)).toHaveLength(1);
    expect(scanProductSource("src/hooks/useX.ts", `await supabase.from("evidence_studies").select("*").eq("id", id);`)).toEqual([]);
    expect(scanProductSource("src/hooks/useX.ts", `await supabase.rpc("search_papers", {});`)).toEqual([]);
  });
});
