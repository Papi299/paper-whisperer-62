/**
 * The Study Record interface's own wording (EVIDENCE-RECORDS-001C1).
 *
 * Domain wording — field labels, state labels, link labels, the identity
 * caveat, error messages — comes from `src/lib/evidence/` so the same thing is
 * never said two ways. These are the screen-level sentences around it, from
 * Requirements-001 §E2–§E12 as amended by 001A and FK-PROOF-001.
 *
 * The product never says "verified": a match proves only that a passage occurs
 * in the saved copy, and nothing in PaperLume checks the user's interpretation.
 */

export const STUDY_RECORD_COPY = {
  startTitle: (paperTitle: string) => `Study record for: ${paperTitle}`,
  listTitle: (paperTitle: string) => `Study records for: ${paperTitle}`,
  editorTitle: (label: string) => `Study record: ${label}`,
  explainer:
    "A study record is your own structured note about one study reported in this paper — its design, participants, interventions, comparators and outcomes — each with the source text that supports it. It's your interpretation: PaperLume doesn't check whether it's right.",
  originalQuestion: "Does this paper report results of an original study?",
  originalChoices: {
    yes: { label: "Yes", hint: "Saved as confirmed by you." },
    not_sure: { label: "Not sure", hint: "Saved as provisional, and shown that way." },
    no: { label: "No", hint: "For example a review, editorial or protocol." },
  },
  originalNoExplanation: "No study record will be created, and PaperLume won't remember this answer.",
  familyQuestion: "What kind of study is it?",
  familyHelp: "This only chooses which fields the record shows. It doesn't prove the study's design — you'll record the design itself in the record.",
  labelLabel: "Study name",
  labelHelp: "A short name you'll recognise, for example the first author and year. It isn't evidence, and you can change it later.",
  sourceWithAbstract:
    "PaperLume will save a copy of this paper's abstract as it is now in your library. Your quotes are checked against that copy, and editing the abstract later won't change it.",
  sourceNoAbstract:
    "This paper has no abstract in your library. You can still create the record, and support values with references to the full text — which PaperLume can't check.",
  sourceCheckingAbstract: "Checking this paper's abstract…",
  sourceUnknown:
    "If this paper has an abstract in your library, PaperLume will save a copy of it, and your quotes are checked against that copy. Without one, support values with references to the full text.",
  createButton: "Create study record",
  closeWithoutCreating: "Close without creating",
  noRecordCreated: "No study record created.",
  notAvailable: "Study records aren't available for your account yet.",
  accessUnknown: "Couldn't check whether your account can create study records. Close this and try again.",
  noRecordForPaper: "There's no study record for this paper.",
  addAnotherStudy: "Add another study from this paper",
  addAnotherHelp: "One paper can report more than one study. Each study gets its own record and its own copy of the abstract.",
  openButton: "Open",
  loadFailed: "Couldn't load the study records for this paper.",
  recordLoadFailed: "Couldn't load this study record.",
  recordIntegrity: "This study record couldn't be shown because the data received did not pass a consistency check. Nothing from it is displayed.",
  recordGone: "This study record no longer exists.",
  tryAgain: "Try again",
  backToList: "All studies from this paper",
  // Editor
  readOnlyNotice: "You can view and delete this study record. Creating and editing study records isn't available for your account.",
  notEnabledNotice: "Your account can no longer edit study records, so your changes weren't saved. You can still view and delete this record.",
  interpretationNotice: "Values are your interpretation of the sources shown. PaperLume checks that a quote occurs in the saved abstract — not that it supports the value.",
  saveDraft: "Save draft",
  saving: (step: number, total: number) => (total > 1 ? `Saving step ${step} of ${total}…` : "Saving…"),
  saved: "Saved.",
  unsavedChanges: "Unsaved changes",
  noChanges: "No unsaved changes",
  multiStep: (total: number) =>
    `These changes are saved in ${total} steps. Each step is saved on its own: if one fails, the steps before it stay saved.`,
  partialSaved: (applied: number, total: number) =>
    applied > 0 ? ` ${applied} of ${total} steps were saved before this; the rest of your changes are still here.` : "",
  conflict:
    "This study record was changed in another tab or window, so your changes weren't saved. They're still here — copy anything you need, then reload to see the latest version.",
  externalChange: "This study record was also changed somewhere else. Reload to see the latest version before saving more.",
  reload: "Reload latest version",
  reloadConfirmTitle: "Reload the study record?",
  reloadConfirmBody: "Reloading shows the latest saved version and discards your unsaved changes. Copy anything you need first.",
  reloadFailed: "Your changes were saved, but the study record couldn't be reloaded. Reload it before making more changes.",
  invalidSummary: (count: number) => `${count === 1 ? "1 problem needs" : `${count} problems need`} fixing before you can save.`,
  gone: "This study record no longer exists. It may have been deleted in another tab or window.",
  identityNoticeTitle: "About this study's identity",
  // Discard
  discardTitle: "Discard unsaved changes?",
  discardBody: "Your changes to this study record haven't been saved. If you close it now, they'll be lost.",
  discardConfirm: "Discard changes",
  keepEditing: "Keep editing",
  // Delete
  deleteButton: "Delete study record",
  deleteTitle: (label: string) => `Delete ‘${label}’?`,
  deleteIntro: "This permanently deletes the study record:",
  deleteItems: [
    "its structured values and the source references they cite,",
    "its saved copies of the abstract,",
    "its history,",
    "and the study with its links to papers.",
  ],
  deletePaperStays: "The paper stays in your library.",
  deleteUnsaved: "Your unsaved changes will be lost too.",
  deleteConfirm: "Delete study record",
  deleting: "Deleting…",
  deleteUncertain: "We couldn't confirm whether the study record was deleted. Try again — nothing is deleted twice.",
  deleteConflict: "This study record was changed in another tab or window. Reload it, then delete it again.",
  deleted: "Study record deleted. The paper stays in your library.",
  // Sections
  sections: {
    study_design: "Study design",
    participants: "Participants",
    interventions: "Interventions and comparators",
    outcomes: "Outcomes",
    notes: "Notes",
  },
  moreDetails: "More details",
  fewerDetails: "Fewer details",
  notesLabel: "Study notes",
  notesHelp: "Your own notes about this study. They're never treated or shown as evidence.",
  familyLabel: "Kind of study",
  familyChangeTitle: "Change the kind of study?",
  familyChangeBody: (groups: number, groupValues: number, numberRandomized: boolean) => {
    const parts: string[] = [];
    if (groups > 0) parts.push(`${groups} ${groups === 1 ? "group" : "groups"}${groupValues > 0 ? ` with ${groupValues} recorded ${groupValues === 1 ? "value" : "values"}` : ""}`);
    if (numberRandomized) parts.push("the number randomized");
    return `A study without an assigned intervention has no groups and no number randomized. Changing it removes ${parts.join(" and ")} when you save. Until then you can change it back.`;
  },
  familyChangeConfirm: "Change and remove",
  // Groups and outcomes
  addIntervention: "Add intervention group",
  addComparator: "Add comparator group",
  newInterventionLabel: (n: number) => `Intervention group ${n}`,
  newComparatorLabel: (n: number) => `Comparator group ${n}`,
  groupRole: { intervention: "Intervention group", comparator: "Comparator group" },
  groupName: "Group name",
  fewGroups: "Comparative studies usually have at least two groups.",
  groupLimit: "A study record can have up to 20 groups.",
  removeGroup: (label: string) => `Remove ${label}`,
  removeGroupTitle: (label: string) => `Remove ‘${label}’?`,
  removeWithValues: (count: number) =>
    `Its ${count} recorded ${count === 1 ? "value" : "values"} and their sources will be deleted when you save. Until then you can undo this.`,
  removedPending: (label: string) => `‘${label}’ will be removed when you save.`,
  undo: "Undo",
  moveUp: (label: string) => `Move ${label} up`,
  moveDown: (label: string) => `Move ${label} down`,
  roleChangeTitle: "Change this group's role?",
  roleChangeBody: (label: string) => `An intervention group has no comparator type, so changing ‘${label}’ clears its comparator type when you save.`,
  roleChangeConfirm: "Change and clear",
  addOutcome: "Add outcome",
  newOutcomeLabel: (n: number) => `Outcome ${n}`,
  outcomeName: "Outcome name",
  outcomeLimit: "A study record can have up to 50 outcomes.",
  outcomesEmpty: "No outcomes yet.",
  groupsEmpty: "No groups yet.",
  // Fields
  stateLegend: (label: string) => `What the source says about ${label}`,
  notYetRecorded: "Not yet recorded",
  clearField: "Clear this field",
  willBeCleared: "This field will be cleared when you save.",
  revertField: "Undo changes to this field",
  noteLabel: "Note",
  noteOptional: "Note (optional)",
  reasonLegend: "Why is it unclear?",
  reasons: { ambiguous: "Ambiguous", conflicting: "Conflicting", incomplete: "Incomplete" },
  valueLabel: "Value",
  reportedTextLabel: "As reported",
  reportedTextHelp: "Exactly as the source writes it, for example “n = 1,204”.",
  confirmedNumberLabel: "Confirmed number",
  confirmedNumberHelp: "The whole number this text reports, which you confirm.",
  suggestion: (value: number) => `We read this as ${value.toLocaleString("en-US")}. Correct?`,
  applySuggestion: (value: number) => `Use ${value}`,
  chooseCode: "Choose…",
  listEntry: (n: number) => `Entry ${n}`,
  addEntry: "Add entry",
  removeEntry: (n: number) => `Remove entry ${n}`,
  trimEntries: "Remove spaces at the start and end of entries",
  reviewChangeWarning: "Saving a change to this value clears your review of it.",
  // Sources
  sourcesLabel: "Sources",
  noSourceGiven: "No source given",
  noSourceGivenHelp: "You can save this, but a value without a source can't be reviewed later.",
  addQuote: "Add quote",
  addFullTextReference: "Add full-text reference",
  removeSource: "Remove",
  quoteFromAbstract: "Quote from the saved abstract",
  quoteFound: "Found in the saved abstract",
  quoteEarlierCopy: "From an earlier copy of the abstract",
  quoteOccurrence: (occurrence: number, count: number) => `occurrence ${occurrence} of ${count}`,
  yourReference: "Your reference — not checked by PaperLume",
  fullTextOf: (title: string) => `Full text of ${title}`,
  thisPaper: "this paper",
  examinedLegend: "Which sources did you examine?",
  examinedAbstract: "The saved abstract copy",
  examinedFullText: "The full text (your statement)",
  unavailableLegend: "Which sources couldn't you check?",
  unavailableAbstract: "The abstract — this paper has no abstract in your library",
  unavailableFullText: "The full text — not available to you",
  noCopyForQuotes: "This study record has no saved copy of the abstract, so quotes can't be added. Use full-text references.",
  // Typed quote
  typedQuoteLabel: "Quote from the saved abstract",
  typedQuoteHelp: "Type or paste the exact words. PaperLume checks that they occur in the saved copy; it doesn't check that they support the value.",
  typedQuoteFoundOnce: "Found once in the saved abstract.",
  typedQuoteFoundMany: (count: number) => `Found ${count} times in the saved abstract. Choose the one you mean.`,
  typedQuoteNotFound:
    "This text wasn't found in the saved abstract. Select it directly in the abstract, or add it as a full-text reference if it comes from elsewhere.",
  typedQuoteTooMany: "This text appears more than 100 times in the abstract. Add a few words so it appears fewer times.",
  occurrenceLegend: "Which occurrence do you mean?",
  occurrenceOption: (n: number) => `Occurrence ${n}`,
  addThisQuote: "Add this quote",
  cancel: "Cancel",
  // Full-text reference
  fullTextReport: "Report",
  locatorKind: "Location type",
  locatorText: "Location",
  locatorPlaceholder: "For example 4, Results, Table 2",
  locatorKinds: { page: "Page", section: "Section", table: "Table", figure: "Figure", paragraph: "Paragraph", other: "Other" },
  addReference: "Add reference",
  // Source pane
  sourcePane: "Source",
  recordPane: "Record",
  savedCopyHeading: "Saved copy of the abstract",
  savedCopyDate: (date: string) => `Saved ${date}. This copy doesn't change when the abstract in your library changes.`,
  noSavedCopy:
    "This study record has no saved copy of this paper's abstract, because the paper had no abstract when the record was created. Record values with references to the full text.",
  fullTextNotice: "Full-text references are locations you give — a page, section or table. PaperLume doesn't open or check the full text.",
  selectionPrompt: "Select text in the abstract to use it as a quote.",
  selectedText: "Selected",
  useAsQuoteFor: "Use as quote for",
  useAsQuote: "Use as quote",
  quoteAdded: (field: string) => `Quote added to ${field}.`,
  selectionInvalid: "Select text inside the saved abstract.",
  selectionOccurrence: (count: number) => `This text appears ${count} times in the abstract. Which one did you select?`,
  quoteNeedsState: "‘Use as quote’ needs a field that is Reported, Unclear or not yet recorded. Change the field's state first.",
  quoteLimit: "A value can have up to 3 supporting sources.",
  sourcePaperLabel: "Paper",
  // Link status
  linkStatusLabel: "This paper and the study",
  markConfirmed: "Mark as confirmed",
  markProvisional: "Mark as provisional",
  // Entry points
  entryLabel: "Study records",
  entryCount: (count: number) => (count === 0 ? "None" : String(count)),
  entryChecking: "Checking…",
  entryFailed: "Couldn't load",
  entryOpen: "Open study record",
  entryStart: "Start a study record",
  entryEditPaperNote: "Opening the study record closes Edit Paper. Save your paper changes first.",
} as const;

/**
 * One-line hints under a field's label (Requirements-001 §H2–§H5). Fields
 * without a hint show only their label.
 */
export const FIELD_HINTS: Partial<Readonly<Record<string, string>>> = {
  design_as_reported: "As the authors describe it. Quote where they describe their own design, not designs they mention.",
  design_classification: "Your judgement, from a fixed list. It isn't taken from the paper's study type.",
  registration_ids: "For example NCT followed by 8 digits. PaperLume doesn't check them against a registry.",
  n_randomized: "The reported text, and the whole number you confirm.",
  n_enrolled: "The reported text, and the whole number you confirm.",
  arm_name_as_reported: "As the authors name the group.",
  comparator_type: "Your judgement, for comparator groups only.",
  outcome_name_as_reported: "As the authors name the outcome.",
  outcome_designation: "Set this only when the source says so; otherwise choose Not reported.",
  time_points: "For example “12 weeks” or “6 months after randomization”.",
};
