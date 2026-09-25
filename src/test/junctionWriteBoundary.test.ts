import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, it, expect } from "vitest";

/**
 * Architecture-fitness guard for DB-JUNCTION-DML-GRANT-HARDENING-001 (C48).
 *
 * Migration `20260925134526_harden_junction_dml_grants.sql` makes the two
 * assignment junctions — `paper_projects` and `paper_tags` — SELECT-only for
 * `authenticated`. From then on a direct Data API INSERT / UPDATE / UPSERT /
 * DELETE on either one is refused with 42501, and the only client write path is
 * the reviewed assignment RPC surface (`set_paper_*`, `bulk_set_paper_*`,
 * `bulk_add_paper_*`, `merge_exact_duplicates`).
 *
 * So a change that makes a client path write a junction directly — the easy
 * mistake being AI "Create & select" assigning its freshly created Project or
 * Tag with `.from("paper_projects").insert(...)` instead of letting Save call
 * `set_paper_projects` — would ship code that fails in Production. This suite
 * is meant to catch that at review time rather than in a browser.
 *
 * What it checks, precisely. It parses the product TypeScript sources of the
 * web app, the Chrome extension and the Edge Functions (which call the Data API
 * with the caller's own token, so they are bound by the same grant) with the
 * TypeScript parser — so a junction name inside a comment, a string or a URL
 * can neither hide nor fake a match — and looks at every `.from(<table>)`
 * builder:
 *   * a mutation on the builder's own chain, or on a same-file local variable
 *     the builder was assigned to (followed by TypeScript's own scoping, so a
 *     shadowing variable of the same name is not confused with it, and through
 *     aliases of aliases), is a violation when the table is a junction;
 *   * a mutation on a builder whose table name it cannot resolve statically
 *     fails closed;
 *   * a BARE junction builder — one nothing has been called on yet, which is
 *     the only kind that can still start a write — that leaves the local view
 *     (passed as an argument, returned, destructured, stored in an object or
 *     exported) fails closed too, because what happens to it next is out of
 *     sight.
 *
 * What it does NOT do: it does not follow a builder across files or through
 * arbitrary data flow, and it does not see a hand-built HTTP request to the
 * REST endpoint (the product sources issue none today). It is a review-time
 * tripwire, not the enforcement: the database ACL is what refuses the write,
 * and the integrated Edit Paper test and the E2E network assertions are the
 * runtime proof for the AI workflow. Creating a Project or Tag —
 * `from("projects")` / `from("tags")` — is deliberately NOT restricted: those
 * entity tables stay user-writable.
 */

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const SCANNED_ROOTS = ["src", "extension/src", "supabase/functions"];
const JUNCTIONS = new Set(["paper_projects", "paper_tags"]);
const MUTATIONS = new Set(["insert", "upsert", "update", "delete"]);
/** A called member this guard cannot name, such as `builder[op](row)`. */
const COMPUTED = "<computed member>";
/** A computed element read that is not called, such as `rows[i]`. */
const INDEX = "<index>";

interface FromCall {
  file: string;
  line: number;
  /** The resolved table name, or null when the argument is not statically known. */
  table: string | null;
  /**
   * Every member used on the builder after `.from(...)` — on its own chain and
   * through each local alias. A computed member is recorded only where it is
   * the first one, i.e. where it could be a mutation.
   */
  chain: string[];
  /** The same-file local variables the builder (or its chain) was assigned to. */
  aliases: string[];
  /** Where the bare builder left this guard's local view, if it did. */
  escapes: string[];
}

function isTestPath(path: string): boolean {
  return /(^|\/)__tests__\//.test(path) || /\.(test|spec)\.[cm]?[jt]sx?$/.test(path);
}

function listSources(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === "node_modules") continue;
      out.push(...listSources(full));
    } else if (/\.(ts|tsx|mts|cts)$/.test(entry) && !entry.endsWith(".d.ts")) {
      out.push(full);
    }
  }
  return out;
}

/** String-literal value of `node`, following a same-file `const X = "..."`. */
function staticString(node: ts.Expression, consts: Map<string, string>): string | null {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isIdentifier(node)) return consts.get(node.text) ?? null;
  if (ts.isAsExpression(node) || ts.isParenthesizedExpression(node) || ts.isSatisfiesExpression(node)) {
    return staticString(node.expression, consts);
  }
  return null;
}

/** Wrappers that hand on the same object: `(x)`, `x!`, `x as T`, `await x`, … */
function isTransparent(node: ts.Node): boolean {
  return (
    ts.isParenthesizedExpression(node) ||
    ts.isNonNullExpression(node) ||
    ts.isAsExpression(node) ||
    ts.isSatisfiesExpression(node) ||
    ts.isTypeAssertionExpression(node) ||
    ts.isAwaitExpression(node)
  );
}

/**
 * Climb outward from `start` through member links — `x.select(...).eq(...)`,
 * `x["delete"]()` — and return the members used plus the outermost expression.
 */
function climb(start: ts.Node, consts: Map<string, string>): { members: string[]; tip: ts.Node } {
  const members: string[] = [];
  let current = start;
  for (;;) {
    while (current.parent && isTransparent(current.parent)) current = current.parent;
    const parent = current.parent;
    if (parent && ts.isPropertyAccessExpression(parent) && parent.expression === current) {
      members.push(parent.name.text);
    } else if (parent && ts.isElementAccessExpression(parent) && parent.expression === current) {
      const called = ts.isCallExpression(parent.parent) && parent.parent.expression === parent;
      members.push(staticString(parent.argumentExpression, consts) ?? (called ? COMPUTED : INDEX));
    } else {
      return { members, tip: current };
    }
    current = parent;
    const call = current.parent;
    if (call && ts.isCallExpression(call) && call.expression === current) current = call;
  }
}

/** The plain local variable `tip` is stored in (`const x = tip` / `x = tip`), if any. */
function boundIdentifier(tip: ts.Node): ts.Identifier | undefined {
  const site = tip.parent;
  if (ts.isVariableDeclaration(site) && site.initializer === tip && ts.isIdentifier(site.name)) return site.name;
  if (
    ts.isBinaryExpression(site) &&
    site.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
    site.right === tip &&
    ts.isIdentifier(site.left)
  ) {
    return site.left;
  }
  return undefined;
}

/** How a bare builder at `tip` leaves the local view, or null when it does not. */
function escapeOf(tip: ts.Node, alias: ts.Identifier | undefined): string | null {
  const site = tip.parent;
  if (alias) {
    const declaration = alias.parent;
    const exported =
      ts.isVariableDeclaration(declaration) && (ts.getCombinedModifierFlags(declaration) & ts.ModifierFlags.Export) !== 0;
    return exported ? "exported" : null;
  }
  if (ts.isExpressionStatement(site)) return null; // evaluated and discarded
  if (ts.isCallExpression(site) || ts.isNewExpression(site)) return "passed as an argument";
  if (ts.isReturnStatement(site) || ts.isArrowFunction(site)) return "returned";
  if (ts.isVariableDeclaration(site)) return "destructured";
  return `used as part of a ${ts.SyntaxKind[site.kind]}`;
}

/** A checker over this one file — enough to resolve local names by scope. */
function checkerFor(sf: ts.SourceFile): ts.TypeChecker {
  const options: ts.CompilerOptions = { noLib: true, noResolve: true, types: [] };
  const host = ts.createCompilerHost(options, true);
  host.getSourceFile = (name) => (name === sf.fileName ? sf : undefined);
  host.fileExists = (name) => name === sf.fileName;
  host.readFile = (name) => (name === sf.fileName ? sf.text : undefined);
  return ts.createProgram({ rootNames: [sf.fileName], options, host }).getTypeChecker();
}

/** The local variable an identifier refers to, including `{ x }` and `export { x }`. */
function symbolAt(checker: ts.TypeChecker, id: ts.Identifier): ts.Symbol | undefined {
  const parent = id.parent;
  if (ts.isShorthandPropertyAssignment(parent) && parent.name === id) {
    return checker.getShorthandAssignmentValueSymbol(parent);
  }
  if (ts.isExportSpecifier(parent)) return checker.getExportSpecifierLocalTargetSymbol(parent);
  return checker.getSymbolAtLocation(id);
}

/** Find every `<x>.from(<arg>)` call and everything used on the builder it returns. */
export function findFromCalls(fileName: string, source: string): FromCall[] {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true,
    fileName.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);

  const consts = new Map<string, string>();
  const identifiers = new Map<string, ts.Identifier[]>();
  const collect = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      const init = node.initializer;
      if (ts.isStringLiteral(init) || ts.isNoSubstitutionTemplateLiteral(init)) consts.set(node.name.text, init.text);
    }
    if (ts.isIdentifier(node) && !(ts.isPropertyAccessExpression(node.parent) && node.parent.name === node)) {
      const named = identifiers.get(node.text);
      if (named) named.push(node);
      else identifiers.set(node.text, [node]);
    }
    ts.forEachChild(node, collect);
  };
  collect(sf);

  let checker: ts.TypeChecker | undefined; // built only for files that alias a builder
  const lineOf = (node: ts.Node) => sf.getLineAndCharacterOfPosition(node.getStart()).line + 1;

  /** Follow one use of the builder (the `.from()` call itself, or an alias reference). */
  const follow = (start: ts.Node, prefix: string[], out: FromCall, seen: Set<ts.Symbol>) => {
    const { members, tip } = climb(start, consts);
    out.chain.push(...members.filter((m, i) => m !== COMPUTED || prefix.length + i === 0));
    const bare = prefix.length === 0 && members.length === 0;
    const alias = boundIdentifier(tip);
    if (bare) {
      const escape = escapeOf(tip, alias);
      if (escape) out.escapes.push(`${escape} at line ${lineOf(tip)}`);
    }
    if (!alias) return;

    checker ??= checkerFor(sf);
    const symbol = checker.getSymbolAtLocation(alias);
    if (!symbol || seen.has(symbol)) return;
    seen.add(symbol);
    out.aliases.push(alias.text);

    const chain = [...prefix, ...members];
    for (const ref of identifiers.get(alias.text) ?? []) {
      if (ref === alias || symbolAt(checker, ref) !== symbol) continue;
      const parent = ref.parent;
      const declares = (ts.isVariableDeclaration(parent) || ts.isParameter(parent)) && parent.name === ref;
      const assigned =
        ts.isBinaryExpression(parent) && parent.operatorToken.kind === ts.SyntaxKind.EqualsToken && parent.left === ref;
      if (declares || assigned) continue;
      if (ts.isShorthandPropertyAssignment(parent) || ts.isExportSpecifier(parent)) {
        if (chain.length === 0) out.escapes.push(`handed on as \`${alias.text}\` at line ${lineOf(ref)}`);
        continue;
      }
      follow(ref, chain, out, seen);
    }
  };

  const calls: FromCall[] = [];
  const visit = (node: ts.Node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "from" &&
      node.arguments.length >= 1
    ) {
      const call: FromCall = {
        file: fileName,
        line: lineOf(node),
        table: staticString(node.arguments[0], consts),
        chain: [],
        aliases: [],
        escapes: [],
      };
      follow(node, [], call, new Set());
      calls.push(call);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return calls;
}

/** The violations the guard reports for a set of `.from()` calls. */
export function junctionWriteViolations(calls: FromCall[]): string[] {
  const violations: string[] = [];
  for (const call of calls) {
    const where = `${call.file}:${call.line}`;
    const via = call.aliases.length > 0 ? ` (through local ${call.aliases.map((a) => `\`${a}\``).join(", ")})` : "";
    const writes = call.chain.filter((m) => MUTATIONS.has(m) || m === COMPUTED);
    if (writes.length > 0) {
      if (call.table === null) {
        // A write whose target cannot be read statically could be a junction.
        // Name the table with a same-file const instead, so this guard can see it.
        violations.push(`${where} ${writes.join("/")} on a table name this guard cannot resolve${via}`);
      } else if (JUNCTIONS.has(call.table)) {
        violations.push(`${where} direct ${writes.join("/")} on ${call.table}${via}`);
      }
    }
    if (call.table !== null && JUNCTIONS.has(call.table) && call.escapes.length > 0) {
      violations.push(`${where} a bare ${call.table} builder leaves this guard's view: ${call.escapes.join("; ")}`);
    }
  }
  return violations;
}

function scanRepository(): FromCall[] {
  const calls: FromCall[] = [];
  for (const root of SCANNED_ROOTS) {
    for (const file of listSources(join(ROOT, root))) {
      const rel = relative(ROOT, file);
      if (isTestPath(rel)) continue;
      calls.push(...findFromCalls(rel, readFileSync(file, "utf8")));
    }
  }
  return calls;
}

describe("assignment-junction write boundary (C48)", () => {
  const calls = scanRepository();

  it("no web-app, extension or Edge Function source writes paper_projects / paper_tags through a .from() builder", () => {
    expect(junctionWriteViolations(calls)).toEqual([]);
  });

  it("is not vacuous: it sees the live junction reads, and every one of them is a read", () => {
    const junctionCalls = calls.filter((c) => c.table !== null && JUNCTIONS.has(c.table));
    const files = new Set(junctionCalls.map((c) => c.file));
    // The dashboard list and the Project/Tag filter read the junctions by name.
    expect(files).toContain("src/hooks/usePapers.ts");
    expect(files).toContain("src/hooks/useFilterState.ts");
    expect(junctionCalls.length).toBeGreaterThanOrEqual(4);
    for (const call of junctionCalls) expect(call.chain).toContain("select");
  });

  it("is not vacuous: it follows the real local builder aliases in the product sources", () => {
    // buildPapersQuery keeps its builder in `let query` and extends it later.
    const papersQuery = calls.find(
      (c) => c.file === "src/lib/buildPapersQuery.ts" && c.table === "papers" && c.aliases.includes("query"),
    );
    expect(papersQuery?.chain).toEqual(expect.arrayContaining(["select", "eq", "order"]));
  });

  it("leaves the entity tables writable: Projects and Tags are still created by direct INSERT", () => {
    const entityInserts = calls.filter(
      (c) => (c.table === "projects" || c.table === "tags") && c.chain.includes("insert"),
    );
    expect(entityInserts.map((c) => `${c.file}:${c.table}`).sort()).toEqual([
      "src/hooks/papers/useProjectMutations.ts:projects",
      "src/hooks/papers/useTagMutations.ts:tags",
    ]);
  });

  describe("self-test: the analyzer flags each way a junction write could be written", () => {
    const flag = (source: string) =>
      junctionWriteViolations(findFromCalls("fixture.ts", source));

    it.each([
      // Directly on the chain.
      ["a literal INSERT", `await supabase.from("paper_projects").insert({ paper_id, project_id });`],
      ["an INSERT that selects the row back", `await supabase.from("paper_tags").insert(row).select().single();`],
      ["an UPSERT", `await supabase.from('paper_tags').upsert(rows);`],
      ["an UPDATE", "await supabase.from(`paper_projects`).update({ project_id }).eq(\"paper_id\", id);"],
      ["a DELETE", `await supabase.from("paper_tags").delete().eq("paper_id", id);`],
      ["a const-named table", `const T = "paper_projects";\nawait supabase.from(T).delete().in("paper_id", ids);`],
      ["a table name the guard cannot resolve", `await supabase.from(tableFor(kind)).insert(row);`],
      ["a write behind non-null and parentheses", `await (supabase.from("paper_tags")!).insert(row);`],
      ["a write named by a string index", `await supabase.from("paper_tags")["delete"]().eq("paper_id", id);`],
      ["a write named by a computed index", `await supabase.from("paper_projects")[op](row);`],
      // Through a local alias of the builder.
      ["an aliased paper_projects INSERT", `const junction = supabase.from("paper_projects");\nawait junction.insert(row);`],
      ["an aliased paper_tags DELETE", `const junction = supabase.from("paper_tags");\nawait junction.delete().eq("paper_id", id);`],
      ["an aliased junction UPSERT on a const-named table", `const TABLE = "paper_tags";\nconst junction = supabase.from(TABLE);\nawait junction.upsert(rows);`],
      ["an aliased mutation on a table the guard cannot resolve", `const junction = supabase.from(tableFor(kind));\nawait junction.insert(row);`],
      ["a write through an alias of an alias", `const a = supabase.from("paper_projects");\nconst b = a;\nawait b.insert(row);`],
      ["a write through a later-assigned let", `let junction;\njunction = supabase.from("paper_projects");\nawait junction.update({ project_id }).eq("paper_id", id);`],
      ["a write through an alias used inside a closure", `const junction = supabase.from("paper_tags");\nconst run = async () => { await junction.insert(row); };`],
      // A bare junction builder leaving the local view.
      ["a bare junction builder passed to a helper", `await writeLinks(supabase.from("paper_projects"), rows);`],
      ["a bare junction builder alias passed to a helper", `const junction = supabase.from("paper_tags");\nawait writeLinks(junction, rows);`],
      ["a bare junction builder returned", `function linkTable() {\n  return supabase.from("paper_projects");\n}`],
      ["a bare junction builder chosen by a conditional", `const b = cond ? supabase.from("paper_projects") : supabase.from("projects");`],
      ["a bare junction builder destructured", `const { insert } = supabase.from("paper_tags");`],
      ["a bare junction builder stored in an object", `const junction = supabase.from("paper_tags");\nregister({ junction });`],
      ["a bare junction builder exported", `export const junction = supabase.from("paper_projects");`],
    ])("flags %s", (_label, source) => {
      expect(flag(source)).toHaveLength(1);
    });

    it.each([
      ["a junction read", `await supabase.from("paper_projects").select("paper_id, project_id").in("paper_id", ids);`],
      ["a Project insert", `await supabase.from("projects").insert({ user_id, name }).select().single();`],
      ["a Tag insert", `await supabase.from("tags").insert({ user_id, name }).select().single();`],
      ["the assignment RPC", `await supabase.rpc("set_paper_projects", { p_paper_id, p_project_ids });`],
      ["a junction name in a comment", `// never supabase.from("paper_projects").insert(...)\nawait supabase.rpc("set_paper_tags", args);`],
      ["an aliased junction SELECT", `const junction = supabase.from("paper_projects");\nawait junction.select("paper_id, project_id");`],
      ["an aliased Project INSERT", `const projects = supabase.from("projects");\nawait projects.insert(row);`],
      ["an aliased Tag INSERT", `const tags = supabase.from("tags");\nawait tags.insert(row);`],
      ["a junction read query handed to a helper", `await paginate(supabase.from("paper_tags").select("paper_id, tag_id"));`],
      ["a reassigned read query on a table the guard cannot resolve", `let query = supabase.from(table).select(cols).eq("user_id", userId);\nquery = query.in("paper_id", ids);\nconst { data } = await query;`],
      ["a shadowing variable of the same name", `const junction = supabase.from("paper_projects");\nawait junction.select("*");\n{\n  const junction = supabase.from("projects");\n  await junction.insert(row);\n}`],
    ])("does not flag %s", (_label, source) => {
      expect(flag(source)).toEqual([]);
    });
  });
});
