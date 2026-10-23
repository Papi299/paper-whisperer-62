/**
 * Turning text in the saved abstract into a quote (EVIDENCE-RECORDS-001C1;
 * Requirements-001 §E4, §I4).
 *
 * The browser only ADVISES. `quoteFromSelection` and `locateQuote` (PR-B's
 * matcher) say whether the text occurs in the saved copy and how often, so the
 * user can choose an occurrence before saving. What is sent is the quote text
 * exactly as selected or typed, plus — when it occurs several times — the
 * occurrence the user chose and the count they saw. No offset, count or match
 * time the browser computed is ever sent as a fact: the save RPC matches
 * every new quote itself, against the copy it names, and refuses one that is
 * not found or ambiguous.
 */

import { MAX_SUPPORTING_REFERENCES } from "@/lib/evidence/validation";
import { quoteFromSelection, type AdvisoryQuoteMatch, type QuoteOccurrence } from "@/lib/evidence/matcher";
import { emptyContent, type DraftContent, type DraftValueEdit, type NewReference } from "./draft";
import type { FieldKey } from "@/lib/evidence/fieldDictionary";

export const QUOTE_MESSAGES = {
  invalid: "Quote at least 3 characters, including a letter or number.",
  tooLong: "Quotes from the abstract can be up to 1,000 characters.",
  notFound:
    "This text wasn't found in the saved abstract. Select it directly in the abstract, or add it as a full-text reference if it comes from elsewhere.",
  tooMany: "This text appears more than 100 times in the abstract. Add a few words so it appears fewer times.",
  selection: "Select text inside the saved abstract.",
} as const;

/** What a selection or a typed quote can become. */
export type QuoteChoice =
  | { readonly kind: "ready"; readonly quoteText: string; readonly occurrence: number | null; readonly count: number | null }
  /** Several occurrences, and the selection does not say which: the user chooses. */
  | { readonly kind: "choose"; readonly quoteText: string; readonly occurrences: readonly QuoteOccurrence[] }
  | { readonly kind: "invalid"; readonly message: string };

/** The message for a match that cannot be used, or null when it can. */
export function matchProblem(match: AdvisoryQuoteMatch): string | null {
  switch (match.kind) {
    case "invalid":
      return match.problems.includes("quote_too_long") || match.problems.includes("normalized_too_long") ? QUOTE_MESSAGES.tooLong : QUOTE_MESSAGES.invalid;
    case "not_found":
      return QUOTE_MESSAGES.notFound;
    case "too_many":
      return QUOTE_MESSAGES.tooMany;
    default:
      return null;
  }
}

/** A selection in the saved copy (UTF-16 indices), as a quote. */
export function quoteChoiceFromSelection(copyText: string, selection: { readonly start: number; readonly end: number }): QuoteChoice {
  const quote = quoteFromSelection(copyText, selection);
  if (quote.kind === "invalid_selection") return { kind: "invalid", message: QUOTE_MESSAGES.selection };
  const problem = matchProblem(quote.match);
  if (problem) return { kind: "invalid", message: problem };
  if (quote.match.kind === "unique") return { kind: "ready", quoteText: quote.quoteText, occurrence: null, count: null };
  if (quote.match.kind !== "multiple") return { kind: "invalid", message: QUOTE_MESSAGES.notFound };
  if (quote.selected.kind === "resolved") {
    return { kind: "ready", quoteText: quote.quoteText, occurrence: quote.selected.occurrence.occurrence, count: quote.match.count };
  }
  return { kind: "choose", quoteText: quote.quoteText, occurrences: quote.match.occurrences };
}

export type QuoteApplication =
  | { readonly ok: true; readonly edit: Omit<DraftValueEdit, "expectedValueVersion"> }
  /** `state`: the field's state takes no supporting quote; `limit`: it already has three. */
  | { readonly ok: false; readonly reason: "state" | "limit" };

function prefill(content: DraftContent, text: string): DraftContent {
  switch (content.shape) {
    case "text":
      return content.text === "" ? { shape: "text", text } : content;
    case "integer_with_reported_text":
      // The number itself is never filled in: the user confirms it.
      return content.reportedText === "" ? { ...content, reportedText: text } : content;
    case "text_list":
      return content.entries.every((entry) => entry === "") ? { shape: "text_list", entries: [text] } : content;
    case "code":
      return content;
  }
}

/**
 * Add an abstract quote to a field. A field not yet recorded becomes Reported,
 * and an empty value is prefilled from the selected text (`prefillText`),
 * which stays editable; a Reported or Unclear field keeps its state and its
 * value. Any other state takes no supporting quote: the user changes it first,
 * so nothing they recorded is replaced behind their back.
 */
export function addQuoteToEdit(
  edit: DraftValueEdit,
  fieldKey: FieldKey,
  reference: Extract<NewReference, { purpose: "supports"; sourceKind: "abstract" }>,
  localId: string,
  prefillText: string | null,
): QuoteApplication {
  const notRecorded = edit.cleared || edit.state === null;
  if (!notRecorded && edit.state !== "reported" && edit.state !== "unclear") return { ok: false, reason: "state" };
  const supporting = edit.references.filter((r) => r.reference.purpose === "supports").length;
  if (supporting >= MAX_SUPPORTING_REFERENCES) return { ok: false, reason: "limit" };
  const state = notRecorded ? "reported" : edit.state;
  let content = edit.content;
  if (state === "reported") {
    const start = content ?? emptyContent(fieldKey);
    content = prefillText !== null ? prefill(start, prefillText) : start;
  }
  const { expectedValueVersion: _ignored, ...rest } = edit;
  return {
    ok: true,
    edit: { ...rest, cleared: false, state, content, references: [...edit.references, { kind: "new", localId, reference }] },
  };
}
