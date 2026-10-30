/**
 * The Source pane comparison's pure parts (EVIDENCE-RECORDS-001C2C-A): what
 * the library read says, and how a change shows characters that would
 * otherwise not be seen. Kept out of the components so they export only
 * components.
 */

import { deriveSourceState, type SourceState } from "@/lib/evidence/sources";
import { StudyRecordReadError, type LibraryAbstract } from "@/lib/studyRecord/read";
import { CHARACTER_NAMES } from "./sourceCompareCopy";

export type LibraryStatus =
  /** A read is on its way: no earlier answer stands in for it. */
  | { readonly kind: "checking" }
  /**
   * The last read failed: `transient` when trying again soon could help (no
   * answer, or the server busy), `refused` when the server said no, `integrity`
   * when the answer failed a check.
   */
  | { readonly kind: "failed"; readonly reason: "transient" | "refused" | "integrity" }
  /** The paper could not be read — never taken to mean its abstract was removed. */
  | { readonly kind: "unavailable" }
  | { readonly kind: "ready"; readonly abstract: string | null; readonly state: SourceState };

/** The part of a query result the status is read from. */
export interface LibraryRead {
  readonly isFetching: boolean;
  readonly isError: boolean;
  readonly error: unknown;
  readonly data: LibraryAbstract | null | undefined;
}

/**
 * What the Source pane may say about the library abstract. Only a read that
 * finished, and finished last, is an answer: while one is on its way the
 * status is `checking`, and after a failure it is `failed` even when an
 * earlier read succeeded — a failed read is never shown as the earlier answer,
 * nor the saved copy as the library's. Normalizes each text at most once;
 * callers memoize on the two texts.
 */
export function libraryStatus(read: LibraryRead, copyText: string | null): LibraryStatus {
  if (read.isFetching) return { kind: "checking" };
  if (read.isError) {
    const error = read.error instanceof StudyRecordReadError ? read.error : null;
    return { kind: "failed", reason: error?.kind === "integrity" ? "integrity" : error?.transient === false ? "refused" : "transient" };
  }
  if (read.data === undefined) return { kind: "checking" };
  if (read.data === null) return { kind: "unavailable" };
  return { kind: "ready", abstract: read.data.abstract, state: deriveSourceState(copyText, read.data.abstract) };
}

export type MarkedPiece = { readonly kind: "text"; readonly text: string } | { readonly kind: "mark"; readonly label: string };

const INVISIBLE = /^\p{Cf}$/u;
const WHITE_SPACE = /^\p{White_Space}$/u;
const ONLY_WHITE_OR_INVISIBLE = /^[\p{White_Space}\p{Cf}]+$/u;

function nameOf(character: string): string {
  const code = character.codePointAt(0) as number;
  const known = CHARACTER_NAMES.get(code);
  if (known) return known;
  const hex = `U+${code.toString(16).toUpperCase().padStart(4, "0")}`;
  return WHITE_SPACE.test(character) ? `space ${hex}` : `invisible character ${hex}`;
}

/**
 * One side of a change, with what can't be seen named. A side made only of
 * white space and invisible characters names every one of them — a removed
 * line break, a no-break space where a space was. In a side with text,
 * ordinary spaces and line breaks show as themselves, and every other white
 * space and invisible character is named. Joined, the text pieces and the
 * named characters are the side, in order.
 */
export function markHiddenCharacters(text: string): MarkedPiece[] {
  const all = ONLY_WHITE_OR_INVISIBLE.test(text);
  const pieces: MarkedPiece[] = [];
  let run = "";
  for (const character of text) {
    const hidden = all || INVISIBLE.test(character) || (WHITE_SPACE.test(character) && character !== " " && character !== "\n");
    if (!hidden) {
      run += character;
      continue;
    }
    if (run) pieces.push({ kind: "text", text: run });
    run = "";
    pieces.push({ kind: "mark", label: nameOf(character) });
  }
  if (run) pieces.push({ kind: "text", text: run });
  return pieces;
}

const MICRO_SIGN = String.fromCodePoint(0x00b5);
const GREEK_MU = String.fromCodePoint(0x03bc);

/**
 * Whether the two sides of a change look the same but are different
 * characters: equal after NFC (an accent composed or not) or with the micro
 * sign read as mu. Never NFKC — a superscript two is not a two.
 */
export function looksAlike(removed: string, added: string): boolean {
  if (removed === added || removed === "" || added === "") return false;
  const canonical = (text: string) => text.normalize("NFC").split(MICRO_SIGN).join(GREEK_MU);
  return canonical(removed) === canonical(added);
}
