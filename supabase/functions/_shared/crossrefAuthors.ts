/**
 * Crossref contributor extraction: the compatibility author list and the
 * structured provenance behind it, produced together from one pass.
 *
 * ## What the provider contract guarantees
 *
 * The authority is the Crossref REST API works schema's contributor object. The
 * fields this module reads, and only these, are ones it documents:
 *
 *   given, family, suffix, ORCID, authenticated-orcid, affiliation[]
 *
 * Deliberate omissions:
 *
 *  • `name` — Crossref's field for an organizational contributor. The existing
 *    compatibility projection builds a name only from `given`/`family`, so a
 *    contributor carrying only `name` produces an empty string and is dropped.
 *    Reading it here would *add* authors the application does not show today,
 *    which is a change to the display projection rather than added provenance.
 *    Left alone, and reported as future scope.
 *  • `sequence`, `prefix`, `role` — position is already carried by array order,
 *    and the other two are not authorship identity.
 *  • affiliation identifiers (ROR/ISNI on newer records) — those identify the
 *    *institution*, not the author. Promoting one into an author's identifier
 *    list would manufacture identity evidence the source never asserted, the
 *    same trap the PubMed extractor avoids with nested `AffiliationInfo`
 *    identifiers.
 *
 * Nothing here resolves people: two Crossref contributors carrying the same
 * ORCID stay two independent statements.
 */

import {
  type AuthorProvenance,
  makeAuthorProvenance,
} from "./authorProvenance.ts";

/** Stable source identifier for the Crossref REST path. */
export const CROSSREF_API_SOURCE = "crossref_api";

/** The contributor fields this module reads, all optional in the provider contract. */
interface CrossrefContributor {
  given?: unknown;
  family?: unknown;
  suffix?: unknown;
  ORCID?: unknown;
  "authenticated-orcid"?: unknown;
  affiliation?: unknown;
}

export interface CrossrefAuthorExtraction {
  /** The compatibility projection — unchanged from the previous implementation. */
  authors: string[];
  /**
   * Structured provenance aligned one-to-one with `authors`, or `null` when the
   * record yielded no usable authors.
   */
  author_provenance: AuthorProvenance[] | null;
}

/** A provider string field, or `null` when absent or not a string. */
function optionalString(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

/**
 * Affiliation names in source order. Only the documented `name` property is
 * read; an entry without one contributes nothing rather than being rendered
 * from whatever else the object holds.
 */
function affiliationNames(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const names: string[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue;
    const name = (entry as { name?: unknown }).name;
    if (typeof name === "string" && name.trim() !== "") names.push(name);
  }
  return names;
}

/**
 * Read every contributor out of a Crossref `work`, in source order.
 *
 * The returned `authors` array is exactly what the previous inline
 * implementation produced: `` `${given ?? ""} ${family ?? ""}`.trim() ``, with
 * empty results dropped. A contributor that yields no usable name is skipped in
 * BOTH arrays, so one partial contributor can never shift provenance out of
 * alignment with the authors it describes.
 */
export function extractCrossrefAuthors(work: {
  author?: unknown;
}): CrossrefAuthorExtraction {
  const contributors = Array.isArray(work.author)
    ? (work.author as CrossrefContributor[])
    : [];

  const authors: string[] = [];
  const provenance: AuthorProvenance[] = [];

  for (const contributor of contributors) {
    if (!contributor || typeof contributor !== "object") continue;

    const given = optionalString(contributor.given);
    const family = optionalString(contributor.family);

    // The pre-existing projection, character for character.
    const sourceName = `${given ?? ""} ${family ?? ""}`.trim();
    if (!sourceName) continue;

    // Crossref states its own ORCID as a URI. It is kept verbatim as raw
    // identifier provenance; the canonical form is derived (and validated) from
    // it rather than assumed.
    const rawOrcid = optionalString(contributor.ORCID);
    const identifiers = rawOrcid ? [{ scheme: "ORCID", value: rawOrcid }] : [];

    // Only a boolean the provider actually supplied. `undefined`, a string
    // "true", or the mere presence of an ORCID never becomes `true` here.
    const assertion = contributor["authenticated-orcid"];
    const orcidAuthenticated = typeof assertion === "boolean" ? assertion : null;

    authors.push(sourceName);
    provenance.push(
      makeAuthorProvenance({
        source: CROSSREF_API_SOURCE,
        source_field: "author",
        // `given`/`family` are Crossref's personal-name fields, so personhood
        // is established by the contract — not by how the name reads.
        kind: "personal",
        source_name: sourceName,
        given_name: given,
        family_name: family,
        // Crossref has no initials field; nothing is derived from `given`.
        suffix: optionalString(contributor.suffix),
        affiliations: affiliationNames(contributor.affiliation),
        identifiers,
        orcid_authenticated: orcidAuthenticated,
      }),
    );
  }

  return {
    authors,
    author_provenance: provenance.length > 0 ? provenance : null,
  };
}
