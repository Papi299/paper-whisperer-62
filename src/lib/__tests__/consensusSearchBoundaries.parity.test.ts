/**
 * Parity between the Edge Function's Consensus boundaries and the browser's.
 *
 * `supabase/functions/_shared/consensusSearch.ts` decides, at the Edge, which
 * upstream DOI becomes an `importDoi` and which upstream URL becomes a
 * `consensusUrl`. `src/lib/searchConsensusEdge.ts` re-applies both decisions in
 * the browser before a row can be selected or a link rendered. The deployed
 * function and the bundled application are separate bundling and deployment
 * domains, so the rules exist twice — the same arrangement the DOI resolver
 * recognisers have (`doiIdentifiers.parity.test.ts`).
 *
 * Two copies allowed to drift are worse than one, so this suite pins them to
 * identical answers over one corpus: a vector added here is asserted against
 * both. The Edge module is imported read-only; it has no Deno API, no remote
 * import and no network call.
 */

import { describe, it, expect } from "vitest";

import { toImportableDoi, toSafeConsensusUrl } from "@/lib/searchConsensusEdge";
import {
  toImportDoi as edgeToImportDoi,
  toSafeConsensusUrl as edgeToSafeConsensusUrl,
} from "../../../supabase/functions/_shared/consensusSearch.ts";

const DOI_VECTORS: Array<[string, unknown]> = [
  ["bare DOI", "10.5555/consensus-mvp.0001"],
  ["upper case preserved", "10.5555/ABC.Def"],
  ["parentheses", "10.5555/ijx.3(47).2025.3516"],
  ["slashes in the suffix", "10.5555/a/b/c"],
  ["reserved punctuation", "10.5555/a;b:c<d>e#f?g%20h"],
  ["non-ASCII letters", "10.5555/Á.GUTIÉRREZ"],
  ["prefix only", "10.5555"],
  ["prefix and slash", "10.5555/"],
  ["wrong directory", "11.5555/x"],
  ["doi: form", "doi:10.5555/x"],
  ["DOI: form", "DOI: 10.5555/x"],
  ["resolver URL", "https://doi.org/10.5555/x"],
  ["dx resolver URL", "https://dx.doi.org/10.5555/x"],
  ["scheme-less resolver", "doi.org/10.5555/x"],
  ["leading space", " 10.5555/x"],
  ["trailing space", "10.5555/x "],
  ["interior space", "10.5555/a b"],
  ["tab", "10.5555/a\tb"],
  ["newline", "10.5555/a\nb"],
  ["NUL", "10.5555/a\u0000b"],
  ["C1 control", "10.5555/a\u0085b"],
  ["RTL override", "10.5555/a‮b"],
  ["zero-width space", "10.5555/a​b"],
  ["BOM", "﻿10.5555/x"],
  ["no-break space", "10.5555/a b"],
  ["lone surrogate", "10.5555/a\ud800"],
  ["valid astral character", "10.5555/a\u{1F600}b"],
  ["500 characters", "10.5555/" + "x".repeat(492)],
  ["501 characters", "10.5555/" + "x".repeat(493)],
  ["empty", ""],
  ["title", "Creatine and cognition"],
  ["null", null],
  ["undefined", undefined],
  ["number", 10.5555],
  ["object", { doi: "10.5555/x" }],
];

const URL_VECTORS: Array<[string, unknown]> = [
  ["audited shape", "https://consensus.app/papers/slug/0123456789abcdef0123456789abcdef/?utm_source=publicapi"],
  ["upper-case host", "https://CONSENSUS.APP/papers/x/"],
  ["http", "http://consensus.app/papers/x/"],
  ["look-alike host", "https://consensus.app.evil.example/papers/x/"],
  ["foreign host with real URL in query", "https://evil.example/?u=https://consensus.app/papers/x/"],
  ["www subdomain", "https://www.consensus.app/papers/x/"],
  ["credentials", "https://user:pass@consensus.app/papers/x/"],
  ["port", "https://consensus.app:8443/papers/x/"],
  ["non-paper path", "https://consensus.app/search/?q=x"],
  ["traversal", "https://consensus.app/papers/../logout"],
  ["javascript", "javascript:alert(1)"],
  ["data", "data:text/html,x"],
  ["relative", "/papers/x/"],
  ["scheme-relative", "//consensus.app/papers/x/"],
  ["surrounding whitespace", "  https://consensus.app/papers/x/  "],
  ["2048 characters", "https://consensus.app/papers/" + "x".repeat(2048 - 29)],
  ["2049 characters", "https://consensus.app/papers/" + "x".repeat(2049 - 29)],
  ["empty", ""],
  ["null", null],
  ["number", 7],
];

describe("Consensus DOI boundary — Edge and browser agree", () => {
  it.each(DOI_VECTORS)("%s", (_label, value) => {
    expect(toImportableDoi(value)).toBe(edgeToImportDoi(value));
  });

  it("the corpus exercises both outcomes", () => {
    const accepted = DOI_VECTORS.filter(([, value]) => edgeToImportDoi(value) !== null).length;
    expect(accepted).toBeGreaterThanOrEqual(5);
    expect(DOI_VECTORS.length - accepted).toBeGreaterThanOrEqual(20);
  });
});

describe("Consensus link boundary — Edge and browser agree", () => {
  it.each(URL_VECTORS)("%s", (_label, value) => {
    expect(toSafeConsensusUrl(value)).toBe(edgeToSafeConsensusUrl(value));
  });

  it("the corpus exercises both outcomes", () => {
    const accepted = URL_VECTORS.filter(([, value]) => edgeToSafeConsensusUrl(value) !== null).length;
    expect(accepted).toBeGreaterThanOrEqual(3);
    expect(URL_VECTORS.length - accepted).toBeGreaterThanOrEqual(12);
  });
});
