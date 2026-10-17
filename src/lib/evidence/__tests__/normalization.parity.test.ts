// @vitest-environment node
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import { normalizeEvidenceV1 } from "../normalization";
import { FIXTURE, FIXTURE_REPO_PATH, FIXTURE_TEXT, readRepoFile } from "./fixtures/vectors";

/**
 * The parity links between TypeScript and the deployed SQL normalizer.
 *
 * Running both implementations on the same vectors happens in two places:
 * `normalization.test.ts` runs normalizeEvidenceV1 on the fixture, and pgTAP
 * suite 032 runs the INSTALLED public.evidence_normalize_v1 on the very same
 * fixture, embedded verbatim. This file pins what makes that a real parity
 * check rather than two unrelated test lists:
 *
 *   1. suite 032 embeds the fixture byte for byte (the drift check of
 *      Requirements-001 §I3);
 *   2. the 30 vectors suite 031 hardcodes as chr() expressions — and the
 *      PR-A2 migration's own $verify$ checks — are evaluated here from the SQL
 *      text itself and must equal the fixture's copies, digests included;
 *   3. normalizeEvidenceV1 gives the SQL-pinned output for each of those
 *      parsed vectors directly, independently of the fixture's transcription.
 *
 * A text search for the function name proves nothing and is not used.
 */

const SUITE_031 = "supabase/tests/database/031_evidence_records_lifecycle.test.sql";
const SUITE_032 = "supabase/tests/database/032_evidence_normalization_parity.test.sql";
const MIGRATION = "supabase/migrations/20261016104232_add_evidence_records_lifecycle_rpcs.sql";

const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

// ── A reader for the SQL text expressions the suites use ─────────────────────
// Grammar: term ('||' term)*, where term is 'literal' (with '' escapes),
// chr(0xHHHH), or '(' expression ')'. Anything else is a parse error.

interface Read {
  readonly value: string;
  readonly end: number;
}

function skipSpace(src: string, at: number): number {
  let i = at;
  while (i < src.length && /\s/.test(src[i])) i += 1;
  return i;
}

function readTerm(src: string, at: number): Read {
  const i = skipSpace(src, at);
  if (src[i] === "'") {
    let value = "";
    let j = i + 1;
    for (;;) {
      if (j >= src.length) throw new Error(`unterminated literal at ${i}`);
      if (src[j] === "'") {
        if (src[j + 1] === "'") {
          value += "'";
          j += 2;
          continue;
        }
        return { value, end: j + 1 };
      }
      value += src[j];
      j += 1;
    }
  }
  const chr = /^chr\(0x([0-9A-Fa-f]+)\)/.exec(src.slice(i));
  if (chr) return { value: String.fromCodePoint(parseInt(chr[1], 16)), end: i + chr[0].length };
  if (src[i] === "(") {
    const inner = readExpression(src, i + 1);
    const close = skipSpace(src, inner.end);
    if (src[close] !== ")") throw new Error(`expected ) at ${close}`);
    return { value: inner.value, end: close + 1 };
  }
  throw new Error(`unexpected SQL at ${i}: ${src.slice(i, i + 20)}`);
}

function readExpression(src: string, at: number): Read {
  let read = readTerm(src, at);
  let value = read.value;
  for (;;) {
    const next = skipSpace(src, read.end);
    if (src.slice(next, next + 2) !== "||") return { value, end: read.end };
    read = readTerm(src, next + 2);
    value += read.value;
  }
}

function expectText(src: string, at: number, text: string): number {
  const i = skipSpace(src, at);
  if (src.slice(i, i + text.length) !== text) throw new Error(`expected "${text}" at ${i}: ${src.slice(i, i + 30)}`);
  return i + text.length;
}

interface PinnedVector {
  readonly id: string;
  readonly title: string;
  readonly input: string;
  readonly expected: string;
}

/** Suite 031 §N: `SELECT is(public.evidence_normalize_v1(<input>), <expected>, 'Nxx <title>: output');` */
function parseSuite031Outputs(sql: string): PinnedVector[] {
  const head = "SELECT is(public.evidence_normalize_v1(";
  const vectors: PinnedVector[] = [];
  for (let at = sql.indexOf(head); at !== -1; at = sql.indexOf(head, at + 1)) {
    const start = at + head.length;
    if (sql.slice(skipSpace(sql, start), skipSpace(sql, start) + 4) === "NULL") continue; // N31, STRICT NULL
    const input = readExpression(sql, start);
    const afterInput = expectText(sql, expectText(sql, input.end, ")"), ",");
    const expected = readExpression(sql, afterInput);
    const label = readTerm(sql, expectText(sql, expected.end, ","));
    const match = /^(N\d\d) (.*): output$/.exec(label.value);
    if (!match) throw new Error(`unexpected label ${label.value}`);
    vectors.push({ id: match[1], title: match[2], input: input.value, expected: expected.value });
  }
  return vectors;
}

/** Suite 031 §N: the SHA-256 assertions, by vector id. */
function parseSuite031Digests(sql: string): Map<string, { input: string; digest: string }> {
  const head = "SELECT is(encode(sha256(convert_to(public.evidence_normalize_v1(";
  const digests = new Map<string, { input: string; digest: string }>();
  for (let at = sql.indexOf(head); at !== -1; at = sql.indexOf(head, at + 1)) {
    const input = readExpression(sql, at + head.length);
    let i = expectText(sql, input.end, ")");
    i = expectText(sql, i, ",");
    i = expectText(sql, i, "'UTF8'))");
    i = expectText(sql, i, ",");
    i = expectText(sql, i, "'hex'),");
    const digest = readTerm(sql, i);
    const label = readTerm(sql, expectText(sql, digest.end, ","));
    const id = /^(N\d\d) .*: SHA-256 of the output$/.exec(label.value)?.[1];
    if (!id) throw new Error(`unexpected label ${label.value}`);
    digests.set(id, { input: input.value, digest: digest.value });
  }
  return digests;
}

/** The migration's $verify$ block: `public.evidence_normalize_v1(<input>) IS DISTINCT FROM <expected>`. */
function parseMigrationChecks(sql: string): { input: string; expected: string }[] {
  const block = sql.slice(sql.indexOf("DO $verify$"), sql.lastIndexOf("$verify$;"));
  const head = "public.evidence_normalize_v1(";
  const checks: { input: string; expected: string }[] = [];
  for (let at = block.indexOf(head); at !== -1; at = block.indexOf(head, at + 1)) {
    const start = at + head.length;
    if (block.slice(skipSpace(block, start), skipSpace(block, start) + 4) === "NULL") continue;
    const input = readExpression(block, start);
    const afterCall = expectText(block, input.end, ")");
    const distinct = skipSpace(block, afterCall);
    if (!block.startsWith("IS DISTINCT FROM", distinct)) continue; // a call that is not a check
    const expected = readExpression(block, distinct + "IS DISTINCT FROM".length);
    checks.push({ input: input.value, expected: expected.value });
  }
  return checks;
}

describe("suite 032 embeds the shared fixture verbatim", () => {
  const sql = readRepoFile(SUITE_032);

  it("has exactly one dollar-quoted fixture block", () => {
    expect(sql.split("$fixture$")).toHaveLength(3);
    expect(FIXTURE_TEXT.includes("$fixture$")).toBe(false);
  });

  it("holds the fixture file byte for byte", () => {
    const start = sql.indexOf("$fixture$") + "$fixture$".length;
    const embedded = sql.slice(start, sql.indexOf("$fixture$", start));
    // On failure: replace everything between the two tags in the suite with
    // the exact contents of the fixture file.
    expect(embedded === FIXTURE_TEXT, `${SUITE_032} must embed ${FIXTURE_REPO_PATH} exactly`).toBe(true);
  });

  it("is printable ASCII, so it can hide no invisible character", () => {
    expect(/^[\x20-\x7e\n]*$/.test(sql)).toBe(true);
    expect(/^[\x20-\x7e\n]*$/.test(FIXTURE_TEXT)).toBe(true);
  });

  it("runs the installed function on every normalization and matching vector", () => {
    expect(sql).toContain("public.evidence_normalize_v1(nv.input)");
    expect(sql).toContain("public.evidence_normalize_v1(public.evidence_normalize_v1(nv.input))");
    expect(sql).toContain("public.evidence_normalize_v1(mv.quote)");
    expect(sql).toContain("public.evidence_normalize_v1(mv.snapshot)");
    expect(sql).toMatch(/SELECT plan\(\s*4\s*\+ \(SELECT 3 \* count\(\*\)::integer \+ count\(second_pass\)::integer FROM nv\)\s*\+ \(SELECT 2 \* count\(\*\)::integer FROM mv\)\);/);
  });
});

describe("suite 031's golden vectors are the fixture's N01-N30", () => {
  const sql = readRepoFile(SUITE_031);
  const pinned = parseSuite031Outputs(sql);
  const digests = parseSuite031Digests(sql);
  const byId = new Map(FIXTURE.normalization.map((v) => [v.id, v]));

  it("parses exactly the 30 pinned vectors and their 30 digests", () => {
    expect(pinned.map((v) => v.id)).toEqual(Array.from({ length: 30 }, (_, i) => `N${String(i + 1).padStart(2, "0")}`));
    expect(digests.size).toBe(30);
  });

  it.each(pinned.map((v) => [v.id, v] as const))("%s matches the fixture, digest included", (id, vector) => {
    const copy = byId.get(id);
    expect(copy?.origin).toBe("suite-031");
    expect(copy?.title).toBe(vector.title);
    expect(copy?.input).toBe(vector.input);
    expect(copy?.expected).toBe(vector.expected);
    expect(digests.get(id)?.input).toBe(vector.input);
    expect(copy?.expected_sha256).toBe(digests.get(id)?.digest);
  });

  it.each(pinned.map((v) => [v.id, v] as const))("%s: TypeScript gives the SQL-pinned output", (id, vector) => {
    expect(normalizeEvidenceV1(vector.input)).toBe(vector.expected);
    expect(sha256(normalizeEvidenceV1(vector.input))).toBe(digests.get(id)?.digest);
  });
});

describe("the PR-A2 migration's own self-check is the fixture's V01-V06", () => {
  const checks = parseMigrationChecks(readRepoFile(MIGRATION));
  const fixtureChecks = FIXTURE.normalization.filter((v) => v.origin === "migration-verify");

  it("parses its six normalization checks", () => {
    expect(checks).toHaveLength(6);
  });

  it("holds each of them, in order", () => {
    expect(fixtureChecks.map((v) => ({ input: v.input, expected: v.expected }))).toEqual(checks);
  });

  it.each(checks.map((c, i) => [i + 1, c] as const))("check %i: TypeScript gives the migration's expected output", (_n, check) => {
    expect(normalizeEvidenceV1(check.input)).toBe(check.expected);
  });
});
