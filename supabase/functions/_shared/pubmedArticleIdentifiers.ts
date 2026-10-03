/**
 * The DOI a PubMed EFetch record states for the article itself.
 *
 * PUBMED-OWN-DOI-EXTRACTION-HARDENING-001. `fetchFromPubMed` used to take the
 * first `<ArticleId IdType="doi">` anywhere in the EFetch XML. The PubMed DTD
 * (https://dtd.nlm.nih.gov/ncbi/pubmed/out/pubmed_250101.dtd) puts an
 * `ArticleIdList` in four places, and two of them describe *other* works:
 *
 *   PubmedArticle     (MedlineCitation, PubmedData?)
 *   PubmedData        (History?, PublicationStatus, ArticleIdList, ObjectList?, ReferenceList*)
 *   ReferenceList     (Title?, Reference*, ReferenceList*)
 *   Reference         (Citation, ArticleIdList?)
 *
 * So a record whose own `ArticleIdList` has no DOI can still carry DOIs in its
 * references, and a global first match then returns a cited paper's DOI as
 * this article's. That value is persisted, and since DOI-PUBMED-MATCH-HARDENING-001
 * it is also the evidence `doiLookup.ts` compares with the requested DOI: a
 * candidate that merely *cites* the requested DOI would pass as that paper.
 *
 * Only the `ArticleIdList` that is a direct child of the record's `PubmedData`
 * is read here. Everything else (references, abstracts, titles, `ELocationID`,
 * comments) is never consulted, and nothing substitutes for a missing DOI.
 *
 * Pure, with no Deno APIs or remote imports, so Vitest tests it directly.
 */

import { decodeHTMLEntities } from "./htmlEntities.ts";
import { doiNamesAreEquivalent } from "./identifierDetection.ts";

/** One `PubmedArticle` element. The DTD does not nest them. */
const PUBMED_ARTICLE = /<PubmedArticle(?:\s[^>]*)?>([\s\S]*?)<\/PubmedArticle>/;

/** Every record a `PubmedArticleSet` can hold: `(PubmedArticle | PubmedBookArticle)+`. */
const PUBMED_RECORD_OPEN = /<Pubmed(?:Book)?Article(?:\s[^>]*)?>/g;

/** The record's `PubmedData`, which the DTD does not nest either. */
const PUBMED_DATA = /<PubmedData(?:\s[^>]*)?>([\s\S]*?)<\/PubmedData>/;

/**
 * Where `PubmedData` stops describing the article itself. `PubmedData` is a
 * DTD *sequence*, so its own `ArticleIdList` always precedes `ObjectList` and
 * `ReferenceList`. Cutting at the first of those makes every reference
 * unreachable, however deeply `ReferenceList`s nest.
 */
const PUBMED_DATA_TAIL = /<(?:ObjectList|ReferenceList)[\s>/]/;

const ARTICLE_ID_LIST = /<ArticleIdList(?:\s[^>]*)?>([\s\S]*?)<\/ArticleIdList>/g;

/**
 * A DOI identifier. `ArticleId` is `#PCDATA`, so its text holds no markup.
 * An `ArticleId` without `IdType` defaults to `pubmed` in the DTD, so only an
 * explicit `IdType="doi"` counts.
 */
const DOI_ARTICLE_ID = /<ArticleId\s+IdType\s*=\s*(["'])doi\1\s*>([^<]*)<\/ArticleId>/g;

/**
 * Extract the fetched article's own DOI from a PubMed EFetch XML document.
 *
 * - The document must hold exactly one record, and it must be a
 *   `PubmedArticle`. EFetch for one PMID returns one; anything else makes "the
 *   fetched article" ambiguous, so the result is `null`. A `PubmedBookArticle`
 *   has no `PubmedData` and also yields `null`.
 * - Inside that record's `PubmedData`, exactly one `ArticleIdList` must sit
 *   before any `ObjectList`/`ReferenceList`, as the DTD requires.
 * - Each `IdType="doi"` value goes through the shared `decodeHTMLEntities`
 *   once (`10.1000/a&amp;b` → `10.1000/a&b`), the decoder the keyword and
 *   author extraction already use. Its replacements run in sequence, so the
 *   rare `&amp;lt;` comes out as `<` rather than the literal `&lt;`. Nothing
 *   else is changed: no trimming, case folding, percent-decoding or
 *   normalization. Comparing DOIs is `doiNamesAreEquivalent`'s job, not this
 *   parser's.
 * - The DTD does not limit `ArticleIdList` to one DOI. Several DOI entries
 *   that are the same DOI keep the first spelling; DOIs that disagree make
 *   the result `null` rather than picking one.
 *
 * @returns The article's DOI in PubMed's spelling, entity-decoded, or `null`
 *   when the article itself states none.
 */
export function extractPubMedArticleDoi(xml: string): string | null {
  if ((xml.match(PUBMED_RECORD_OPEN) ?? []).length !== 1) return null;

  const article = PUBMED_ARTICLE.exec(xml)?.[1];
  if (article === undefined) return null;

  const pubmedData = PUBMED_DATA.exec(article)?.[1];
  if (pubmedData === undefined) return null;

  const tailStart = pubmedData.search(PUBMED_DATA_TAIL);
  const ownPart = tailStart === -1 ? pubmedData : pubmedData.slice(0, tailStart);

  const lists = [...ownPart.matchAll(ARTICLE_ID_LIST)];
  if (lists.length !== 1) return null;

  const dois = [...lists[0][1].matchAll(DOI_ARTICLE_ID)]
    .map((match) => decodeHTMLEntities(match[2]))
    .filter((doi) => doi.length > 0);
  if (dois.length === 0) return null;

  const [first] = dois;
  return dois.every((doi) => doiNamesAreEquivalent(doi, first)) ? first : null;
}
