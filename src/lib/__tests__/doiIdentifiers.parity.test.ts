/**
 * Parity between the application's DOI resolver-URL recogniser and the Edge
 * Function's.
 *
 * `src/lib/doiIdentifiers.ts` and
 * `supabase/functions/_shared/identifierDetection.ts` implement the same
 * structural classification twice, deliberately: the deployed function and the
 * bundled application are separate bundling and deployment domains, updated by
 * different commands on different cadences. That is the same arrangement PubMed
 * recognition has had since the Edge module was written — and the reason its own
 * suite pins `extractPmidFromPubMedUrl` across the two.
 *
 * Two implementations that are allowed to drift are worse than one, so this file
 * is the pin for the DOI direction: both sides answer the shared corpus in
 * `fixtures/recordUrlVectors.ts` identically, or the suite fails. A vector added
 * for one implementation is therefore automatically asserted against the other.
 *
 * The Edge module is imported read-only. It is pure TypeScript with no Deno
 * API, no remote import and no network call, which is what makes it importable
 * from a Node test at all; nothing here modifies it, and nothing here creates an
 * Edge deployment obligation.
 *
 * No network request is made. The property under test is what each function
 * decides about untrusted text, never what a resolver answers.
 */

import { describe, it, expect } from "vitest";

import { extractDoiFromDoiUrl } from "@/lib/doiIdentifiers";
import { extractDoiFromDoiUrl as edgeExtractDoiFromDoiUrl } from "../../../supabase/functions/_shared/identifierDetection.ts";
import { DOI_RESOLVER_URLS, NON_DOI_URLS } from "./fixtures/recordUrlVectors";

describe("extractDoiFromDoiUrl — accepted resolver URLs", () => {
  it.each(DOI_RESOLVER_URLS)("resolves %s to its DOI name", (_label, value, doi) => {
    expect(extractDoiFromDoiUrl(value)).toBe(doi);
  });
});

describe("extractDoiFromDoiUrl — rejected values", () => {
  it.each(NON_DOI_URLS)("refuses DOI authority to %s", (_label, value) => {
    expect(extractDoiFromDoiUrl(value)).toBeNull();
  });

  it("refuses a non-string", () => {
    expect(extractDoiFromDoiUrl(null)).toBeNull();
    expect(extractDoiFromDoiUrl(undefined)).toBeNull();
    // A caller reading `tab.url` gets `string | undefined`; a runtime value of
    // some other type must fail closed rather than reaching `new URL()`.
    expect(extractDoiFromDoiUrl(12345 as unknown as string)).toBeNull();
  });

  it("refuses an empty or whitespace-only value", () => {
    expect(extractDoiFromDoiUrl("")).toBeNull();
    expect(extractDoiFromDoiUrl("   ")).toBeNull();
  });

  it("does not repair a bare DOI name into a resolver URL", () => {
    // Recognition is for *URLs*. A bare `10.1000/example` is a DOI name, which
    // the importer's own classifier handles; inventing a resolver URL around it
    // here would blur the two directions this module keeps apart.
    expect(extractDoiFromDoiUrl("10.1000/example")).toBeNull();
    expect(extractDoiFromDoiUrl("doi:10.1000/example")).toBeNull();
  });
});

describe("parity with supabase/functions/_shared/identifierDetection.ts", () => {
  const everyVector: readonly string[] = [
    ...DOI_RESOLVER_URLS.map(([, value]) => value),
    ...NON_DOI_URLS.map(([, value]) => value),
  ];

  it.each(everyVector)("agrees with the Edge implementation on %s", (value) => {
    expect(extractDoiFromDoiUrl(value)).toBe(edgeExtractDoiFromDoiUrl(value));
  });

  it("covers every shared DOI vector", () => {
    // Guards against a future edit that empties a corpus and leaves `it.each`
    // asserting nothing — a green suite that proves no parity at all.
    expect(DOI_RESOLVER_URLS.length).toBeGreaterThan(0);
    expect(NON_DOI_URLS.length).toBeGreaterThan(0);
    expect(everyVector.length).toBe(DOI_RESOLVER_URLS.length + NON_DOI_URLS.length);
  });
});

describe("isDoiResolverUrl", () => {
  it("is exactly the predicate form of extractDoiFromDoiUrl", async () => {
    const { isDoiResolverUrl } = await import("@/lib/doiIdentifiers");
    for (const [, value] of DOI_RESOLVER_URLS) {
      expect(isDoiResolverUrl(value)).toBe(true);
    }
    for (const [, value] of NON_DOI_URLS) {
      expect(isDoiResolverUrl(value)).toBe(false);
    }
  });
});
