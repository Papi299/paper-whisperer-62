/**
 * The shared normalization v1 golden fixture, loaded for the Vitest suites.
 *
 * `normalizationV1.vectors.json` is read by these suites AND embedded verbatim
 * in `supabase/tests/database/032_evidence_normalization_parity.test.sql`, so
 * TypeScript and PostgreSQL answer the same vectors. It is printable ASCII:
 * every other character is a JSON \u escape that both JSON.parse and
 * PostgreSQL's jsonb decode.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

export const REPO_ROOT = resolve(HERE, "../../../../..");
export const FIXTURE_PATH = resolve(HERE, "normalizationV1.vectors.json");
export const FIXTURE_REPO_PATH = "src/lib/evidence/__tests__/fixtures/normalizationV1.vectors.json";

export interface NormalizationVector {
  readonly id: string;
  readonly origin: "suite-031" | "migration-verify" | "001b";
  readonly title: string;
  readonly input: string;
  readonly input_code_points: string;
  readonly expected: string;
  readonly expected_sha256: string;
  readonly second_pass?: string;
}

export interface MatchingVector {
  readonly id: string;
  readonly title: string;
  readonly quote: string;
  readonly snapshot: string;
  readonly expected_kind: "invalid" | "not_found" | "unique" | "multiple" | "too_many";
  readonly invalid_problems: readonly string[];
  readonly normalized_quote_length: number;
  readonly expected_normalized: readonly (readonly [number, number])[];
  readonly expected_exact: readonly (readonly [number, number])[];
  readonly expected_exact_snapped: readonly boolean[];
  readonly expected_exact_utf16: readonly (readonly [number, number])[];
}

export interface GoldenFixture {
  readonly fixture: string;
  readonly fixture_version: number;
  readonly normalization_version: string;
  readonly normalization: readonly NormalizationVector[];
  readonly matching: readonly MatchingVector[];
}

export const FIXTURE_TEXT = readFileSync(FIXTURE_PATH, "utf8");
export const FIXTURE = JSON.parse(FIXTURE_TEXT) as GoldenFixture;

export function readRepoFile(path: string): string {
  return readFileSync(resolve(REPO_ROOT, path), "utf8");
}

/** Build a string from code points, so no test source holds an invisible character. */
export const cp = (...codePoints: number[]): string => String.fromCodePoint(...codePoints);

/** "0070 2009 ..." — the fixture's code point notation. */
export const codePointsOf = (text: string): string =>
  Array.from(text, (ch) => (ch.codePointAt(0) as number).toString(16).toUpperCase().padStart(4, "0")).join(" ");
