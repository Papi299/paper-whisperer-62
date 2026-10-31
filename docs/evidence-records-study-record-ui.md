# Study records — the Study Record interface (EVIDENCE-RECORDS-001C1, 001C2A, 001C2B, 001C2C-A, 001C2C-B)

> **Status: merged and deployed; the owner-pilot workflow is Production-accepted with qualifications.** PR-C1 (PR #348) merged on 2026-10-23 as `ec4bdbde` and is live on `app.paperlume.app`. It needed no migration, secret or Edge Function, and it is the first application code that calls the study-record RPCs. The backend it uses was merged, applied to Production and accepted before this rollout: the eight tables (PR-A1), the lifecycle RPCs and owner-only pilot gate (PR-A2, [evidence-records-lifecycle.md](evidence-records-lifecycle.md)), the field RPCs (PR-A3, [evidence-records-field-operations.md](evidence-records-field-operations.md)) and the domain library (PR-B, [evidence-domain-library.md](evidence-domain-library.md)). On 2026-10-23 the Product Owner ran one synthetic-canary workflow through the normal Production interface, and it passed with four qualifications (§13). That accepts the workflow exercised, not every operation, Unicode case or recovery path described below. Creating and editing remain owner-only (§3). **EVIDENCE-RECORDS-001C2A** adds Review (§14): Confirm and Flag of one saved value at a time. It merged on 2026-10-24 (PR #355, `0ba43a17`) with no migration, secret or Edge Function, and is live on `app.paperlume.app`. The same day the Product Owner ran one synthetic-canary Review workflow in Production, and it passed with three qualifications (§15). **EVIDENCE-RECORDS-001C2B** adds History (§16): a read-only, paginated view of a record's committed operations, with no migration, RPC, secret or Edge Function. It merged on 2026-10-30 (PR #358, `fe6d2b0f`) and is live on `app.paperlume.app`. The same day the Product Owner ran one synthetic-canary History workflow in Production, and it passed with three qualifications (§17). **EVIDENCE-RECORDS-001C2C-A** adds the Source pane's read-only source comparison and earlier saved copies (§18), with no migration, RPC, grant, secret or Edge Function. It merged on 2026-10-30 (PR #360, `d41413db`) and is live on `app.paperlume.app`. **EVIDENCE-RECORDS-001C2C-B** adds **Use current abstract** (§19), the interface for the installed `evidence_rebase_source`, with no migration, RPC, grant, secret or Edge Function. It merged on 2026-10-31 (PR #362, `63f5ed60`) and is live on `app.paperlume.app`. The same day the Product Owner ran one combined synthetic-canary acceptance of C2C-A and C2C-B in Production, including the first Production rebase and first capture, and it passed with limitations (§20).

This document describes what a user can do and what the interface sends. The executable specification is the Vitest suites under `src/lib/studyRecord/__tests__/`, `src/components/papers/study-record/__tests__/`, `src/hooks/__tests__/useStudyRecordEditor.test.tsx`, `useStudyRecordReview.test.tsx`, `useStudyRecordHistory.test.tsx`, `useStudyRecordSourceReads.test.tsx` and `useStudyRecordRebase.test.tsx`, the paper-safeguard suites, `src/test/studyRecordUiBoundary.test.ts`, `e2e/study-records.spec.ts`, `e2e/study-records-review.spec.ts`, `e2e/study-records-history.spec.ts`, `e2e/study-records-source-compare.spec.ts` and `e2e/study-records-rebase.spec.ts`.

## 1. Where it lives

| Layer | Files | Role |
|---|---|---|
| Pure logic | `src/lib/studyRecord/` | Reads (`read.ts`, `paperLinks.ts`), the in-memory draft (`draft.ts`), checks (`validateDraft.ts`), save planning (`savePlan.ts`, `jsonbSize.ts`), quotes (`quotes.ts`), the pilot mirror (`access.ts`), paper safeguards (`paperGuards.ts`), creates whose outcome is unknown (`pendingCreates.ts`), Review's items, holds and summary (`reviewModel.ts`), History's read and its reading of events (`historyRead.ts`, `historyModel.ts`), Use current abstract's eligibility, review impact and SHA-256 (`sourceUpdate.ts`), the one write client (`client.ts`) |
| Hooks | `src/hooks/useStudyRecords.ts`, `src/hooks/useStudyRecordEditor.ts`, `src/hooks/useStudyRecordCreations.ts`, `src/hooks/useStudyRecordHistory.ts` | Owner-scoped queries; the editor's save, review and rebase state machine, and its open Flag notes; the dialog's store of unresolved creates; History's paged, owner-scoped reads |
| UI | `src/components/papers/study-record/` | The dialog, the start screen, the study list, the editor (Edit: record and source panes; Review: the review pane, its cards and the Flag form; History: the history pane and its entries), the entry point |
| Entry points | `PaperList.tsx`, `EditPaperDialog.tsx`, `Dashboard.tsx` | Expanded row details, Edit Paper, the delete confirmation |
| Safeguards | `PaperList.tsx`, `BulkActionsToolbar.tsx`, `DeduplicationDialog.tsx`, `useDeduplication.ts`, `usePaperMutations.ts`, `useBulkMutations.ts` | Checks before paper delete and duplicate merge; the database refusal explained |

One dialog is mounted by the Dashboard, beside Compare. It is never stacked on another modal and has no route.

## 2. Entry points

- **A paper's expanded details** (the row's abstract expander): `Study records — None / 1 / 2`, then **Start a study record** or **Open study record**. Read only while the row is expanded. It is not another icon in the row's action cluster.
- **Edit Paper**: the same entry. Choosing it closes Edit Paper first (unsaved Edit Paper changes are not kept — the entry says so) and opens the Study Record dialog once Edit Paper has finished closing.
- **A refused paper delete** offers **Open study record** for the paper that blocks it, again after the confirmation closes.

Every opening reads the paper's studies from the server again before it chooses what to show — a cached list, however recent, is never taken as the answer. With one study the dialog opens it; with several it lists them (each a separate record — nothing suggests two are the same study). The pilot owner can add another study from the list. A failed read says so and offers Try again; it is never shown as "None", and nothing can be created until a read succeeds. A paper with an unresolved create opens on its recovery instead (§4).

## 3. The owner-only pilot

The server decides: create, update, set_link and save call `evidence_records_assert_writable()`, which reads `internal_user_access` on every call and refuses anything but `owner` with `42501 evidence_records_not_enabled`. The interface mirrors that from `useCurrentUserAccess()` only — never a JWT claim, an email address, browser storage or a client flag — and fails closed:

| Role (or state) | Sees | Can |
|---|---|---|
| `owner` | every entry point | create, edit, save, delete |
| `manager`, `user` | only papers holding their own records | view and delete those records |
| role loading, lookup failed | only papers holding their own records | view and delete |
| signed out | nothing | nothing |

Delete is ungated on the server, so a former owner keeps View and Delete. If the role is removed while a draft is open, Save is refused with a distinct message ("Your account can no longer edit study records…"), the draft stays on screen, and the editor locks. History (§16) is a read of the user's own rows and is not gated either: every role that can open a record reads its History, and no role can write it.

## 4. Starting a study record

1. **Does this paper report results of an original study?** *Yes* creates a `user_confirmed` link, *Not sure* a `provisional` one, *No* creates nothing and remembers nothing. Never inferred from `study_type`, AI analysis or metadata.
2. **What kind of study is it?** `rct_parallel`, `intervention_other` or `non_intervention`, with PR-B's labels. The family chooses the fields; it does not prove the design.
3. **Study name**, prefilled as "‹first author› ‹year›" (else the title, else "Study 1"), editable, checked by the label rules.
4. **Source notice**: the server will save an immutable copy of the abstract; without one, full-text references can still support values.

Create waits for this opening's read of the paper's studies, and names any the paper already has ("This paper already has 1 study record: …. Create another only if the paper reports a separate study."). It calls `evidence_create_study_from_paper` through PR-B's client with one request id per action.

**When the outcome is unknown** (EVIDENCE-RECORDS-001C1-REVIEW-FIX-001, finding C1-R1) — a lost or unreadable answer, `applied: "unknown"`, after which the database may hold the new study — the attempt is kept with its exact prepared request (user, paper, arguments, request id) in the dialog's in-memory store of unresolved creates (`pendingCreates.ts`). The dialog, mounted once by the Dashboard, owns the store, so it outlives every opening:

- **Leaving is allowed**, also while the request is still on its way; a notice says the record isn't confirmed yet.
- **Reopening the paper** — at once or later in the session, whatever a cached list says — shows *An earlier attempt to create a study record didn't finish* instead of the form: the attempt's answers, why its outcome is unknown, **Try again** and **Check this paper's study records**. Try again resends the same request object: the server answers with the original record if it was created (`replayed`) and creates it otherwise. An attempt still on its way is waited for, never sent twice. A fresh list is shown on request but proves nothing about the attempt, and nothing is retried automatically.
- **A further unknown outcome** keeps the attempt; no replacement request id is ever generated for it.
- **Only that paper waits**: other papers create normally. Once the attempt is resolved, **Add another study** is an intentional new action with a new request id.
- **Isolation**: an attempt is found only by the user who made it, and every other user's attempts are forgotten when the signed-in user changes or signs out.

An answer that says nothing was applied (any refusal with a SQLSTATE) retires the attempt: the form returns with its answers and the message, and the same answers resend the same request. Nothing of this reaches browser storage, cookies or the URL.

## 5. Reading a record

Plain SELECTs under the owner-only RLS policies, each also filtered by `user_id`, read in 1,000-row pages until a short page, so a truncated answer never passes for a complete one. Only the current copy's text is read with the record; earlier copies are metadata, and a copy's text is read only when the user opens that copy (§18). Every row is mapped by PR-B and cross-checked (owner, study, linked paper, copy); a failure shows nothing of the record. The record is never refetched in the background (`staleTime: "static"`): the draft is checked against the version it was built on.

## 6. The editor

- **Sections**: Study design, Participants, Interventions and comparators (intervention families only), Outcomes, Notes — collapsible. Core fields show; optional ones sit behind **More details** unless they hold something.
- **Fields**: PR-B's 23-key dictionary. Five state radios — Reported, Not reported, Unclear, Not applicable, Couldn't check — and "Not yet recorded" when no value exists. Unclear needs a reason and an explanation; Not applicable an explanation. Values are typed as the dictionary says; a confirmed number is never filled in for the user (a suggestion needs an explicit "Use").
- **Groups and outcomes**: add, rename, Move up / Move down, remove. Removing one with recorded values asks first and can be undone until Save. Changing a comparator to an intervention group asks before clearing its comparator type; moving to `non_intervention` asks before removing the groups and the number randomized.
- **No source given**: a Reported value without a supporting source is marked and savable; it can't be confirmed until a source is added ("You can save this, but you can't confirm it until you add a source.").
- **Review status** is shown read-only in Edit (and "Saving a change to this value clears your review of it"); Confirm and Flag exist only in Review (§14).

## 7. Source capture

- **The saved copy** is shown as plain text with `white-space: pre-wrap` — thin spaces, superscripts and line breaks intact, nothing interpreted as HTML. Passages already quoted are highlighted with an underline as well as a colour.
- **Use as quote**: select text in the copy and choose the field. The selection itself says which occurrence it is; when it cannot, the user chooses. The quote text is sent exactly as selected. Edit only: Review shows saved quotes and offers no quoting (§14).
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

The dialog title takes focus on open and focus returns to the opener on close. Refusals are announced (`role="alert"`) and focused. State choices are radio groups; sections and More details are disclosure buttons; quoting works without a pointer. Status is never colour alone. On a phone the dialog is full screen, with no sideways scroll and a sticky footer padded for the safe area; Edit has a **Record / Source** switch, and Review shows each card's source in the card (§14). Touch targets follow the app's `coarse:` sizing.

## 12. Known C1 limitations and the PR-C2 handoff

C1 limitations:

- The expanded-row entry exists only for papers with an abstract (the row's expander does); every paper is reachable through Edit Paper.
- Edit Paper has no unsaved-changes check, so opening a study record from it discards Edit Paper edits (the entry warns).
- Links: only *Mark as confirmed* / *Mark as provisional* on existing links. Linking further reports, and removing a link, are not offered.
- Quotes from an earlier copy are labelled "From an earlier copy of the abstract", and **Show copy N** opens that copy, read-only (§18). A new copy is saved only by **Use current abstract** (§19).
- A multi-step save is not one transaction (§8).
- **Creation across a reload is not exactly-once.** An unresolved create (§4) lives in memory only — browser persistence of request material is excluded by design — so a hard reload, closing the tab, signing out or leaving the Dashboard forgets it. Afterwards the dialog reads the paper's studies afresh and names those that exist before offering a creation, so a record the lost attempt created is found and opened rather than silently created again. It cannot disprove an attempt the server was still processing at that moment, and a user may still create another deliberately. Exactly-once creation across a reload would need a durable request identity (a persistent operation journal), which needs its own privacy and lifecycle review and is not built.
- The server remembers a request id only while its study exists ([evidence-records-lifecycle.md](evidence-records-lifecycle.md) §5): if the study an unresolved attempt created is deleted elsewhere before the retry, the retry creates it again.
- C1 had one owner-pilot Production acceptance on 2026-10-23 (§13). Later qualified Production acceptances covered Review (§15), History (§17), and combined source comparison and rebase (§20). Operations, failure paths, limits and device scenarios not exercised in those acceptances remain supported by the relevant automated tests, not by Production acceptance evidence.

PR-C2 is three phases. **C2A — Review** (Confirm and Flag, `evidence_review_fields`) is §14. **C2B — History** (a read-only view of `evidence_events`) is §16, merged and deployed, with its qualified Production acceptance in §17. **C2C** is two phases, both merged and deployed: **C2C-A** (the read-only source comparison and earlier saved copies) is §18, and **C2C-B** (**Use current abstract**, `evidence_rebase_source`) is §19. Their combined Production acceptance, with limitations, is §20. The Evidence Matrix integration is later still. The boundary test fails if the Study Record UI reads `evidence_events` anywhere but the history read module, or sends the rebase from anywhere but the editor hook.

## 13. Production acceptance (2026-10-23)

The report of EVIDENCE-RECORDS-001C1-PROD-ACCEPTANCE-EXEC-001 gives the verdict `EVIDENCE_RECORDS_001C1_PROD_ACCEPTANCE_PASSED` and discloses four qualifications. The documentation classifies the result as **`EVIDENCE_RECORDS_001C1_PROD_ACCEPTANCE_PASSED_WITH_QUALIFICATIONS`**: the owner-pilot workflow below succeeded, and nothing beyond it was accepted. The Product Owner performed every action in their own browser, through the normal Production interface. The audits between stages were read-only. No test automation, service-role browser access or direct database write was used. The identities and the cleanup record are in [migration-history.md](migration-history.md).

**Verified Production operation.** On one synthetic canary paper (title prefix `SR-C1-CANARY-`, a fictional abstract), the owner:

1. added the paper by hand;
2. started a study record: *Yes*, the paper reports an original study, in the `non_intervention` family;
3. created it, which saved an immutable copy of the abstract;
4. recorded **Who took part** (`population_description`) as Reported, with one supporting quote selected in the saved copy;
5. saved explicitly with **Save draft**, reloaded the page and reopened the record, which still held the value and its quote;
6. tried to delete the paper, and the interface refused, offering no Delete (§10);
7. deleted the study record: the dialog closed, and the paper stayed;
8. deleted the canary paper.

**Verified database state** (read-only, after each stage):

- **Create:** one study at version 1, one `user_confirmed` link, and one saved abstract copy byte-identical to the library abstract. Four events: the request header, `study_created`, `link_created` and `source_captured`.
- **Save:** study version 2, and one Reported study-level value, `unreviewed`. It has one supporting abstract anchor, the server's match: the unique occurrence at normalized offsets `[215,274)`. Six events in all.
- **API logs:** exactly one create, one save and one study-delete RPC. The refused paper delete sent only the precheck's read, never the delete RPC.
- **After cleanup:** no evidence row and no `SR-C1-CANARY-%` paper. The owner's library, storage and usage counts, the ledger, the function bodies, privileges and advisors all equal the baseline taken before the run.

**Qualifications.**

- **Attempt 1 stopped.** The first canary paper was created with a 32-character MD5 check value as its abstract. That was a test-instruction error, not an application defect. The run stopped before any study-record write, the paper was deleted through the interface, and its cleanup was audited. Attempt 2 ran under a separate Product Owner authorization.
- **The thin space was not exercised.** In attempt 2 the fixture's U+2009 THIN SPACE was stored as U+0020 SPACE. The Product Owner authorized continuing with that amended fixture, whose abstract and quote were re-verified against the installed matcher, still at `[215,274)`. U+2265 `≥` and U+00B2 `²` were exercised; **thin-space preservation was not**. No application-level cause of the substitution has been established, and it is not recorded as a defect.
- **Paper deletion: frontend precheck only.** The refusal came from the interface's check (§10). The server's NO ACTION key, and the race in which a link appears after the check, were not exercised in Production. They rest on the installed key definition and the disposable local E2E.
- **The audit connection dropped** between source capture and Save. The test paused, and after reconnection a read-only check found nothing had changed. No Study Record defect was shown.

**Not exercised in Production, so covered only by the Vitest suites and the disposable local E2E:** an unknown create outcome and its recovery (§4); an unknown save outcome; a multi-step save (§8); version-conflict recovery; full-text references; several study records on one paper; link and header-only edits (`evidence_set_link`, `evidence_update_study`); the selection and duplicate-merge safeguards; the paper-delete race (§10); thin-space preservation. The reload limit (§12) was not exercised either, and it remains a limit.

**Not yet implemented:** PR-C2's review, history and rebase interface (§12).

## 14. Review (EVIDENCE-RECORDS-001C2A)

> **Status:** merged and deployed (EVIDENCE-RECORDS-001C2A, PR #355, 2026-10-24), with no migration, secret or Edge Function. It is the first interface that calls `evidence_review_fields`. It is covered by the Vitest suites and the disposable local E2E. On 2026-10-24 one synthetic-canary Review workflow passed in Production, with qualifications (§15).

**What a review means.** "Reviewed by you" records that the user pressed **Confirm against this source** on one saved value, at its exact `value_version`, while the value and its source were shown together (001A §I2). It does not mean PaperLume verified anything, and nothing says "verified", "accurate" or "correct". There is no automatic, bulk or record-level confirmation, and saving is never a review. Changing a saved value resets its review on the server; replacing a saved copy sends abstract-dependent values to Needs re-review ([evidence-records-field-operations.md](evidence-records-field-operations.md) §4–§5).

**Modes.** The dialog opens in **Edit**; the **Review** tab sits beside it, and **History** (§16) after it ("Study record mode"). Edit and Review stay mounted, so a draft and a half-typed Flag note survive switching.

**What Review shows.** Everything comes from the record as saved (`reviewModel.ts`), never from the draft.

- **The summary** counts the recorded fields by their own status: Not reviewed, Reviewed by you, Flagged, Needs re-review. It also says how many can't be confirmed yet, with the standing sentence "Saving is never a review, and PaperLume doesn't check your interpretation." There is no percentage and no verdict on the record.
- **The filter** is *Needs your review* (the default: everything not reviewed at its current version) or *All recorded*. It changes only what is shown.
- **One card per saved value**, grouped by the dictionary's sections, then by group and outcome in saved order and under their saved names. A card shows:
  - the value and state as saved, with its note;
  - the status as an icon and in words ("Reviewed by you on ‹date›", from the server's `reviewed_at`), the flag's note, or the earlier note of a value needing re-review;
  - its sources, each naming its paper and copy ("copy 1 of 2, saved ‹date›"). Quotes carry about a sentence of context, located by the server's stored offsets and not by a new search. Full-text references read "your reference — check it in your copy; PaperLume doesn't". Examined and couldn't-check sources are listed too, with "From the abstract only" where it applies.
- **The Source pane** (desktop) highlights only the SAVED quotes of the card being reviewed and offers no "Use as quote". A source on an earlier copy is named as such and never highlighted in the current copy; **Show copy N** opens that copy in the pane, read-only, with the card's quotes on it marked (§18).
- **On a phone** Review has no Source tab. Each card shows its quotes in context and **Show the saved abstract**, which puts the copy beside the claim (001A §I3), as a Not reported or Couldn't check claim needs.

**Actions.** Only the pilot owner gets them. A manager or a former owner sees every value and status, and no action; the server refuses a direct call (`42501 evidence_records_not_enabled`).

- **Confirm against this source** is for one value at the version shown. It is offered only when all of these hold:
  - the user may write, and nothing else is in flight or in doubt;
  - the record has not changed elsewhere;
  - the value has no unsaved edit, and its group or outcome is not waiting to be removed;
  - PR-B's `checkConfirm` allows it, with an empty list of sources never counting as the support a state needs.

  Otherwise the button stays focusable (`aria-disabled`), and the reason is written beside it and linked to it ("This field has unsaved changes. Save or undo them to review it.", "Add a quote from the saved abstract or a full-text reference, then save."). A version already reviewed has no Confirm. On a flagged value the button says "Confirming replaces your flag and its note." Once recorded, the result is announced, and focus moves to the next value that needs review (Confirm & next), or to the summary when none is left.
- **Flag…** opens a labelled note of 3–2,000 characters, checked by `checkFlag`. An existing flag prefills it, and **Update flag** waits until the note changes. Escape cancels and returns focus to the button.
- **Edit** switches to Edit, opens the field's section (and More details), and focuses the field.

**Requests.** Every press is one `evidence_review_fields` call, prepared once with a new request id, from the editor hook (`useStudyRecordEditor`) and nowhere else. It sends the study version the editor knows and the card's value version, and the record is read back after the answer. The answers:

| Answer | What happens |
|---|---|
| `applied`, `replayed`, `unchanged` | the record is read back, and every unsaved edit stays exactly as it was (a review changes no `value_version`) |
| outcome unknown, database busy or unreachable, session ended | The prepared request is kept and every other write waits. The editor says "We couldn't tell whether your review was recorded. Try again — it won't be recorded twice." (or, when nothing was applied, why). **Try again** resends the same request, which the server replays if it was recorded; **Reload** abandons it. Nothing is retried automatically. |
| `version_conflict` | nothing is recorded; Reload (asking first if the draft has unsaved changes) |
| `confirm_blocked` | the server's reasons replace the browser's, on the card |
| `records_not_enabled`, `study_not_found` | read-only from then on; the record is gone |

**Locks.** A review in flight or in doubt holds Save, link changes, Delete, typing and every other review. A save, link change or deletion in flight or in doubt holds every review. A conflict or a change seen elsewhere holds them until Reload.

**Wording.** Review's sentences are in `reviewCopy.ts`; the Confirm-block messages are PR-B's ([evidence-domain-library.md](evidence-domain-library.md) §5). Before C2A merged (EVIDENCE-RECORDS-001C2A-MERGE-001, 2026-10-24), the Product Owner accepted this wording and the phone layout above: Edit and Review modes, no Source tab inside Review, and each card's saved sources and **Show the saved abstract**.

**Tests.**

- **Vitest:** `reviewModel.test.ts`, `useStudyRecordReview.test.tsx`, `StudyRecordReview.test.tsx` and `reviewCopy.test.ts`, plus the boundary test. That test allows `reviewField` and `prepareReviewField` in the editor hook only, and still forbids the rebase; history is read in the history read module only (§16).
- **E2E:** `e2e/study-records-review.spec.ts` has its own disposable fixture, `scripts/e2e-local-review-fixture.mjs`. Afterwards it proves, as the database owner, each value's status, note, versions and review events, then removes its accounts and verifies they are gone. The `e2e-evidence` job runs it after the C1 spec: `npm run test:e2e:local -- e2e/study-records.spec.ts e2e/study-records-review.spec.ts`.
- **Fixture selection:** the lifecycle asks Playwright which files it will run, and gives each Evidence Records spec its own fixture (`scripts/e2e-local-spec-selection.mjs`). An Evidence Records spec without one fails closed.

**Limits.**

- Earlier copies are not shown beside the current one; each opens on its own, read-only (§18).
- An unknown outcome is abandoned if the dialog closes or the page reloads. The re-read shows whether it was recorded, and pressing again is safe: a version already reviewed has no Confirm, and the same Flag note sends nothing.
- Each review reads the whole record back.
- The record is read by several parallel SELECTs. A change made at that moment can show a mixed view, but any write is then refused as a version conflict.

## 15. Review — Production acceptance (2026-10-24)

The report of EVIDENCE-RECORDS-001C2A-PRODUCTION-ACCEPTANCE-001 gives the verdict **`EVIDENCE_RECORDS_001C2A_PROD_ACCEPTANCE_PASSED_WITH_QUALIFICATIONS`**: the Review workflow below succeeded, and nothing beyond it was accepted. It ran on the deployed C2A build (PR #355, `main` at `0ba43a17`). The Product Owner performed every action in their own browser, through the normal Production interface: on a computer, and on their own phone for the phone check. The audits between stages were read-only. No test automation, service-role browser access or direct database write was used. The identities and the cleanup record are in [migration-history.md](migration-history.md).

**Verified Production operation.** On one synthetic canary paper (title prefix `SR-C2A-CANARY-`, a fictional abstract), the owner:

1. added the paper by hand and created a study record: *Yes*, in the `non_intervention` family;
2. saved **Who took part** as Reported, with one quote selected in the saved copy, and **Setting** as Reported, with no source;
3. opened the record, which started in Edit, and switched to Review:
   - the summary counted two fields Not reviewed, and *Needs your review* was the default filter;
   - Setting gave its reason: "Add a quote from the saved abstract or a full-text reference, then save.";
   - pressing Setting's held Confirm sent nothing;
4. pressed **Confirm against this source** on Who took part. It showed "Reviewed by you on ‹date›", and after a reload it still did, with no Confirm for that version;
5. flagged Setting:
   - a two-character note was refused;
   - a valid note was recorded;
   - the reopened form was prefilled, and sent nothing while the note was unchanged;
   - a changed note updated the flag;
6. edited Who took part without saving. Review still showed the saved value and quote, and held the card's actions ("This field has unsaved changes. Save or undo them to review it."). The draft survived switching back to Edit;
7. saved the edit. Who took part returned to Not reviewed at its next version, still citing the same quote, and Setting kept its flag;
8. on a phone:
   - saw one row of mode tabs and no sideways scroll;
   - opened **Show the saved abstract**;
   - opened the Flag form and cancelled it;
   - confirmed the new version of Who took part;
9. deleted the study record, then the canary paper.

**Verified database state** (read-only, after each stage):

- **Create and save:** the create made version 1, with four events; the save made version 2, with two `value_saved` events. The saved copy is byte-identical to the library abstract. The quote is the server's own match: the unique occurrence at normalized offsets `[115,185)`.
- **Reviews:** each press is one request at the next study version, with one event, and the value itself is unchanged.
  - Confirm: `review_confirmed`; `user_reviewed`, with `reviewed_version` 1 (version 3).
  - Flag: `review_flagged`; `disputed`, with the note (version 4).
  - Changed note: `review_flagged` (version 5). Each event stores its note as a digest.
  - Save of the edited value: `value_saved`; `value_version` 2, review back to `unreviewed`, and no review event (version 6).
  - Confirm of the new version: `review_confirmed`, with `reviewed_version` 2 (version 7).
- **API logs:**
  - **Reviews:** four `evidence_review_fields` calls, one per deliberate press. None came from opening Review, the held Confirm, the refused or unchanged notes, or the cancelled phone form.
  - **Other writes:** one paper insert, two saves, one study delete and one paper delete.
  - **Excluded:** no Edge Function or Storage call.
- **After cleanup:** no evidence row and no `SR-C2A-CANARY-%` paper remain, checked by exact identifiers. Everything else equals the baseline taken before the run:
  - the owner's library, storage and usage counts;
  - the ledger, the function bodies and the privileges;
  - the Security Advisor findings.

**Qualifications.**

- **One log row is missing.** The API log never showed the create RPC's POST, only its CORS preflight. The database holds exactly one create request, so the gap is in the log, not in the application.
- **The phone check is observational.** It rests on the Product Owner's report, one screenshot and the API log. Touch-target sizes were not measured in Production; the phone E2E measures them locally.
- **Reviewing another field during an unsaved edit was checked in the interface only.** That was allowed, so as not to record a redundant review event. The disposable local E2E covers it (R4).

**Not exercised in Production, so covered only by the Vitest suites and the disposable local E2E:**

- an unknown review outcome and Try again;
- version-conflict refusals, and the server's own Confirm refusal (`confirm_blocked`);
- Confirm of a flagged value;
- full-text references, and examined or couldn't-check sources;
- Needs re-review;
- the read-only view of a non-owner.

History (C2B) and rebase (C2C) are not implemented.

## 16. History (EVIDENCE-RECORDS-001C2B)

> **Status:** merged and deployed (EVIDENCE-RECORDS-001C2B, PR #358, 2026-10-30), with no migration, RPC, secret or Edge Function. It is covered by the Vitest suites and the disposable local E2E. On 2026-10-30 one synthetic-canary History workflow passed in Production, with qualifications (§17).

**What History is.** A read-only list of the record's committed operations — every request that changed it — newest first, each with the changes it recorded. It is built from `evidence_events` alone, never from the record's current state: it shows what happened, when, and which saved field, group, outcome, link or source it touched. It is not a reconstruction of an editing session, nor a certification of anything. It sends no write, its pane offers no Save, Confirm or Flag, and it changes nothing it shows.

**What history holds** ([evidence-records-field-operations.md](evidence-records-field-operations.md) §9). One header per committed request (ordinal 0) and its change events (ordinals 1..n), all at the study version the request produced. The study name and the names of groups and outcomes are stored as written; codes, whole numbers, states, review statuses, ids, versions and copy numbers in clear; every other user text — values, list entries, notes, review notes, locators — and every quote only as a SHA-256 and a length. So:

- **A digest is not text.** History can say that a value's text, a note or a quote changed — the fingerprints are compared for equality, then dropped — and never what it said: "Earlier text isn't stored in History." It never decodes, reverses or reconstructs text, and no fingerprint, request id, payload fingerprint, stored result or internal id reaches the screen.
- **Today's names are called today's.** A value event names its group or outcome only by id, and a link event its paper. History shows the current name, marked "now named" or "now titled", or says the group, outcome or link is gone. No current value, note or review note ever stands in for an earlier one.
- **Reviews as recorded.** "Reviewed by you" is one Confirm of one saved value. A Flag says its note isn't kept. A save that cleared a review says so ("Previously reviewed by you — saving this change reset the review."): the reset is recorded in `value_saved`, and `review_reset`, which no installed RPC writes, is never interpreted. A rebase's events — a new copy, quotes found again or kept on their copy, values sent to re-review — are described from their metadata only; no earlier copy is loaded.
- **Unreadable details stay unread.** Each digest is checked, field by field, against the rules of the RPC that wrote it. An event that fails is shown by its type alone, with "The details of this change can't be shown." Unknown fields are ignored and never shown.

**Entries.** Each operation shows a title, its date and time (with the time zone) and the record version it produced; **Show details** opens its changes. The titles map the request ops one to one: Study record created, Study details updated, Changes saved, Review recorded, Linked paper changed, Saved abstract copy updated.

**Reading.** `src/lib/studyRecord/historyRead.ts` is the only module that reads `evidence_events`; the boundary test refuses that table anywhere else.

- **Operations** are paged by version, ten at a time: headers only (`ordinal = 0`), `study_version < cursor`, newest first, with one row of look-ahead. The projection is `id, user_id, study_id, study_version, ordinal, event_type, request_id, op, occurred_at` — never `payload_sha256`, `result` or `note`. The request id is read only to check that the changes shown under an operation are its own.
- **An operation's changes** are read only when it is opened: the same user, study and version, `ordinal > cursor`, in pages of 50 with the same look-ahead, so a large save is shown in parts and never cut short. Each change must carry its operation's request id and continue its ordinals without a gap. Anything else is refused, never attached to a neighbouring operation.
- Every query also names the caller and the study, under the owner-only RLS policy. Every row is mapped by PR-B's `mapEventRow` and checked; a failure says that the data "did not pass a consistency check" and shows nothing from it.

**States.** Loading; a failed read ("Couldn't load this study record's history.", with **Try again**), which is never shown as an empty history; empty, only when the study exists and nothing is recorded; more history (**Load older entries**); the beginning; and gone ("This study record no longer exists, so its history can't be shown."). Every study has history from its creation, and events leave only with their study. So a read that finds nothing where something must be asks whether the study still exists, and a deleted record — or another user's, which reads the same — shows nothing.

**Freshness and concurrency.** History is read on demand. The pane mounts only while History is chosen, and its queries keep nothing once it unmounts, so every opening reads afresh: after a Save, Confirm, Flag or link change, the new operation is there. While it is open:

- each of the editor's own writes reads the list again, because they invalidate every study-record read of the user;
- a change made in another tab or window appears on **Refresh**, which reads the newest page again and drops the older pages read so far — one request, however far back the user had read;
- **Load older entries** reads below the oldest version shown, never by offset, so an operation committed meanwhile can neither repeat nor push out an older one; after a failure it asks for the same page again;
- an operation's changes are committed once, and are not read again while it stays open.

The cache keys are user-scoped (`queryKeys.studyRecords.history` and `historyOperation`), so one account is never shown another's history, and nothing of it outlives the pane.

**Who sees it.** Every signed-in user who can open the record. History reads the user's own rows and is not gated by the pilot: a former owner, now a manager, reads their record's History and cannot write it (the server refuses with `evidence_records_not_enabled`). A manager's role gives no access to anyone else's History: RLS returns a user's own rows only.

**Layout and accessibility.** History is the third mode tab. On a desktop it takes the full width: the Source pane is hidden, still mounted, so its selection is kept. On a phone it is a full-screen mode of its own. The dialog's footer — **Delete study record**, the save status and **Save draft** — belongs to the whole dialog and stays visible in every mode, History included. Edit and Review stay mounted, so a draft and an open Flag note survive switching. Entries are an ordered list of articles with headings. Each **Show details** button is named after its entry and carries `aria-expanded` and `aria-controls`. Load older moves focus to the first entry it added and announces how many; Refresh announces itself; after **Try again** focus goes to the History heading. Long names wrap, nothing scrolls sideways, and the controls follow the app's `coarse:` touch sizing.

**Tests.**

- **Vitest:** `historyRead.test.ts` (pages, cursors, look-ahead, appends between pages, empty, gone, integrity, the projection); `historyModel.test.ts` (every event type, malformed and unknown shapes, missing targets, review transitions, source events); `historyModel.parity.test.ts` (the digest and event shapes the tests use, parsed from the two migrations' SQL); `historyCopy.test.ts` (titles, wording, what History never says, dates); `useStudyRecordHistory.test.tsx` (the cache lifecycle, a change of user, Refresh, retry, invalidation); and `StudyRecordHistory.test.tsx` (the dialog: modes, details, paging, failures, read-only use, a draft and a Flag note kept, phone and desktop layouts). The boundary test lifts only the C2B read restriction, and its negative controls refuse a history write, an unscoped or private-column read, and a read from any other module.
- **E2E:** `e2e/study-records-history.spec.ts`, with its own disposable fixture, `scripts/e2e-local-history-fixture.mjs` (accounts `e2e-disposable-srh-…`). The fixture writes twelve operations through the installed RPCs — never into `evidence_events` — and the spec covers the order, a creation (and a record created in the browser), a Save, a Confirm, a Flag, a save that resets a review, read-only traffic and scoped reads, paging, an operation's own changes, a large save's changes in two parts (52, on the former owner's record), a former owner, Refresh after a write made elsewhere, a failed read, and the phone layout. Afterwards the lifecycle proves, as the database owner, every committed operation of the history study with its own events — the fixture's twelve and exactly the spec's five, so the viewer wrote nothing — then removes the accounts and verifies that nothing of theirs remains. At the C2B release, the `e2e-evidence` lane ran the three C1/C2A/C2B specs. The current lane also runs `e2e/study-records-source-compare.spec.ts` and `e2e/study-records-rebase.spec.ts`; see `.github/workflows/e2e-local.yml`.
- **C2B-specific E2E scope:** the original `study-records-history.spec.ts` does not exercise rebase events, and its fixture never calls the rebase RPC; C2C-B had no interface when C2B shipped. The separate C2C-B E2E exercises source rebase and first-capture History behavior (§19). The History Vitest suites also cover rendering against the event shapes defined by the migration.

**Limits.**

- History shows what each operation recorded, not the record at an earlier time: no earlier text, quote, note or copy can be recovered from it. An earlier copy is read from the copy itself (§18), never from History.
- The name of a group, an outcome or a paper in a value or link event is today's, or "since removed".
- Refresh drops the older pages read so far.
- An operation's changes can't be filtered or searched, and a large save is shown 50 changes at a time.
- Production acceptances exercised History's core workflow (§17) and its rebase and first-capture entries (§20). Paging, failure recovery and other scenarios not exercised in Production remain covered by the relevant Vitest suites and disposable local E2E.

C2C-A — the read-only source comparison and earlier copies — is §18. C2C-B — **Use current abstract** and `evidence_rebase_source` — is §19.

## 17. History — Production acceptance (2026-10-30)

The report of EVIDENCE-RECORDS-001C2B-PRODUCTION-ACCEPTANCE-001 gives the verdict **`EVIDENCE_RECORDS_001C2B_PROD_ACCEPTANCE_PASSED_WITH_QUALIFICATIONS`**: the History workflow below succeeded, and nothing beyond it was accepted. It ran on the deployed C2B build (PR #358, `main` at `fe6d2b0f`, Vercel deployment `dpl_2MdMPQcek3izv2bife5ENVpxvi1H`). The Product Owner performed every action in their own browser, through the normal Production interface: on a computer, and on their own phone for the phone check. The audits between stages were read-only: SQL in read-only transactions, and content-free API-log counts of each request's method, path and status, which stood in for the browser's network panel. No test automation, service-role browser access or direct database write was used. The identities and the cleanup record are in [migration-history.md](migration-history.md).

**Verified Production operation.** On one synthetic canary paper (title prefix `SR-C2B-CANARY-`, a fictional plain-ASCII abstract), the owner:

1. added the paper by hand and created a study record: *Yes*, in the `non_intervention` family. The editor opened in **Edit**, with the tabs **Edit | Review | History**;
2. saved **Who took part** as Reported, with one quote selected in the saved copy, and **Setting** as Reported, with no source;
3. opened **History**, read both entries and opened their details, then went back to Edit, pressing nothing else;
4. confirmed Who took part, flagged Setting, and changed the flag's note. The reopened Flag form sent nothing while its note was unchanged. After each review, History's newest entry was the new one;
5. edited Who took part without saving and opened History, which still showed the previous newest entry (the Product Owner's report). Back in Edit the draft was intact, and saving it recorded exactly the draft's text;
6. confirmed the new version of Who took part;
7. read the full chronology with every entry open, pressed **Refresh**, reloaded the page and reopened History, and switched History → Edit → Review → History;
8. opened the record's History on a phone (iPhone, Chrome): its details, **Refresh** and the mode switch;
9. deleted the study record, then the canary paper.

**What History showed** (the Product Owner's screenshots, checked word for word against the stored events). Each entry gave its title, its date and time with the time zone ("Oct 30, 2026, 10:38 AM GMT+2") and "Record version N". Below the seventh came "This is the beginning of this study record's history.", with no **Load older entries**.

| Version | Entry | Its details |
|---|---|---|
| 7 | Review recorded | "Who took part: reviewed by you" |
| 6 | Changes saved | "Who took part: text changed", then "Previously reviewed by you — saving this change reset the review." and "Earlier text isn't stored in History." |
| 5 | Review recorded | "Setting (countries, care setting): flagged", then "The flag's note changed." and "History doesn't keep the text of notes." |
| 4 | Review recorded | "Setting (countries, care setting): flagged", then "History doesn't keep the text of notes." |
| 3 | Review recorded | "Who took part: reviewed by you" |
| 2 | Changes saved | Setting "recorded as Reported — a text of 27 characters" with "No source given."; Who took part "recorded as Reported — a text of 36 characters" with "Sources: 1 quote from a saved abstract."; each with "The text itself isn't stored in History." |
| 1 | Study record created | the creation under the canary's name, with its kind of study; the link to the paper "now titled" the canary title, "as confirmed by you"; "Copy 1, 390 characters. History doesn't keep the copy's text." |

No value, note, quote or abstract text, and no identifier or fingerprint, appeared in History. The footer's **Delete study record** and **Save draft** stayed visible in History (§16); no write was sent from History.

**Verified database state** (read-only, after each stage):

- **Operations.** Seven requests, versions 1–7, 17 events. Each request wrote one header at ordinal 0 and its changes at gapless ordinals, under one request id and one timestamp; its operation, version and changes are the ones History showed. The create wrote `study_created`, `link_created` and `source_captured`. The first save wrote `value_saved` for Setting, then for Who took part, whose quote is the server's match at normalized offsets `[115,185)`.
- **Reviews.** Each left its value unchanged.
  - Confirm: `review_confirmed`, with `reviewed_version` 1.
  - Flag: `review_flagged`; the changed note, a second `review_flagged`.
  - Save of the edit: one `value_saved` from `user_reviewed` to `unreviewed` at `value_version` 2, with the quote reference unchanged and no review event.
  - Confirm of the new version: `review_confirmed`, with `reviewed_version` 2.
- **Digests.** Every value text, note and quote is stored only as `{sha256, chars}`, and each digest equals the SHA-256 of the fictional text entered.

**Read-only proof.** A fingerprint of every canary row — the study, its events, values, anchor, saved copy and link, and the paper — was taken before and after the first History check, and before and after the full one (steps 7–8). Both pairs are equal.

- **History's reads** in the API log were `GET /rest/v1/evidence_events` only.
- **No write came from History.** Neither interval holds an Evidence RPC, a table insert, update or delete, or an Edge Function or Storage call. Their only POSTs are the app's three read RPCs on each page load (STABLE functions with no write statement) and one Auth token request: the owner's session doing its own sign-in bookkeeping.
- **The draft visit** (step 5) was read before that stage's only write, the save.
- **Across the run,** the log shows one request per deliberate write: one paper insert, one create, two saves, four reviews, one study delete and one paper delete. Postgres logged no error or warning.

**After cleanup:** no evidence row and no `SR-C2B-CANARY-%` paper remain, checked by exact identifiers. These equal the baseline taken before the run:

- the ledger, the function bodies, table privileges, RLS and policies, the paper key and the Security Advisor findings;
- the owner's 703 papers and their latest update;
- Project and Tag assignments, attachments, author links, the cleanup queue and tombstones, storage bytes and objects, and AI usage;
- the account count.

**Qualifications.**

- **The phone check is observational.** It rests on the Product Owner's report and the API log, which shows only reads in that window. There is no phone screenshot, and touch-target sizes were not measured in Production; the phone E2E measures them locally.
- **The audit connector dropped twice:** before the baseline, and before the first History check's closing fingerprint. The test paused each time. The fingerprint taken after reconnection covers the whole interval, so the read-only proof stands.
- **One baseline value changed, not through this test.** The validity of the Supabase CLI's login role, `cli_login_postgres`, moved to 08:15 UTC that day. That is consistent with a CLI command run against the linked project at about 08:10. The test ran no CLI command, Postgres logged nothing from that role during the run, and no other compared value changed.

**Not exercised in Production, so covered only by the Vitest suites and the disposable local E2E:**

- **Load older entries** and **Show more changes**: the canary had seven operations, fewer than a page of ten, and no operation had more than three changes;
- an operation committed elsewhere while History is open, and Refresh picking it up;
- a failed read and **Try again**, the consistency-check refusal, and the "no longer exists" state;
- a former owner's History, and another user's isolation;
- the titles and details of **Study details updated**, **Linked paper changed**, group and outcome events, and every rebase event (C2C has no interface).

## 18. Source comparison and earlier copies (EVIDENCE-RECORDS-001C2C-A)

> **Status: merged and deployed; Production-accepted with limitations.** PR #360 merged on 2026-10-30 as `d41413db` and is live on `app.paperlume.app` (first deployed as Vercel `dpl_HEAjLZV1NutXjjkaVQkoTDKfRDA7`). On 2026-10-31 it passed one authenticated Production acceptance together with C2C-B, with limitations (§20; **Release**, at the end of this section). No migration, RPC, grant, secret or Edge Function. C2C-B — **Use current abstract**, the interface for the installed `evidence_rebase_source` — is §19.

C2C-A makes a change to the library abstract visible without changing the record. It adds three read-only things to the Source pane. Edit, Review and History stay the only modes, and nothing here writes: comparing is for information only, and the record keeps its saved copy, its quotes, its reviews and its versions.

**The source status.** Above the saved copy, a banner says how the copy relates to the abstract in the library now, as `deriveSourceState` (`src/lib/evidence/sources.ts`) classifies the last read:

| State | Shown when | The banner |
|---|---|---|
| `current` | the two are equal, character for character | "Same as the abstract in your library, character for character." |
| `typography_only_change` | equal only after normalization v1 | the characters quote matching treats as the same, and that this is a technical comparison, not a check of meaning; **Compare** |
| `content_change` | different after v1 | an amber notice that the library abstract changed; **Compare** |
| `abstract_removed` | the library abstract is gone, or empty after v1 | the record keeps its saved copy; nothing to compare |
| `abstract_now_available` | no saved copy, and the library has an abstract | the record has no copy, so it can't be quoted; **Show the library abstract** |
| `no_copy_no_abstract` | neither | the domain message |

- **Typography-only** is equality after normalization v1 — NFC; soft hyphen, zero-width space, word joiner and byte-order mark removed; white space collapsed; curly quotes, dashes, the ellipsis and the micro sign mapped. It never says the two texts mean the same thing.
- **Too long (G1).** Every state that could lead to a new copy — `abstract_now_available`, `typography_only_change` and `content_change` — now carries `capture`. A library abstract over 50,000 characters (code points, as PostgreSQL's `char_length`) is `refused_too_long` whichever way it differs, and the banner adds that a copy can't hold it. Before C2C-A only `abstract_now_available` was gated.
- **A read that hasn't answered is not an answer.** While a read is on its way the banner says "Checking…". After a failure it says so — one worth trying again soon (no answer, or the server busy), a refusal, or an answer that failed a check — with **Check again**, even when an earlier read succeeded. A paper that can't be read is "couldn't be read", never "removed". The saved copy never stands in for the library abstract.
- In Review the banner shows the state only: comparing is Edit's.

**Compare** (Edit only; on a phone, in the Source tab) has three readings, one at a time, each full width:

- **Changes** — a word-level comparison. Text only in saved copy N is struck through, text only in the library abstract is underlined, and each is also labelled for screen readers ("Only in the saved copy: …", "Only in the library abstract: …"), so neither colour nor decoration is the only signal. White space and invisible characters that changed are named ("no-break space", "soft hyphen", "line break"), and two sides that look the same but are stored differently (an accent composed or not, the micro sign and mu) say so. A summary counts the places and words that differ; **Previous change** and **Next change**, in a bar that stays in reach while the text scrolls, move focus to each change.
- **Saved copy N** — "the abstract currently saved with this study record", in full and exact.
- **Library abstract** — "the abstract currently stored in your paper library", in full and exact, read just now.

Opening Compare reads the library again, and so does **Check again**. A view the user opens — Compare or a saved copy — takes focus at its heading; one shown again after a mode switch leaves focus where the user put it. **Back to the saved copy** returns focus to the pane's heading. Every text is rendered as plain text nodes with `white-space: pre-wrap`; nothing is injected as HTML.

**Earlier saved copies.** When a link has more than one copy, **Saved copies of this abstract (M)** lists them, newest first, from the record's metadata — number, date and length. **Show copy N** opens one: its number, date and length, its exact text, and the saved quotes that name it, marked by their own stored offsets mapped through that copy's own text. A quote of one copy is never marked on another. An earlier copy is read-only: there is no **Use as quote**, and new quotes come from the current copy. A copy also opens from a field's sources in Edit ("From an earlier copy of the abstract" → **Show copy N**), from Review's source focus on a desktop, and inside the Review card on a phone. History stays separate and digest-based: no text is ever rebuilt from it.

**Reads.** Two owner-scoped SELECTs, both in `src/lib/studyRecord/read.ts`, both through the authenticated client:

- `fetchLinkedPaperAbstract` reads one paper's `id, user_id, abstract` by `user_id` and `id`. It accepts at most one row, of this user and this paper, whose abstract is null or text PostgreSQL could hold; anything else is an integrity failure. No row resolves to null.
- `fetchSavedCopy` reads one copy by `user_id`, `study_id`, `paper_id` and `id`, maps it with PR-B's `mapSourceSnapshotRow`, and requires its paper, sequence number, capture time and length to equal what the record already holds. No row resolves to null ("no longer saved with this record").

Their hooks are in `useStudyRecords.ts`, under user-scoped keys beside the record's:

| Hook | Key | Read when | Kept |
|---|---|---|---|
| `useLinkedPaperAbstract` | `studyRecords.libraryAbstract(userId, paperId)` | while the Source pane shows that link — on a desktop in Edit and Review, on a phone while the Source tab is shown; never in History. Again each time the pane is shown again, on Compare, on **Check again**, and after any study-record write | never as fresh (`staleTime: 0`), not once nothing shows it (`gcTime: 0`), not on focus or reconnect |
| `useSavedCopy` | `studyRecords.savedCopy(userId, studyId, snapshotId)` | when the user opens that copy | never refetched while shown (a copy never changes), not once closed |

The shared `useAbstract` cache (`papers.abstract`) is not used: its key is not per user, and other screens keep it warm. One account is never shown another's answer, and switching paper, copy or account reads afresh. The comparison is informational: the library can change the moment after it is read.

**Selection safety (G2).** A selection in the Source pane, a choice between occurrences and its message belong to one copy, shown in one view. Another linked paper, another current copy (after a reload) or another view — Compare or an earlier copy — drops them before anything renders, and clears the browser's own selection in the pane. **Use as quote** also refuses a selection made in any other copy or view, and the **Add quote** panel starts afresh for another copy. Server-side quote matching is unchanged.

**The comparison algorithm** (`src/lib/studyRecord/sourceDiff.ts`, no dependency). Both texts are split into tokens — white space, runs of letters, marks and digits, and each other character with its marks — whose concatenation is the text; both texts can always be read back from the comparison exactly. The common start and end are set aside, and the middle goes through Myers' O(ND) shortest edit with a fixed budget: at most 1,500 tokens inserted or deleted (about 750 changed words) and at most 1,000,000 steps. Past either, the reading says the texts differ in too many places to show one by one, and offers both in full. Measured on a desktop (Node 26, Apple silicon), median of five runs:

| Input (each side about 50,000 characters unless noted) | Time | Result |
|---|---|---|
| a 300-word abstract, 3 edits / 70 % of its words rewritten | 0.2 / 1.5 ms | compared |
| 3 edits / 1 % / 5 % of words changed | 4 / 5 / 9 ms | compared |
| a line break added in every sentence (≈ 500 changes) | 10 ms | compared |
| one sentence repeated, 1 / 20 copies changed | 1 / 4 ms | compared |
| 20 % of words changed; two unrelated abstracts; NFC against NFD throughout; every space doubled; a 200,000-character library abstract | 12–15 ms | too different: full texts |

A phone is a few times slower; the comparison runs only when the user opens it, once per pair of texts. It aligns by tokens: a moved passage shows as removed in one place and added in another.

**The boundary.** `src/test/studyRecordUiBoundary.test.ts` admits the two reads and nothing wider:

- every read of a named table must name its user (`.eq("user_id", …)`);
- `papers` is read in the two read modules only, by id, for `id, user_id, title` — or, in `read.ts` alone, `id, user_id, abstract`;
- `evidence_source_snapshots` is read in `read.ts` only, by user and study, with a literal projection; the reads are pinned exactly, the new one by user, study, paper and id;
- `fetchLinkedPaperAbstract`, `fetchSavedCopy` and their keys are used by `useStudyRecords.ts` alone, `papers.abstract` by no study-record module, and `useAbstract` by the create flow only;
- the rebase stayed forbidden everywhere: `rebaseSource`, `prepareRebaseSource`, `evidence_rebase_source` and `rebase_source`, in every new module and the editor hook. C2C-B (§19) lifts that for the editor hook's `rebaseSource` and `prepareRebaseSource` alone. Negative controls cover each rule.

**Who sees it.** Every signed-in user who can read their own record — a former owner, now a manager, included. RLS returns only the user's own papers and copies.

**Tests.**

- **Vitest:** `sources.test.ts` (every state, exact and v1 equality, Unicode and white-space edges, the 50,000-character gate in every state that could lead to a copy); `sourceDiff.test.ts` (read-back of both texts, minimality against an independent LCS on 400 random pairs, typography-only changes, the budget); `sourceReads.test.ts` (both reads: filters, cardinality, ownership, metadata, failures); `sourceCompareModel.test.ts`; `useStudyRecordSourceReads.test.tsx` (per-user keys, reading only while shown, nothing kept, never the shared abstract cache); `StudyRecordSourceCompare.test.tsx` (every banner state, failures and Check again, Compare's readings and navigation, earlier copies from each entry point, G2 across papers, views and a reload, an unsaved draft kept, no RPC, Review, phone, a former owner); and the boundary test.
- **E2E:** `e2e/study-records-source-compare.spec.ts`, with its own disposable fixture, `scripts/e2e-local-source-compare-fixture.mjs` (accounts `e2e-disposable-srsc-…`). The fixture writes its records through the installed RPCs and its library changes as the owner's own paper updates; it makes the earlier copies with the installed rebase, and inserts no copy, quote or event. The spec covers the six states, Compare's changes and readings, an earlier copy and its own quote, **Check again** after an edit made elsewhere, a selection dropped when another copy opens, the phone layout (no sideways scroll, reachable 40 px touch targets) and a former owner, whose direct rebase the server refuses. The traffic watch allows no study-record RPC. Afterwards the lifecycle proves, as the database owner, that both users' study records — copies, quotes and offsets, values, reviews, versions, events — are exactly as provisioned, and the library as provisioned but for the spec's own edit; then it removes the accounts and verifies nothing of theirs remains. The `e2e-evidence` job ran the four Evidence Records specs; since C2C-B it runs five (§19).
- **Not in the E2E:** switching between linked papers. No installed RPC links a second paper, so only the Vitest suite covers it.

**Bundle.** No new dependency and no code split (the boundary forbids dynamic imports). Measured on the files `app.paperlume.app` served before and after the release (`dpl_GkrvxtaA…` from `97558b18`, then `dpl_HEAjLZV1…` from `d41413db`), the entry script grew by 27.1 kB (7.9 kB with gzip -9) and the stylesheet by 1.1 kB (0.2 kB); every other asset was byte-identical. The 26.7 kB (7.8 kB gzip) in the PR description was a preliminary measurement, taken before its last two commits.

**Limits.**

- Replacing the saved copy — **Use current abstract**, its confirmation, the rebase and its recovery — is C2C-B's (§19).
- The library abstract can change right after it is read; **Check again** reads it again.
- Two texts that differ too much are offered in full, not change by change.

**Release (2026-10-30) and acceptance (2026-10-31).** The merge, its checks, the deployment and the post-merge database check are recorded in [migration-history.md](migration-history.md) (2026-10-30, EVIDENCE-RECORDS-001C2C-A). The acceptance is in §20, and its identities are in that file's 2026-10-31 entry.

| Stage | Status |
|---|---|
| Implemented | Yes |
| Merged | Yes — PR #360, `d41413db` |
| Deployed | Yes — first as `dpl_HEAjLZV1…` on `app.paperlume.app` |
| Automated tests passed | Yes — on the reviewed head and on merged `main` |
| Authenticated Production acceptance | Yes, with limitations — 2026-10-31, together with C2C-B (§20) |

Deployment alone did not accept it. The 2026-10-31 acceptance exercised, on desktop Chrome, source comparison by a signed-in user, earlier-copy navigation after a real rebase, and both reads under a real session and RLS. **Still not exercised in Production:** a physical phone or a phone-width layout, a screen reader, and a non-owner's or former owner's view. The disposable local E2E checks the phone layout in a narrow Chromium window, and a former owner's view.

## 19. Use current abstract (EVIDENCE-RECORDS-001C2C-B)

> **Status: merged and deployed; Production-accepted with limitations.** PR #362 merged on 2026-10-31 as `63f5ed60` and is live on `app.paperlume.app` (first deployed as Vercel `dpl_DesyA2knVC8ifKKvyYJqy8nqrnnW`). The same day, one authenticated acceptance of C2C-A and C2C-B together ran the first rebase and the first capture in Production, and passed with limitations (§20). No migration, RPC, grant, policy, secret or Edge Function: the interface calls the installed `evidence_rebase_source` (`20261017155445`; [evidence-records-field-operations.md](evidence-records-field-operations.md) §5). Before work began, a read-only check found Production's function body equal to the repository's (md5 `910685085611df3faf4eb31072f57f3e`), executable by `authenticated` only, and never yet called there.

C2C-B adds the one write the comparison left out. The user can save the library abstract the comparison shows as the link's new saved copy, or as its first copy. Edit, Review and History stay the only modes, and keeping the saved copy stays the default.

**The flow.**

1. In Edit, **Compare** (§18) reads the library abstract again and shows it beside the saved copy. Above the readings, a panel says the record keeps saved copy N unless the user chooses otherwise. For a first capture it says there is no copy yet, and that saving one makes the abstract quotable. It offers **Use current abstract**, or says why it can't be used now.
2. **Use current abstract** freezes the exact text shown, with the study version, the link's current copy and the time of the read it came from. It then opens a confirmation. **Cancel** sends nothing and returns focus to the button.
3. **Save as copy N** (or **Save as the first copy**) hands that frozen text to the editor hook, which checks everything again and sends one request. The pane then shows the new current copy, and what the server did.

**When it is offered** (`sourceUpdateEligibility`, `src/lib/studyRecord/sourceUpdate.ts`, in the rebase's own order of refusal):

| The library abstract | Offered? |
|---|---|
| differs in content (`content_change`) | yes |
| differs only typographically (`typography_only_change`) | yes, as a secondary button; the panel and the confirmation say keeping the copy is the default |
| exists, and the link has no copy (`abstract_now_available`) | yes: a first capture |
| is the saved copy, character for character; removed; or empty after normalization v1 | no: nothing to choose, and no panel |
| is over 50,000 code points | no: the button waits, with the reason |
| would be the link's 21st copy | no: the button waits, with the reason |

It also needs a library read that finished (not checking, not failed) and Web Crypto in the browser. It is shown only to the pilot owner with a record that is still writable. A former owner or a manager compares and opens copies as before, and gets no control.

While something else is under way, the button stays focusable but `aria-disabled`. The reason is written beside it and linked to it, and pressing it opens nothing. The hook's `sourceUpdateHold`, in order:

| Hold | When |
|---|---|
| `busy` | a save, link change, deletion, review or rebase is in flight |
| `unresolved` | an earlier write's outcome is unknown, or the record must be reloaded |
| `changed_elsewhere` | a version conflict, or a change seen on reading the record back |
| `unsaved_changes` | the draft has unsaved edits |
| `flag_open` | a Flag note is open in Review (G3, below) |
| `refused` | the last attempt was refused for a reason only a reload clears |

**The confirmation** (`describeSourceUpdate`). Everything it says comes from the record as loaded, never from a forecast:

- the paper, and the record's current copy (copy N of M and its date), or that it has none;
- that the library abstract shown, with its length, will be saved as copy N+1 (or as the first copy), and that a saved copy never changes afterwards;
- that every earlier copy stays and can still be opened;
- "PaperLume will check existing quotations against the new abstract. Quotations that cannot be matched uniquely will remain linked to their earlier saved copies." It also gives how many quotes are on the current copy, which are the ones the server looks for. Quotes on earlier copies stay as they are. A quote found again only means the same characters are in the new copy, not that they mean the same thing.
- each field that cites this paper's abstract — a quote on any of its copies, an examined copy, or "couldn't check" — by name, in three lists. Reviewed by you and Flagged values will need re-review. Values already needing re-review stay so. Not-reviewed values stay not reviewed. This is `deriveSourceChangeTransitions`, the server's rule: it applies even when every quote is found again. Review notes are kept. On a first capture, fields that said the paper had no abstract to check are named: once a copy exists, they can't be confirmed until edited.

No count of quotes that will be found, moved or kept is shown. Only the server's answer says that. The confirmation is checked again on every render. If the library text shown, the record's version, the link's copy, the user's role, Web Crypto or a hold changed while it was open, **Save** is `aria-disabled`, sends nothing and says why. While a read is on its way, it waits. Focus starts on **Cancel**. On a phone the confirmation fits the screen: its text scrolls inside it, and its buttons stay outside that scroll.

**The exact text, and its SHA-256.** The candidate is the text of the user-scoped library read (`useLinkedPaperAbstract`, §18), never the shared `useAbstract` cache. It is never trimmed, normalized or re-read. `abstractSha256` computes SHA-256 over its UTF-8 bytes with the browser's Web Crypto (`crypto.subtle.digest`), as lowercase hex, in the application layer; the evidence library uses no crypto. A text with a lone surrogate or NUL has no faithful UTF-8 form, so it is not hashed. Without Web Crypto, or if the digest fails, nothing is sent ("Nothing was sent: …"). The server compares the digest with the abstract it reads in the same transaction, and its answer stands. `source_changed_again` makes the pane read the library again at once. A new choice must then come from a read finished after the refusal; a candidate from an earlier read is refused unsent. No digest is ever retried with different text.

**One prepared write, and safe retries.** Only `useStudyRecordEditor` calls `prepareRebaseSource` and `client.rebaseSource`, once each (`updateSource`, and `sendSourceUpdate` for the send):

- one confirmation is one request, with a new request id from `newStudyRecordRequestId`;
- the request is kept, in memory only, while its outcome is unknown. **Try again** (`retrySourceUpdate`) resends that request unchanged — the same id, digest, version and paper — and the server replays an applied one rather than saving a second copy;
- nothing is retried by itself. **Reload** abandons a request in doubt, and the record read back shows whether it was saved; a new attempt is a new confirmation and a new request;
- no prepared request, digest or text is written to browser storage, and nothing is logged.

**Holds both ways.** While a rebase is being prepared, is in flight or is in doubt, every other write waits: edits, Save, link changes, Confirm and Flag, and Delete (the button is disabled). A lock is set the moment it starts, so nothing slips in before a render. In turn, the rebase waits for every other write in flight or in doubt, for an unsaved edit, and for an open Flag note. Each condition is checked again in the hook at the write itself, whatever the button showed.

**Answers and recovery:**

| Answer | What the user sees | Next |
|---|---|---|
| `applied` | "Saved copy N of this paper's abstract…" with the server's counts | — |
| `replayed` (after Try again) | the same, and "Your earlier attempt had already saved it: nothing was saved twice." | — |
| `unchanged` | "Nothing was saved: saved copy N is already the abstract in your library…" | — |
| unknown outcome: transport failure, gateway 5xx, malformed answer | one alert: "We couldn't tell whether the new copy was saved. Try again — it won't be saved twice." | **Try again** (the same request) or **Reload** |
| not applied, worth resending as is: database busy or unreachable, session ended | the same alert, saying the copy wasn't saved | **Try again** or **Reload** |
| `source_changed_again` | "Nothing was saved: the abstract in your library changed after you compared it…"; the library is read again | a new confirmation |
| `version_conflict` | the editor's alert: "…so no copy was saved. Reload to see the latest version." | **Reload** |
| `records_not_enabled` | the pilot role is gone: no write is offered any more | — |
| `snapshot_limit`, `history_limit`, `abstract_too_long`, `link_not_found`, `invalid_input` (for example an abstract empty after normalization), `request_id_reused`, and any other refusal | its fixed message, with "Reload the record before trying again." | **Reload**; until then the action waits (`refused`) |
| `study_not_found` | the record no longer exists | close |

No message is built from the server's text. Refused requests are retired.

**After it is saved.** The record is read back once and checked against the answer. At the answer's version, the link's current copy must be the copy it named, with the same number. If it is not, or the read fails, the pane says "Copy N was saved, but the record couldn't be read back…" and offers a reload; a confirmed write is never reported as a failure. A record read back at a later version means a change was made elsewhere, which holds the next write. The draft had no unsaved edit, and could take none while the write ran, so it starts again from the record read back: no reference to the old copy stays in it. The pane shows the new current copy, and G2 (§18) drops any selection, occurrence choice or **Add quote** panel made on the old one. Only this user's study-record queries are invalidated, as after every write: the library abstract, summaries and History. History reads the new operation when it is next opened or refreshed. Nothing of it is kept locally.

The message reports the server's own counts — rematched, not found, found more than once, values sent to re-review — in words. A first capture says it is the record's first copy and that no quote was checked, never that it replaced one. A later copy says which copies are kept, and that quotes not found exactly once stay on the copy before. With no quote on the copy it replaced, it says so. With no review changed, it says so too.

**G3 — the Flag note lives in the editor.** An open Flag note and its text used to be the Review card's own state, invisible to the editor. Now they are the hook's (`flagNotes`, `openFlag`, `editFlagNote`, `closeFlag`), and `FlagForm` shows the note it is given. A partly written note survives a switch between Edit and Review, a reload, and a filter that would hide its card: a card with an open note stays shown under "Needs your review". While any note is open, **Use current abstract** waits (`flag_open`), and it says the note must be sent or cancelled first. The note closes when the flag is recorded, whether on the first press or on **Try again**, or on **Cancel**. It takes focus only when the user opens it, not when its card comes back into view. An open note holds nothing else. Closing the dialog still drops an unsent note, as before: the dialog's leave check covers the draft.

**G4 — History says what a rebase did.** Without changing an event or a read:

- the operation's title is "Copy of the library abstract saved" for a first copy and a later one alike, since the header can't tell them apart;
- the summary event reads `previous_snapshot_id`. A first copy says "No quotes to recheck: this was the first saved copy…". A later copy with no quote on the copy it replaced says none was rechecked. Otherwise it gives the counts, with not found apart from found more than once, and says quotes not found exactly once stay where they were;
- the review count is the values moved to Needs re-review, and zero says "No field's review status changed.";
- a field sent back to re-review says "needs re-review — a new copy of the abstract was saved" and that its review note is kept. The Review card's status line uses the same words, so neither says a copy "changed" when it was a first capture.

History still shows no abstract, value, quote or note text.

**The boundary** (`src/test/studyRecordUiBoundary.test.ts`):

- `rebaseSource` and `prepareRebaseSource` are allowed in `useStudyRecordEditor.ts` alone, and are called there exactly once each;
- every other module is refused both, as a call, a member, an alias or a destructured name;
- `evidence_rebase_source` and `rebase_source` stay forbidden as strings in every module, the hook's included;
- Web Crypto's `subtle` and `digest` appear in `src/lib/studyRecord/sourceUpdate.ts` alone, and no other hashing library is used.

Positive tests and negative controls cover each rule; the C1–C2C-A rules are unchanged.

**Tests.**

- **Vitest.**
  - `sourceUpdate.test.ts`: every eligible and ineligible state; the 50,000-code-point boundary with supplementary characters; the 20-copy limit; stale candidates; review impact by status, by copy and by link, for a first capture too; the digest against Node's for ASCII, Latin-1, composed and decomposed accents, CJK, supplementary characters and exact white space; refusals without Web Crypto, on a failed digest and for text with no UTF-8 form.
  - `useStudyRecordRebase.test.tsx`: one request per confirmation; holds both ways; every stale and ineligible candidate; no digest; the unknown outcome and Try again, replayed; every refusal; reload; read-back failures; G3.
  - `StudyRecordRebase.test.tsx`: the whole flow through the dialog, with a scripted server — the confirmation's lists, Cancel, the exact SHA-256, the outcome and the new copy, typography only, a first capture, a former owner, both holds, a change while open, too long, no Web Crypto, source changed again, the unknown outcome, a refusal, a conflict, the phone layout.
  - The History and Flag-note suites cover G3 and G4.
- **E2E:** `e2e/study-records-rebase.spec.ts`, with its own disposable fixture `scripts/e2e-local-rebase-fixture.mjs` (accounts `e2e-disposable-srrb-…`). The fixture writes every row through the installed RPCs — create, save, review, and the rebase that gives one record an earlier copy — and inserts nothing directly. The spec covers:
  - R1: a changed abstract adopted through the UI, with the confirmation's lists, one request carrying the SHA-256 of the exact text, the server's counts, the new copy with its moved quotes, the earlier copy with its kept quotes, the reviews in Review and the operation in History;
  - R2: a first capture;
  - R3: typography only, cancelled;
  - R4: an unsaved edit and an open Flag note hold the write, and lose nothing;
  - R5: a library abstract changed while the confirmation was open is refused, and read again;
  - R6: an answer lost in transit, then Try again with the identical request, replayed;
  - R7: an unchanged answer to a direct rebase saves nothing;
  - R8: the phone layout — no sideways scroll, reachable 40 px targets, a confirmation that fits;
  - R9: a former owner gets no write, and a direct rebase is refused (42501).

  The traffic watch allows `evidence_rebase_source` alone and keeps each body sent. Afterwards the lifecycle checks, as the database owner:
  - each rebased record's version;
  - its copies (the earlier ones byte for byte as they were);
  - each quote's copy and offsets, which must locate the quote in its copy;
  - each value's review status, reason, version and note;
  - its events: one request, gapless, in order, with the server's counts;
  - that every other record and the library are as provisioned, but for the spec's own edit.

  It then removes the accounts and verifies nothing of theirs remains. The `e2e-evidence` job runs the five Evidence Records specs: `npm run test:e2e:local -- e2e/study-records.spec.ts e2e/study-records-review.spec.ts e2e/study-records-history.spec.ts e2e/study-records-source-compare.spec.ts e2e/study-records-rebase.spec.ts`.

**Limits, and what is not exercised.**

- The history limit is known only from the server's answer: the browser doesn't count a record's events. After that refusal the action waits for a reload.
- An `unchanged` answer can't be reached through the interface. The action is offered only when the texts differ, and a new copy moves the version first. It is covered by a direct call in the E2E and by the Vitest suites.
- Switching between linked papers is covered only by the Vitest suites (no installed RPC links a second paper).
- A request in doubt lives in memory: closing the dialog or the tab abandons it, and reopening the record shows whether it was saved.
- Strict re-review applies to every rebase, typography-only included (001A §E5); the confirmation says so before anything is sent.
- No physical phone or screen reader has been used: the phone layout is checked in a narrow Chromium window with a coarse pointer. The 2026-10-31 acceptance (§20) ran the first rebase and the first capture in Production; the recovery paths, refusals and limits above were not exercised there, and rest on the Vitest suites and the disposable local E2E.

## 20. Source comparison and Use current abstract — Production acceptance (2026-10-31)

The report of EVIDENCE-RECORDS-001C2C-AB-PRODUCTION-ACCEPTANCE-EXEC-001 gives the verdict **`C2C_AB_PRODUCTION_ACCEPTED_WITH_LIMITATIONS`**: the workflow below succeeded, and nothing beyond it was accepted. It covered C2C-A (§18) and C2C-B (§19) together, on the deployed C2C-B build (PR #362, `main` at `63f5ed60`, Vercel deployment `dpl_DesyA2knVC8ifKKvyYJqy8nqrnnW`). The Product Owner authorized exactly 15 writes and 4 cleanup deletes beforehand, and the first rebase separately, after a read-only check of the record and the library abstract. They performed every action in their own browser, desktop Chrome, through the normal Production interface. The audits between stages were read-only: SQL in read-only transactions, and content-free API-log counts of each request's method, path and status. No test automation, service-role browser access or direct database write was used. Before the first write, read-only gates confirmed the release, and that Production's database contract — the ledger, 14 function bodies including the rebase's, privileges, RLS and policies — equalled the repository's, with no Evidence row. The identities and the cleanup record are in [migration-history.md](migration-history.md).

**The run.** Two synthetic canary papers (title prefix `SR-C2CAB-CANARY-`, fictional abstracts), in the owner's own library:

1. Paper A was added with an abstract and Paper B without one. Record A was created with copy 1 of the abstract, and four values were saved in one save: **Who took part**, **Setting** and **Condition**, each quoting copy 1, and **Eligibility**, with a full-text page reference only. Who took part and Eligibility were confirmed, Setting was flagged with a note, and Condition was left not reviewed. Record B was created with no copy; its Condition was saved as "couldn't check" the abstract, and confirmed.
2. Record A was compared with the unchanged library (no write).
3. Paper A's abstract was changed in Edit Paper. Record A was compared, and the confirmation read and cancelled (no write). **Save as copy 2** was then pressed once: the first rebase in Production.
4. Review, the copies list, copy 1 and History were read (no write).
5. Paper B was given an abstract in Edit Paper, and Record B's first copy was saved: the first capture in Production.
6. Paper A's abstract was changed by white space only. Record A was compared, the confirmation read and cancelled, and both holds checked (no write).
7. Both records, then both papers, were deleted through the interface.

After each Edit Paper save, the paper's other columns, compared one by one, were unchanged apart from its update time and the columns derived from the abstract.

**Source comparison (C2C-A)** — the Product Owner's screenshots, checked against the plan word for word and against the fixture's texts:

- **Unchanged library.** "Same as the abstract in your library, character for character.", with no **Compare**, no **Use current abstract** and no copies list.
- **Changed library.** **Compare** summarized "2 places differ: 1 word only in the saved copy, 16 words only in the library abstract.", with the removed word struck through and the added words underlined. **Saved copy 1** and **Library abstract** each showed its full text, exactly.
- **White-space change.** "1 place differs: spacing, punctuation or invisible characters only.", naming the removed space and the added line break. The panel said keeping saved copy 2 is the default, and **Use current abstract** was a secondary button.
- **Earlier copies.** After the rebase, **Saved copies of this abstract (2)** listed both copies, and **Show copy 1** opened "Copy 1 of 2 — an earlier saved copy", read-only, marking only the two quotes saved on it. A selection made in the current copy was dropped when copy 1 opened. In Review each source named its copy: Who took part's quote was on copy 2 of 2, with Confirm offered; Setting's and Condition's Confirm was held, their quotes being on an earlier copy.
- **No write.** A fingerprint of every canary row was equal before and after each comparison-only stage.

**Use current abstract (C2C-B):**

- **Offered only when eligible.** It was absent while the copy equalled the library abstract and while the paper had no abstract. It was the primary action for a content change, a secondary one for a white-space change, and, for Record B's first copy, inside **Show the library abstract**.
- **Held** while the record had an unsaved edit ("Save or undo your unsaved changes first…") and while a Flag note was open ("Send or cancel the Flag note you started in Review first.").
- **The confirmation** named the paper and "copy 1 of 1", said the library abstract would be saved as copy 2 and that copy 1 stays, and said quotations are checked against the new abstract. Its review lists named Who took part and Setting as needing re-review and Condition as staying not reviewed, said review notes are kept, and left Eligibility out. It forecast no quote matches. Focus started on **Cancel**; **Cancel** and Escape sent nothing. For the white-space change it offered copy 3, with one quote on copy 2 to check and the two fields already needing re-review staying so; it was cancelled.
- **The first rebase** (Record A, 10:49:31 UTC). The outcome said copy 2 was saved as the current copy and copy 1 kept, that "3 quotes were checked against copy 2: 1 found exactly once and moved to it, 1 not found, 1 found more than once.", and that 2 fields now need re-review. In the database:
  - one `rebase_source` request, result `applied`, version 5 → 6;
  - copy 2 holds exactly the library abstract, whose SHA-256 the browser sent, and copy 1's row is byte-identical to before;
  - Who took part's quote moved to copy 2; Setting's (not found) and Condition's (found twice) stayed on copy 1 at their stored offsets;
  - Who took part (confirmed) and Setting (flagged) went to Needs re-review (`source_changed`) at value version 2, Setting's note kept; Condition stayed not reviewed, and Eligibility, with only a full-text reference, stayed reviewed;
  - the eight version-6 events came in the planned order, and Record B and both papers were untouched.
- **The first capture** (Record B, 11:20:07 UTC): version 3 → 4; copy 1, with no earlier copy; no quote to recheck; Condition went to Needs re-review (`source_changed`) at value version 2, its abstract-unavailable reference kept. Its events were the request header, `source_captured`, `review_needs_rereview` and `source_rebased`, and Record A was untouched. On the first attempt the Product Owner did not reach the button, which sits behind **Show the library abstract**; nothing was written, and the second attempt saved the copy.
- **History** listed both operations as "Copy of the library abstract saved". Record A's gave "3 quotes rechecked: 1 found again, 1 not found, 1 found more than once." and "2 fields were marked as needing re-review.", Setting's line adding "Its review note is kept." Record B's said "No quotes to recheck: this was the first saved copy of the abstract of ‹paper›" and "1 field was marked as needing re-review." Neither showed abstract, value, quote or note text.

**Integrity.** Record A ended at version 6 with 23 events in 6 requests, and Record B at version 4 with 11 events in 4 requests, one header each; the ten request ids were distinct. The API log for the run (08:29–12:18 UTC) holds exactly the authorized writes — 2 paper inserts, 3 paper updates (each with the Edit Paper dialog's empty Tag and Project assignments), 2 creates, 2 saves, 4 reviews, 2 rebases, 2 study deletes and 2 paper deletes — all answered 2xx, and no Edge Function call.

**After cleanup:** at 12:18 UTC, a read-only audit found no canary paper, study, link, copy, value, reference, event or request receipt, and no Project or Tag link, attachment, author link or cleanup-queue row, by recorded identifiers and by title prefix. The owner's library equalled the baseline taken before the first write in all 19 compared fields — among them 703 papers (684 with an abstract) and their fingerprint, 41 Projects, 189 Tags, 32 attachments, 68 author links, storage and 66 AI usage events — and the database contract equalled the gate's, with no Evidence row. The independent reviewer's later read-only audit found the same ledger and rebase body, all eight Evidence tables empty, no canary identifier or title-prefix match, an empty cleanup queue and the same owner counts. That is the state observed after the run; it does not replay the intermediate actions. Deleting the rows removed the application data only: platform request logs (method, path, status and time) and database backups keep their own retention.

**Limitations.**

- **Skipped steps.** To shorten the run, at the Product Owner's request, two planned views were not opened: each field's sources in Edit after the rebase (G1), and copy 1 opened from Setting's sources in Edit and in Review (H2). The references they would show were checked in the database.
- **Not captured as screenshots:** Compare's change-navigation labels, the changed-source banner, the view after returning from copy 1, and the first capture's confirmation and outcome. The first capture rests on the database and its History entry.
- **Access.** Only the pilot owner was used: no non-owner, former owner, manager or role change.
- **Failures and limits.** Not exercised: `source_changed_again`, an unknown outcome and **Try again** with the identical request, a version conflict, permission loss, a read-back failure, concurrent writes, and the 20-copy, history and 50,000-character limits.
- **Devices.** Desktop Chrome only: keyboard use (the confirmation opened from the keyboard, focus on **Cancel**, Escape closing it) and a desktop window narrowed to about 650 CSS px, in which the confirmation wrapped and both its buttons stayed visible. No physical iPhone or Android, no phone-width layout and no screen reader; the narrowed window is not a device test.
- **Operations.** The read-only database connector dropped twice: before the backend gate, and before the audit of the last stages. The run paused each time and re-verified before going on; the record fingerprints after the second drop equalled those taken before its stages.
- **Discoverability.** The first-capture action was hard to find on the first attempt (above). That is an observed discoverability concern, recorded for later prioritization, not a demonstrated functional defect.
