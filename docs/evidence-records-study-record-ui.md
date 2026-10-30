# Study records — the Study Record interface (EVIDENCE-RECORDS-001C1, 001C2A, 001C2B)

> **Status: merged and deployed; the owner-pilot workflow is Production-accepted with qualifications.** PR-C1 (PR #348) merged on 2026-10-23 as `ec4bdbde` and is live on `app.paperlume.app`. It needed no migration, secret or Edge Function, and it is the first application code that calls the study-record RPCs. The backend it uses was merged, applied to Production and accepted before this rollout: the eight tables (PR-A1), the lifecycle RPCs and owner-only pilot gate (PR-A2, [evidence-records-lifecycle.md](evidence-records-lifecycle.md)), the field RPCs (PR-A3, [evidence-records-field-operations.md](evidence-records-field-operations.md)) and the domain library (PR-B, [evidence-domain-library.md](evidence-domain-library.md)). On 2026-10-23 the Product Owner ran one synthetic-canary workflow through the normal Production interface, and it passed with four qualifications (§13). That accepts the workflow exercised, not every operation, Unicode case or recovery path described below. Creating and editing remain owner-only (§3). **EVIDENCE-RECORDS-001C2A** adds Review (§14): Confirm and Flag of one saved value at a time. It merged on 2026-10-24 (PR #355, `0ba43a17`) with no migration, secret or Edge Function, and is live on `app.paperlume.app`. The same day the Product Owner ran one synthetic-canary Review workflow in Production, and it passed with three qualifications (§15). **EVIDENCE-RECORDS-001C2B** adds History (§16): a read-only, paginated view of a record's committed operations, with no migration, RPC, secret or Edge Function. It merged on 2026-10-30 (PR #358, `fe6d2b0f`) and is live on `app.paperlume.app`. The same day the Product Owner ran one synthetic-canary History workflow in Production, and it passed with three qualifications (§17).

This document describes what a user can do, what the interface sends, and what it deliberately leaves to C2C. The executable specification is the Vitest suites under `src/lib/studyRecord/__tests__/`, `src/components/papers/study-record/__tests__/`, `src/hooks/__tests__/useStudyRecordEditor.test.tsx`, `useStudyRecordReview.test.tsx` and `useStudyRecordHistory.test.tsx`, the paper-safeguard suites, `src/test/studyRecordUiBoundary.test.ts`, `e2e/study-records.spec.ts`, `e2e/study-records-review.spec.ts` and `e2e/study-records-history.spec.ts`.

## 1. Where it lives

| Layer | Files | Role |
|---|---|---|
| Pure logic | `src/lib/studyRecord/` | Reads (`read.ts`, `paperLinks.ts`), the in-memory draft (`draft.ts`), checks (`validateDraft.ts`), save planning (`savePlan.ts`, `jsonbSize.ts`), quotes (`quotes.ts`), the pilot mirror (`access.ts`), paper safeguards (`paperGuards.ts`), creates whose outcome is unknown (`pendingCreates.ts`), Review's items, holds and summary (`reviewModel.ts`), History's read and its reading of events (`historyRead.ts`, `historyModel.ts`), the one write client (`client.ts`) |
| Hooks | `src/hooks/useStudyRecords.ts`, `src/hooks/useStudyRecordEditor.ts`, `src/hooks/useStudyRecordCreations.ts`, `src/hooks/useStudyRecordHistory.ts` | Owner-scoped queries; the editor's save and review state machine; the dialog's store of unresolved creates; History's paged, owner-scoped reads |
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

PR-C2 is three phases. **C2A — Review** (Confirm and Flag, `evidence_review_fields`) is §14. **C2B — History** (a read-only view of `evidence_events`) is §16, merged and deployed, with its qualified Production acceptance in §17. **C2C** (the source-change comparison, earlier copies and **Use current abstract**, `evidence_rebase_source`) is not started, and the Evidence Matrix integration is later still. The boundary test fails if the Study Record UI reads `evidence_events` anywhere but the history read module, or names the rebase.

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

- **Vitest:** `reviewModel.test.ts`, `useStudyRecordReview.test.tsx`, `StudyRecordReview.test.tsx` and `reviewCopy.test.ts`, plus the boundary test. That test allows `reviewField` and `prepareReviewField` in the editor hook only, and still forbids the rebase; history is read in the history read module only (§16).
- **E2E:** `e2e/study-records-review.spec.ts` has its own disposable fixture, `scripts/e2e-local-review-fixture.mjs`. Afterwards it proves, as the database owner, each value's status, note, versions and review events, then removes its accounts and verifies they are gone. The `e2e-evidence` job runs it after the C1 spec: `npm run test:e2e:local -- e2e/study-records.spec.ts e2e/study-records-review.spec.ts`.
- **Fixture selection:** the lifecycle asks Playwright which files it will run, and gives each Evidence Records spec its own fixture (`scripts/e2e-local-spec-selection.mjs`). An Evidence Records spec without one fails closed.

**Limits.**

- Earlier copies are named, not shown (C2C).
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
- **E2E:** `e2e/study-records-history.spec.ts`, with its own disposable fixture, `scripts/e2e-local-history-fixture.mjs` (accounts `e2e-disposable-srh-…`). The fixture writes twelve operations through the installed RPCs — never into `evidence_events` — and the spec covers the order, a creation (and a record created in the browser), a Save, a Confirm, a Flag, a save that resets a review, read-only traffic and scoped reads, paging, an operation's own changes, a large save's changes in two parts (52, on the former owner's record), a former owner, Refresh after a write made elsewhere, a failed read, and the phone layout. Afterwards the lifecycle proves, as the database owner, every committed operation of the history study with its own events — the fixture's twelve and exactly the spec's five, so the viewer wrote nothing — then removes the accounts and verifies that nothing of theirs remains. The `e2e-evidence` job runs the three Evidence Records specs: `npm run test:e2e:local -- e2e/study-records.spec.ts e2e/study-records-review.spec.ts e2e/study-records-history.spec.ts`.
- **Not in the E2E:** rebase events. C2C has no interface yet, and nothing in C2B, its fixture included, calls the rebase. The Vitest suites cover their rendering, against the shapes the migration writes.

**Limits.**

- History shows what each operation recorded, not the record at an earlier time: no earlier text, quote, note or copy can be recovered from it, and there is no comparison view (C2C).
- The name of a group, an outcome or a paper in a value or link event is today's, or "since removed".
- Refresh drops the older pages read so far.
- An operation's changes can't be filtered or searched, and a large save is shown 50 changes at a time.
- Production has exercised one owner-pilot History workflow (§17). Paging, failures and every other state rest on the Vitest suites and the disposable local E2E.

C2C — the source comparison, earlier copies, **Use current abstract** and `evidence_rebase_source` — is not started.

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
