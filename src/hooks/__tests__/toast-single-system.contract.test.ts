// @vitest-environment node
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

/**
 * UI-TOAST-LIFECYCLE-CONSISTENCY-001 — PaperLume has ONE notification system.
 *
 * Before this change two toasters were mounted: the shadcn/Radix one behind
 * `useToast()` and a Sonner one the synonym pool called directly. They differed
 * in timing, stacking, position and close behaviour, and the Radix one could
 * leave notifications on screen until clicked. These checks keep a second
 * system from coming back. They read the TypeScript AST — import specifiers,
 * JSX elements and string literals — so a comment can neither satisfy nor
 * break them.
 */

const ROOT = resolve(process.cwd());
const SRC = join(ROOT, "src");

/** The only two files allowed to import Sonner: the adapter and the toaster. */
const SONNER_OWNERS = ["src/components/ui/sonner.tsx", "src/hooks/use-toast.ts"];

const REMOVED_TOAST_MODULES = [
  "@radix-ui/react-toast",
  "@/components/ui/toast",
  "@/components/ui/toaster",
  "@/components/ui/use-toast",
];

function toRepoPath(file: string): string {
  return relative(ROOT, file).split(sep).join("/");
}

function productionFiles(dir: string = SRC): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "__tests__" || entry.name === "test") continue;
      files.push(...productionFiles(path));
    } else if (/\.(ts|tsx)$/.test(entry.name) && !/\.test\.(ts|tsx)$/.test(entry.name)) {
      files.push(path);
    }
  }
  return files;
}

function importsOf(file: string): string[] {
  return ts.preProcessFile(readFileSync(file, "utf8"), true, true).importedFiles.map((f) => f.fileName);
}

function parse(repoPath: string): ts.SourceFile {
  const text = readFileSync(join(ROOT, repoPath), "utf8");
  return ts.createSourceFile(repoPath, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
}

function collect<T extends ts.Node>(root: ts.Node, match: (node: ts.Node) => node is T): T[] {
  const found: T[] = [];
  const visit = (node: ts.Node) => {
    if (match(node)) found.push(node);
    ts.forEachChild(node, visit);
  };
  visit(root);
  return found;
}

/** Every string a file can emit: plain literals plus the text of template literals. */
function stringsOf(repoPath: string): string[] {
  return collect(parse(repoPath), (node): node is ts.Node =>
    ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateHead(node),
  ).map((node) => (node as ts.LiteralLikeNode).text);
}

describe("one notification system", () => {
  const files = productionFiles();

  it("scans the application source", () => {
    expect(files.length).toBeGreaterThan(50);
    expect(files.map(toRepoPath)).toContain("src/App.tsx");
  });

  it("imports Sonner only in the adapter and the toaster", () => {
    const importers = files.filter((file) => importsOf(file).includes("sonner")).map(toRepoPath).sort();
    expect(importers).toEqual(SONNER_OWNERS);
  });

  it("no longer references the Radix toaster anywhere", () => {
    const offenders = files.flatMap((file) =>
      importsOf(file)
        .filter((specifier) => REMOVED_TOAST_MODULES.includes(specifier))
        .map((specifier) => `${toRepoPath(file)} → ${specifier}`),
    );
    expect(offenders).toEqual([]);

    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    expect({ ...pkg.dependencies, ...pkg.devDependencies }).not.toHaveProperty("@radix-ui/react-toast");
  });

  it("mounts exactly one toaster in App, the Sonner one", () => {
    const app = parse("src/App.tsx");
    const toasters = collect(app, (node): node is ts.JsxSelfClosingElement | ts.JsxOpeningElement =>
      (ts.isJsxSelfClosingElement(node) || ts.isJsxOpeningElement(node)) && /Toaster|Sonner/.test(node.tagName.getText()),
    );
    expect(toasters.map((node) => node.tagName.getText())).toEqual(["Toaster"]);
    expect(importsOf(join(ROOT, "src/App.tsx"))).toContain("@/components/ui/sonner");
  });

  it.each([
    ["src/hooks/papers/useBulkMutations.ts", ["Bulk import complete", "Keywords updated"]],
    ["src/hooks/papers/usePaperMutations.ts", ["Paper deleted"]],
    ["src/hooks/useSynonymPool.ts", ["Synonym group deleted"]],
  ])("%s notifies through useToast()", (repoPath, titles) => {
    const imports = importsOf(join(ROOT, repoPath));
    expect(imports).toContain("@/hooks/use-toast");
    expect(imports).not.toContain("sonner");
    const strings = stringsOf(repoPath);
    for (const title of titles) expect(strings).toContain(title);
  });
});
