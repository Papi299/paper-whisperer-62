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
 *     or quote offset, and no review status, time or version, is ever built in
 *     the browser;
 *   * a review write outside the editor hook: `reviewField` and
 *     `prepareReviewField` are used by `useStudyRecordEditor` alone
 *     (EVIDENCE-RECORDS-001C2A), and no UI module names the review RPC;
 *   * anything of PR-C2C's: the source rebase (`rebaseSource`,
 *     `prepareRebaseSource`) or its RPC name.
 *   * a read of `evidence_events` (History, EVIDENCE-RECORDS-001C2B) anywhere
 *     but `src/lib/studyRecord/historyRead.ts`, or one there without its
 *     `.eq("user_id", …)` and `.eq("study_id", …)`, or whose projection is
 *     not a literal list of named columns — `*`, `payload_sha256`, `result`
 *     and `note` never among them. The general table allow-list does not
 *     include `evidence_events`: this rule is its only way in.
 * And it checks the positive relationships: the adapter is created exactly
 * once, the editor's default client is that adapter, and the writes the UI
 * makes are exactly the five C1 adapter methods and C2A's `reviewField` — a
 * create only from the store of unresolved creates (C1-R1), which the Start
 * view reaches through `start` and `retry` alone, and every other write from
 * the editor hook. History adds reads only: exactly two, in the history read
 * module, with the projections it reviewed; its hook is, beside
 * `useStudyRecords`, the only other module that may import the Supabase client.
 *
 * A review-time tripwire like `evidenceDomainBoundary.test.ts`, not the
 * enforcement: RLS, the SELECT-only grants and the RPCs' own checks refuse a
 * write. It reads source text only and does not follow data across files.
 */

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const UI_DIRECTORY = "src/components/papers/study-record";
const LIB_DIRECTORY = "src/lib/studyRecord";
const HOOK_FILES = ["src/hooks/useStudyRecords.ts", "src/hooks/useStudyRecordEditor.ts", "src/hooks/useStudyRecordCreations.ts", "src/hooks/useStudyRecordHistory.ts"];
const CREATIONS_FILE = "src/hooks/useStudyRecordCreations.ts";
const CLIENT_FILE = "src/lib/studyRecord/client.ts";
const READS_FILE = "src/hooks/useStudyRecords.ts";
const EDITOR_FILE = "src/hooks/useStudyRecordEditor.ts";
/** C2B: the History hook, which hands the shared client to the history read module. */
const HISTORY_HOOK_FILE = "src/hooks/useStudyRecordHistory.ts";
/** C2B: the one module that reads `evidence_events`. */
const HISTORY_READ_FILE = "src/lib/studyRecord/historyRead.ts";

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
  "@/hooks/useStudyRecordHistory",
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
  "@/lib/studyRecord/historyModel",
  "@/lib/studyRecord/historyRead",
  "@/lib/studyRecord/jsonbSize",
  "@/lib/studyRecord/labelSuggestion",
  "@/lib/studyRecord/paperGuards",
  "@/lib/studyRecord/paperLinks",
  "@/lib/studyRecord/pendingCreates",
  "@/lib/studyRecord/quotes",
  "@/lib/studyRecord/read",
  "@/lib/studyRecord/reviewModel",
  "@/lib/studyRecord/savePlan",
  "@/lib/studyRecord/validateDraft",
]);
/** Only for types, anywhere. */
const TYPE_ONLY_IMPORTS = new Set(["@/integrations/supabase/types", "@/types/database", "@/integrations/supabase/client", "@/lib/evidence/lifecycleClient"]);
/** Value imports allowed in one module only. */
const VALUE_IMPORT_OWNERS: Readonly<Record<string, readonly string[]>> = {
  "@/integrations/supabase/client": [CLIENT_FILE, READS_FILE, HISTORY_HOOK_FILE],
  "@/lib/evidence/lifecycleClient": [CLIENT_FILE],
};

/** The general read allow-list. `evidence_events` is not on it: History's rule below is its only way in. */
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
/** C2B: history, read only by `HISTORY_READ_FILE`, for one user and one study. */
const HISTORY_TABLE = "evidence_events";
/** What a history read never selects: request idempotency (`payload_sha256`, `result`), `note`, or everything. */
const PRIVATE_EVENT_COLUMNS = new Set(["*", "payload_sha256", "result", "note"]);
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
/** PR-C2C: the source rebase. */
const DEFERRED_NAMES = new Set(["rebaseSource", "prepareRebaseSource"]);
const DEFERRED_STRINGS = new Set(["evidence_rebase_source", "rebase_source"]);
/** C2A's review write: the editor hook's alone. Its RPC name is the adapter's alone (never a UI string). */
const REVIEW_WRITE_NAMES = new Set(["reviewField", "prepareReviewField"]);
const REVIEW_RPC_STRINGS = new Set(["evidence_review_fields", "review_fields"]);

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

/** A module's `const NAME = "literal"` declarations: what a projection constant, or a table name kept in one, says. */
function stringConstants(sourceFile: ts.SourceFile): ReadonlyMap<string, string> {
  const constants = new Map<string, string>();
  const visit = (node: ts.Node) => {
    if (ts.isVariableDeclarationList(node) && (node.flags & ts.NodeFlags.Const) !== 0) {
      for (const declaration of node.declarations) {
        if (ts.isIdentifier(declaration.name) && declaration.initializer && ts.isStringLiteralLike(declaration.initializer)) {
          constants.set(declaration.name.text, declaration.initializer.text);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return constants;
}

/** A string literal, or a module constant naming one; undefined when it can't be read here. */
function literalOf(node: ts.Expression | undefined, constants: ReadonlyMap<string, string>): string | undefined {
  if (!node) return undefined;
  if (ts.isStringLiteralLike(node)) return node.text;
  return ts.isIdentifier(node) ? constants.get(node.text) : undefined;
}

/** What one `.from(table)` call's chain filters on (`.eq` columns) and selects. */
function chainOf(from: ts.CallExpression): { readonly eq: readonly string[]; readonly select: ts.Expression | undefined } {
  const eq: string[] = [];
  let select: ts.Expression | undefined;
  for (let up: ts.Node | undefined = from.parent; up && (ts.isPropertyAccessExpression(up) || ts.isElementAccessExpression(up) || ts.isCallExpression(up)); up = up.parent) {
    if (!ts.isCallExpression(up)) continue;
    const step = memberOf(up.expression);
    const [first] = up.arguments;
    if (step?.member === "eq" && first && ts.isStringLiteralLike(first)) eq.push(first.text);
    if (step?.member === "select") select = first;
  }
  return { eq, select };
}

export function scanStudyRecordSource(file: string, source: string): Violation[] {
  const sourceFile = parse(file, source);
  const constants = stringConstants(sourceFile);
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
        const tableName = literalOf(table, constants);
        if (tableName === HISTORY_TABLE) {
          // C2B: History is read in one module, for one user and one study, by named columns only.
          if (file !== HISTORY_READ_FILE) report(node, `${HISTORY_TABLE} read outside ${HISTORY_READ_FILE}`);
          const chain = chainOf(node);
          if (!chain.eq.includes("user_id")) report(node, `${HISTORY_TABLE} read without .eq("user_id", …)`);
          if (!chain.eq.includes("study_id")) report(node, `${HISTORY_TABLE} read without .eq("study_id", …)`);
          const projection = literalOf(chain.select, constants);
          if (projection === undefined) report(node, `${HISTORY_TABLE} read with a projection that isn't a literal list of columns`);
          else for (const column of projection.split(",").map((name) => name.trim()).filter((name) => PRIVATE_EVENT_COLUMNS.has(name))) report(node, `${HISTORY_TABLE} read of ${column}`);
        } else if (tableName !== undefined && !READ_TABLES.has(tableName)) report(node, `from("${tableName}")`);
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

    const reviewWriter = file === EDITOR_FILE;
    const access = memberOf(node);
    if (access) {
      if (FORBIDDEN_MEMBERS.has(access.member)) report(node, `member .${access.member}`);
      if (DEFERRED_NAMES.has(access.member)) report(node, `PR-C2C .${access.member}`);
      if (REVIEW_WRITE_NAMES.has(access.member) && !reviewWriter) report(node, `review write .${access.member} outside the editor hook`);
      if (ts.isIdentifier(access.object) && GLOBAL_OBJECTS.has(access.object.text) && FORBIDDEN_GLOBAL_MEMBERS.has(access.member)) {
        report(node, `${access.object.text}.${access.member}`);
      }
    }
    if (ts.isBindingElement(node)) {
      const name = node.propertyName ?? node.name;
      if (ts.isIdentifier(name) && (FORBIDDEN_MEMBERS.has(name.text) || DEFERRED_NAMES.has(name.text) || (REVIEW_WRITE_NAMES.has(name.text) && !reviewWriter))) {
        report(node, `destructured ${name.text}`);
      }
    }
    if (ts.isIdentifier(node) && isValueReference(node)) {
      if (FORBIDDEN_GLOBALS.has(node.text)) report(node, `global ${node.text}`);
      if (DEFERRED_NAMES.has(node.text)) report(node, `PR-C2C ${node.text}`);
      if (REVIEW_WRITE_NAMES.has(node.text) && !reviewWriter) report(node, `review write ${node.text} outside the editor hook`);
    }
    if (ts.isStringLiteralLike(node) && DEFERRED_STRINGS.has(node.text)) report(node, `PR-C2C "${node.text}"`);
    if (ts.isStringLiteralLike(node) && REVIEW_RPC_STRINGS.has(node.text)) report(node, `review RPC name "${node.text}"`);

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
      "src/components/papers/study-record/FlagForm.tsx",
      "src/components/papers/study-record/HistoryEntry.tsx",
      "src/components/papers/study-record/HistoryPane.tsx",
      "src/components/papers/study-record/RecordPane.tsx",
      "src/components/papers/study-record/ReviewCard.tsx",
      "src/components/papers/study-record/ReviewPane.tsx",
      "src/components/papers/study-record/SavedCopyText.tsx",
      "src/components/papers/study-record/SourcePane.tsx",
      "src/components/papers/study-record/StudyRecordDialog.tsx",
      "src/components/papers/study-record/StudyRecordEditor.tsx",
      "src/components/papers/study-record/StudyRecordEntry.tsx",
      "src/components/papers/study-record/StudyRecordList.tsx",
      "src/components/papers/study-record/StudyRecordStart.tsx",
      "src/components/papers/study-record/editorContext.ts",
      "src/components/papers/study-record/historyCopy.ts",
      "src/components/papers/study-record/reviewCopy.ts",
      "src/components/papers/study-record/sourcePaneModel.ts",
      "src/components/papers/study-record/studyRecordCopy.ts",
      "src/components/papers/study-record/useReviewFlow.ts",
      "src/hooks/useStudyRecordCreations.ts",
      "src/hooks/useStudyRecordEditor.ts",
      "src/hooks/useStudyRecordHistory.ts",
      "src/hooks/useStudyRecords.ts",
      "src/lib/studyRecord/access.ts",
      "src/lib/studyRecord/client.ts",
      "src/lib/studyRecord/draft.ts",
      "src/lib/studyRecord/historyModel.ts",
      "src/lib/studyRecord/historyRead.ts",
      "src/lib/studyRecord/jsonbSize.ts",
      "src/lib/studyRecord/labelSuggestion.ts",
      "src/lib/studyRecord/paperGuards.ts",
      "src/lib/studyRecord/paperLinks.ts",
      "src/lib/studyRecord/pendingCreates.ts",
      "src/lib/studyRecord/quotes.ts",
      "src/lib/studyRecord/read.ts",
      "src/lib/studyRecord/reviewModel.ts",
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

  it("makes exactly the five C1 writes and C2A's review, through the adapter's typed methods", () => {
    const creations = callsOn(read(CREATIONS_FILE), "creations.ts", new Set(["studyRecordClient"]));
    const editor = callsOn(read(EDITOR_FILE), "editor.ts", new Set(["client"]));
    expect(creations).toEqual(["createStudyFromPaper"]);
    expect([...new Set(editor)].sort()).toEqual(["deleteStudy", "reviewField", "saveChanges", "setLink", "updateStudy"]);
    // No other module calls the adapter itself.
    for (const file of scannedFiles.filter((path) => path !== CREATIONS_FILE)) {
      expect(callsOn(read(file), file, new Set(["studyRecordClient"])), file).toEqual([]);
    }
  });

  it("prepares and sends a review only in the editor hook, once each (C2A)", () => {
    const uses = (name: string) =>
      scannedFiles.flatMap((file) => {
        const sourceFile = parse(file, read(file));
        const found: string[] = [];
        const visit = (node: ts.Node) => {
          if (ts.isCallExpression(node)) {
            const callee = node.expression;
            const called = ts.isIdentifier(callee) ? callee.text : ts.isPropertyAccessExpression(callee) ? callee.name.text : null;
            if (called === name) found.push(file);
          }
          ts.forEachChild(node, visit);
        };
        visit(sourceFile);
        return found;
      });
    // One preparation, one send: a press and its "Try again" both go through the one `sendReview`.
    expect(uses("prepareReviewField")).toEqual([EDITOR_FILE]);
    expect(uses("reviewField")).toEqual([EDITOR_FILE]);
    // Components reach a review only through the hook's `review` and `retryReview`.
    for (const file of scannedFiles.filter((path) => path !== EDITOR_FILE)) {
      expect(read(file).includes("prepareReviewField"), file).toBe(false);
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
    expect([...tables].sort()).toEqual(["evidence_events", "evidence_source_snapshots", "evidence_studies", "evidence_study_reports", "papers"]);
  });

  it("reads history in exactly two places, both in the history read module, scoped to the user and the study, with the reviewed projections (C2B)", () => {
    const reads: { file: string; eq: readonly string[]; columns: string | undefined }[] = [];
    for (const file of scannedFiles) {
      const sourceFile = parse(file, read(file));
      const constants = stringConstants(sourceFile);
      const visit = (node: ts.Node) => {
        if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === "from") {
          if (literalOf(node.arguments[0], constants) === HISTORY_TABLE) {
            const chain = chainOf(node);
            reads.push({ file, eq: chain.eq, columns: literalOf(chain.select, constants) });
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(sourceFile);
    }
    // The headers: a version, an op and a time, plus the request id (grouping only) and the owner (a check only).
    // The changes add the target, field and digests. Never payload_sha256, result or note.
    expect(reads).toEqual([
      { file: HISTORY_READ_FILE, eq: ["user_id", "study_id", "ordinal"], columns: "id, user_id, study_id, study_version, ordinal, event_type, request_id, op, occurred_at" },
      {
        file: HISTORY_READ_FILE,
        eq: ["user_id", "study_id", "study_version"],
        columns: "id, user_id, study_id, study_version, ordinal, event_type, request_id, op, target_id, field_key, before, after, occurred_at",
      },
    ]);
    // No other module names the table at all, even in a string.
    for (const file of scannedFiles.filter((path) => path !== HISTORY_READ_FILE)) {
      expect(read(file).includes(`"${HISTORY_TABLE}"`), file).toBe(false);
    }
  });

  it("names past operations only through identifier keys: the rebase and review RPC names stay unwritten in every History module (C2B)", () => {
    for (const file of scannedFiles.filter((path) => /history/i.test(path))) {
      const sourceFile = parse(file, read(file));
      const strings: string[] = [];
      const visit = (node: ts.Node) => {
        if (ts.isStringLiteralLike(node)) strings.push(node.text);
        ts.forEachChild(node, visit);
      };
      visit(sourceFile);
      for (const forbidden of [...DEFERRED_STRINGS, ...REVIEW_RPC_STRINGS]) expect(strings, `${file}: "${forbidden}"`).not.toContain(forbidden);
    }
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
    // C2B: the History hook hands the client to the read module; the pane and the read module itself may not import it.
    expect(scanStudyRecordSource(HISTORY_HOOK_FILE, value)).toEqual([]);
    expect(scanStudyRecordSource("src/components/papers/study-record/HistoryPane.tsx", value).length).toBeGreaterThan(0);
    expect(scanStudyRecordSource(HISTORY_READ_FILE, value).length).toBeGreaterThan(0);
  });

  const HISTORY_READ = `
    const COLUMNS = "id, user_id, study_id, study_version, ordinal, event_type, request_id, op, occurred_at";
    const rows = client.from("evidence_events").select(COLUMNS).eq("user_id", userId).eq("study_id", studyId).eq("ordinal", 0).limit(11);
  `;

  it("lets the history read module — and only it — read evidence_events, for one user and one study, by named columns (C2B)", () => {
    expect(scanStudyRecordSource(HISTORY_READ_FILE, HISTORY_READ)).toEqual([]);
    // Unauthorized modules: the same read from a component, the hook, another read module or a copy module.
    for (const file of [
      "src/components/papers/study-record/HistoryPane.tsx",
      "src/components/papers/study-record/HistoryEntry.tsx",
      "src/components/papers/study-record/historyCopy.ts",
      HISTORY_HOOK_FILE,
      READS_FILE,
      LIB,
      "src/lib/studyRecord/historyModel.ts",
    ]) {
      expect(scanStudyRecordSource(file, HISTORY_READ).map((violation) => violation.rule), file).toContain(`evidence_events read outside ${HISTORY_READ_FILE}`);
    }
  });

  it.each([
    // Unscoped reads.
    ["a read without its user filter", `client.from("evidence_events").select("id, study_version").eq("study_id", studyId);`],
    ["a read without its study filter", `client.from("evidence_events").select("id, study_version").eq("user_id", userId);`],
    ["a user filter that isn't equality", `client.from("evidence_events").select("id").neq("user_id", userId).eq("study_id", studyId);`],
    ["a table name kept in a constant, unscoped", `const table = "evidence_events"; client.from(table).select("id").eq("study_id", studyId);`],
    // Private or unbounded projections.
    ["every column", `client.from("evidence_events").select("*").eq("user_id", userId).eq("study_id", studyId);`],
    ["the request fingerprint", `client.from("evidence_events").select("id, payload_sha256").eq("user_id", userId).eq("study_id", studyId);`],
    ["the stored result", `client.from("evidence_events").select("id,result").eq("user_id", userId).eq("study_id", studyId);`],
    ["the note", `client.from("evidence_events").select("id, note").eq("user_id", userId).eq("study_id", studyId);`],
    ["a projection built at run time", `client.from("evidence_events").select(columns.join(",")).eq("user_id", userId).eq("study_id", studyId);`],
    ["a projection that isn't a constant", `let columns = "id"; client.from("evidence_events").select(columns).eq("user_id", userId).eq("study_id", studyId);`],
    ["a select of nothing", `client.from("evidence_events").select().eq("user_id", userId).eq("study_id", studyId);`],
    // Writes.
    ["a history insert", `client.from("evidence_events").insert(row);`],
    ["a history update", `client.from("evidence_events").update({ note }).eq("id", id);`],
    ["a history delete", `client.from("evidence_events").delete().eq("study_id", studyId);`],
    ["a history upsert", `client.from("evidence_events").upsert(rows);`],
    ["a write after a scoped select", `client.from("evidence_events").select("id").eq("user_id", userId).eq("study_id", studyId).update({ op: "x" });`],
    ["a from() that is not a select", `const q = client.from("evidence_events"); q.select("id").eq("user_id", userId).eq("study_id", studyId);`],
    // Anything else of the write side, from the history module.
    ["an RPC", `client.rpc("evidence_save_changes", args);`],
    ["the source rebase", `client.rebaseSource(request);`],
    ["a rebase op name", `const op = "rebase_source";`],
    ["a review op name", `const op = "review_fields";`],
    ["a forged version", `const shown = { study_version: 3 };`],
  ])("flags %s in the history read module (C2B)", (_label, source) => {
    expect(scanStudyRecordSource(HISTORY_READ_FILE, source).length).toBeGreaterThan(0);
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
    ["a review sent from a component", `client.reviewField(request);`],
    ["a review sent through the shared adapter", `studyRecordClient.reviewField(request);`],
    ["a review request prepared in a component", `const request = prepareReviewField(input);`],
    ["an aliased review send", `const { reviewField } = client; reviewField(request);`],
    ["a review RPC name", `const fn = "evidence_review_fields";`],
    ["a review op name", `const op = "review_fields";`],
    ["a forged review status", `const shown = { ...value, review: { status: "user_reviewed", reviewedAt: now, reviewedVersion: 3 } };`],
    ["the source rebase", `client.rebaseSource(request);`],
    ["a rebase request", `const request = prepareRebaseSource(input);`],
    ["a rebase RPC name", `const fn = "evidence_rebase_source";`],
    ["a rebase op name", `const op = "rebase_source";`],
  ])("flags %s", (_label, source) => {
    expect(scanStudyRecordSource(COMPONENT, source).length).toBeGreaterThan(0);
  });

  it("lets the editor hook — and only it — prepare and send a review; lets anyone read a review status or ask checkConfirm", () => {
    const send = `const prepared = prepareReviewField(input); await client.reviewField(prepared.request);`;
    expect(scanStudyRecordSource(EDITOR_FILE, send)).toEqual([]);
    expect(scanStudyRecordSource(COMPONENT, send).length).toBe(2);
    expect(scanStudyRecordSource(LIB, send).length).toBe(2);
    const advisory = `const check = checkConfirm(value, value.valueVersion, links); const done = value.review.status === "user_reviewed";`;
    expect(scanStudyRecordSource(COMPONENT, advisory)).toEqual([]);
    expect(scanStudyRecordSource(LIB, advisory)).toEqual([]);
    // The rebase stays C2C's everywhere, the editor hook included.
    expect(scanStudyRecordSource(EDITOR_FILE, `client.rebaseSource(request);`).length).toBeGreaterThan(0);
    expect(scanStudyRecordSource(EDITOR_FILE, `const fn = "evidence_review_fields";`).length).toBeGreaterThan(0);
  });
});
