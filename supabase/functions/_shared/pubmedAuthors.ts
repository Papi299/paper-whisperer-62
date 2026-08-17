/**
 * PubMed authorship extraction: the compatibility author list and the
 * structured provenance behind it, produced together from one pass.
 *
 * ## What the source guarantees
 *
 * The authority is the NLM PubMed DTD's content model for `Author`:
 *
 *   Author (((LastName, ForeName?, Initials?, Suffix?) | CollectiveName),
 *           Identifier*, AffiliationInfo*)
 *   AffiliationInfo (Affiliation, Identifier*)
 *   Identifier (#PCDATA)   with Source CDATA #REQUIRED
 *
 * Three consequences drive this file:
 *
 *  1. Personal and collective authorship are an **exclusive choice** in the
 *     grammar, so `kind` is read off the structure rather than guessed from
 *     wording. A `<CollectiveName>` is collective because the source said so —
 *     never because the text contains "Consortium" or "Group".
 *  2. `ForeName` is **optional**, and the existing compatibility projection only
 *     emits a personal author when both `LastName` and `ForeName` are present.
 *     That behavior is preserved exactly, and provenance is appended only for
 *     authors actually emitted — which is what keeps the two arrays aligned.
 *  3. `Identifier` occurs in **two** places: directly under `Author` (the
 *     author's own identifiers, e.g. `Source="ORCID"`) and nested inside
 *     `AffiliationInfo` (the *institution's* identifiers, e.g. GRID/ISNI).
 *     Scanning the whole author block would silently promote an institutional
 *     identifier into author identity provenance, so affiliation blocks are
 *     removed before author identifiers are read.
 *
 * Nothing here resolves people. A checksum-valid ORCID is recorded because
 * PubMed stated it for that mention; two mentions carrying the same ORCID
 * remain two independent statements.
 */

import {
  type AuthorProvenance,
  makeAuthorProvenance,
} from "./authorProvenance.ts";
import { decodeHTMLEntities } from "./htmlEntities.ts";

/** Stable source identifier for the PubMed E-utilities path. */
export const PUBMED_API_SOURCE = "pubmed_api";

/**
 * One `<Author>` element's body.
 *
 * Deliberately the pre-existing pattern, character for character. It is bounded
 * by the FIRST `</Author>` so it can never span siblings, and the loop it
 * drives produces exactly today's author list. (`<Author[^>]*>` also matches the
 * opening `<AuthorList>` tag, which makes the first match cover the wrapper plus
 * the first author — harmless, because the first author's fields are inside it
 * and every later author matches on its own tag. Preserved rather than
 * "fixed", so the compatibility projection is provably unchanged.)
 */
const AUTHOR_BLOCK = /<Author[^>]*>([\s\S]*?)<\/Author>/g;

/** A whole `<AffiliationInfo>` element — removed before author identifiers are read. */
const AFFILIATION_INFO_BLOCK = /<AffiliationInfo[^>]*>[\s\S]*?<\/AffiliationInfo>/g;

/** `<Affiliation>` text, which the DTD allows to contain markup. */
const AFFILIATION = /<Affiliation[^>]*>([\s\S]*?)<\/Affiliation>/g;

/**
 * `<Identifier Source="…">value</Identifier>`. `Source` is `#REQUIRED`, so an
 * element without one is malformed and contributes nothing rather than being
 * given an invented authority. Both quote styles are accepted because XML
 * permits either.
 */
const IDENTIFIER = /<Identifier[^>]*\sSource=["']([^"']*)["'][^>]*>([\s\S]*?)<\/Identifier>/g;

const COLLECTIVE_NAME = /<CollectiveName[^>]*>([\s\S]*?)<\/CollectiveName>/;
const LAST_NAME = /<LastName>([^<]+)<\/LastName>/;
const FORE_NAME = /<ForeName>([^<]+)<\/ForeName>/;
const INITIALS = /<Initials>([^<]+)<\/Initials>/;
const SUFFIX = /<Suffix>([^<]+)<\/Suffix>/;

/** Strip any nested markup, decode entities, trim. Used for mixed-content text. */
function plainText(value: string): string {
  return decodeHTMLEntities(value.replace(/<[^>]+>/g, "")).trim();
}

export interface PubMedAuthorExtraction {
  /** The compatibility projection — unchanged from the previous implementation. */
  authors: string[];
  /**
   * Structured provenance aligned one-to-one with `authors`, or `null` when the
   * record yielded no authors at all.
   */
  author_provenance: AuthorProvenance[] | null;
}

/**
 * Read every author out of a PubMed EFetch XML record, in source order.
 *
 * The returned `authors` array is byte-for-byte what the previous inline
 * implementation produced: a `<CollectiveName>` (tags stripped, entities
 * decoded, trimmed) takes precedence, otherwise `${foreName} ${lastName}` — and
 * only when both are present. `author_provenance[i]` describes `authors[i]`.
 */
export function extractPubMedAuthors(xml: string): PubMedAuthorExtraction {
  const authors: string[] = [];
  const provenance: AuthorProvenance[] = [];

  for (const block of xml.matchAll(AUTHOR_BLOCK)) {
    const body = block[1];

    // Affiliations belong to the author; the identifiers *inside* an
    // AffiliationInfo belong to the institution. Read the affiliations, then
    // read author identifiers from a body with those blocks removed.
    const affiliations: string[] = [];
    for (const affiliation of body.matchAll(AFFILIATION)) {
      const text = plainText(affiliation[1]);
      if (text) affiliations.push(text);
    }

    const authorLevel = body.replace(AFFILIATION_INFO_BLOCK, "");
    const identifiers: { scheme: string; value: string }[] = [];
    for (const identifier of authorLevel.matchAll(IDENTIFIER)) {
      identifiers.push({ scheme: identifier[1], value: plainText(identifier[2]) });
    }

    // ── Collective author ──
    // Precedence preserved exactly: a usable CollectiveName ends this block.
    const collectiveName = plainText(body.match(COLLECTIVE_NAME)?.[1] ?? "");
    if (collectiveName) {
      authors.push(collectiveName);
      provenance.push(
        makeAuthorProvenance({
          source: PUBMED_API_SOURCE,
          source_field: "CollectiveName",
          kind: "collective",
          source_name: collectiveName,
          // A collective name is an organization's name, not a person's. It is
          // never parsed into given/family components.
          collective_name: collectiveName,
          affiliations,
          identifiers,
        }),
      );
      continue;
    }

    // ── Personal author ──
    const lastName = body.match(LAST_NAME)?.[1];
    const foreName = body.match(FORE_NAME)?.[1];
    if (!lastName || !foreName) continue;

    // The exact string the compatibility projection has always emitted — not
    // entity-decoded here, because the previous implementation did not decode
    // it either and `source_name` records the source's own representation
    // before Paperlume's normalization runs.
    const sourceName = `${foreName} ${lastName}`;
    authors.push(sourceName);
    provenance.push(
      makeAuthorProvenance({
        source: PUBMED_API_SOURCE,
        source_field: "Author",
        // The DTD makes personal-vs-collective an exclusive structural choice,
        // so this is read from the grammar, not inferred from the name.
        kind: "personal",
        source_name: sourceName,
        given_name: foreName,
        family_name: lastName,
        initials: body.match(INITIALS)?.[1] ?? null,
        suffix: body.match(SUFFIX)?.[1] ?? null,
        affiliations,
        identifiers,
      }),
    );
  }

  return {
    authors,
    // No authors means there is nothing for provenance to describe, and an
    // empty array carries no more than absence does.
    author_provenance: provenance.length > 0 ? provenance : null,
  };
}
