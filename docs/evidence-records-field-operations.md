# Study records — field, review and rebase RPC contract (EVIDENCE-RECORDS-001A3)

> **Status:** implemented in this repository; **not applied to Production**. Migration `20261017155445_add_evidence_records_field_review_rebase_rpcs.sql` adds the write path for everything inside a study: groups, outcomes, values and their source references, human review, and rebasing a saved abstract copy. Applying it to Production needs a separate authorization (§13). There is no user-facing Study Record interface, and nothing in the application calls these functions; the typed client for them in `src/lib/evidence/` ([evidence-domain-library.md](evidence-domain-library.md) §10) is not used by application code either.

This document is the client contract. The migration header holds the database-level detail. The executable specification is pgTAP suite `033_evidence_field_review_rebase.test.sql`, section L of suite `032_evidence_normalization_parity.test.sql`, and the db-tests lifecycle's evidence field race probe (`runEvidenceFieldRaceProbe` in `scripts/e2e-local.mjs`). The study lifecycle — create, update, link and delete — is [evidence-records-lifecycle.md](evidence-records-lifecycle.md), and everything there about the pilot gate, request ids and history applies here unchanged.

## 1. Functions

| Function | Who may call it | What it does |
|---|---|---|
| `evidence_save_changes(p_study_id uuid, p_expected_version integer, p_changes jsonb, p_request_id uuid)` | authenticated, **owner only** | One atomic batch of group, outcome and value changes, with source references (§3). |
| `evidence_review_fields(p_study_id uuid, p_expected_version integer, p_value_id uuid, p_expected_value_version integer, p_action text, p_note text, p_request_id uuid)` | authenticated, **owner only** | Confirm or Flag **one** value at **one** `value_version` (§4). |
| `evidence_rebase_source(p_study_id uuid, p_paper_id uuid, p_expected_version integer, p_expected_abstract_sha256 text, p_request_id uuid)` | authenticated, **owner only** | Save a new copy of a linked paper's abstract for one study-report link — "Use current abstract", or the link's first copy — and re-match its quotes (§5). |
| `evidence_locate_quote(p_quotes text[], p_snapshot text)` | nobody (internal) | Deterministic quote location under normalization v1 (§6). |
| `evidence_state_reference_problems(p_state text, p_supports integer, p_examined integer, p_unavailable integer)` | nobody (internal) | FK-PROOF-001 §J, stated once for save and Confirm. |
| `evidence_value_digest(p_user_id uuid, p_value_id uuid)` | nobody (internal) | The bounded, text-free history record of one value (§9). |

The three RPCs are `SECURITY DEFINER`, `VOLATILE`, `search_path = public, pg_temp`, owned by `postgres`, and executable by `authenticated` alone. The helpers are `SECURITY INVOKER` with a fixed `search_path` (`pg_catalog, pg_temp` for the two pure ones) and no EXECUTE grant to anyone but their owner; a client cannot call them, and the RPCs call them as their owner. The installed `evidence_normalize_v1` and `evidence_records_assert_writable` are reused as PR-A2 left them: the migration refuses to run unless their bodies are byte-identical to PR-A2's.

Each RPC calls the pilot gate first (`42501 evidence_auth_required` / `evidence_records_not_enabled`), refuses any isolation level but READ COMMITTED, takes the caller from `auth.uid()`, accepts no user id, and names that caller's `user_id` in every read and write. Someone else's study, paper, group, outcome, value or reference id gets the same answer as an id that does not exist.

## 2. Answers

Every RPC returns a JSON object with a `status`: `applied`, `replayed` (this request id was already applied; the original answer, with `status` replaced) or `unchanged` (nothing would change; nothing was written, and the request id is not consumed).

| RPC | Fields |
|---|---|
| save | `study_id`, `study_version`, `arm_ids` and `outcome_ids` — `{ ref: id }` for each group and outcome the batch added (`{}` when `unchanged`) |
| review | `study_id`, `study_version`, `value_id`, `value_version` (never changed by a review), `review_status` (`user_reviewed` after Confirm, `disputed` after Flag) |
| rebase | `study_id`, `study_version`, `paper_id`, `snapshot_id` (the link's current copy afterwards), `previous_snapshot_id` (null for a first capture and when unchanged), `seq`, and the counts `rematched`, `not_found`, `ambiguous`, `needs_rereview` |

`applied` and `replayed` carry the next study version; `unchanged` carries the current one.

## 3. `evidence_save_changes`

### 3.1 The payload

`p_changes` is a JSON array of 1–200 changes, at most 65,536 bytes as jsonb text. An empty array is refused, `22023` with DETAIL `p_changes: empty`, before anything is read or locked, so it writes nothing and consumes no request id. A batch whose changes are all no-ops is not empty: it answers `unchanged` (§3.6). Every key an operation lists is required — JSON `null` where the operation allows it — and any other key is refused. A key for a column the server alone writes is refused as `server_attested`: `id`, `user_id`, `study_id`, `value_id`, `position` (except a group's or outcome's), the timestamps, the match columns (`match_start`, `match_end`, `match_occurrence`, `match_count`, `matched_at`, `normalization_version`), the review columns, `value_version`, `extraction_method`, and a copy's text, fingerprints, `seq` and `char_count`.

| Operation | Keys |
|---|---|
| `add_arm` | `ref`, `arm_role` (`intervention` \| `comparator`), `display_label` (≤ 120), `position` (0–99) |
| `update_arm` | `arm_id`, `arm_role`, `display_label`, `position` |
| `remove_arm` | `arm_id` — removes the group's values and their references with it |
| `add_outcome` | `ref`, `display_label` (≤ 200), `position` (0–99) |
| `update_outcome` | `outcome_id`, `display_label`, `position` |
| `remove_outcome` | `outcome_id` — removes the outcome's values and their references with it |
| `set_value` | `target`, `field_key`, `expected_value_version`, `value_state`, `state_reason`, `content`, `note`, `references` |
| `clear_value` | `target`, `field_key`, `expected_value_version` |

- **`target`** is `{scope:"study"}`, `{scope:"arm", arm_id}` or `{scope:"arm", arm_ref}`, `{scope:"outcome", outcome_id}` or `{scope:"outcome", outcome_ref}`. A `*_ref` names a group or outcome added in the same batch by its `ref`: 1–64 characters of `[A-Za-z0-9_-]`, unique across the batch.
- **`expected_value_version`** is the `value_version` on screen, or `null` for a field not yet recorded. Any other answer is `evidence_version_conflict` with DETAIL `p_changes[i].expected_value_version`. `clear_value` needs a number.
- **`content`** follows the field's shape and is `null` unless the state is `reported`: `{shape:"text", text}`, `{shape:"code", code}`, `{shape:"integer_with_reported_text", reported_text, value}`, `{shape:"text_list", entries}`.
- **`references`** is the value's **complete** new set. `{anchor_id}` keeps an existing reference of that value exactly as stored, match columns included; anything else is new:

| Reference | Keys |
|---|---|
| abstract quote | `purpose:"supports"`, `source_kind:"abstract"`, `paper_id`, `snapshot_id`, `quote_text`, `occurrence`, `expected_match_count` |
| full-text locator | `purpose:"supports"`, `source_kind:"full_text"`, `paper_id`, `locator_kind`, `locator_text` |
| examined abstract | `purpose:"examined"`, `source_kind:"abstract"`, `paper_id`, `snapshot_id` |
| examined full text | `purpose:"examined"`, `source_kind:"full_text"`, `paper_id`, `locator_kind`, `locator_text` (both null, or both given) |
| couldn't check | `purpose:"unavailable"`, `source_kind`, `paper_id` |

Supporting references take positions 0–2 in their order in the list.

### 3.2 A batch is a set, not a script

A change names each entity at most once: one change per group, per outcome, and per target and field. The server applies the batch in a fixed phase order — groups and outcomes in array order, then values in array order — and checks every rule that spans the batch on the **final** state: distinct positions, comparator-only fields, the limits, no value change targeting a group or outcome the batch removes, every ref resolving. So the order of the array never changes the outcome. Any refusal rolls back the whole call.

### 3.3 Field rules

- **The dictionary.** The 23 field keys with their scope, shape and bounds — the PR-A1 CHECKs — are a constant inside the function; `fieldDictionary.parity.test.ts` compares it with `src/lib/evidence/fieldDictionary.ts` key by key.
- **Design families.** `add_arm` is refused in a `non_intervention` study (`not_allowed_for_design`), so no group value can exist there either; `n_randomized` exists only in `rct_parallel` and `intervention_other`. `comparator_type` applies to comparator groups only (`not_allowed_for_arm_role`), checked again on the final state when a group's role changes (`comparator_type_present`).
- **Blank text (Product Owner decision 4).** A value text, reported text, list entry, note, locator or label is blank when it is empty after normalization v1, and is refused. The text is stored exactly as sent: nothing is trimmed or normalized. The PR-A1 CHECKs measure `btrim` of U+0020 only, so this is stricter. The minimum lengths of an Unclear note (10) and a Not applicable note (3) are measured as the CHECKs measure them.
- **Lists.** Entries are never trimmed, rewritten or de-duplicated silently. An entry with a leading or trailing White_Space character (the 25 code points of v1) is refused (`untrimmed`), as is a registration number containing one (`contains_whitespace`), U+001F anywhere (`forbidden_character`), a blank entry and an exact duplicate (`duplicate`). The PR-A1 CHECK pattern runs last.
- **State reasons and notes.** A reason exactly when the state is Unclear.

### 3.4 Source-attribution rules

Per value, FK-PROOF-001 §J and PR-A1's cap, through `evidence_state_reference_problems`:

| State | Supporting | Examined | Unavailable |
|---|---|---|---|
| Reported | 0–3 | 0 | 0 |
| Not reported | 0 | ≥ 1 | any |
| Unclear | 0–3 | any; supporting + examined ≥ 1 | any |
| Not applicable | 0 | 0 | 0 |
| Couldn't check (`source_unavailable`) | 0 | 0 | ≥ 1 |

A broken row is refused with DETAIL `p_changes[i].references: <rules>`, the rules in PR-B's order (`too_many_supporting`, `not_allowed`, `supporting_not_allowed`, `examined_not_allowed`/`examined_required`, `unavailable_not_allowed`/`unavailable_required`, `basis_required`). Per reference:

- the paper must be linked to this study (`evidence_link_not_found` otherwise);
- an abstract quote or examined abstract names a copy **of that link** (`evidence_target_not_found` otherwise), and a **new** one names the link's **current** copy — its highest `seq` (`not_current`; 001A §D1 R5). A kept reference may stay on a superseded copy;
- an unavailable abstract names a link with no copy (`unavailable_abstract_has_copy`);
- one examined-or-unavailable assessment per paper and source kind (`duplicate_assessment`), and at most 10 per value (`too_many_assessments`, a proposed limit PR-A3 added to bound history, §10);
- full-text references are locator-only; no full-text text is stored;
- a Reported value with no supporting reference may be saved — the derived **No source given** (Product Owner decision 3) — and cannot be confirmed.

### 3.5 Quotes on save

Every new abstract quote is located in the copy it names (§6), each copy normalized once per call. With one occurrence the quote may leave `occurrence` and `expected_match_count` null. With several, it must name the 1-based `occurrence` the user chose **and** the count the user saw; a count that differs from the server's, or no choice, is `evidence_quote_ambiguous`, as is a quote found more than 100 times. No occurrence is `evidence_quote_not_found`. A quote that is too short, too long or has no letter or digit is `22023 evidence_invalid_input` with DETAIL `…quote_text: invalid`. The server alone writes the match columns, `normalization_version = 'v1'` and `matched_at`. **A match proves only that the passage occurs in the saved copy** — never that it supports the value.

### 3.6 What a save writes

A change that differs in nothing from the stored value — state, reason, content, note, and references that keep every stored one by its `{anchor_id}`, supporting ones in their stored order — writes nothing. A reference sent as new always counts as a change, even when it repeats a stored one. Any other change to a value replaces it, returns it to **Not reviewed** (clearing the review, its note and its reviewed version) and increments `value_version`. A batch in which nothing differs answers `unchanged`. Otherwise the study version moves by exactly one and the history records one header and one event per change (§9).

## 4. `evidence_review_fields`

One value, one `value_version`, one action per call. There is no array parameter, so no request can confirm two values, and there is no automatic, bulk or record-level confirmation (001A PD-7). A review changes `review_status`, `review_note`, `reviewed_at` and `reviewed_version` — never `value_version`.

- `p_expected_value_version` must be the value's current version (`evidence_version_conflict`, DETAIL `p_expected_value_version`), so a Confirm can never land on a value the user has not seen.
- **Flag** needs a note of at least 3 characters (measured after trimming spaces, and not blank after v1), in any state. Flag again with the same note is `unchanged`.
- **Confirm** takes an optional note, never blank. Confirm of a version already confirmed with the same note is `unchanged` (001A §I5); it is checked after the version check and before the preconditions, which is safe because every path that could invalidate a precondition — any edit, a rebase, a first capture — moves the value out of Reviewed by you and increments `value_version`. A different note re-confirms.
- Otherwise Confirm is refused with `evidence_confirm_blocked`, DETAIL a comma-separated list in PR-B's `ConfirmBlock` codes and order (`checkConfirm` in `review.ts`):

| Code | When |
|---|---|
| `sources_not_allowed`, `examined_source_missing`, `unclear_source_missing`, `unavailable_source_missing` | the references break the state's §J row |
| `no_current_support` | a Reported value has neither an abstract quote on its link's current copy nor a full-text locator — including `design_classification` (Product Owner decision 2) and a Reported value with no source (decision 3) |
| `unclear_source_not_current` | an Unclear value's only basis is quotes on superseded copies (decision 1); an examined source always counts |
| `examined_abstract_not_current` | an examined abstract is not its link's current copy |
| `unavailable_abstract_has_copy` | an "abstract unavailable" reference's link now has a copy |
| `count_not_confirmed` | a Reported number has no integer |
| `state_reason_missing` | an Unclear value has no reason |
| `note_missing` | a required Unclear or Not applicable note is missing, too short or blank after v1 |

The five block messages PR-B added are provisional copy, to be refined in the Study Record UI phase (Product Owner decision 5).

## 5. `evidence_rebase_source`

"Use current abstract", and the first capture of a link without a copy (001A §E2–§E8; FK-PROOF-001 §J).

1. The caller sends `p_expected_abstract_sha256`: the lowercase hex SHA-256 of the UTF-8 abstract it displayed. The paper is then read with the owner predicate `FOR SHARE`, so an edit or merge already in flight finishes first and one that starts waits for this commit. A NULL abstract, or one whose hash differs, is `evidence_source_changed_again`: the user reviews the abstract again before saving it.
2. An abstract over 50,000 characters is `evidence_abstract_too_long`; one that is empty after v1 is `22023` with DETAIL `p_expected_abstract_sha256: source_empty`.
3. The same text as the current copy, byte for byte, is `unchanged`.
4. At most 20 copies per link (`evidence_snapshot_limit`, a proposed limit, §10). A new copy, `seq` n + 1, is inserted with both fingerprints; no copy is ever updated or removed.
5. Each abstract quote on the previous current copy is located in the new one. Exactly one occurrence re-points it (`anchor_rematched`); none, several or more than the cap leave it on its earlier copy (`anchor_not_rematched`, with the reason). Examined abstracts are never re-pointed. The order is deterministic.
6. **Strict re-review (001A §E5, PD-6).** Every value with any abstract reference on that link that was Reviewed by you, Flagged or Needs re-review is **Needs re-review** (`source_changed`) afterwards — **even if every quote was found again**. Not-reviewed values stay Not reviewed. A first capture moves values holding an "abstract unavailable" reference on that link the same way (FK-PROOF-001 §J). `value_version` increments wherever a reference moved or the status changed.

## 6. Quote matching (`evidence_locate_quote`)

REQUIREMENTS-001 §I4 with the Product Owner's offset convention:

- The copy is normalized once for all quotes, and each quote once, with the installed `evidence_normalize_v1` — never twice, because v1 is not idempotent.
- A match is a contiguous occurrence of the normalized quote in the normalized copy. Every occurrence counts, overlapping ones included, in position order. Case, punctuation and every character count; an ellipsis is three full stops; nothing approximate matches.
- The search compares UTF-8 bytes. UTF-8 is prefix-free and a continuation byte never starts a character, so a byte match is exactly a code point match.
- **Offsets** are 0-based, half-open `[start, end)` code point offsets of the v1-normalized copy — PostgreSQL character positions.
- A quote is invalid when it has fewer than 3 or more than 1,000 characters as stored or once normalized, or contains **no letter or digit**: `[[:alnum:]]` under the builtin `pg_c_utf8` collation — Unicode Alphabetic, or an ASCII digit — whatever the database's own collation provider is. A digit of another script is not one; a letter number (a Roman numeral) is.
- At most 100 occurrences are enumerated (a proposed limit PR-A3 added, §10); beyond that the status is `too_many`, with no count and no offsets.
- Statuses are `invalid` (with problems `quote_missing`, `quote_too_short`, `quote_too_long`, `normalized_too_short`, `normalized_too_long`, `no_letter_or_digit`, in that order), `not_found`, `unique`, `multiple` and `too_many`.

The TypeScript `locateQuote` applies the same rules and is advisory. Suite 032 runs every matching vector of the shared fixture through both, offsets included; the vectors' expected values were derived outside both implementations.

Measured locally, the worst cases for the byte search are small: an adversarial 1,000-character quote that almost matches everywhere in a 50,000-character copy takes about 20 ms, and the 62 such quotes a 64 KB save can carry about 85 ms.

## 7. Errors

Fixed messages that never echo input, ids, text or SQL. The PR-A2 refusals of [evidence-records-lifecycle.md](evidence-records-lifecycle.md) §4 apply too.

| SQLSTATE | Message | DETAIL |
|---|---|---|
| 22023 | `evidence_invalid_input` | the parameter (`p_note`), or a payload path and rules: `p_changes[3].references[1].snapshot_id: not_current` |
| P0002 | `evidence_not_found` | — (the study) |
| P0002 | `evidence_link_not_found` | save: the reference's `paper_id` path; rebase: — |
| P0002 | `evidence_target_not_found` | the path of the id that names nothing of the caller's: a group, outcome, value (`p_value_id`), kept reference or copy |
| P0001 | `evidence_version_conflict` | none for the study version; `p_expected_value_version` or `p_changes[i].expected_value_version` for a value |
| P0001 | `evidence_request_id_reused` | — |
| P0001 | `evidence_quote_not_found`, `evidence_quote_ambiguous` | the reference's path |
| P0001 | `evidence_confirm_blocked` | the reasons (§4) |
| P0001 | `evidence_source_changed_again`, `evidence_abstract_too_long` | — |
| P0001 | `evidence_snapshot_limit`, `evidence_arm_limit`, `evidence_outcome_limit`, `evidence_value_limit`, `evidence_history_limit` | — |
| P0001 | `evidence_requires_read_committed` | — |
| XX000 | `evidence_internal_invariant` | — (unreachable by design) |

Paths are 0-based. `src/lib/evidence/errors.ts` parses DETAIL with a strict grammar and drops anything outside it.

## 8. Request ids, versions and concurrency

FK-PROOF-001 I-1, exactly as PR-A2 (lifecycle §5): pure validation; a transaction-scoped advisory lock on (caller, request id) in namespace 20261016, shared with PR-A2's RPCs; the committed request header — the same operation and payload fingerprint replays its stored answer, anything else is `evidence_request_id_reused`; the study row `FOR UPDATE` and the version check; `unchanged` writes nothing. The fingerprint is SHA-256 over the UTF-8 text of a jsonb object holding the operation and every argument except the request id.

Locks, in order: the request advisory lock; the study row `FOR UPDATE`; for rebase, the paper row `FOR SHARE`; the inserts take `KEY SHARE` through their foreign keys. No function locks a table. Every write inside a study therefore serializes on its study row, and every limit is checked on the batch's final state under that lock, so neither a large batch nor concurrent requests can pass one.

The field race probe runs these with real separate sessions, each forced order observed blocked on the expected lock before the holder commits:

| Case | Race | Outcome |
|---|---|---|
| F1 | identical saves | the second replays the first |
| F2 | one request id, two bodies | the second is `request_id_reused` |
| F3 | two saves at one study version | the second is a version conflict |
| F4 / F5 | a save against a Confirm of the same value, both orders | the late Confirm conflicts on the value version; the late save applies and resets the review |
| F6 / F7 | a rebase against a Confirm, both orders | the late Confirm conflicts; the late rebase sets Needs re-review again |
| F8 / F9 | a rebase against the owner's abstract edit, both orders | the edit waits for the rebase, whose copy is the text displayed; the late rebase is `source_changed_again` |
| F10 / F11 | a save citing a link against removing that link, both orders | `link_not_found`; `link_in_use` |
| F12 | the 20th group against a 21st | `evidence_arm_limit` |
| F13 | a save reaching 5,000 events against one passing it | `evidence_history_limit` |
| F14 | a rolled-back attempt, its retry, and a retry after a lost answer | nothing, applied, replayed |
| F15 | the 20th copy of a link against a rebase of the same text | the late rebase is `unchanged`; the next text is `evidence_snapshot_limit` |

Barrier-released free rounds then race identical saves, conflicting saves, Confirm against a save, and a rebase against an abstract edit; every round must match one serial order.

## 9. History

Append-only. Each committed request writes one header (`ordinal 0`, with the operation, the payload fingerprint and the answer) and its events (`ordinal 1..n`) at the new study version. No function here updates or deletes an event.

| RPC | Events |
|---|---|
| save | `arm_added`, `arm_updated` (changed fields only), `arm_removed` (with the ids, states and versions of the values removed with it); the same for outcomes; `value_saved` (before and after digests), `value_cleared` (before) |
| review | `review_confirmed`, `review_flagged` (before and after digests) |
| rebase | `source_captured`, `anchor_rematched` / `anchor_not_rematched`, `review_needs_rereview` (before and after digests), `source_rebased` (a summary) |

Groups and outcomes are recorded with their labels, as PR-A2 records the study label. A value digest names its state, codes, integers, ids, versions, review and every reference with the `seq` of its copy and its match, but every user text — values, list entries, notes, review notes, locators — and every quote only as `{sha256, chars}` (a list as `{sha256, count}`). No event holds source text, and every payload stays inside the 32 KB PR-A1 allows. `review_reset` is not emitted: `value_saved` records the review it cleared.

## 10. Limits

The limits PR-A3 introduces are **proposed policy**. This migration enforces them, but none is a Product Owner decision, Q11 is still open, and each needs explicit acceptance as part of an authorized Production rollout (§13).

| Limit | Value | Status |
|---|---|---|
| History events per study | 5,000 | kept: in Production since PR-A2 |
| Supporting references per value | 3 | kept: in Production since PR-A1 (CHECK) |
| Abstract length | 50,000 characters | kept: in Production since PR-A1 (CHECK) and PR-A2 |
| Groups / outcomes / values per study | 20 / 50 / 400 | **proposed**: the earlier Q11 proposal |
| Copies per study–report link | 20 | **proposed**: the earlier Q11 proposal |
| Changes / bytes per save | 200 / 65,536 | **proposed**: the earlier Q11 proposal |
| Assessments per value | 10 | **proposed**: added by PR-A3 |
| Occurrences enumerated per quote | 100 | **proposed**: added by PR-A3 |

- **The earlier Q11 proposal** is Requirements-001 L10, as amended by 001A §L ("per study–report link: 20 copies" in place of "per paper: 20 snapshots"). It is Q11's recommended default, and Q11 has not been decided. PR-A3 enforces its per-study, per-link and per-call counts as listed. Its other entries were already enforced by PR-A1/PR-A2 and are unchanged here: 2,000 studies per user, 5,000 events per study, and 3 sources per value (PR-A1's cap of 3 supporting references).
- **The two additions are PR-A3's own.** L10 sets no bound on a value's examined-or-unavailable assessments, nor on how many occurrences of a quote are enumerated. PR-A3 caps assessments at 10 per value, to bound a value's history digest, and enumerated occurrences at 100 per quote, to bound the work and the answer of one match. They are engineering proposals, not Product Owner decisions.
- **Acceptance and change.** Each proposed value is accepted, or changed, explicitly at the Production rollout. Until this migration is applied anywhere, a change amends it; after that, a change is a new migration.

## 11. Client privilege model

- The eight evidence tables stay SELECT-only for `authenticated` under FORCE RLS; this migration adds no table privilege, policy, trigger, view or column grant. The RPCs are the only write path.
- EXECUTE: the seven client RPCs (PR-A2's four, PR-A3's three) for `authenticated` only; nothing for `anon`, `service_role` or PUBLIC; the internal helpers for their owner only. Suites 003, 007, 015, 021 and 030–033 pin the inventory, and the migration's own `$verify$` block refuses a weaker result.
- No function here uses dynamic SQL.
- `src/test/evidenceDomainBoundary.test.ts` allows `.rpc()` only in `src/lib/evidence/lifecycleClient.ts`, only for these seven literal names, each exactly once, and no evidence-table write anywhere in the product.

## 12. Known limitations

- Owner-only pilot; delete stays ungated (PR-A2).
- No UI, and no application caller (PR-C1/C2).
- No RPC adds a link: a study's further reports are planted only by the owner in tests. Linking further reports belongs to a later phase.
- Full-text references are locator-only; non-library sources are deferred (001A PD-3, PD-4).
- The proposed limits (§10) need explicit acceptance at the Production rollout; Q11 is still open.
- "Letter or digit" and NFC follow PostgreSQL 17's built-in Unicode 15.1 tables. A browser's newer Unicode version can disagree on characters assigned since; the server's answer stands.
- Strict re-review resets every review that depends on a link's abstract on every rebase, including typographic-only changes. That is the accepted 001A §E5 rule, not a defect.
- A rebase writes one event per re-checked quote and per changed value. On a study near 5,000 events it can be refused by the history limit; delete still works.
- A request id is remembered only while its study exists (lifecycle §5).
- The generated types list `p_note` as non-null; `src/lib/evidence/fieldRequests.ts` widens only that argument.

## 13. Production migration prerequisites

Applying `20261017155445` to Production is **not** authorized by EVIDENCE-RECORDS-001A3. Before an authorized application:

- **Dependencies.** PR-A1 (`20261012031537`) and PR-A2 (`20261016104232`) applied, and nothing in between. The file's `$pre$` block checks and refuses otherwise: UTF-8 encoding; an applying role that holds BYPASSRLS; exactly PR-A2's six evidence functions with their reviewed bodies (pinned `md5(prosrc)`) and the helpers' attributes; `get_current_user_access()` and `auth.uid()`; the eight tables with PR-A1's CHECK and UNIQUE constraints (pinned digest); the request-header unique index; the `pg_c_utf8` collation.
- **The proposed limits (§10)** are accepted, or changed, explicitly as part of that authorization. Neither EVIDENCE-RECORDS-001A3 nor its review accepted them.
- **A read-only preflight first**, as for 001A1/001A2: the pending-migration plan computed against the ledger, the `$pre$` conditions, and a catalog fingerprint to compare after. A `supabase db push --dry-run` is not side-effect-free (it mints a login role), so the plan is computed instead.
- **The apply.** The file is one explicit transaction and its `$verify$` block fails closed. It creates functions, grants and comments only, and takes no lock on any user table. As with PR-A1/PR-A2, the CLI's ledger insert runs after the file's own `COMMIT`; a connection lost between the two leaves the functions installed with no ledger row, which needs a separately authorized `migration repair`.
- **After.** Read-only catalog verification: the six functions, their attributes, owners, ACLs and bodies; the table privileges unchanged. An authenticated smoke test is a separate authorization.
- Nothing in the application calls these RPCs, so applying them changes no user-facing behaviour.

## 14. Rollback

Forward-only. A reversal is a new migration that drops the three RPCs, then the three helpers; no other object depends on them, and no table, policy or row is touched. Rows the RPCs wrote are ordinary PR-A1 rows — every CHECK and key still holds — and stay readable; removing them is a separate decision (each study can be deleted with `evidence_delete_study`). The narrowest emergency stop is `REVOKE EXECUTE … FROM authenticated` on the three RPCs, itself a Production privilege change that needs authorization.
