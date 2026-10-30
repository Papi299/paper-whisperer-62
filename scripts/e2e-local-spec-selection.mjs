// @ts-nocheck
/**
 * Which spec files a local E2E run executes, and which Evidence Records
 * fixture each needs (EVIDENCE-RECORDS-001C2A; the History spec joined in
 * 001C2B, the source-comparison spec in 001C2C-A).
 *
 * Playwright treats every positional argument as a case-insensitive regular
 * expression over each test file's path (`new RegExp(arg, "gi")`, Playwright
 * 1.58 `util.js`), so a spec argument does not name a file: `study-records`
 * runs every `study-records*` spec, `E2E/Study-Records.spec.ts` runs the C1
 * spec, and `review` runs the review spec. Choosing fixtures by a substring of
 * the arguments therefore disagrees with what runs, in both directions. This
 * module asks Playwright itself instead — `playwright test --list
 * --reporter=json` with the run's own arguments — and maps the files it will
 * run to the fixtures they own:
 *
 *   * a registry keyed by exact file (`EVIDENCE_SPEC_FIXTURES`): each Evidence
 *     Records spec has its own fixture, accounts and post-run proof;
 *   * an Evidence Records spec (`study-records*`, any case, any folder) that is
 *     not in the registry fails closed before anything is provisioned — it is
 *     never given another spec's fixture;
 *   * a listing that cannot be read fails closed, with a fixed message.
 *
 * SECRETS. Playwright's JSON report echoes the configuration it loaded —
 * including the web server's environment, so every environment value the
 * listing process has. The listing therefore runs with an explicit, minimal
 * environment: inert placeholders that satisfy the config's loopback guard
 * (no real key, password or address), plus only `PATH`, `HOME` and `CI`. Its
 * output is captured and parsed in memory, only the suites' file names are
 * kept, and nothing of it is ever printed, written or put in an error.
 *
 * Pure apart from `resolveSpecSelection`, which runs the listing through the
 * caller's capture function (the lifecycle's `runCapture`), so the rest is
 * unit-tested without a browser, a stack or a network (e2e/support/
 * spec-selection.test.ts).
 */

/**
 * The Evidence Records specs and the fixture each owns, keyed by the file
 * path Playwright reports (relative to `e2e/`). The account-deletion and AI
 * model fixtures of the general lane are not here: they keep their own rules.
 */
export const EVIDENCE_SPEC_FIXTURES = Object.freeze({
  "study-records.spec.ts": "study-records",
  "study-records-review.spec.ts": "study-records-review",
  "study-records-history.spec.ts": "study-records-history",
  "study-records-source-compare.spec.ts": "study-records-source-compare",
});

/** Inert values the Playwright config's guard accepts. None is a credential; none reaches a backend. */
export const LISTING_PLACEHOLDERS = Object.freeze({
  E2E_BACKEND_MODE: "local",
  E2E_EXPECTED_SUPABASE_URL: "http://127.0.0.1:54321",
  VITE_SUPABASE_URL: "http://127.0.0.1:54321",
  VITE_SUPABASE_PUBLISHABLE_KEY: "e2e-listing-inert-placeholder",
  TEST_USER_EMAIL: "e2e-listing-inert@paperlume.test",
  TEST_USER_PASSWORD: "e2e-listing-inert-placeholder",
});

/** The only variables the listing inherits: enough to find Node and npx, and whether this is CI (`forbidOnly`). */
const INHERITED = Object.freeze(["PATH", "HOME", "CI"]);

export class SpecSelectionError extends Error {
  constructor(message) {
    super(message);
    this.name = "SpecSelectionError";
  }
}

/** Whether a file Playwright reports belongs to the Evidence Records family: its name starts with `study-records`. */
export function isEvidenceRecordsSpec(file) {
  return typeof file === "string" && /(^|\/)study-records[^/]*$/i.test(file);
}

/** Refuse the arguments the resolver owns: it lists, and it reads JSON. */
export function assertSelectableArgs(specArgs) {
  if (!Array.isArray(specArgs) || specArgs.some((arg) => typeof arg !== "string")) {
    throw new SpecSelectionError("Spec arguments must be strings.");
  }
  for (const arg of specArgs) {
    if (arg === "--list" || arg === "--reporter" || arg.startsWith("--reporter=") || arg === "--help" || arg === "-h") {
      throw new SpecSelectionError(`"${arg}" can't be passed to the local E2E run: it decides which fixtures to provision by listing the tests itself.`);
    }
  }
}

/** The listing command's arguments: the run's own, after `--list --reporter=json`. */
export function listingArgs(specArgs) {
  return ["--no-install", "playwright", "test", "--list", "--reporter=json", ...specArgs];
}

/** The listing's whole environment: the placeholders, and `PATH`, `HOME` and `CI` from `baseEnv`. */
export function listingEnv(baseEnv = {}) {
  const env = { ...LISTING_PLACEHOLDERS };
  for (const key of INHERITED) if (typeof baseEnv[key] === "string") env[key] = baseEnv[key];
  return env;
}

/**
 * The test files in a `--list --reporter=json` answer, relative to the test
 * directory, sorted and unique. Throws a fixed message — never any of the
 * output — when the answer is not a readable report, or reports an error.
 */
export function parseListedFiles(stdout) {
  let report;
  try {
    report = JSON.parse(stdout);
  } catch {
    throw new SpecSelectionError("Playwright's test list could not be read; refusing to provision fixtures.");
  }
  if (!report || typeof report !== "object" || !Array.isArray(report.suites) || !Array.isArray(report.errors)) {
    throw new SpecSelectionError("Playwright's test list is not a report this runner reads; refusing to provision fixtures.");
  }
  if (report.errors.length > 0) {
    const noTests = report.errors.some((error) => typeof error?.message === "string" && /no tests found/i.test(error.message));
    throw new SpecSelectionError(
      noTests ? "No tests match the given spec arguments." : "Playwright could not list the selected tests; refusing to provision fixtures.",
    );
  }
  const files = report.suites.map((suite) => (suite && typeof suite.file === "string" && suite.file !== "" ? suite.file.split("\\").join("/") : null));
  if (files.some((file) => file === null)) {
    throw new SpecSelectionError("Playwright's test list names a suite without a file; refusing to provision fixtures.");
  }
  return [...new Set(files)].sort();
}

/**
 * The Evidence Records fixtures `files` need, as a set of fixture names.
 * An Evidence Records spec without a registered fixture fails closed.
 */
export function fixturesForFiles(files) {
  const fixtures = new Set();
  for (const file of files) {
    if (!isEvidenceRecordsSpec(file)) continue;
    const fixture = Object.prototype.hasOwnProperty.call(EVIDENCE_SPEC_FIXTURES, file) ? EVIDENCE_SPEC_FIXTURES[file] : undefined;
    if (!fixture) {
      throw new SpecSelectionError(
        `Evidence Records spec "${file}" has no fixture in scripts/e2e-local-spec-selection.mjs; refusing to run it with another spec's fixture.`,
      );
    }
    fixtures.add(fixture);
  }
  return fixtures;
}

/**
 * Resolve what a run with `specArgs` will execute, with Playwright's own
 * matcher, before any stack or fixture exists. `run(cmd, args, env)` must
 * capture stdout and stderr and resolve to `{ code, out, err }`; neither is
 * ever printed. Resolves to the files and the Evidence Records fixtures.
 */
export async function resolveSpecSelection({ specArgs, run, baseEnv = process.env }) {
  assertSelectableArgs(specArgs);
  const result = await run("npx", listingArgs(specArgs), listingEnv(baseEnv));
  // A nonzero exit with a readable report says why (no tests, a bad pattern); anything else is a fixed refusal.
  const files = parseListedFiles(result?.out ?? "");
  if (result?.code !== 0) throw new SpecSelectionError(`Playwright could not list the selected tests (exit ${result?.code}); refusing to provision fixtures.`);
  if (files.length === 0) throw new SpecSelectionError("No tests match the given spec arguments.");
  return Object.freeze({ files: Object.freeze(files), fixtures: fixturesForFiles(files) });
}
