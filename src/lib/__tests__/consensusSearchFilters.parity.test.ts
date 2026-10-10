/**
 * Parity between the Edge Function's Consensus filter contract and the
 * browser's (CONSENSUS-ADVANCED-FILTERS-001A).
 *
 * `supabase/functions/_shared/consensusSearch.ts` decides, at the Edge, which
 * filters a search may carry. `src/lib/consensusSearchFilters.ts` mirrors that
 * contract so the panel can explain a problem before Search is pressed. The two
 * live in separate deployment domains, so the vocabulary and the bounds exist
 * twice — the arrangement `consensusSearchBoundaries.parity.test.ts` already
 * pins for the DOI and link boundaries. This suite pins the filter copies: the
 * same allowlist, the same years, and every browser-accepted draft accepted by
 * the Edge with an identical result.
 */

import { describe, it, expect } from "vitest";

import {
  CONSENSUS_FILTER_MIN_YEAR as BROWSER_MIN_YEAR,
  CONSENSUS_STUDY_TYPES as BROWSER_STUDY_TYPES,
  EMPTY_CONSENSUS_FILTER_DRAFT,
  consensusFilterMaxYear as browserMaxYear,
  validateConsensusFilterDraft,
  type ConsensusFilterDraft,
} from "@/lib/consensusSearchFilters";
import {
  CONSENSUS_FILTER_MIN_YEAR as EDGE_MIN_YEAR,
  CONSENSUS_STUDY_TYPES as EDGE_STUDY_TYPES,
  consensusFilterMaxYear as edgeMaxYear,
  validateConsensusSearchRequest,
} from "../../../supabase/functions/_shared/consensusSearch.ts";

const NOW = new Date("2026-10-10T12:00:00Z");

const DRAFTS: Array<[string, Partial<ConsensusFilterDraft>]> = [
  ["nothing set", {}],
  ["the full set", { yearMin: "2020", yearMax: "2026", studyTypes: ["rct", "meta-analysis"], human: true, excludePreprints: true }],
  ["a start year", { yearMin: "1900" }],
  ["an end year at the ceiling", { yearMax: "2027" }],
  ["one year", { yearMin: "2001", yearMax: "2001" }],
  ["every design", { studyTypes: ["cohort study", "systematic review", "meta-analysis", "rct"] }],
  ["human only", { human: true }],
  ["no preprints", { excludePreprints: true }],
  ["unchecked booleans", { human: false, excludePreprints: false }],
];

/** Year text the browser refuses, and the number the Edge would receive for it. */
const REFUSED_YEARS: Array<[string, number]> = [
  ["1899", 1899],
  ["2028", 2028],
  ["0", 0],
  ["20", 20],
  ["2020.5", 2020.5],
  ["99999", 99999],
];

describe("Consensus filters — browser ↔ Edge parity", () => {
  it("both allowlists are the same values, in the same order", () => {
    expect([...BROWSER_STUDY_TYPES]).toEqual([...EDGE_STUDY_TYPES]);
  });

  it("both apply the same year floor and the same UTC ceiling", () => {
    expect(BROWSER_MIN_YEAR).toBe(EDGE_MIN_YEAR);
    for (const instant of ["2026-01-01T00:00:00Z", "2026-12-31T23:59:59Z", "2027-01-01T00:00:00Z", "2099-06-15T12:00:00Z"]) {
      expect(browserMaxYear(new Date(instant))).toBe(edgeMaxYear(new Date(instant)));
    }
  });

  it.each(DRAFTS)("a browser-accepted draft (%s) is a body the Edge accepts, with identical filters", (_label, overrides) => {
    const checked = validateConsensusFilterDraft({ ...EMPTY_CONSENSUS_FILTER_DRAFT, ...overrides }, browserMaxYear(NOW));
    expect(checked.ok).toBe(true);
    if (!checked.ok) return;

    const body = JSON.parse(JSON.stringify({ query: "x", ...checked.filters })) as unknown;
    const edge = validateConsensusSearchRequest(body, { now: NOW });
    expect(edge).toEqual({ ok: true, request: { query: "x", ...checked.filters } });
  });

  it.each(REFUSED_YEARS)("year %s, refused by the browser, is refused by the Edge too", (text, number) => {
    const maxYear = browserMaxYear(NOW);
    expect(validateConsensusFilterDraft({ ...EMPTY_CONSENSUS_FILTER_DRAFT, yearMin: text }, maxYear).ok).toBe(false);
    expect(validateConsensusSearchRequest({ query: "x", yearMin: number }, { now: NOW }).ok).toBe(false);
  });

  it("a reversed range is refused on both sides", () => {
    const maxYear = browserMaxYear(NOW);
    expect(validateConsensusFilterDraft({ ...EMPTY_CONSENSUS_FILTER_DRAFT, yearMin: "2024", yearMax: "2020" }, maxYear).ok).toBe(
      false,
    );
    expect(validateConsensusSearchRequest({ query: "x", yearMin: 2024, yearMax: 2020 }, { now: NOW }).ok).toBe(false);
  });
});
