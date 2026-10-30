/**
 * Wording for the Source pane's comparison and its saved copies
 * (EVIDENCE-RECORDS-001C2C-A). Everything here describes; nothing offers a
 * write: this release has no way to replace a saved copy, and the comparison
 * never says that two texts mean the same thing. Its "typography-only" is
 * equality after normalization v1, the characters quote matching ignores.
 */

const plural = (count: number, one: string, many: string) => `${count.toLocaleString("en-US")} ${count === 1 ? one : many}`;

export const SOURCE_COMPARE_COPY = {
  // The status of the library abstract, above the saved copy
  checking: "Checking the abstract in your library…",
  failed: "Couldn't read the abstract in your library, so PaperLume can't say whether it has changed since this copy was saved.",
  failedIntegrity: "The abstract in your library didn't pass PaperLume's checks, so it isn't compared.",
  unavailable: "This paper couldn't be read from your library, so its abstract can't be compared.",
  current: "Same as the abstract in your library, character for character.",
  checkAgain: "Check again",
  checkAgainLabel: "Check the abstract in your library again",
  compare: "Compare",
  compareLabel: "Compare the saved copy with the abstract in your library",
  showLibrary: "Show the library abstract",
  informational: (seq: number) =>
    `In this version of PaperLume, comparing is for information only: nothing is saved or changed. Your record keeps saved copy ${seq}, and its quotes and reviews stay as they are.`,
  informationalNoCopy: "In this version of PaperLume, showing the library abstract is for information only: nothing is saved, and the record still has no saved copy.",

  // The comparison
  compareHeading: "Saved copy and library abstract",
  libraryHeading: "The abstract in your library",
  readingsLabel: "What to show",
  readingChanges: "Changes",
  readingSaved: (seq: number) => `Saved copy ${seq}`,
  readingLibrary: "Library abstract",
  savedLabel: (seq: number) => `Saved copy ${seq} — the abstract currently saved with this study record`,
  savedNote: (date: string) => `Saved ${date}. It doesn't change when the abstract in your library changes.`,
  libraryLabel: "Library abstract — the abstract currently stored in your paper library",
  libraryNote: "Read from your library just now. It can change again at any time, and nothing of it is saved in this record.",
  legend: (seq: number) => `Struck-through text is only in saved copy ${seq}. Underlined text is only in the library abstract. Everything else is in both.`,
  summary: (changes: number, removedWords: number, addedWords: number) =>
    `${plural(changes, "place differs", "places differ")}: ${
      removedWords === 0 && addedWords === 0
        ? "spacing, punctuation or invisible characters only"
        : `${plural(removedWords, "word", "words")} only in the saved copy, ${plural(addedWords, "word", "words")} only in the library abstract`
    }.`,
  typographyNote: "PaperLume's quote matching treats every difference shown here as no difference. That is a technical comparison of characters, not a check of meaning.",
  tooDifferent: (seq: number) =>
    `These two texts differ in too many places to show one by one. Read them in full: “Saved copy ${seq}” and “Library abstract” above.`,
  changeCount: (count: number) => plural(count, "change", "changes"),
  previousChange: "Previous change",
  nextChange: "Next change",
  changePosition: (at: number, of: number) => `Change ${at.toLocaleString("en-US")} of ${of.toLocaleString("en-US")}`,
  changesNavigation: "Move between changes",
  onlyInSaved: "Only in the saved copy: ",
  onlyInLibrary: "Only in the library abstract: ",
  storedDifferently: "These look the same, but are stored as different characters.",
  libraryRemoved: "The abstract was removed from your library, so there is nothing to compare the saved copy with.",
  backToSaved: "Back to the saved copy",

  // Saved copies of one link's abstract
  copiesHeading: (count: number) => `Saved copies of this abstract (${count.toLocaleString("en-US")})`,
  showCopies: "Show saved copies",
  hideCopies: "Hide saved copies",
  copyLine: (seq: number, total: number, date: string, chars: number) => `Copy ${seq} of ${total} · saved ${date} · ${plural(chars, "character", "characters")}`,
  currentCopy: "The current copy, shown above: new quotes come from it.",
  showCopy: (seq: number) => `Show copy ${seq}`,
  hideCopy: (seq: number) => `Hide copy ${seq}`,
  earlierHeading: (seq: number, total: number) => `Copy ${seq} of ${total} — an earlier saved copy`,
  earlierNote: (current: number) => `Read-only. A quote stays on the copy it was made on; new quotes come from the current copy, copy ${current}.`,
  earlierMeta: (date: string, chars: number) => `Saved ${date} · ${plural(chars, "character", "characters")}`,
  earlierQuotes: (count: number) =>
    count === 0
      ? "No saved quote of this record is on this copy."
      : count === 1
        ? "The highlighted passage is the saved quote on this copy."
        : `The highlighted passages are the ${count} saved quotes on this copy.`,
  earlierReviewQuotes: (count: number) =>
    count === 0
      ? "This field has no saved quote on this copy."
      : count === 1
        ? "The highlighted passage is this field's saved quote on this copy."
        : `The highlighted passages are this field's ${count} saved quotes on this copy.`,
  loadingCopy: (seq: number) => `Loading copy ${seq}…`,
  copyFailed: (seq: number) => `Couldn't load copy ${seq}.`,
  copyIntegrity: (seq: number) => `Copy ${seq} didn't pass PaperLume's checks, so it isn't shown.`,
  copyGone: (seq: number) => `Copy ${seq} is no longer saved with this record. Reload the record to see it as it is now.`,
  tryAgain: "Try again",
  backToCurrent: "Back to the current copy",
} as const;

/** What an invisible or white-space character in a change is called, where it would otherwise not be seen. */
export const CHARACTER_NAMES: ReadonlyMap<number, string> = new Map([
  [0x0020, "space"],
  [0x000a, "line break"],
  [0x000d, "carriage return"],
  [0x0009, "tab"],
  [0x000b, "vertical tab"],
  [0x000c, "page break"],
  [0x0085, "next line"],
  [0x00a0, "no-break space"],
  [0x202f, "narrow no-break space"],
  [0x2009, "thin space"],
  [0x200a, "hair space"],
  [0x2028, "line separator"],
  [0x2029, "paragraph separator"],
  [0x3000, "ideographic space"],
  [0x00ad, "soft hyphen"],
  [0x200b, "zero-width space"],
  [0x2060, "word joiner"],
  [0xfeff, "zero-width no-break space"],
]);
