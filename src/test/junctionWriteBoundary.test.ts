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
 * So a change that makes ANY client path write a junction directly — the easy
 * mistake being AI "Create & select" assigning its freshly created Project or
 * Tag with `.from("paper_projects").insert(...)` instead of letting Save call
 * `set_paper_projects` — would ship code that fails in Production. This suite
 * catches that at review time, repository-wide, instead of in a browser.
 *
 * It reads the committed sources through the TypeScript parser rather than a
 * regex, so a junction name inside a comment, a string or a URL cannot hide or
 * fake a match. It covers the web app, the Chrome extension and the Edge
 * Functions (which call the Data API with the caller's own token, so they are
 * bound by the same grant). Creating a Project or Tag — `from("projects")` /
 * `from("tags")` — is deliberately NOT restricted: those entity tables stay
 * user-writable.
 */

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const SCANNED_ROOTS = ["src", "extension/src", "supabase/functions"];
const JUNCTIONS = new Set(["paper_projects", "paper_tags"]);
const MUTATIONS = new Set(["insert", "upsert", "update", "delete"]);

interface FromCall {
  file: string;
  line: number;
  /** The resolved table name, or null when the argument is not statically known. */
  table: string | null;
  /** Every method called on the chain after `.from(...)`, in order. */
  chain: string[];
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

/** Find every `<x>.from(<arg>)` call and the method chain hanging off it. */
export function findFromCalls(fileName: string, source: string): FromCall[] {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true,
    fileName.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);

  const consts = new Map<string, string>();
  const collect = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      const init = node.initializer;
      if (ts.isStringLiteral(init) || ts.isNoSubstitutionTemplateLiteral(init)) consts.set(node.name.text, init.text);
    }
    ts.forEachChild(node, collect);
  };
  collect(sf);

  const calls: FromCall[] = [];
  const visit = (node: ts.Node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "from" &&
      node.arguments.length >= 1
    ) {
      const chain: string[] = [];
      let current: ts.Node = node;
      // Walk outward through `.method(...)` links: from(...).select(...).eq(...)
      while (
        current.parent &&
        ts.isPropertyAccessExpression(current.parent) &&
        current.parent.expression === current
      ) {
        chain.push(current.parent.name.text);
        const call = current.parent.parent;
        current = call && ts.isCallExpression(call) && call.expression === current.parent ? call : current.parent;
      }
      calls.push({
        file: fileName,
        line: sf.getLineAndCharacterOfPosition(node.getStart()).line + 1,
        table: staticString(node.arguments[0], consts),
        chain,
      });
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
    const writes = call.chain.filter((m) => MUTATIONS.has(m));
    if (writes.length === 0) continue;
    if (call.table === null) {
      // A write whose target cannot be read statically could be a junction.
      // Name the table with a same-file const instead, so this guard can see it.
      violations.push(`${call.file}:${call.line} ${writes.join("/")} on a table name this guard cannot resolve`);
    } else if (JUNCTIONS.has(call.table)) {
      violations.push(`${call.file}:${call.line} direct ${writes.join("/")} on ${call.table}`);
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

  it("no web-app, extension or Edge Function path writes paper_projects / paper_tags directly", () => {
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
      ["a literal INSERT", `await supabase.from("paper_projects").insert({ paper_id, project_id });`],
      ["an INSERT that selects the row back", `await supabase.from("paper_tags").insert(row).select().single();`],
      ["an UPSERT", `await supabase.from('paper_tags').upsert(rows);`],
      ["an UPDATE", "await supabase.from(`paper_projects`).update({ project_id }).eq(\"paper_id\", id);"],
      ["a DELETE", `await supabase.from("paper_tags").delete().eq("paper_id", id);`],
      ["a const-named table", `const T = "paper_projects";\nawait supabase.from(T).delete().in("paper_id", ids);`],
      ["a table name the guard cannot resolve", `await supabase.from(tableFor(kind)).insert(row);`],
    ])("flags %s", (_label, source) => {
      expect(flag(source)).toHaveLength(1);
    });

    it.each([
      ["a junction read", `await supabase.from("paper_projects").select("paper_id, project_id").in("paper_id", ids);`],
      ["a Project insert", `await supabase.from("projects").insert({ user_id, name }).select().single();`],
      ["a Tag insert", `await supabase.from("tags").insert({ user_id, name }).select().single();`],
      ["the assignment RPC", `await supabase.rpc("set_paper_projects", { p_paper_id, p_project_ids });`],
      ["a junction name in a comment", `// never supabase.from("paper_projects").insert(...)\nawait supabase.rpc("set_paper_tags", args);`],
    ])("does not flag %s", (_label, source) => {
      expect(flag(source)).toEqual([]);
    });
  });
});
