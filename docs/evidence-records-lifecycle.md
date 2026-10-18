# Study records — lifecycle RPC contract (EVIDENCE-RECORDS-001A2)

> **Status:** applied to Production. Migration `20261016104232_add_evidence_records_lifecycle_rpcs.sql` (PR #344) was merged on 2026-10-16 and applied to Supabase Production the same day. The four RPCs and the two internal helpers below are installed in the Production database, beside the eight evidence tables of `20261012031537` (PR-A1). There is still no user-facing Study Record interface: nothing in the app calls these functions. The typed client for them in `src/lib/evidence/` (EVIDENCE-RECORDS-001B, [evidence-domain-library.md](evidence-domain-library.md)) is not used by application code either. The write path inside a study — groups, outcomes, values, references, review and rebase — is EVIDENCE-RECORDS-001A3 ([evidence-records-field-operations.md](evidence-records-field-operations.md)), whose three RPCs were applied to Production on 2026-10-18; nothing in the app calls them either.

This document is the client contract for the four functions that create, edit, link and delete study records, and the two internal helpers behind them. The migration header holds the database-level detail; suite `031_evidence_records_lifecycle.test.sql` and the db-tests lifecycle's evidence lifecycle race probe (`scripts/e2e-local.mjs`) are the executable specification.

## 1. Functions

| Function | Who may call it | What it does |
|---|---|---|
| `evidence_create_study_from_paper(p_paper_id, p_label, p_design_profile, p_link_status, p_request_id)` | authenticated, **owner only** | A new study, its `created_from_paper` link to one of the caller's papers, and — when the paper has an abstract — a saved copy of it. All at study version 1. |
| `evidence_update_study(p_study_id, p_expected_version, p_label, p_design_profile, p_notes, p_request_id)` | authenticated, **owner only** | Replaces label, design family and notes. `p_notes` NULL means no notes. |
| `evidence_set_link(p_study_id, p_paper_id, p_action, p_expected_version, p_request_id)` | authenticated, **owner only** | `confirm`, `mark_provisional` or `remove` one existing link of the study. |
| `evidence_delete_study(p_study_id, p_expected_version, p_request_id)` | **any** authenticated owner of the study | Deletes the study and everything it holds, history included. |
| `evidence_records_assert_writable()` | nobody (internal) | The pilot gate. |
| `evidence_normalize_v1(text)` | nobody (internal) | Match normalization v1, used to fingerprint saved copies. |

The four RPCs are `SECURITY DEFINER` with `search_path = public, pg_temp`, owned by `postgres`, and executable by `authenticated` alone; `anon` and `service_role` hold nothing. The tables stay SELECT-only for `authenticated`: these functions are the only write path. Each one takes the caller from `auth.uid()`, accepts no user id, and names that caller's `user_id` in every read and write.

## 2. The pilot gate

Create, update and set_link first call `evidence_records_assert_writable()`:

- no authenticated subject → `42501 evidence_auth_required`;
- a caller whose role in `internal_user_access` (read through `get_current_user_access()`) is not exactly `owner` → `42501 evidence_records_not_enabled`.

The role is read on every call and never from the JWT, so removing a user's role row refuses their next call. A manager is not an owner. **Delete is not gated**: whoever owns a study can always delete it, which also frees the papers its links protect.

## 3. Answers

Every RPC returns a JSON object with a `status`:

| `status` | Meaning | Other fields |
|---|---|---|
| `applied` | The request changed the study now. | create: `study_id`, `study_version` (1), `link_id`, `snapshot_id` (null without a copy). update: `study_id`, `study_version`. set_link: `study_id`, `study_version`, `paper_id`, `link_id`, `link_status` (null after `remove`). |
| `replayed` | This request id was already applied; this is that request's **original** answer. | As the original. |
| `unchanged` | The request would change nothing. Nothing was written. | update: `study_id`, `study_version` (current). set_link: as `applied`, at the current version. |
| `deleted` / `already_absent` | Delete removed the study / there is no such study of the caller's. | — |

## 4. Errors

Fixed messages that never echo input, ids or SQL.

| SQLSTATE | Message | When |
|---|---|---|
| 42501 | `evidence_auth_required`, `evidence_records_not_enabled` | §2 |
| 22023 | `evidence_invalid_input` | A parameter is missing, out of bounds or not in its closed list. DETAIL names the parameter. |
| P0002 | `evidence_not_found` | The study is not one of the caller's (unknown and foreign ids answer alike). |
| P0002 | `evidence_paper_not_found` | Create: the paper is not one of the caller's. |
| P0002 | `evidence_link_not_found` | set_link: the caller's study has no link to that paper. |
| P0001 | `evidence_version_conflict` | `p_expected_version` is not the study's current version. Reload, then retry with a **new** request id. |
| P0001 | `evidence_request_id_reused` | The request id was already committed with another operation or other arguments. |
| P0001 | `evidence_profile_change_blocked` | Moving to `non_intervention` while the study has a group or any `n_randomized` value. |
| P0001 | `evidence_last_link` | Removing the study's only link. Delete the study instead. |
| P0001 | `evidence_link_in_use` | Removing a link that a source reference uses. |
| P0001 | `evidence_abstract_too_long` | The paper's stored abstract exceeds 50,000 characters; nothing is created. |
| P0001 | `evidence_study_limit`, `evidence_history_limit` | 2,000 studies per user; 5,000 history events per study. |
| P0001 | `evidence_requires_read_committed` | The caller's transaction is not READ COMMITTED (PostgREST always is). |

## 5. Request ids, replays and versions

The client generates one request id (a UUID) per user action and reuses it for every retry of that action (FK-PROOF-001 I-1):

- A retry with the same id and the same arguments returns `replayed` with the original answer — even after later writes moved the study on.
- The same id with other arguments, or for another operation, is refused (`evidence_request_id_reused`). It is never applied twice.
- Identical requests arriving at the same moment serialize on a transaction-scoped advisory lock; the second replays the first. The unique index `evidence_events_request_header_key` is the backstop.
- A request that changes nothing (`unchanged`) records nothing, so its id is not consumed. A retry of it is evaluated afresh: `unchanged` again, or `evidence_version_conflict` if another write has moved the study.
- A request that failed or was rolled back left nothing; its retry runs afresh.
- **The guarantee lasts only as long as the study.** Deleting a study deletes its history, request headers included, so a create retried after its study was deleted creates a new study. This is not exactly-once execution forever.

Update, set_link and delete carry the version the client last read. A different version refuses the request (`evidence_version_conflict`) without writing anything; the client should keep the user's edits, reload, and resend with a new request id.

The payload fingerprint is SHA-256 over the UTF-8 text of a jsonb object holding the operation name and every argument except the request id. jsonb orders its own keys, so argument order never matters.

## 6. Source capture at creation

Create reads the paper's stored abstract on the server and saves a byte-exact copy for the new link (`source_kind = library_abstract`, `seq = 1`), with `exact_sha256` over its UTF-8 bytes, `normalized_sha256` after match normalization v1, `normalization_version = 'v1'` and `char_count`. The browser never sends the text. A NULL abstract, or one that is empty after v1 (white space and invisible format characters only), gets no copy. A copy is the abstract **as stored in the user's library** — nothing checks it against a publisher or PubMed.

**Match normalization v1** is REQUIREMENTS-001 §I3, applied in this order: Unicode NFC (never NFKC or NFKD, which would read `10⁵` as `105`); remove U+00AD, U+200B, U+2060 and U+FEFF; map every Unicode `White_Space` character to a space, collapse runs and trim; map ‘ ’ ‚ ‛ to `'` and “ ” „ ‟ to `"`; map U+2010–U+2015 and U+2212 to `-`; map U+2026 to `...` and U+00B5 to U+03BC; nothing else. The order matters at the edges: a soft hyphen between `e` and a combining accent is removed only after NFC, so that pair stays decomposed. Suite 031 pins 30 golden vectors whose expected outputs and SHA-256 values were computed outside PostgreSQL. The shared fixture of EVIDENCE-RECORDS-001B carries those vectors and more; suite 032 runs it against the installed function and Vitest against the TypeScript normalizer ([evidence-domain-library.md](evidence-domain-library.md) §6).

**Phase order.** The staged plan put `evidence_normalize_v1` in PR-A3 (001A3). PR-A1's schema already requires a v1 fingerprint on every copy, so only that function moved into this phase. Server-side quote location and matching, and every source-reference write, are 001A3, which reuses this function unchanged ([evidence-records-field-operations.md](evidence-records-field-operations.md) §6). The TypeScript normalizer, its shared fixture and the parity check are 001B ([evidence-domain-library.md](evidence-domain-library.md) §6).

## 7. History

Each committed request writes one header (`ordinal 0`, `event_type = 'request'`, with the operation, the payload fingerprint and the answer) and its change events (`ordinal 1..n`), all at the new study version. Creation is version 1; every later change is exactly one new version.

| Event | Records |
|---|---|
| `study_created` | label, design family, notes (null) |
| `study_updated` | the changed fields only, before and after; notes as `{sha256, chars}` |
| `link_created` | paper, link status, basis |
| `link_status_changed` | paper and link status, before and after |
| `link_removed` | paper, link status, basis, and the ids of the copies removed with the link |
| `source_captured` | paper, `seq`, both fingerprints, `normalization_version`, `char_count` |

No event holds abstract text or notes text: notes can be 10,000 characters, which could exceed the 32 KB PR-A1 allows for an event's before + after. No function updates an event; only delete removes them, with their study.

## 8. Links, design family and deletion

- **Links.** set_link changes an existing link only. It never creates one, re-parents one, or infers that two papers report one study — linking further reports to a study belongs to a later phase. A link is removed only when no source reference uses it and it is not the study's last; its copies go with it.
- **Design family.** Groups and the number randomized exist only in the intervention families, so a move to `non_intervention` is refused while either exists. Every other move is allowed.
- **Deletion.** Delete locks the study, checks the version, and removes references, values, groups, outcomes, copies, links, history and the study in that order. Afterwards the papers it linked can be deleted or merged again.

## 9. Limitations

- Owner-only pilot. Widening it is one reviewed change to `evidence_records_assert_writable()` plus a separate Production authorization (001A G7).
- These four functions never create or change groups, outcomes, values, source references or reviews (delete only removes them with their study), and never rebase a copy. EVIDENCE-RECORDS-001A3's three RPCs do ([evidence-records-field-operations.md](evidence-records-field-operations.md)), behind the same owner-only gate; they are installed in Production, but no authenticated call has exercised them there.
- A request id is remembered only while its study exists (§5).
- Generated TypeScript types list every argument as required and non-null (`p_notes: string`); the database accepts NULL for `p_notes`. `src/lib/evidence/lifecycleRequests.ts` widens only that argument.
