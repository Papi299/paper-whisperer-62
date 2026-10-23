import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, posix, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

/**
 * Architecture-fitness guard for the Study Record UI (EVIDENCE-RECORDS-001C1):
 * the components in `src/components/papers/study-record/`, the hooks
 * `useStudyRecords`, `useStudyRecordEditor` and `useStudyRecordCreations`, and
 * `src/lib/studyRecord/`.
 *
 * Every write must go through PR-B's typed adapter, which `src/lib/studyRecord/
 * client.ts` creates once over the shared client; everything else is a read.
 * This suite parses each module with the TypeScript parser — a forbidden name
 * in a comment or a string can neither hide nor fake a match — and fails on:
 *   * an import outside an allow-list: no paper-mutation, AI, Edge, search,
 *     auth, routing or comparison module; the Supabase client only where reads
 *     are made (`useStudyRecords`) and where the adapter is created
 *     (`client.ts`); the adapter's module itself only there, or for types;
 *   * any use of a member named `rpc` — RPCs are the adapter's alone;
 *   * a `.from()` that is not immediately a `.select()`, a mutation anywhere in
 *     its chain, or a table outside the evidence tables and `papers`;
 *   * Edge Functions, Storage, network globals, browser storage and cookies,
 *     `window.open`, and HTML injection (`dangerouslySetInnerHTML`,
 *     `innerHTML` and kin); any URL attribute on a DOM element;
 *   * an object literal that writes a field only the server may set — match
 *     offsets, counts and times, the normalization version, review and
 *     extraction state, versions, capture metadata — so no trusted provenance
 *     or quote offset is ever built in the browser;
 *   * anything of PR-C2's: Confirm/Flag (`reviewField`, `checkConfirm`), the
 *     source rebase (`rebaseSource`), or their RPC names.
 * And it checks the positive relationships: the adapter is created exactly
 * once, the editor's default client is that adapter, and the writes the UI
 * makes are exactly the five C1 adapter methods — a create only from the store
 * of unresolved creates (C1-R1), which the Start view reaches through `start`
 * and `retry` alone.
 *
 * A review-time tripwire like `evidenceDomainBoundary.test.ts`, not the
 * enforcement: RLS, the SELECT-only grants and the RPCs' own checks refuse a
 * write. It reads source text only and does not follow data across files.
 */

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const UI_DIRECTORY = "src/components/papers/study-record";
const LIB_DIRECTORY = "src/lib/studyRecord";
const HOOK_FILES = ["src/hooks/useStudyRecords.ts", "src/hooks/useStudyRecordEditor.ts", "src/hooks/useStudyRecordCreations.ts"];
const CREATIONS_FILE = "src/hooks/useStudyRecordCreations.ts";
const CLIENT_FILE = "src/lib/studyRecord/client.ts";
const READS_FILE = "src/hooks/useStudyRecords.ts";

const ALLOWED_IMPORTS = new Set([
  "react",
  "lucide-react",
  "@tanstack/react-query",
  "@/components/ui/alert-dialog",
  "@/components/ui/badge",
  "@/components/ui/button",
  "@/components/ui/checkbox",
  "@/components/ui/dialog",
  "@/components/ui/input",
  "@/components/ui/label",
  "@/components/ui/radio-group",
  "@/components/ui/tabs",
  "@/components/ui/textarea",
  "@/hooks/use-mobile",
  "@/hooks/use-toast",
  "@/hooks/useAbstract",
  "@/hooks/useCurrentUserAccess",
  "@/hooks/useStudyRecords",
  "@/hooks/useStudyRecordCreations",
  "@/hooks/useStudyRecordEditor",
  "@/lib/queryKeys",
  "@/lib/evidenceRecordsAvailability",
  "@/lib/evidence/errors",
  "@/lib/evidence/fieldDictionary",
  "@/lib/evidence/fieldRequests",
  "@/lib/evidence/identity",
  "@/lib/evidence/ids",
  "@/lib/evidence/lifecycleRequests",
  "@/lib/evidence/matcher",
  "@/lib/evidence/normalization",
  "@/lib/evidence/numbers",
  "@/lib/evidence/records",
  "@/lib/evidence/review",
  "@/lib/evidence/sources",
  "@/lib/evidence/states",
  "@/lib/evidence/types",
  "@/lib/evidence/validation",
  "@/lib/studyRecord/access",
  "@/lib/studyRecord/client",
  "@/lib/studyRecord/draft",
  "@/lib/studyRecord/jsonbSize",
  "@/lib/studyRecord/labelSuggestion",
  "@/lib/studyRecord/paperGuards",
  "@/lib/studyRecord/paperLinks",
  "@/lib/studyRecord/pendingCreates",
  "@/lib/studyRecord/quotes",
  "@/lib/studyRecord/read",
  "@/lib/studyRecord/savePlan",
  "@/lib/studyRecord/validateDraft",
]);
/** Only for types, anywhere. */
const TYPE_ONLY_IMPORTS = new Set(["@/integrations/supabase/types", "@/types/database", "@/integrations/supabase/client", "@/lib/evidence/lifecycleClient"]);
/** Value imports allowed in one module only. */
const VALUE_IMPORT_OWNERS: Readonly<Record<string, readonly string[]>> = {
  "@/integrations/supabase/client": [CLIENT_FILE, READS_FILE],
  "@/lib/evidence/lifecycleClient": [CLIENT_FILE],
};

const READ_TABLES = new Set([
  "evidence_studies",
  "evidence_study_reports",
  "evidence_source_snapshots",
  "evidence_arms",
  "evidence_outcomes",
  "evidence_field_values",
  "evidence_field_anchors",
  "papers",
]);
const MUTATIONS = new Set(["insert", "upsert", "update", "delete"]);
const FORBIDDEN_GLOBALS = new Set([
  "fetch",
  "XMLHttpRequest",
  "WebSocket",
  "EventSource",
  "localStorage",
  "sessionStorage",
  "indexedDB",
  "caches",
  "BroadcastChannel",
  "DOMParser",
]);
const FORBIDDEN_MEMBERS = new Set([
  "localStorage",
  "sessionStorage",
  "indexedDB",
  "cookie",
  "sendBeacon",
  "innerHTML",
  "outerHTML",
  "insertAdjacentHTML",
  "createContextualFragment",
  "functions",
  "invoke",
  "storage",
  "rpc",
  "upsert",
  "insert",
]);
const GLOBAL_OBJECTS = new Set(["window", "globalThis", "self", "document", "navigator"]);
const FORBIDDEN_GLOBAL_MEMBERS = new Set([...FORBIDDEN_GLOBALS, "open"]);
const URL_ATTRIBUTES = new Set(["href", "src", "srcSet", "action", "formAction"]);
/** Fields only the server sets: never a key of an object literal built here. */
const SERVER_KEYS = new Set([
  "match_start",
  "match_end",
  "match_occurrence",
  "match_count",
  "matched_at",
  "normalization_version",
  "normalizedStart",
  "normalizedEnd",
  "matchedAt",
  "attestation",
  "exact_sha256",
  "normalized_sha256",
  "review_status",
  "review_reason",
  "reviewed_at",
  "reviewed_version",
  "reviewedAt",
  "reviewedVersion",
  "extraction_method",
  "extractionMethod",
  "row_version",
  "study_version",
  "value_version",
  "valueVersion",
  "captured_at",
  "char_count",
]);
/** PR-C2: review, Confirm/Flag and the source rebase. */
const DEFERRED_NAMES = new Set(["reviewField", "rebaseSource", "prepareReviewField", "prepareRebaseSource", "checkConfirm"]);
const DEFERRED_STRINGS = new Set(["evidence_review_fields", "evidence_rebase_source", "user_reviewed", "rebase_source", "review_fields"]);

interface Violation {
  readonly file: string;
  readonly line: number;
  readonly rule: string;
}

const isTestPath = (path: string) => /(^|\/)__tests__\//.test(path) || /\.(test|spec)\.[cm]?[jt]sx?$/.test(path);

function listFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...listFiles(full));
    else if (/\.(ts|tsx)$/.test(entry) && !entry.endsWith(".d.ts")) out.push(full);
  }
  return out;
}

const scannedFiles = [...listFiles(join(ROOT, UI_DIRECTORY)), ...listFiles(join(ROOT, LIB_DIRECTORY)), ...HOOK_FILES.map((file) => join(ROOT, file))]
  .map((full) => relative(ROOT, full).split("\\").join("/"))
  .filter((path) => !isTestPath(path))
  .sort();

function parse(file: string, source: string): ts.SourceFile {
  return ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
}

/** Whether `file` may import `specifier`, and whether only for types. */
function importRule(file: string, specifier: string, typeOnly: boolean): string | null {
  if (specifier.startsWith(".")) {
    const target = posix.normalize(posix.join(posix.dirname(file), specifier));
    return target.startsWith(`${UI_DIRECTORY}/`) || target.startsWith(`${LIB_DIRECTORY}/`) ? null : `relative module "${specifier}"`;
  }
  if (ALLOWED_IMPORTS.has(specifier)) return null;
  const owners = VALUE_IMPORT_OWNERS[specifier];
  if (owners && owners.includes(file)) return null;
  if (TYPE_ONLY_IMPORTS.has(specifier)) return typeOnly ? null : `value import of "${specifier}"`;
  return `module "${specifier}"`;
}

function isTypeOnlyImport(node: ts.ImportDeclaration): boolean {
  const clause = node.importClause;
  if (!clause) return false;
  if (clause.isTypeOnly) return true;
  if (clause.name) return false;
  const bindings = clause.namedBindings;
  return !!bindings && ts.isNamedImports(bindings) && bindings.elements.length > 0 && bindings.elements.every((element) => element.isTypeOnly);
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
      ts.isPropertyDeclaration(parent) ||
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

function memberOf(node: ts.Node): { readonly member: string; readonly object: ts.Expression } | null {
  if (ts.isPropertyAccessExpression(node)) return { member: node.name.text, object: node.expression };
  if (ts.isElementAccessExpression(node) && ts.isStringLiteralLike(node.argumentExpression)) return { member: node.argumentExpression.text, object: node.expression };
  return null;
}

function keyName(name: ts.PropertyName): string | null {
  if (ts.isIdentifier(name) || ts.isStringLiteralLike(name) || ts.isNumericLiteral(name)) return name.text;
  return null;
}

export function scanStudyRecordSource(file: string, source: string): Violation[] {
  const sourceFile = parse(file, source);
  const violations: Violation[] = [];
  const report = (node: ts.Node, rule: string) =>
    violations.push({ file, line: sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1, rule });

  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node)) {
      if (!ts.isStringLiteral(node.moduleSpecifier)) report(node, "computed module specifier");
      else {
        const rule = importRule(file, node.moduleSpecifier.text, isTypeOnlyImport(node));
        if (rule) report(node, rule);
      }
    }
    if (ts.isExportDeclaration(node) && node.moduleSpecifier) {
      if (!ts.isStringLiteral(node.moduleSpecifier)) report(node, "computed module specifier");
      else {
        const rule = importRule(file, node.moduleSpecifier.text, node.isTypeOnly);
        if (rule) report(node, rule);
      }
    }
    if (ts.isImportEqualsDeclaration(node)) report(node, "import = require");
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      if (callee.kind === ts.SyntaxKind.ImportKeyword) report(node, "dynamic import");
      if (ts.isIdentifier(callee) && callee.text === "require") report(node, "require");

      // `.from(table)` — a read: immediately `.select()`, no mutation in the chain.
      const access = memberOf(callee);
      if (access && access.member === "from" && !(ts.isIdentifier(access.object) && access.object.text === "Array")) {
        const [table] = node.arguments;
        if (table && ts.isStringLiteralLike(table) && !READ_TABLES.has(table.text)) report(node, `from("${table.text}")`);
        if (table && (ts.isTemplateExpression(table) || ts.isBinaryExpression(table))) report(node, "computed table name");
        const next = node.parent;
        const nextMember = next ? memberOf(next) : null;
        if (!nextMember || nextMember.member !== "select") report(node, "from() not followed by select()");
        for (let up: ts.Node | undefined = node.parent; up && (ts.isPropertyAccessExpression(up) || ts.isElementAccessExpression(up) || ts.isCallExpression(up)); up = up.parent) {
          const step = memberOf(up);
          if (step && MUTATIONS.has(step.member)) report(up, `.${step.member}() on a table`);
        }
      }
    }

    const access = memberOf(node);
    if (access) {
      if (FORBIDDEN_MEMBERS.has(access.member)) report(node, `member .${access.member}`);
      if (DEFERRED_NAMES.has(access.member)) report(node, `PR-C2 .${access.member}`);
      if (ts.isIdentifier(access.object) && GLOBAL_OBJECTS.has(access.object.text) && FORBIDDEN_GLOBAL_MEMBERS.has(access.member)) {
        report(node, `${access.object.text}.${access.member}`);
      }
    }
    if (ts.isBindingElement(node)) {
      const name = node.propertyName ?? node.name;
      if (ts.isIdentifier(name) && (FORBIDDEN_MEMBERS.has(name.text) || DEFERRED_NAMES.has(name.text))) report(node, `destructured ${name.text}`);
    }
    if (ts.isIdentifier(node) && isValueReference(node)) {
      if (FORBIDDEN_GLOBALS.has(node.text)) report(node, `global ${node.text}`);
      if (DEFERRED_NAMES.has(node.text)) report(node, `PR-C2 ${node.text}`);
    }
    if (ts.isStringLiteralLike(node) && DEFERRED_STRINGS.has(node.text)) report(node, `PR-C2 "${node.text}"`);

    if ((ts.isPropertyAssignment(node) || ts.isShorthandPropertyAssignment(node)) && ts.isObjectLiteralExpression(node.parent)) {
      const name = keyName(node.name);
      if (name && SERVER_KEYS.has(name)) report(node, `server-only field "${name}"`);
    }

    if (ts.isJsxAttribute(node) && ts.isIdentifier(node.name)) {
      const element = node.parent?.parent;
      const tag = element && (ts.isJsxOpeningElement(element) || ts.isJsxSelfClosingElement(element)) ? element.tagName.getText(sourceFile) : "";
      if (node.name.text === "dangerouslySetInnerHTML") report(node, "dangerouslySetInnerHTML");
      if (/^[a-z]/.test(tag) && URL_ATTRIBUTES.has(node.name.text)) report(node, `${node.name.text} on <${tag}>`);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return violations;
}

/** Calls `<receiver>.<method>(…)`, by method name. */
function callsOn(source: string, file: string, receivers: ReadonlySet<string>): string[] {
  const sourceFile = parse(file, source);
  const names: string[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && ts.isIdentifier(node.expression.expression) && receivers.has(node.expression.expression.text)) {
      names.push(node.expression.name.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return names;
}

const read = (file: string) => readFileSync(join(ROOT, file), "utf8");

describe("Study Record UI boundary — the real modules", () => {
  it("scans every Study Record module", () => {
    expect(scannedFiles).toEqual([
      "src/components/papers/study-record/FieldEditor.tsx",
      "src/components/papers/study-record/FieldSources.tsx",
      "src/components/papers/study-record/RecordPane.tsx",
      "src/components/papers/study-record/SourcePane.tsx",
      "src/components/papers/study-record/StudyRecordDialog.tsx",
      "src/components/papers/study-record/StudyRecordEditor.tsx",
      "src/components/papers/study-record/StudyRecordEntry.tsx",
      "src/components/papers/study-record/StudyRecordList.tsx",
      "src/components/papers/study-record/StudyRecordStart.tsx",
      "src/components/papers/study-record/editorContext.ts",
      "src/components/papers/study-record/sourcePaneModel.ts",
      "src/components/papers/study-record/studyRecordCopy.ts",
      "src/hooks/useStudyRecordCreations.ts",
      "src/hooks/useStudyRecordEditor.ts",
      "src/hooks/useStudyRecords.ts",
      "src/lib/studyRecord/access.ts",
      "src/lib/studyRecord/client.ts",
      "src/lib/studyRecord/draft.ts",
      "src/lib/studyRecord/jsonbSize.ts",
      "src/lib/studyRecord/labelSuggestion.ts",
      "src/lib/studyRecord/paperGuards.ts",
      "src/lib/studyRecord/paperLinks.ts",
      "src/lib/studyRecord/pendingCreates.ts",
      "src/lib/studyRecord/quotes.ts",
      "src/lib/studyRecord/read.ts",
      "src/lib/studyRecord/savePlan.ts",
      "src/lib/studyRecord/validateDraft.ts",
    ]);
  });

  it("writes only through the adapter, reads only by SELECT, and reaches nothing else", () => {
    const violations = scannedFiles.flatMap((file) => scanStudyRecordSource(file, read(file)));
    expect(violations).toEqual([]);
  });

  it("creates the adapter exactly once, over the shared client", () => {
    const sourceFile = parse(CLIENT_FILE, read(CLIENT_FILE));
    const creations: string[] = [];
    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "createEvidenceLifecycleClient") {
        creations.push(node.arguments.map((argument) => argument.getText(sourceFile)).join(","));
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
    expect(creations).toEqual(["supabase"]);
    for (const file of scannedFiles.filter((path) => path !== CLIENT_FILE)) {
      expect(read(file).includes("createEvidenceLifecycleClient("), file).toBe(false);
    }
  });

  it("gives the editor the adapter as its default client", () => {
    const file = "src/hooks/useStudyRecordEditor.ts";
    const sourceFile = parse(file, read(file));
    const defaults: string[] = [];
    const visit = (node: ts.Node) => {
      if (ts.isBindingElement(node) && ts.isIdentifier(node.name) && node.name.text === "client" && node.initializer) defaults.push(node.initializer.getText(sourceFile));
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
    expect(defaults).toEqual(["studyRecordClient"]);
    expect(read(file)).toMatch(/import \{ newStudyRecordRequestId, studyRecordClient \} from "@\/lib\/studyRecord\/client";/);
  });

  it("makes exactly the five C1 writes, through the adapter's typed methods", () => {
    const creations = callsOn(read(CREATIONS_FILE), "creations.ts", new Set(["studyRecordClient"]));
    const editor = callsOn(read("src/hooks/useStudyRecordEditor.ts"), "editor.ts", new Set(["client"]));
    expect(creations).toEqual(["createStudyFromPaper"]);
    expect([...new Set(editor)].sort()).toEqual(["deleteStudy", "saveChanges", "setLink", "updateStudy"]);
    // No other module calls the adapter itself.
    for (const file of scannedFiles.filter((path) => path !== CREATIONS_FILE)) {
      expect(callsOn(read(file), file, new Set(["studyRecordClient"])), file).toEqual([]);
    }
  });

  it("creates only through the store of unresolved creates, which sends the request it is given (C1-R1)", () => {
    const start = callsOn(read("src/components/papers/study-record/StudyRecordStart.tsx"), "start.tsx", new Set(["creations"]));
    expect([...new Set(start)].sort()).toEqual(["retry", "start"]);
    // The store's only network path is the injected sender, called with the stored request.
    const store = parse("pendingCreates.ts", read("src/lib/studyRecord/pendingCreates.ts"));
    const sends: string[] = [];
    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "send") sends.push(node.arguments.map((argument) => argument.getText(store)).join(","));
      ts.forEachChild(node, visit);
    };
    visit(store);
    expect(sends).toEqual(["request"]);
    expect(read("src/lib/studyRecord/pendingCreates.ts")).not.toMatch(/newStudyRecordRequestId|randomUUID/);
  });

  it("reads only the evidence tables and paper titles", () => {
    const tables = new Set<string>();
    for (const file of scannedFiles) {
      const sourceFile = parse(file, read(file));
      const visit = (node: ts.Node) => {
        if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === "from") {
          const [table] = node.arguments;
          if (table && ts.isStringLiteralLike(table)) tables.add(table.text);
        }
        ts.forEachChild(node, visit);
      };
      visit(sourceFile);
    }
    expect([...tables].sort()).toEqual(["evidence_source_snapshots", "evidence_studies", "evidence_study_reports", "papers"]);
  });
});

describe("Study Record UI boundary — negative controls", () => {
  const COMPONENT = "src/components/papers/study-record/FieldSources.tsx";
  const LIB = "src/lib/studyRecord/read.ts";

  it("accepts the shapes the real modules use, and ignores names in comments, strings and types", () => {
    const harmless = `
      import { useState } from "react";
      import type { Database } from "@/integrations/supabase/types";
      import { draftHelper } from "./draft";
      // supabase.rpc("evidence_save_changes"); localStorage.setItem("draft", x); fetch(url)
      /* <p dangerouslySetInnerHTML={{ __html: abstract }} /> window.open(url) */
      const copy = "Use Confirm later: reviewField rebaseSource innerHTML";
      type Shape = { match_start: number; reviewedAt: string };
      const rows = client.from("evidence_arms").select("id").eq("user_id", userId).range(0, 999);
      const values = new Map(); values.delete(key); editor.update((d) => d);
      const reference = { purpose: "supports", quoteText, occurrence: 2, expectedMatchCount: 2 };
      const start = occurrence.exactUtf16.start;
      const selection = window.getSelection();
    `;
    expect(scanStudyRecordSource(LIB, harmless)).toEqual([]);
  });

  it("allows the Supabase client only where reads are made and the adapter is created", () => {
    const value = `import { supabase } from "@/integrations/supabase/client";`;
    expect(scanStudyRecordSource(READS_FILE, value)).toEqual([]);
    expect(scanStudyRecordSource(CLIENT_FILE, value)).toEqual([]);
    expect(scanStudyRecordSource(COMPONENT, value).length).toBeGreaterThan(0);
    expect(scanStudyRecordSource(COMPONENT, `import type { supabase } from "@/integrations/supabase/client";`)).toEqual([]);
    expect(scanStudyRecordSource(COMPONENT, `import { createEvidenceLifecycleClient } from "@/lib/evidence/lifecycleClient";`).length).toBeGreaterThan(0);
    expect(scanStudyRecordSource(COMPONENT, `import type { EvidenceLifecycleClient } from "@/lib/evidence/lifecycleClient";`)).toEqual([]);
  });

  it.each([
    ["an RPC call", `supabase.rpc("evidence_save_changes", args);`],
    ["an RPC call by key", `supabase["rpc"]("update_paper", args);`],
    ["an aliased RPC", `const { rpc } = supabase; rpc("x");`],
    ["a paper mutation hook", `import { usePaperMutations } from "@/hooks/papers/usePaperMutations";`],
    ["the papers hook", `import { usePapers } from "@/hooks/usePapers";`],
    ["an AI hook", `import { usePaperAnalysisActions } from "@/hooks/usePaperAnalysisActions";`],
    ["an AI error helper", `import { parseAnalyzeError } from "@/lib/analyzeError";`],
    ["an Edge search", `import { searchPubMed } from "@/lib/searchPubMedEdge";`],
    ["a provider SDK", `import OpenAI from "openai";`],
    ["auth", `import { useAuth } from "@/hooks/useAuth";`],
    ["routing", `import { useNavigate } from "react-router";`],
    ["a relative climb out of the feature", `import { supabase } from "../../../integrations/supabase/client";`],
    ["a re-export", `export * from "@/integrations/supabase/client";`],
    ["a dynamic import", `const m = await import("@/hooks/usePapers");`],
    ["require", `const m = require("@/hooks/usePapers");`],
    ["an Edge Function", `supabase.functions.invoke("analyze-paper", { body });`],
    ["Storage", `supabase.storage.from("paper-attachments").upload(path, file);`],
    ["a table insert", `client.from("evidence_field_values").insert(row);`],
    ["a table update", `client.from("papers").update({ title }).eq("id", id);`],
    ["an update hidden after a select", `client.from("papers").select("id").update({ title });`],
    ["a table delete", `client.from("evidence_studies").delete().eq("id", id);`],
    ["an upsert", `client.from("evidence_arms").upsert(rows);`],
    ["a from() that is not a select", `const q = client.from("evidence_arms"); q.select("id");`],
    ["a table outside the reads", `client.from("paper_attachments").select("*");`],
    ["a computed table", "client.from(`evidence_${name}`).select(\"id\");"],
    ["fetch", `fetch("https://example.invalid", { method: "POST", body });`],
    ["fetch through window", `window.fetch(url);`],
    ["a beacon", `navigator.sendBeacon(url, body);`],
    ["a socket", `new WebSocket(url);`],
    ["browser storage", `localStorage.setItem("study-draft", JSON.stringify(draft));`],
    ["browser storage via window", `window.sessionStorage.setItem("k", v);`],
    ["indexedDB", `indexedDB.open("drafts");`],
    ["a cookie", `document.cookie = "draft=" + value;`],
    ["a new window", `window.open(url);`],
    ["HTML injection", `const x = <div dangerouslySetInnerHTML={{ __html: abstract }} />;`],
    ["innerHTML", `element.innerHTML = abstract;`],
    ["a parsed fragment", `range.createContextualFragment(abstract);`],
    ["a link", `const x = <a href={url}>x</a>;`],
    ["an image", `const x = <img src={url} />;`],
    ["forged match offsets", `const anchor = { quote_text: q, match_start: 3, match_end: 9 };`],
    ["a forged attestation", `const match = { attestation: "server", normalizedStart: 1, normalizedEnd: 4 };`],
    ["a forged match time", `const m = { matchedAt: new Date().toISOString() };`],
    ["a forged review", `const v = { review_status: "user_reviewed", reviewed_at: now };`],
    ["a forged version", `const row = { value_version: 2 };`],
    ["a forged capture", `const copy = { captured_at: now, char_count: 10 };`],
    ["a shorthand server field", `const matchedAt = now; const m = { matchedAt };`],
    ["Confirm", `client.reviewField(request);`],
    ["a review request", `const request = prepareReviewField(input);`],
    ["the source rebase", `client.rebaseSource(request);`],
    ["a confirm precheck", `const blocks = checkConfirm(value);`],
    ["a review RPC name", `const fn = "evidence_review_fields";`],
    ["a rebase RPC name", `const fn = "evidence_rebase_source";`],
  ])("flags %s", (_label, source) => {
    expect(scanStudyRecordSource(COMPONENT, source).length).toBeGreaterThan(0);
  });
});
