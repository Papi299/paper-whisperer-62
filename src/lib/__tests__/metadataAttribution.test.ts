import { describe, it, expect } from "vitest";
import { attributeToRequestedIdentifiers, type AttributableResult } from "../metadataAttribution";

/**
 * `fetch-paper-metadata` labels a record found on PubMed's path with its PMID,
 * whatever was requested. These pin how each result is reported back under the
 * identifier that was actually requested — by label, then DOI equivalence, then
 * PMID — and that nothing is guessed when no requested identifier matches.
 */

function result(identifier: string, overrides: Partial<AttributableResult> = {}): AttributableResult {
  return { identifier, doi: null, pmid: null, ...overrides };
}

const labels = (requested: string[], results: AttributableResult[]) =>
  attributeToRequestedIdentifiers(requested, results).map((entry) => entry.identifier);

describe("attributeToRequestedIdentifiers", () => {
  it("keeps a result under its own label when that label was requested", () => {
    expect(labels(["12345678", "10.5555/x"], [result("12345678"), result("10.5555/x", { doi: "10.5555/x" })])).toEqual([
      "12345678",
      "10.5555/x",
    ]);
  });

  it("matches a label the server trimmed", () => {
    expect(labels(["  10.5555/x  "], [result("10.5555/x")])).toEqual(["  10.5555/x  "]);
  });

  it("reports a DOI resolved on PubMed's path under the requested DOI, not the PMID", () => {
    // fetchFromPubMed answers `identifier: pmid`; the record's own DOI is
    // equivalent to the requested one (here it differs in ASCII case only).
    expect(labels(["10.5555/Consensus.1"], [result("31415926", { pmid: "31415926", doi: "10.5555/consensus.1" })])).toEqual([
      "10.5555/Consensus.1",
    ]);
  });

  it.each([
    ["the doi: form", "doi:10.5555/x"],
    ["the DOI: form", "DOI: 10.5555/x"],
    ["a resolver URL", "https://doi.org/10.5555/x"],
  ])("matches a PubMed-path DOI result to %s that was requested", (_label, requested) => {
    expect(labels([requested], [result("31415926", { pmid: "31415926", doi: "10.5555/x" })])).toEqual([requested]);
  });

  it("matches a PubMed record URL to the PMID-labelled result it produced", () => {
    const url = "https://pubmed.ncbi.nlm.nih.gov/31415926/";
    expect(labels([url], [result("31415926", { pmid: "31415926" })])).toEqual([url]);
  });

  it("attributes by content, never by position", () => {
    expect(
      labels(
        ["12345678", "10.5555/b"],
        [result("77777777", { pmid: "77777777", doi: "10.5555/B" }), result("12345678", { pmid: "12345678" })],
      ),
    ).toEqual(["10.5555/b", "12345678"]);
  });

  it("claims each requested identifier at most once", () => {
    // The same DOI requested twice yields two PubMed-path results.
    const rows = [result("31415926", { pmid: "31415926", doi: "10.5555/x" }), result("31415926", { pmid: "31415926", doi: "10.5555/x" })];
    expect(labels(["10.5555/x", "10.5555/X"], rows)).toEqual(["10.5555/x", "10.5555/X"]);
  });

  it("lets genuine labels win before any inference", () => {
    // The second result is the PMID that was requested; the first is a DOI's
    // record that happens to carry the same PMID. The genuine label is matched
    // in the first pass, the DOI's record by its DOI in the second.
    const rows = [result("12345678", { pmid: "12345678", doi: "10.5555/same" }), result("12345678", { pmid: "12345678", doi: "10.5555/same" })];
    expect(labels(["10.5555/same", "12345678"], rows).sort()).toEqual(["10.5555/same", "12345678"]);
  });

  it("keeps the record's own label when nothing requested matches — e.g. a title resolved on PubMed", () => {
    expect(labels(["Creatine and cognition"], [result("31415926", { pmid: "31415926", doi: "10.5555/x" })])).toEqual(["31415926"]);
  });

  it("does not match DOIs that are not equivalent (ASCII case is the only fold)", () => {
    expect(labels(["10.5555/Á"], [result("31415926", { pmid: "31415926", doi: "10.5555/á" })])).toEqual(["31415926"]);
  });

  it("ignores an empty or absent DOI and PMID", () => {
    expect(labels(["10.5555/x"], [result("31415926", { doi: "", pmid: null })])).toEqual(["31415926"]);
  });

  it("returns the result objects themselves, untouched and in result order", () => {
    const rows = [result("31415926", { pmid: "31415926", doi: "10.5555/x" })];
    const [entry] = attributeToRequestedIdentifiers(["10.5555/x"], rows);
    expect(entry.meta).toBe(rows[0]);
    expect(entry.meta.identifier).toBe("31415926");
  });
});
