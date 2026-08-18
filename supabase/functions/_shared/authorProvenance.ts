/**
 * Structured authorship provenance — Edge Function copy of the contract.
 *
 * The application's authoritative definition lives at
 * `src/lib/authorProvenance.ts`; this is the Edge-side copy, for the same
 * module-graph reason `orcid.ts` is duplicated here. Shape and semantics are
 * identical, and the Edge response is asserted field-by-field against fixtures
 * so the two cannot drift.
 *
 * The invariant both copies exist to hold:
 *
 *   Provenance records what a source stated. It does not convert
 *   similar-looking names into a shared human identity.
 *
 * An ORCID captured here is therefore a value PubMed or Crossref supplied for
 * one authorship mention — not a resolved person, and not a licence to merge
 * two mentions that happen to carry it.
 *
 * Alignment is the contract that makes the data usable: the emitted array runs
 * one-to-one, in order, with the `authors` string array in the same response.
 * A source path that cannot produce a complete aligned array emits `null`
 * instead of a partial one, because once the indexes stop mapping onto
 * `authors`, every entry describes the wrong mention.
 */

import { deriveCanonicalOrcid } from "./orcid.ts";

export type AuthorProvenanceKind = "personal" | "collective" | "unknown";

// Type aliases rather than interfaces, matching the application copy: these are
// closed JSON payloads, and keeping the two declarations textually parallel is
// the point of a deliberately duplicated contract.
export type AuthorIdentifierProvenance = {
  scheme: string;
  value: string;
};

export type AuthorProvenance = {
  source: string;
  source_field: string | null;
  kind: AuthorProvenanceKind;
  source_name: string;
  given_name: string | null;
  family_name: string | null;
  initials: string | null;
  suffix: string | null;
  collective_name: string | null;
  affiliations: string[];
  identifiers: AuthorIdentifierProvenance[];
  orcid: string | null;
  orcid_authenticated: boolean | null;
};

/** Trimmed, blank-free, order-preserving, exact-duplicate-free affiliation text. */
export function cleanAffiliations(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const trimmed = value.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    result.push(trimmed);
  }
  return result;
}

/**
 * Identifier provenance, cleaned. An entry survives only when the source
 * supplied both a non-blank authority and a non-blank value — half an
 * identifier cannot be represented honestly.
 */
export function cleanIdentifiers(
  values: readonly { scheme: string; value: string }[],
): AuthorIdentifierProvenance[] {
  const result: AuthorIdentifierProvenance[] = [];
  for (const { scheme, value } of values) {
    const cleanScheme = scheme.trim();
    const cleanValue = value.trim();
    if (!cleanScheme || !cleanValue) continue;
    result.push({ scheme: cleanScheme, value: cleanValue });
  }
  return result;
}

/**
 * Build one provenance entry, defaulting every field the caller did not
 * establish. `orcid` is derived from the cleaned identifiers rather than
 * accepted from the caller, so no extractor can place an ORCID its own
 * identifier provenance does not support.
 */
export function makeAuthorProvenance(fields: {
  source: string;
  source_field?: string | null;
  kind: AuthorProvenanceKind;
  source_name: string;
  given_name?: string | null;
  family_name?: string | null;
  initials?: string | null;
  suffix?: string | null;
  collective_name?: string | null;
  affiliations?: readonly string[];
  identifiers?: readonly { scheme: string; value: string }[];
  orcid_authenticated?: boolean | null;
}): AuthorProvenance {
  const identifiers = cleanIdentifiers(fields.identifiers ?? []);
  const orcid = deriveCanonicalOrcid(identifiers);
  return {
    source: fields.source,
    source_field: fields.source_field ?? null,
    kind: fields.kind,
    source_name: fields.source_name,
    given_name: fields.given_name ?? null,
    family_name: fields.family_name ?? null,
    initials: fields.initials ?? null,
    suffix: fields.suffix ?? null,
    collective_name: fields.collective_name ?? null,
    affiliations: cleanAffiliations(fields.affiliations ?? []),
    identifiers,
    orcid,
    // An assertion flag qualifies an ORCID; with no derived ORCID there is
    // nothing for it to be an assertion about.
    orcid_authenticated: orcid === null ? null : fields.orcid_authenticated ?? null,
  };
}
