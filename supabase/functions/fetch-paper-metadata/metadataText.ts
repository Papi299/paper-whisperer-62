/**
 * The title and abstract text `fetch-paper-metadata` returns, read out of the
 * providers' markup (CODEQL-EDGE-TEXT-EXTRACTION-001).
 *
 * Pure, with no Deno APIs and no remote imports, so Vitest and Deno import the
 * exact functions the request handler calls. `index.ts` keeps the provider
 * calls and the response shape; only these three readings moved here.
 *
 * ## The representation they return
 *
 * Each returns the field's character data with the markup removed and the
 * references still written as references (`&amp;`, `&lt;`, `&#x3B1;`), which is
 * what this function has always returned for these fields: the client's
 * `normalizePaperData` decodes the title and the abstract, once. These readings
 * therefore never decode. A CDATA section's text, and a stray `<` or `&`, come
 * back escaped, so that the client's one decoding pass gives the literal text;
 * see `../_shared/xmlText.ts`.
 *
 * ## What they select
 *
 * Unchanged: the first `ArticleTitle` element; every `AbstractText` element in
 * document order, joined with one space, labels not included; Crossref's
 * `abstract` string. Only how the text is read out of each changed.
 */

import { xmlCharacterData, xmlElementContents } from "../_shared/xmlText.ts";

/**
 * The text of the first `ArticleTitle` element of a PubMed EFetch document,
 * or `undefined` when the document has none. `ArticleTitle` is
 * `(%text; | mml:math)*` in the PubMed DTD, so its markup is inline: removed
 * without inserting anything.
 */
export function pubmedArticleTitle(xml: string): string | undefined {
  const [source] = xmlElementContents(xml, "ArticleTitle", 1);
  return source === undefined ? undefined : xmlCharacterData(source);
}

/**
 * The text of every `AbstractText` element of a PubMed EFetch document — a
 * structured abstract's sections — joined with one space, or `null` when there
 * is none. `AbstractText` is `(%text; | mml:math | DispFormula)*`, so markup
 * inside a section is inline; the section boundary is the space. Each section is
 * kept exactly as read, white space included, and an empty element still
 * contributes its separator, as before.
 */
export function pubmedAbstract(xml: string): string | null {
  const sections = xmlElementContents(xml, "AbstractText");
  return sections.length > 0 ? sections.map((section) => xmlCharacterData(section)).join(" ") : null;
}

/**
 * JATS elements that are blocks rather than inline markup — sections, titles,
 * labels, paragraphs, lists, definition lists, display formulas, quotes,
 * statements, boxes, figures, tables and their captions, verse — plus the
 * `<break/>` line break. Crossref writes them with the `jats:` prefix; they are
 * matched by local name. Inline elements (`italic`, `bold`, `sub`, `sup`, `sc`,
 * `xref`, `inline-formula`, MathML…) are deliberately absent, so `CO<sub>2</sub>`
 * stays `CO2`.
 */
export const JATS_BLOCK_ELEMENTS: ReadonlySet<string> = new Set([
  "abstract",
  "trans-abstract",
  "sec",
  "title",
  "label",
  "p",
  "list",
  "list-item",
  "def-list",
  "def-item",
  "term",
  "def",
  "disp-quote",
  "disp-formula",
  "disp-formula-group",
  "statement",
  "boxed-text",
  "fig",
  "fig-group",
  "caption",
  "table-wrap",
  "table-wrap-group",
  "speech",
  "verse-group",
  "verse-line",
  "address",
  "preformat",
  "ack",
  "break",
]);

/**
 * The text of a Crossref work's `abstract`: a JATS fragment (`<jats:title>`,
 * `<jats:p>`, `<jats:sec>`…) or plain text. A JATS block boundary separates
 * words — one space is written where removing the tag would otherwise join two
 * words, and nowhere else, so an abstract whose blocks are already separated by
 * white space reads exactly as before. Trimmed; `null` when nothing remains.
 *
 * The parameter is typed as the provider contract states it; `index.ts` passes
 * `(work.abstract as string) || ""`, exactly as before.
 */
export function crossrefAbstract(rawAbstract: string): string | null {
  return xmlCharacterData(rawAbstract, { wordBoundaries: JATS_BLOCK_ELEMENTS }).trim() || null;
}
