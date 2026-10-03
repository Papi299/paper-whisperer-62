// PUBMED-OWN-DOI-EXTRACTION-HARDENING-001 — the DOI a PubMed record states for
// the article itself, never a DOI belonging to one of its cited references.
//
// Fixtures are hand-built in the shape of the PubMed DTD (see
// ./fixtures/pubmedEfetchXml.ts); no PubMed or any other network request is made.

import { describe, it, expect } from "vitest";
import { extractPubMedArticleDoi } from "../pubmedArticleIdentifiers.ts";
import {
  CITED_DOI,
  OWN_NO_DOI_CITES_DOI,
  articleId,
  efetchDocument,
  pubmedArticle,
  reference,
  referenceList,
  type PubmedArticleParts,
} from "./fixtures/pubmedEfetchXml.ts";

const doc = (parts: PubmedArticleParts) => efetchDocument(pubmedArticle(parts));

describe("extractPubMedArticleDoi — the article's own ArticleIdList only", () => {
  it("A: returns the article's own DOI, not a different cited DOI", () => {
    const xml = doc({
      ownIds: [articleId("doi", "10.1000/OWN")],
      referenceLists: [referenceList(reference("Cited A.", [articleId("doi", CITED_DOI)]))],
    });
    expect(extractPubMedArticleDoi(xml)).toBe("10.1000/OWN");
  });

  it("B: returns null when only a cited reference carries a DOI", () => {
    // Guard the fixture itself: the cited DOI really is in a Reference, and the
    // article's own identifier list really has no DOI. Without both, this test
    // would pass vacuously.
    const own = OWN_NO_DOI_CITES_DOI.slice(
      OWN_NO_DOI_CITES_DOI.indexOf("<PubmedData>"),
      OWN_NO_DOI_CITES_DOI.indexOf("<ReferenceList>"),
    );
    expect(own).toContain("<ArticleIdList>");
    expect(own).not.toContain('IdType="doi"');
    expect(OWN_NO_DOI_CITES_DOI).toContain(`<Reference><Citation>Cited A. An earlier study.`);
    expect(OWN_NO_DOI_CITES_DOI).toContain(`<ArticleId IdType="doi">${CITED_DOI}</ArticleId>`);

    expect(extractPubMedArticleDoi(OWN_NO_DOI_CITES_DOI)).toBeNull();
  });

  it("C: decodes XML entities in the article's DOI with the shared decoder", () => {
    const own = (escaped: string) => extractPubMedArticleDoi(doc({ ownIds: [articleId("doi", escaped)] }));
    expect(own("10.1000/a&amp;b")).toBe("10.1000/a&b");
    // A SICI-style DOI: XML must escape `<`, and PubMed escapes `>` too.
    expect(own("10.1002/(SICI)1097-4636(199706)35:4&lt;425::AID-JBM4&gt;3.0.CO;2-H")).toBe(
      "10.1002/(SICI)1097-4636(199706)35:4<425::AID-JBM4>3.0.CO;2-H",
    );
    expect(own("10.1000/a&#38;b")).toBe("10.1000/a&b");
    expect(own("10.1000/a&#x26;b")).toBe("10.1000/a&b");
    // A doubly escaped ampersand stays the literal text `&amp;`.
    expect(own("10.1000/a&amp;amp;b")).toBe("10.1000/a&amp;b");
  });

  it("D: ignores any number of references, including nested ReferenceLists", () => {
    const references = [
      referenceList(
        reference("Cited A.", [articleId("doi", "10.1000/CITED-A")]),
        reference("Cited B, no identifiers."),
        reference("Cited C.", [articleId("pubmed", "33333333"), articleId("doi", "10.1000/CITED-C")]),
        referenceList(reference("Nested D.", [articleId("doi", "10.1000/CITED-D")])),
      ),
      referenceList(reference("Second list E.", [articleId("doi", "10.1000/CITED-E")])),
    ];
    expect(extractPubMedArticleDoi(doc({ ownIds: [articleId("doi", "10.1000/OWN")], referenceLists: references }))).toBe(
      "10.1000/OWN",
    );
    expect(extractPubMedArticleDoi(doc({ referenceLists: references }))).toBeNull();
  });

  it("E: never reads a DOI from the title, abstract, ELocationID or citation notes", () => {
    const elsewhere: PubmedArticleParts = {
      title: "Replication of 10.1000/IN-TITLE",
      abstract: 'See doi:10.1000/IN-ABSTRACT and &lt;ArticleId IdType="doi"&gt;10.1000/ESCAPED&lt;/ArticleId&gt;.',
      articleExtras: '<ELocationID EIdType="doi" ValidYN="Y">10.1000/ELOCATION</ELocationID>',
      citationExtras:
        '<CommentsCorrectionsList><CommentsCorrections RefType="CommentOn"><RefSource>Other J. 2020. doi: 10.1000/COMMENT</RefSource></CommentsCorrections></CommentsCorrectionsList>',
    };
    expect(extractPubMedArticleDoi(doc(elsewhere))).toBeNull();
    expect(extractPubMedArticleDoi(doc({ ...elsewhere, ownIds: [articleId("doi", "10.1000/OWN")] }))).toBe("10.1000/OWN");
  });

  it("F: returns null when there is no PubmedData", () => {
    expect(extractPubMedArticleDoi(doc({ withoutPubmedData: true }))).toBeNull();
    // A book record has PubmedBookData, not PubmedData.
    const book =
      "<PubmedBookArticle><BookDocument><PMID>44444444</PMID>" +
      `<ArticleIdList>${articleId("doi", "10.1000/BOOK")}</ArticleIdList></BookDocument>` +
      `<PubmedBookData><PublicationStatus>ppublish</PublicationStatus><ArticleIdList>${articleId("doi", "10.1000/BOOK")}</ArticleIdList></PubmedBookData>` +
      "</PubmedBookArticle>";
    expect(extractPubMedArticleDoi(efetchDocument(book))).toBeNull();
    expect(extractPubMedArticleDoi("")).toBeNull();
    expect(extractPubMedArticleDoi("not xml at all")).toBeNull();
  });

  it("G: preserves the provider's exact spelling, ASCII case included", () => {
    expect(extractPubMedArticleDoi(doc({ ownIds: [articleId("doi", "10.1000/OwN.MiXeD-Case")] }))).toBe(
      "10.1000/OwN.MiXeD-Case",
    );
  });

  it("H: fails closed on conflicting article-level DOIs, keeps one spelling of the same DOI", () => {
    const own = (...dois: string[]) => extractPubMedArticleDoi(doc({ ownIds: dois.map((d) => articleId("doi", d)) }));
    expect(own("10.1000/ONE", "10.1000/TWO")).toBeNull();
    expect(own("10.1000/Same", "10.1000/SAME")).toBe("10.1000/Same");
    expect(own("10.1000/dup", "10.1000/dup")).toBe("10.1000/dup");
    // Equivalence is DOI Handbook 4.3.4: ASCII case only.
    expect(own("10.26321/Á", "10.26321/á")).toBeNull();
  });
});

describe("extractPubMedArticleDoi — structural boundaries", () => {
  it("reads only IdType=\"doi\": a DOI-shaped PII or an untyped ArticleId is not a DOI", () => {
    expect(
      extractPubMedArticleDoi(
        doc({ ownIds: [articleId("pii", "10.1000/LOOKS-LIKE-A-DOI"), "<ArticleId>10.1000/UNTYPED</ArticleId>"] }),
      ),
    ).toBeNull();
  });

  it("accepts a single-quoted IdType attribute", () => {
    expect(extractPubMedArticleDoi(doc({ ownIds: ["<ArticleId IdType='doi'>10.1000/SINGLE</ArticleId>"] }))).toBe(
      "10.1000/SINGLE",
    );
  });

  it("does not trim the DOI text", () => {
    expect(extractPubMedArticleDoi(doc({ ownIds: [articleId("doi", " 10.1000/padded ")] }))).toBe(" 10.1000/padded ");
  });

  it("treats an empty DOI element as no DOI", () => {
    expect(extractPubMedArticleDoi(doc({ ownIds: [articleId("doi", "")] }))).toBeNull();
  });

  it("is not distracted by an ObjectList between the own identifiers and the references", () => {
    const objectList = '<ObjectList><Object Type="keyword"><Param Name="value">x</Param></Object></ObjectList>';
    expect(
      extractPubMedArticleDoi(
        doc({
          ownIds: [articleId("doi", "10.1000/OWN")],
          afterOwnIds: objectList,
          referenceLists: [referenceList(reference("Cited A.", [articleId("doi", CITED_DOI)]))],
        }),
      ),
    ).toBe("10.1000/OWN");
  });

  it("fails closed when the article's ArticleIdList is not where the DTD puts it", () => {
    // ReferenceList before the record's own ArticleIdList violates the DTD
    // sequence, so the record's own identifiers cannot be told apart.
    const misordered = efetchDocument(
      "<PubmedArticle><MedlineCitation><PMID>11111111</PMID></MedlineCitation><PubmedData>" +
        "<PublicationStatus>ppublish</PublicationStatus>" +
        referenceList(reference("Cited A.", [articleId("doi", CITED_DOI)])) +
        `<ArticleIdList>${articleId("doi", "10.1000/OWN")}</ArticleIdList>` +
        "</PubmedData></PubmedArticle>",
    );
    expect(extractPubMedArticleDoi(misordered)).toBeNull();
  });

  it("fails closed when the document holds more than one record", () => {
    const one = pubmedArticle({ pmid: "11111111", ownIds: [articleId("doi", "10.1000/ONE")] });
    const two = pubmedArticle({ pmid: "22222222", ownIds: [articleId("doi", "10.1000/TWO")] });
    expect(extractPubMedArticleDoi(efetchDocument(one, two))).toBeNull();
    const book = "<PubmedBookArticle><BookDocument><PMID>44444444</PMID></BookDocument></PubmedBookArticle>";
    expect(extractPubMedArticleDoi(efetchDocument(one, book))).toBeNull();
  });
});
