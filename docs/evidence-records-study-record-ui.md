# Study records — the Study Record interface (EVIDENCE-RECORDS-001C1, 001C2A)

> **Status: merged and deployed; the owner-pilot workflow is Production-accepted with qualifications.** PR-C1 (PR #348) merged on 2026-10-23 as `ec4bdbde` and is live on `app.paperlume.app`. It needed no migration, secret or Edge Function, and it is the first application code that calls the study-record RPCs. The backend it uses was merged, applied to Production and accepted before this rollout: the eight tables (PR-A1), the lifecycle RPCs and owner-only pilot gate (PR-A2, [evidence-records-lifecycle.md](evidence-records-lifecycle.md)), the field RPCs (PR-A3, [evidence-records-field-operations.md](evidence-records-field-operations.md)) and the domain library (PR-B, [evidence-domain-library.md](evidence-domain-library.md)). On 2026-10-23 the Product Owner ran one synthetic-canary workflow through the normal Production interface, and it passed with four qualifications (§13). That accepts the workflow exercised, not every operation, Unicode case or recovery path described below. Creating and editing remain owner-only (§3). **EVIDENCE-RECORDS-001C2A** adds Review (§14): Confirm and Flag of one saved value at a time. It merged on 2026-10-24 (PR #355, `0ba43a17`) with no migration, secret or Edge Function, and is live on `app.paperlume.app`. The same day the Product Owner ran one synthetic-canary Review workflow in Production, and it passed with three qualifications (§15).

This document describes what a user can do, what the interface sends, and what it deliberately leaves to C2B and C2C. The executable specification is the Vitest suites under `src/lib/studyRecord/__tests__/`, `src/components/papers/study-record/__tests__/`, `src/hooks/__tests__/useStudyRecordEditor.test.tsx` and `useStudyRecordReview.test.tsx`, the paper-safeguard suites, `src/test/studyRecordUiBoundary.test.ts`, `e2e/study-records.spec.ts` and `e2e/study-records-review.spec.ts`.

## 1. Where it lives

| Layer | Files | Role |
|---|---|---|
| Pure logic | `src/lib/studyRecord/` | Reads (`read.ts`, `paperLinks.ts`), the in-memory draft (`draft.ts`), checks (`validateDraft.ts`), save planning (`savePlan.ts`, `jsonbSize.ts`), quotes (`quotes.ts`), the pilot mirror (`access.ts`), paper safeguards (`paperGuards.ts`), creates whose outcome is unknown (`pendingCreates.ts`), Review's items, holds and summary (`reviewModel.ts`), the one write client (`client.ts`) |
| Hooks | `src/hooks/useStudyRecords.ts`, `src/hooks/useStudyRecordEditor.ts`, `src/hooks/useStudyRecordCreations.ts` | Owner-scoped queries; the editor's save and review state machine; the dialog's store of unresolved creates |
| UI | `src/components/papers/study-record/` | The dialog, the start screen, the study list, the editor (Edit: record and source panes; Review: the review pane, its cards and the Flag form), the entry point |
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

Delete is ungated on the server, so a former owner keeps View and Delete. If the role is removed while a draft is open, Save is refused with a distinct message ("Your account can no longer edit study records…"), the draft stays on screen, and the editor locks.

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

Plain SELECTs under the owner-only RLS policies, each also filtered by `user_id`, read in 1,000-row pages until a short page, so a truncated answer never passes for a complete one. Only the current copy's text is read; earlier copies are metadata. Every row is mapped by PR-B and cross-checked (owner, study, linked paper, copy); a failure shows nothing of the record. The record is never refetched in the background (`staleTime: "static"`): the draft is checked against the version it was built on.

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
- Quotes from an earlier copy are labelled "From an earlier copy of the abstract"; there is no comparison or rebase.
- A multi-step save is not one transaction (§8).
- **Creation across a reload is not exactly-once.** An unresolved create (§4) lives in memory only — browser persistence of request material is excluded by design — so a hard reload, closing the tab, signing out or leaving the Dashboard forgets it. Afterwards the dialog reads the paper's studies afresh and names those that exist before offering a creation, so a record the lost attempt created is found and opened rather than silently created again. It cannot disprove an attempt the server was still processing at that moment, and a user may still create another deliberately. Exactly-once creation across a reload would need a durable request identity (a persistent operation journal), which needs its own privacy and lifecycle review and is not built.
- The server remembers a request id only while its study exists ([evidence-records-lifecycle.md](evidence-records-lifecycle.md) §5): if the study an unresolved attempt created is deleted elsewhere before the retry, the retry creates it again.
- Production has exercised one owner-pilot workflow (§13). Everything else in this document rests on the Vitest suites and the disposable local E2E.

PR-C2 is three phases. **C2A — Review** (Confirm and Flag, `evidence_review_fields`) is §14. **C2B** (the history viewer, `evidence_events`) and **C2C** (the source-change comparison, earlier copies and **Use current abstract**, `evidence_rebase_source`) are not started, and the Evidence Matrix integration is later still. The boundary test fails if the Study Record UI reads `evidence_events` or names the rebase before then.

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

**Modes.** The dialog opens in **Edit**; the **Review** tab sits beside it ("Study record mode"). Both stay mounted, so a draft and a half-typed Flag note survive switching. There is no History tab yet (C2B).

**What Review shows.** Everything comes from the record as saved (`reviewModel.ts`), never from the draft.

- **The summary** counts the recorded fields by their own status: Not reviewed, Reviewed by you, Flagged, Needs re-review. It also says how many can't be confirmed yet, with the standing sentence "Saving is never a review, and PaperLume doesn't check your interpretation." There is no percentage and no verdict on the record.
- **The filter** is *Needs your review* (the default: everything not reviewed at its current version) or *All recorded*. It changes only what is shown.
- **One card per saved value**, grouped by the dictionary's sections, then by group and outcome in saved order and under their saved names. A card shows:
  - the value and state as saved, with its note;
  - the status as an icon and in words ("Reviewed by you on ‹date›", from the server's `reviewed_at`), the flag's note, or the earlier note of a value needing re-review;
  - its sources, each naming its paper and copy ("copy 1 of 2, saved ‹date›"). Quotes carry about a sentence of context, located by the server's stored offsets and not by a new search. Full-text references read "your reference — check it in your copy; PaperLume doesn't". Examined and couldn't-check sources are listed too, with "From the abstract only" where it applies.
- **The Source pane** (desktop) highlights only the SAVED quotes of the card being reviewed and offers no "Use as quote". A source on an earlier copy is named as such and never highlighted in the current copy: this view does not load earlier copies (C2C).
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

- **Vitest:** `reviewModel.test.ts`, `useStudyRecordReview.test.tsx`, `StudyRecordReview.test.tsx` and `reviewCopy.test.ts`, plus the boundary test. That test allows `reviewField` and `prepareReviewField` in the editor hook only, and still forbids the rebase and any history read.
- **E2E:** `e2e/study-records-review.spec.ts` has its own disposable fixture, `scripts/e2e-local-review-fixture.mjs`. Afterwards it proves, as the database owner, each value's status, note, versions and review events, then removes its accounts and verifies they are gone. The `e2e-evidence` job runs it after the C1 spec: `npm run test:e2e:local -- e2e/study-records.spec.ts e2e/study-records-review.spec.ts`.
- **Fixture selection:** the lifecycle asks Playwright which files it will run, and gives each Evidence Records spec its own fixture (`scripts/e2e-local-spec-selection.mjs`). An Evidence Records spec without one fails closed.

**Limits.**

- Earlier copies are named, not shown (C2C), and there is no history view (C2B).
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
