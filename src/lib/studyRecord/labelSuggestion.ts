/**
 * The study name suggested when a study record is started
 * (EVIDENCE-RECORDS-001C1; Requirements-001 §E2: "‹first author› ‹year›").
 *
 * Only a convenience for the name field, which the user edits freely. It is a
 * label, not a fact: nothing reads it as evidence, and the study's design,
 * population or identity are never taken from the paper's metadata.
 */

import { codePointLength } from "@/lib/evidence/normalization";
import { STUDY_LABEL_MAX_LENGTH } from "@/lib/evidence/validation";

const INITIALS = /^[A-Z]{1,3}$/;

/** A family name from one author string, as the library stores authors. */
export function surnameOf(author: string): string | null {
  const text = author.replace(/ +/g, " ").replace(/^ | $/g, "");
  if (text === "") return null;
  if (text.includes(",")) return text.split(",")[0].replace(/^ | $/g, "") || null;
  const parts = text.split(" ");
  // "Phillips SM" (PubMed style): the initials come last.
  if (parts.length > 1 && INITIALS.test(parts[parts.length - 1])) return parts.slice(0, -1).join(" ");
  return parts[parts.length - 1];
}

function clamp(text: string): string {
  if (codePointLength(text) <= STUDY_LABEL_MAX_LENGTH) return text;
  return Array.from(text).slice(0, STUDY_LABEL_MAX_LENGTH - 1).join("") + "…";
}

/** "Smith 2021", or the paper's title (shortened), or "Study 1" when neither is usable. */
export function suggestStudyLabel(paper: { readonly authors?: readonly string[] | null; readonly year?: number | null; readonly title?: string | null }): string {
  const surname = paper.authors?.length ? surnameOf(paper.authors[0]) : null;
  const year = typeof paper.year === "number" && Number.isInteger(paper.year) ? String(paper.year) : null;
  const byline = [surname, year].filter(Boolean).join(" ");
  if (byline !== "") return clamp(byline);
  const title = paper.title?.replace(/^ +| +$/g, "") ?? "";
  return title !== "" ? clamp(title) : "Study 1";
}
