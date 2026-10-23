# Study records — the Study Record interface (EVIDENCE-RECORDS-001C1)

> **Status: Draft PR, not merged, not deployed, not Production-accepted.** PR-C1 (branch `feat/evidence-records-study-ui-foundation`) adds the first application code that calls the study-record RPCs. The backend it uses is merged and applied to Production: the eight tables (PR-A1), the lifecycle RPCs and owner-only pilot gate (PR-A2, [evidence-records-lifecycle.md](evidence-records-lifecycle.md)), the field RPCs (PR-A3, [evidence-records-field-operations.md](evidence-records-field-operations.md)) and the domain library (PR-B, [evidence-domain-library.md](evidence-domain-library.md)). Until PR-C1 is merged, the deployed application has no Study Record interface. Merging it needs no migration, secret or Edge Function — Vercel publishes it with `main` — and it then still needs an authenticated Production acceptance before it can be called accepted.

This document describes what a user can do, what the interface sends, and what it deliberately leaves to PR-C2. The executable specification is the Vitest suites under `src/lib/studyRecord/__tests__/`, `src/components/papers/study-record/__tests__/`, `src/hooks/__tests__/useStudyRecordEditor.test.tsx`, the paper-safeguard suites, `src/test/studyRecordUiBoundary.test.ts`, and `e2e/study-records.spec.ts`.

## 1. Where it lives

| Layer | Files | Role |
|---|---|---|
| Pure logic | `src/lib/studyRecord/` | Reads (`read.ts`, `paperLinks.ts`), the in-memory draft (`draft.ts`), checks (`validateDraft.ts`), save planning (`savePlan.ts`, `jsonbSize.ts`), quotes (`quotes.ts`), the pilot mirror (`access.ts`), paper safeguards (`paperGuards.ts`), the one write client (`client.ts`) |
| Hooks | `src/hooks/useStudyRecords.ts`, `src/hooks/useStudyRecordEditor.ts` | Owner-scoped queries; the editor's save state machine |
| UI | `src/components/papers/study-record/` | The dialog, the start screen, the study list, the editor (record and source panes), the entry point |
| Entry points | `PaperList.tsx`, `EditPaperDialog.tsx`, `Dashboard.tsx` | Expanded row details, Edit Paper, the delete confirmation |
| Safeguards | `PaperList.tsx`, `BulkActionsToolbar.tsx`, `DeduplicationDialog.tsx`, `useDeduplication.ts`, `usePaperMutations.ts`, `useBulkMutations.ts` | Checks before paper delete and duplicate merge; the database refusal explained |

One dialog is mounted by the Dashboard, beside Compare. It is never stacked on another modal and has no route.

## 2. Entry points

- **A paper's expanded details** (the row's abstract expander): `Study records — None / 1 / 2`, then **Start a study record** or **Open study record**. Read only while the row is expanded. It is not another icon in the row's action cluster.
- **Edit Paper**: the same entry. Choosing it closes Edit Paper first (unsaved Edit Paper changes are not kept — the entry says so) and opens the Study Record dialog once Edit Paper has finished closing.
- **A refused paper delete** offers **Open study record** for the paper that blocks it, again after the confirmation closes.

With one study the dialog opens it; with several it lists them (each a separate record — nothing suggests two are the same study). The pilot owner can add another study from the list. A failed read says so and offers Try again; it is never shown as "None".

## 3. The owner-only pilot

The server decides: create, update, set_link and save call `evidence_records_assert_writable()`, which reads `internal_user_access` on every call and refuses anything but `owner` with `42501 evidence_records_not_enabled`. The interface mirrors that from `useCurrentUserAccess()` only — never a JWT claim, an email address, browser storage or a client flag — and fails closed:

| Role (or state) | Sees | Can |
|---|---|---|
| `owner` | every entry point | create, edit, save, delete |
| `manager`, `user` | only papers holding their own records | view and delete those records |
| role loading, lookup failed | only papers holding their own records | view and delete |
| signed out | nothing | nothing |

Delete is ungated on the server, so a former owner keeps View and Delete. If the role is removed while a draft is open, Save is refused with a distinct message ("Your account can no longer edit study records…"), the draft stays on screen, and the editor locks.

## 4. Starting a study record

1. **Does this paper report results of an original study?** *Yes* creates a `user_confirmed` link, *Not sure* a `provisional` one, *No* creates nothing and remembers nothing. Never inferred from `study_type`, AI analysis or metadata.
2. **What kind of study is it?** `rct_parallel`, `intervention_other` or `non_intervention`, with PR-B's labels. The family chooses the fields; it does not prove the design.
3. **Study name**, prefilled as "‹first author› ‹year›" (else the title, else "Study 1"), editable, checked by the label rules.
4. **Source notice**: the server will save an immutable copy of the abstract; without one, full-text references can still support values.

Create calls `evidence_create_study_from_paper` through PR-B's client with one request id per action. An unknown outcome resends the same request (the server replays it), never a new id.

## 5. Reading a record

Plain SELECTs under the owner-only RLS policies, each also filtered by `user_id`, read in 1,000-row pages until a short page, so a truncated answer never passes for a complete one. Only the current copy's text is read; earlier copies are metadata. Every row is mapped by PR-B and cross-checked (owner, study, linked paper, copy); a failure shows nothing of the record. The record is never refetched in the background (`staleTime: "static"`): the draft is checked against the version it was built on.

## 6. The editor

- **Sections**: Study design, Participants, Interventions and comparators (intervention families only), Outcomes, Notes — collapsible. Core fields show; optional ones sit behind **More details** unless they hold something.
- **Fields**: PR-B's 23-key dictionary. Five state radios — Reported, Not reported, Unclear, Not applicable, Couldn't check — and "Not yet recorded" when no value exists. Unclear needs a reason and an explanation; Not applicable an explanation. Values are typed as the dictionary says; a confirmed number is never filled in for the user (a suggestion needs an explicit "Use").
- **Groups and outcomes**: add, rename, Move up / Move down, remove. Removing one with recorded values asks first and can be undone until Save. Changing a comparator to an intervention group asks before clearing its comparator type; moving to `non_intervention` asks before removing the groups and the number randomized.
- **No source given**: a Reported value without a supporting source is marked, savable, and not reviewable later.
- **Review status** is shown read-only (and "Saving a change to this value clears your review of it"); there is no Confirm or Flag (§12).

## 7. Source capture

- **The saved copy** is shown as plain text with `white-space: pre-wrap` — thin spaces, superscripts and line breaks intact, nothing interpreted as HTML. Passages already quoted are highlighted with an underline as well as a colour.
- **Use as quote**: select text in the copy and choose the field. The selection itself says which occurrence it is; when it cannot, the user chooses. The quote text is sent exactly as selected.
- **Add quote** (keyboard and phone path): type or paste; PR-B's browser matcher says found once, found N times (choose one), not found, too short or too many — advice only.
- **Never sent**: offsets, match counts or times, normalization versions. The server matches every new quote itself, against the copy it names, and refuses one that is absent or ambiguous.
- **Full-text references**: a linked paper and a location (page, section, table, figure, paragraph, other) — "Your reference — not checked by PaperLume". No full-text quotation is stored.
- **Examined / couldn't check**: checkboxes for Not reported, Unclear and Couldn't check, per the state rules.

## 8. Saving

Explicit **Save draft**; no autosave; the draft lives in memory only. Unsaved changes are shown, closing or leaving asks first, and every refusal keeps the draft.

- **Steps.** The header goes through `evidence_update_study`; groups, outcomes and values through `evidence_save_changes` — at most **200 changes and 65,536 bytes** per call, measured exactly as the server measures `p_changes::text`. Group and outcome changes go in the first batch; values are packed into as few batches as the limits allow; a value of a group created by an earlier batch names it by the returned id. Moving to `non_intervention` saves the removals before the header. With more than one step the interface says each step is saved on its own and that a failure leaves earlier steps saved — never that the steps are one transaction.
- **Request ids** are generated once per step with the plan. **Try again** resends the same prepared request; nothing is retried automatically, and while an outcome is unknown the draft is locked.
- **Versions.** Every write names the study version the draft is based on; every value change names the `value_version` captured when the user first touched it. A change made elsewhere is refused (`evidence_version_conflict`): the edits stay, and **Reload latest version** (after a confirmation) replaces them. Nothing is rebased automatically.
- **Messages** come from PR-B's error classification — never a raw database message. A refusal naming a value points at its input ("Go to the field").

## 9. Deleting a study record

**Delete study record** says what goes — values and their source references, saved copies, history, the study and its links — and that **the paper stays in your library**. It calls `evidence_delete_study` with the version on screen; an unknown outcome resends the same request, and "already absent" counts as deleted.

## 10. Paper delete and duplicate merge

`evidence_study_reports_paper_fkey` is ON DELETE NO ACTION: `delete_papers_with_attachment_cleanup` and `merge_exact_duplicates` fail with `23503` — in one transaction, leaving attachments, Project/Tag assignments and the cleanup queue as they were — whenever they would remove a paper a study links to. The interface checks first and explains the key's refusal when a link appears after the check:

- **One paper**: the confirmation checks that paper (fresh each time). Held → "This paper has a study record", Open study record, no Delete. Check failed → Try again, no Delete.
- **A selection**: every selected id is checked (chunks of 100, paged). Held papers are named (eight, then "and N more"), with **Deselect papers with study records**; the selection is never sent while it holds one.
- **Duplicate merge**: the scan's papers are checked. A held paper is suggested as the keeper, badged "Study record", and a group that would discard one — or holds several — is left out of Merge All, with the reason. Studies are never merged or moved.
- **Race**: a `23503` on that constraint is explained ("Paper not deleted", "Papers not deleted", "Group not merged"); every other error, including every other foreign key, keeps its existing message. The E2E creates a link in "another tab" after the check and proves, as the database owner, that the refused delete and merge changed no assignment, attachment or cleanup job.

## 11. Accessibility and phones

The dialog title takes focus on open and focus returns to the opener on close. Refusals are announced (`role="alert"`) and focused. State choices are radio groups; sections and More details are disclosure buttons; quoting works without a pointer. Status is never colour alone. On a phone the dialog is full screen with a **Record / Source** switch, no sideways scroll, and a sticky footer padded for the safe area; touch targets follow the app's `coarse:` sizing.

## 12. Known C1 limitations and the PR-C2 handoff

C1 limitations:

- The expanded-row entry exists only for papers with an abstract (the row's expander does); every paper is reachable through Edit Paper.
- Edit Paper has no unsaved-changes check, so opening a study record from it discards Edit Paper edits (the entry warns).
- Links: only *Mark as confirmed* / *Mark as provisional* on existing links. Linking further reports, and removing a link, are not offered.
- Quotes from an earlier copy are labelled "From an earlier copy of the abstract"; there is no comparison or rebase.
- A multi-step save is not one transaction (§8).
- The interface has not run against Production with an authenticated user.

PR-C2 (not started): Confirm and Flag (`evidence_review_fields`) with the review checklist; the history viewer (`evidence_events`); the source-change comparison and **Use current abstract** (`evidence_rebase_source`); review-history displays. The Evidence Matrix integration is later still. The C1 boundary test fails if any of these appear in the Study Record UI before then.
