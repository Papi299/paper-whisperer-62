// PubMed EFetch XML fixtures, hand-built in the shape of the PubMed DTD
// (https://dtd.nlm.nih.gov/ncbi/pubmed/out/pubmed_250101.dtd). No PubMed
// request is made. Element order follows the DTD's sequences, notably
//
//   PubmedData (History?, PublicationStatus, ArticleIdList, ObjectList?, ReferenceList*)
//   Reference  (Citation, ArticleIdList?)

/** One `ArticleId` element. `value` is written as-is, so XML escapes are the caller's. */
export const articleId = (idType: string, value: string): string =>
  `<ArticleId IdType="${idType}">${value}</ArticleId>`;

/** One cited work, optionally with its own identifiers. */
export const reference = (citation: string, ids: string[] = []): string =>
  "<Reference>" +
  `<Citation>${citation}</Citation>` +
  (ids.length > 0 ? `<ArticleIdList>${ids.join("")}</ArticleIdList>` : "") +
  "</Reference>";

/** A `ReferenceList` holding the given references and nested lists. */
export const referenceList = (...items: string[]): string =>
  `<ReferenceList><Title>References</Title>${items.join("")}</ReferenceList>`;

export interface PubmedArticleParts {
  pmid?: string;
  title?: string;
  abstract?: string;
  /** Elements after `Pagination` inside `Article`, e.g. `ELocationID`s. */
  articleExtras?: string;
  /** Elements after `PMID` inside `MedlineCitation`'s tail, e.g. `CommentsCorrectionsList`. */
  citationExtras?: string;
  /** `ArticleId`s for the article's own `ArticleIdList`, after its PMID entry. */
  ownIds?: string[];
  /** Raw XML between the own `ArticleIdList` and the references, e.g. an `ObjectList`. */
  afterOwnIds?: string;
  /** Raw `ReferenceList` elements. */
  referenceLists?: string[];
  /** The DTD makes `PubmedData` optional: `PubmedArticle (MedlineCitation, PubmedData?)`. */
  withoutPubmedData?: boolean;
}

/** One `PubmedArticle` record. */
export function pubmedArticle(parts: PubmedArticleParts = {}): string {
  const pmid = parts.pmid ?? "11111111";
  const pubmedData = parts.withoutPubmedData
    ? ""
    : [
        "  <PubmedData>",
        '    <History><PubMedPubDate PubStatus="pubmed"><Year>2024</Year><Month>1</Month><Day>2</Day></PubMedPubDate></History>',
        "    <PublicationStatus>ppublish</PublicationStatus>",
        "    <ArticleIdList>",
        `      ${articleId("pubmed", pmid)}`,
        ...(parts.ownIds ?? []).map((id) => `      ${id}`),
        "    </ArticleIdList>",
        ...(parts.afterOwnIds ? [`    ${parts.afterOwnIds}`] : []),
        ...(parts.referenceLists ?? []).map((list) => `    ${list}`),
        "  </PubmedData>",
      ].join("\n");
  return [
    "<PubmedArticle>",
    '  <MedlineCitation Status="MEDLINE" Owner="NLM">',
    `    <PMID Version="1">${pmid}</PMID>`,
    '    <Article PubModel="Print-Electronic">',
    "      <Journal>",
    '        <JournalIssue CitedMedium="Internet"><Volume>1</Volume><PubDate><Year>2024</Year><Month>Jan</Month></PubDate></JournalIssue>',
    "        <Title>Journal of Fixtures</Title>",
    "      </Journal>",
    `      <ArticleTitle>${parts.title ?? "A synthetic article"}</ArticleTitle>`,
    "      <Pagination><MedlinePgn>1-10</MedlinePgn></Pagination>",
    ...(parts.articleExtras ? [`      ${parts.articleExtras}`] : []),
    `      <Abstract><AbstractText>${parts.abstract ?? "A synthetic abstract."}</AbstractText></Abstract>`,
    "      <Language>eng</Language>",
    '      <PublicationTypeList><PublicationType UI="D016428">Journal Article</PublicationType></PublicationTypeList>',
    "    </Article>",
    "    <MedlineJournalInfo><Country>England</Country><MedlineTA>J Fix</MedlineTA></MedlineJournalInfo>",
    ...(parts.citationExtras ? [`    ${parts.citationExtras}`] : []),
    "  </MedlineCitation>",
    ...(pubmedData ? [pubmedData] : []),
    "</PubmedArticle>",
  ].join("\n");
}

/** A whole EFetch response holding the given records. */
export function efetchDocument(...records: string[]): string {
  return [
    '<?xml version="1.0" ?>',
    '<!DOCTYPE PubmedArticleSet PUBLIC "-//NLM//DTD PubMedArticle, 1st January 2025//EN" "https://dtd.nlm.nih.gov/ncbi/pubmed/out/pubmed_250101.dtd">',
    "<PubmedArticleSet>",
    ...records,
    "</PubmedArticleSet>",
  ].join("\n");
}

/** The cited DOI used by the critical fixture. */
export const CITED_DOI = "10.1000/CITED";

/**
 * The critical case: the article states no DOI of its own (a PMID and a PII
 * only), and one of its references carries {@link CITED_DOI}.
 */
export const OWN_NO_DOI_CITES_DOI = efetchDocument(
  pubmedArticle({
    ownIds: [articleId("pii", "S0000-0000(24)00001-1")],
    referenceLists: [
      referenceList(
        reference("Cited A. An earlier study. J Fix. 2020;1:1-2.", [
          articleId("doi", CITED_DOI),
          articleId("pubmed", "22222222"),
        ]),
      ),
    ],
  }),
);
