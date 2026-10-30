import { describe, expect, it, vi } from "vitest";
// The lifecycle's selection module is plain Node ESM (no compile step), imported here
// so the rule that gives each Evidence Records spec its own fixture has coverage of its own.
import {
  assertSelectableArgs,
  EVIDENCE_SPEC_FIXTURES,
  fixturesForFiles,
  isEvidenceRecordsSpec,
  LISTING_PLACEHOLDERS,
  listingArgs,
  listingEnv,
  parseListedFiles,
  resolveSpecSelection,
  SpecSelectionError,
} from "../../scripts/e2e-local-spec-selection.mjs";

/**
 * EVIDENCE-RECORDS-001C2A: which fixtures a local E2E run provisions follows
 * the files Playwright will run — resolved with Playwright's own listing — by
 * exact file. These are pure unit tests: the listing is a stub, and no
 * browser, stack, network or file system is touched. `npm run
 * test:e2e:local:verify-guards` checks the same rule against the real listing.
 */

/** A `--list --reporter=json` report naming `files`, with an environment echo like the real one's. */
const report = (files: readonly string[], errors: readonly unknown[] = []) =>
  JSON.stringify({
    config: { webServer: { env: { VITE_SUPABASE_PUBLISHABLE_KEY: "sb_secret_SHOULD_NEVER_SURFACE", TEST_USER_PASSWORD: "hunter2-SHOULD_NEVER_SURFACE" } } },
    suites: files.map((file) => ({ title: file, file, specs: [], suites: [] })),
    errors,
    stats: {},
  });

describe("the fixture registry", () => {
  it("gives each Evidence Records spec its own fixture, by exact file", () => {
    expect(EVIDENCE_SPEC_FIXTURES).toEqual({
      "study-records.spec.ts": "study-records",
      "study-records-review.spec.ts": "study-records-review",
      "study-records-history.spec.ts": "study-records-history",
      "study-records-source-compare.spec.ts": "study-records-source-compare",
    });
    expect(Object.isFrozen(EVIDENCE_SPEC_FIXTURES)).toBe(true);
  });

  it.each([
    [["global-setup.ts", "study-records.spec.ts"], ["study-records"]],
    [["global-setup.ts", "study-records-review.spec.ts"], ["study-records-review"]],
    [["global-setup.ts", "study-records-review.spec.ts", "study-records.spec.ts"], ["study-records", "study-records-review"]],
    // EVIDENCE-RECORDS-001C2B: the History spec has its own fixture, alone or with the others.
    [["global-setup.ts", "study-records-history.spec.ts"], ["study-records-history"]],
    [
      ["global-setup.ts", "study-records-history.spec.ts", "study-records-review.spec.ts", "study-records.spec.ts"],
      ["study-records", "study-records-history", "study-records-review"],
    ],
    // EVIDENCE-RECORDS-001C2C-A: the source-comparison spec has its own fixture, alone or with the others.
    [["global-setup.ts", "study-records-source-compare.spec.ts"], ["study-records-source-compare"]],
    [
      ["global-setup.ts", "study-records-history.spec.ts", "study-records-review.spec.ts", "study-records-source-compare.spec.ts", "study-records.spec.ts"],
      ["study-records", "study-records-history", "study-records-review", "study-records-source-compare"],
    ],
    [["auth.spec.ts", "account-deletion.spec.ts", "ai-model-settings.spec.ts"], []],
  ])("provisions for %j exactly %j", (files, fixtures) => {
    expect([...fixturesForFiles(files)].sort()).toEqual(fixtures);
  });

  it("refuses an Evidence Records spec it has no fixture for, rather than lending it another's", () => {
    for (const file of [
      "study-records-unregistered.spec.ts",
      "study-records-history-extra.spec.ts",
      "study-records-source-compare-extra.spec.ts",
      "evidence/study-records-history.spec.ts",
      "evidence/study-records-source-compare.spec.ts",
      "evidence/study-records.spec.ts",
      "Study-Records.spec.ts",
      "Study-Records-History.spec.ts",
      "study-records.spec.tsx",
    ]) {
      expect(isEvidenceRecordsSpec(file), file).toBe(true);
      expect(() => fixturesForFiles(["study-records.spec.ts", file]), file).toThrow(SpecSelectionError);
      expect(() => fixturesForFiles([file]), file).toThrow(/has no fixture/);
    }
  });

  it("recognizes the family by file name, in any case and folder, and nothing else", () => {
    expect(isEvidenceRecordsSpec("study-records.spec.ts")).toBe(true);
    expect(isEvidenceRecordsSpec("STUDY-RECORDS-REVIEW.SPEC.TS")).toBe(true);
    expect(isEvidenceRecordsSpec("nested/study-records-x.spec.ts")).toBe(true);
    expect(isEvidenceRecordsSpec("my-study-records.spec.ts")).toBe(false);
    expect(isEvidenceRecordsSpec("study-records/helper.ts")).toBe(false);
    expect(isEvidenceRecordsSpec("paper-comparison.spec.ts")).toBe(false);
  });
});

describe("the listing", () => {
  it("passes the run's own arguments, unchanged, after --list --reporter=json", () => {
    const args = ["e2e/study-records.spec.ts", "e2e/study-records-review.spec.ts", "--grep", "R1 ·", "--project=chromium"];
    expect(listingArgs(args)).toEqual(["--no-install", "playwright", "test", "--list", "--reporter=json", ...args]);
  });

  it("refuses the arguments the resolver owns", () => {
    for (const arg of ["--list", "--reporter", "--reporter=html", "--help", "-h"]) {
      expect(() => assertSelectableArgs(["e2e/auth.spec.ts", arg]), arg).toThrow(SpecSelectionError);
    }
    expect(() => assertSelectableArgs(["e2e/auth.spec.ts", "--grep", "list"])).not.toThrow();
    expect(() => assertSelectableArgs([42 as unknown as string])).toThrow(SpecSelectionError);
  });

  it("runs with inert placeholders and PATH, HOME and CI only — never the parent's credentials", () => {
    const env = listingEnv({
      PATH: "/usr/bin",
      HOME: "/home/runner",
      CI: "true",
      VITE_SUPABASE_URL: "https://lioxtgiputfniqbktcsz.supabase.co",
      VITE_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_real",
      SUPABASE_SERVICE_ROLE_KEY: "service-role-real",
      E2E_STUDY_OWNER_PASSWORD: "real-password",
      TEST_USER_PASSWORD: "real-password",
      PLAYWRIGHT_JSON_OUTPUT_FILE: "/tmp/report.json",
      GITHUB_TOKEN: "ghs_real",
    });
    expect(env).toEqual({ ...LISTING_PLACEHOLDERS, PATH: "/usr/bin", HOME: "/home/runner", CI: "true" });
    // The placeholders satisfy the config's guard: local mode, a loopback target, nothing real.
    expect(LISTING_PLACEHOLDERS.E2E_BACKEND_MODE).toBe("local");
    expect(new URL(LISTING_PLACEHOLDERS.VITE_SUPABASE_URL).hostname).toBe("127.0.0.1");
    expect(LISTING_PLACEHOLDERS.E2E_EXPECTED_SUPABASE_URL).toBe(LISTING_PLACEHOLDERS.VITE_SUPABASE_URL);
    expect(JSON.stringify(LISTING_PLACEHOLDERS)).not.toMatch(/lioxtgiputfniqbktcsz|sb_publishable_|sb_secret_|eyJ/);
    expect(listingEnv({})).toEqual({ ...LISTING_PLACEHOLDERS });
  });

  it("reads only the suites' files from a report, sorted and once each", () => {
    expect(parseListedFiles(report(["study-records.spec.ts", "global-setup.ts", "study-records.spec.ts", "nested\\x.spec.ts"]))).toEqual([
      "global-setup.ts",
      "nested/x.spec.ts",
      "study-records.spec.ts",
    ]);
  });

  it.each([
    ["no JSON at all", "Error: something went wrong", /could not be read/],
    ["JSON that is not a report", JSON.stringify({ suites: "x" }), /not a report/],
    ["a suite without a file", JSON.stringify({ suites: [{ title: "x" }], errors: [] }), /without a file/],
    ["no tests found", report([], [{ message: "Error: No tests found" }]), /No tests match/],
    ["any other error", report([], [{ message: "SyntaxError: invalid regular expression /study-records(/" }]), /could not list/],
  ])("fails closed on %s, with a fixed message", (_label, stdout, message) => {
    expect(() => parseListedFiles(stdout)).toThrow(message);
  });
});

describe("resolveSpecSelection", () => {
  it("lists with the run's arguments and the inert environment, and returns the files and their fixtures", async () => {
    const run = vi.fn(async () => ({ code: 0, out: report(["global-setup.ts", "study-records-review.spec.ts"]), err: "" }));
    const selection = await resolveSpecSelection({ specArgs: ["review"], run, baseEnv: { PATH: "/bin", SECRET: "x" } });
    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith("npx", listingArgs(["review"]), { ...LISTING_PLACEHOLDERS, PATH: "/bin" });
    expect(selection.files).toEqual(["global-setup.ts", "study-records-review.spec.ts"]);
    expect([...selection.fixtures]).toEqual(["study-records-review"]);
  });

  it("fails closed — before any fixture — on a failed listing, an empty one, or an unknown Evidence Records spec", async () => {
    const cases: [{ code: number; out: string; err: string }, RegExp][] = [
      [{ code: 1, out: report([], [{ message: "Error: No tests found" }]), err: "" }, /No tests match/],
      [{ code: 1, out: "", err: "boom" }, /could not be read/],
      [{ code: 1, out: report(["auth.spec.ts"]), err: "" }, /could not list the selected tests \(exit 1\)/],
      [{ code: 0, out: report([]), err: "" }, /No tests match/],
      [{ code: 0, out: report(["global-setup.ts", "study-records-zzz.spec.ts"]), err: "" }, /study-records-zzz\.spec\.ts" has no fixture/],
    ];
    for (const [result, message] of cases) {
      await expect(resolveSpecSelection({ specArgs: ["e2e/study-records"], run: async () => result, baseEnv: {} })).rejects.toThrow(message);
    }
  });

  it("never puts the listing's output, which echoes the environment, into an error", async () => {
    const secretOut = report(["study-records-unknown.spec.ts"], [{ message: "SHOULD_NEVER_SURFACE in an error" }]);
    for (const out of [secretOut, `${secretOut}trailing`, report(["study-records-unknown.spec.ts"])]) {
      const error = await resolveSpecSelection({ specArgs: ["x"], run: async () => ({ code: 0, out, err: "SHOULD_NEVER_SURFACE" }), baseEnv: {} }).catch((e: Error) => e);
      expect(error).toBeInstanceOf(SpecSelectionError);
      expect(String((error as Error).message)).not.toMatch(/SHOULD_NEVER_SURFACE|hunter2|sb_secret/);
    }
  });

  it("refuses its own flags before listing anything", async () => {
    const run = vi.fn();
    await expect(resolveSpecSelection({ specArgs: ["--list"], run, baseEnv: {} })).rejects.toThrow(SpecSelectionError);
    expect(run).not.toHaveBeenCalled();
  });
});
