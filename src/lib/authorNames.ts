import { decodeHTMLEntities } from "./decodeHTMLEntities";

/**
 * Author-mention canonicalization — the single authoritative answer to "are
 * these two author strings the same *mention*, written differently?".
 *
 * The distinction this module is built around, and refuses to blur:
 *
 *  • A **mention** is one author string as some source wrote it. Two mentions
 *    are equivalent when they differ only in presentation — casing, spacing,
 *    HTML encoding, Unicode composition, quote/dash typography, or the period
 *    on a standalone initial.
 *  • A **person** is not modelled here at all. `S M Phillips`, `Stuart M
 *    Phillips` and `Stuart Phillips` may well be one researcher; nothing in the
 *    stored string proves it, so they stay three mentions. Resolving them needs
 *    provenance and identity data this phase does not have.
 *
 * So `authorMentionKey` is a *textual* grouping key, never a person ID. It
 * exists to stop `Stuart M. Phillips` and `Stuart M Phillips` from occupying
 * two rows of the Analytics author list; it is not evidence about a human.
 *
 * Read-time only. `papers.authors` keeps the source spelling — the stored value
 * carries provenance and is what the UI displays, and rewriting it would
 * destroy information to save a comparison. Nothing here is used by the import
 * or storage pipeline.
 *
 * Deliberately independent of `lexicalTerms.ts`. Keyword matching answers a
 * different question (does a term *occur inside* a text, as a token) with
 * different rules, and the two must be free to evolve apart.
 */

/**
 * Typographic apostrophe glyphs folded to `'`.
 *
 * The same written apostrophe reaches us as U+0027 from one source and U+2019
 * from another, so the glyph carries no information. Its *presence* still does:
 * `OConnor` never folds into `O'Connor`. U+02BB (Hawaiian okina) and U+02BC are
 * left alone — they are letters in their own orthographies, not punctuation.
 */
const APOSTROPHES = new Set(["‘", "’", "′"]);

/**
 * Dash glyphs folded to `-`: hyphen, non-breaking hyphen, figure dash, en dash,
 * em dash, horizontal bar. Again the glyph is typography and the presence is
 * not — `Jean-Pierre` never folds into `Jean Pierre`, because a hyphen joins
 * name components and a space separates them.
 */
const DASHES = new Set([
  "‐",
  "‑",
  "‒",
  "–",
  "—",
  "―",
]);

/**
 * Greek final sigma, folded to medial sigma for comparison.
 *
 * `String.prototype.toLowerCase` maps U+03A3 to final sigma at the end of a
 * word and to medial sigma elsewhere, so `"ΟΣ".toLowerCase()` and
 * `"ΟΣΑ".toLowerCase()` disagree about the same letter. Folding per code point
 * removes that context sensitivity and collapsing the sigma family on top makes
 * Σ, σ and ς compare equal, which is what Unicode simple case folding does.
 * Final_Sigma is the only language-independent context-sensitive lowercase
 * mapping in ECMAScript, so nothing else needs this treatment.
 */
const FINAL_SIGMA = "ς";
const MEDIAL_SIGMA = "σ";

/** Runs of any Unicode whitespace, including NBSP and the thin spaces PubMed emits. */
const WHITESPACE_RUN = /\s+/gu;

/**
 * A token that is exactly one Unicode letter followed by a period — `M.`, `J.`,
 * `Ю.`. Only these lose the period. `St.` keeps it (two letters is an
 * abbreviation, not an initial), and so does `J.R.R.` (a cluster, not a
 * standalone initial); expanding either would need a name parser this phase
 * deliberately does not have. `\p{L}` rather than `[A-Za-z]` so Cyrillic and
 * Greek initials are treated like Latin ones.
 */
const STANDALONE_INITIAL = /^(\p{L})\.$/u;

/**
 * The presentation form of an author mention: safe to show, safe to compare
 * against, and still recognisably what the source wrote.
 *
 * Decodes HTML entities, applies canonical composition (NFC), collapses
 * whitespace runs and trims. Notably it does NOT title-case, expand initials,
 * reorder components, strip accents or transliterate — every one of those would
 * make the label a claim about the name rather than a rendering of it.
 *
 * NFC is composition, not accent removal: `Jose` + combining acute and the
 * precomposed `José` become the same string; `Jose Garcia` stays a different
 * name.
 *
 * Returns `""` when the mention carries no usable content, which is how callers
 * recognise an empty author slot.
 */
export function normalizeAuthorDisplay(raw: string | null | undefined): string {
  if (!raw) return "";
  const decoded = decodeHTMLEntities(raw) ?? raw;
  return decoded.normalize("NFC").replace(WHITESPACE_RUN, " ").trim();
}

/**
 * Folds one code point into its comparison form: case, then the typographic
 * quote/dash equivalences and the sigma family.
 *
 * Lowercasing can expand one code point into several (U+0130 → `i` + combining
 * dot above), so this returns a string. It is applied after NFC, so canonically
 * equivalent inputs have already converged on the same code points.
 */
function foldCharacter(character: string): string {
  const lowered = character.toLowerCase();
  if (APOSTROPHES.has(lowered)) return "'";
  if (DASHES.has(lowered)) return "-";
  if (lowered === FINAL_SIGMA) return MEDIAL_SIGMA;
  return lowered;
}

/** Comparison key for an already display-normalized mention. */
function keyFromDisplay(display: string): string {
  if (!display) return "";

  let folded = "";
  // `for…of` iterates code points, so surrogate pairs survive intact.
  for (const character of display) folded += foldCharacter(character);

  // Whitespace is already collapsed to single spaces, so tokens split cleanly.
  return folded
    .split(" ")
    .map((token) => token.replace(STANDALONE_INITIAL, "$1"))
    .join(" ");
}

/**
 * The canonical comparison key for one author mention.
 *
 * Two mentions share a key exactly when they are formatting-equivalent. They do
 * NOT share a key when one abbreviates, omits or reorders name components — see
 * the module header for why that is the point rather than a limitation.
 *
 * `""` means "no usable author mention" (empty, whitespace-only, or absent) and
 * such mentions are excluded from grouping and counting entirely.
 */
export function authorMentionKey(raw: string | null | undefined): string {
  return keyFromDisplay(normalizeAuthorDisplay(raw));
}

/** One canonical author mention, with the source spelling chosen to represent it. */
export interface AuthorMentionEntry {
  /** Canonical comparison key. Internal — never shown to the user. */
  key: string;
  /** Display-normalized first source spelling encountered for this key. */
  label: string;
  /** Documents containing at least one mention with this key. */
  documentCount: number;
}

/**
 * Groups author mentions across documents into one entry per canonical key.
 *
 * The representative label is the first non-empty mention encountered in the
 * caller's document order, display-normalized — a real source spelling, with
 * its casing, initials, periods, punctuation and accents intact. Which of two
 * equivalent spellings wins is therefore stable for a given input and does not
 * depend on any judgement about which spelling is "better".
 *
 * `documentCount` counts documents, not mentions: a paper whose author array
 * happens to contain two equivalent spellings still counts once.
 *
 * Linear in the total number of mentions — one key per mention, `Map`/`Set`
 * lookups, no pairwise comparison.
 */
export function indexAuthorMentions(
  documents: ReadonlyArray<readonly string[] | null | undefined>,
): AuthorMentionEntry[] {
  const entries = new Map<string, AuthorMentionEntry>();

  for (const mentions of documents) {
    if (!mentions) continue;
    const seenInDocument = new Set<string>();

    for (const mention of mentions) {
      const label = normalizeAuthorDisplay(mention);
      if (!label) continue;
      const key = keyFromDisplay(label);

      let entry = entries.get(key);
      if (!entry) {
        entry = { key, label, documentCount: 0 };
        entries.set(key, entry);
      }
      if (!seenInDocument.has(key)) {
        seenInDocument.add(key);
        entry.documentCount += 1;
      }
    }
  }

  return Array.from(entries.values());
}

/**
 * Whether an author option matches a search query, comparing canonical forms.
 *
 * Substring semantics, exactly as before — only the normalization changed — so
 * a fragment still narrows the list. What this adds is that a user who types
 * `Stuart M. Phillips` finds the option displayed as `Stuart M Phillips`, and
 * vice versa: the grouped option must be reachable by any spelling that groups
 * into it, or grouping would hide authors from search.
 *
 * A blank query matches everything, which is what an untouched search box means.
 */
export function authorSearchMatches(label: string, search: string): boolean {
  const needle = authorMentionKey(search);
  if (!needle) return true;
  return authorMentionKey(label).includes(needle);
}
