# Study records — domain library (EVIDENCE-RECORDS-001B)

> **Status:** implemented in `src/lib/evidence/`. Pure TypeScript with no UI, and nothing in the application imports it yet. Every rule here is advisory: the database CHECKs and the RPCs decide. The RPC contract itself is in [evidence-records-lifecycle.md](evidence-records-lifecycle.md).

The library gives PR-A3 (the save, review and rebase RPCs) and PR-C1/C2 (the Study record dialog) one typed, tested implementation of the study-record domain. It covers the field dictionary, validation, the value and review state rules, match normalization v1, quote matching, number suggestions, identity and link rules, error classification, and a client for the four deployed lifecycle RPCs.

## 1. Modules

| Module | What it holds | Side effects |
|---|---|---|
| `fieldDictionary.ts` | The 23 closed field keys, their scope, shape, bounds, design families, group roles, core/optional status, labels and where each rule is enforced | none |
| `types.ts` | Closed vocabularies, generated rows narrowed to them, and the domain models | none |
| `ids.ts` | Branded identities (study, paper, link, copy, group, outcome, value, reference, request) and versions | none |
| `records.ts` | Generated rows mapped onto the domain models, failing closed | none |
| `validation.ts` | Value, reference and study-header validation with stable issue codes | none |
| `states.ts` | The value-state rule table, state labels and the derived "No source given" | none |
| `review.ts` | Confirm and Flag preconditions, reset on edit, re-review after a source change | none |
| `sources.ts` | The saved copy against the library abstract (001A §E2) and what creation will capture | none |
| `identity.ts` | Link transitions, labels and the study/report helpers | none |
| `normalization.ts` | Match normalization v1 and its index map | none |
| `matcher.ts` | The advisory abstract-quote matcher | none |
| `numbers.ts` | Number suggestions and the digit-not-in-quote warning | none |
| `errors.ts` | The error taxonomy and classification | none |
| `lifecycleRequests.ts` | Prepared, validated requests for the four RPCs | none |
| `lifecycleClient.ts` | The only module that calls `.rpc()`: four literal names, on an injected client | one RPC per call to `send` |

`src/test/evidenceDomainBoundary.test.ts` enforces the last column (§9).

## 2. Sources and precedence

Rules come from, in this order: accepted Product Owner decisions; the applied PR-A1 and PR-A2 migrations; FK-PROOF-001's corrections; Requirements-001A; and Requirements-001 where it is not superseded. Each field records where its rules are enforced. `pr_a1_check` is a CHECK constraint. `pr_a2_rpc` is an applied RPC. `pr_a3_planned` is a rule the requirements give to an RPC that does not exist yet, so nothing on the server enforces it today.

These parts of Requirements-001 are superseded, and are **not** implemented:

- the `basis` column (`abstract`, `full_text`, `abstract_and_full_text`, `other_source`) — replaced by source references with a purpose (FK-PROOF-001 §J);
- non-library sources and `basis = other_source` — deferred (001A PD-4);
- full-text quotes and the 300-character cap — references are locator-only (PD-3), and a reference has no `source_label`;
- bulk confirmation — removed (001A §I, PD-7);
- keeping a review when a re-matched quote is found again — replaced by strict re-review (001A §E5, PD-6);
- one copy per paper, de-duplicated by hash — replaced by copies per study-report link with `seq` (001A §D2);
- `n_randomized_arm` — deferred (Q10).

## 3. Field dictionary

`EVIDENCE_FIELDS` lists exactly the keys of `evidence_field_values_field_key_check`: 10 study, 8 group and 5 outcome keys. Each carries the shape and bounds of `evidence_field_values_value_shape_check`:

- text, 300–4,000 characters depending on the field;
- a closed code list;
- an integer with its reported text: the text is 1–200 characters and the integer 0–10,000,000, always stored together;
- a list: registration numbers take 1–5 entries of 3–50 characters with no white space; time points take 1–10 entries of 1–100 characters, white space inside only.

Characters are Unicode code points, as PostgreSQL's `char_length` counts them.

**Design families.** Groups and `n_randomized` exist only in `rct_parallel` and `intervention_other`. PR-A2 refuses moving a study that has either to `non_intervention`, and a PR-A3 save must refuse adding them there. `comparator_type` applies to comparator groups only (`pr_a3_planned`). Labels and core/optional status are Requirements-001 §H2–H5 and §E13; `n_enrolled` is core only for `non_intervention`. The code-list labels are provisional copy for PR-C1.

**Parity.** `fieldDictionary.parity.test.ts` re-derives every key, scope, shape, bound and code list from the PR-A1 SQL text. It takes the family rule from PR-A2's `evidence_update_study`, and the other closed vocabularies and bounds from their CHECKs and argument checks. It then compares them with the dictionary. Negative controls mutate either side and must be caught. A new key, or a new meaning for an old one, therefore needs a migration first.

## 4. Values, states and sources

No row means **Not yet recorded**, which is never stored. Which sources a value may name depends on its state (FK-PROOF-001 §J; a PR-A3 RPC will enforce it):

| State | Supporting | Examined | Unavailable | Also required |
|---|---|---|---|---|
| Reported | 0–3 | 0 | 0 | a typed value |
| Not reported | 0 | ≥ 1 | any | — |
| Unclear | 0–3 | any; at least one supporting or examined | any | a reason; a note of ≥ 10 characters |
| Not applicable | 0 | 0 | 0 | a note of ≥ 3 characters |
| Couldn't check | 0 | 0 | ≥ 1 | — |

Each reference follows the PR-A1 matrix:

- An abstract quote names the copy, and the server computes its match columns; the browser can send none of them.
- A supporting full-text reference needs a locator. An examined one may have one. Nothing stores full-text text.
- A **new** quote, or a new examined abstract, must name the link's current copy (001A §D1 R5). An unavailable abstract names a link that has no copy.

A value holds at most one examined-or-unavailable assessment per report and source kind. A Reported value with no supporting source gets the derived warning **No source given** and cannot be confirmed.

`checkStateReferences` states the table's count rules once, from `VALUE_STATE_RULES`, together with PR-A1's cap of three supporting sources. `validateValueDraft` and `checkConfirm` both use it, so a value whose sources break its state's row can be neither saved from the browser nor confirmed. The tests check it against a transcription of §J (`__tests__/fixtures/sectionJ.ts`), not against the table.

Validation never rewrites input. Untrimmed list entries are an error; `trimListEntries` is an explicit fix the UI shows. "Blank" means empty after normalization v1, the rule PR-A2 applies to labels and notes; for values, PR-A3 decides whether its RPCs adopt it. Note minimums are measured as the CHECK measures them, after trimming spaces only.

## 5. Review

`checkConfirm` takes **one** value and the `value_version` on screen. There is no bulk, automatic or record-level confirmation. It returns one of three outcomes:

- **allowed**, with the `{ valueId, valueVersion }` binding for the PR-A3 review RPC;
- **already reviewed**, when Confirm would change nothing;
- **blocked**, with reasons to show beside the button.

A stale version is refused first, because the user must reload. Otherwise Confirm is blocked, with every reason at once, when:

- the sources break the state's row in the table above: Not reported without an examined source, Unclear without a supporting or examined one, Couldn't check without an unavailable one, a source the state forbids (Not applicable takes none), or more than three supporting sources;
- a Reported value has no current support — an abstract quote on the link's current copy, or a full-text locator; quotes on superseded copies do not count;
- an Unclear value's only basis is quotes on superseded copies (001A's amendment to 001 §J1: only current-copy quotes count toward Confirm);
- in any state, an examined abstract is not the current copy, or an "abstract unavailable" claim now has a copy;
- a number has no confirmed integer;
- an Unclear value has no reason, or an Unclear or Not applicable note is too short or blank after v1.

Flag needs a note of at least 3 characters, in any state. Any change to state, reason, content, note or sources returns a value to Not reviewed (`predictReviewAfterSave`).

When a link's copy is replaced or first saved, `deriveSourceChangeTransitions` applies 001A §E5 to every value with any abstract reference on that link. Reviewed, flagged and needs-re-review values go to **Needs re-review** (`source_changed`), even if every quote is found again; not-reviewed values stay. A typography-only difference keeps the saved copy by default (`deriveSourceState`), so nothing changes unless the user chooses the current abstract.

## 6. Normalization v1 and the shared fixture

`normalizeEvidenceV1` mirrors the deployed `public.evidence_normalize_v1` step by step:

1. NFC;
2. remove U+00AD, U+200B, U+2060 and U+FEFF;
3. map the 25 White_Space code points to a space, collapse runs and trim;
4. map curly quotes to `'` and `"`;
5. map U+2010–U+2015 and U+2212 to `-`;
6. map U+2026 to `...` and U+00B5 to U+03BC.

Nothing else happens. **Normalize each original input exactly once**: v1 is not idempotent, because NFC runs before removal. `e`, U+00AD, U+0301 becomes `e` + U+0301, and a second pass would compose it.

Text PostgreSQL cannot store — a lone surrogate, or U+0000 — throws `EvidenceTextError` instead of being normalized.

**Parity.** The fixture `src/lib/evidence/__tests__/fixtures/normalizationV1.vectors.json` holds normalization and matching vectors. Among them are suite 031's 30 golden vectors and the migration's 6 self-checks. Expected values were written by hand and re-derived outside both implementations (Python `unicodedata`, identical under Unicode 13.0 and 16.0). The file is printable ASCII; every other character is a JSON `\u` escape.

- Vitest runs the TypeScript normalizer and matcher on every vector.
- pgTAP suite `032_evidence_normalization_parity.test.sql` embeds the file **byte for byte** and runs the installed function on every vector, SHA-256 included. It also uses built-in `substr`/`char_length` as an oracle for the matching offsets; it creates no function.
- `normalization.parity.test.ts` fails if the embedded copy drifts. It also parses suite 031's `chr()` vectors and the migration's checks from their SQL text and requires them to equal the fixture.

To change a vector, edit the JSON, then replace everything between the two dollar-quote tags in suite 032 with the file's exact contents.

**Limitation.** Each NFC follows its own Unicode tables: PostgreSQL 17 its built-in Unicode 15.1, a browser or Node its ICU. They agree for every character both versions assign. Text with characters assigned later can normalize differently, so the browser's answer is advisory.

## 7. Advisory matcher and offsets

`locateQuote(quote, copy)` normalizes each input once. A match is a contiguous occurrence of the normalized quote in the normalized copy.

- The stored quote must be 3–1,000 characters.
- The normalized quote must be 3–1,000 characters and contain a letter or digit (Unicode L or N).
- Every occurrence counts, overlapping ones included, in position order.
- The result is `invalid` (with its problems), `not_found`, `unique` or `multiple`.

Each occurrence has:

- `occurrence` — 1-based;
- `normalized` — 0-based, half-open **code point** offsets into the normalized copy. These are PostgreSQL character positions, the convention 001 §I4 gives `match_start`/`match_end`, and suite 032 checks them on the server;
- `exact` — the same span in the original copy, through the index map; `snapped` when a boundary fell inside one character's output (an expanded ellipsis, a composed sequence);
- `exactUtf16` — JavaScript indices, for highlighting only;
- `context` — up to 40 characters on each side.

`selectOccurrence` and `resolveSelectedOccurrence` / `quoteFromSelection` let the user choose an occurrence explicitly, or from their selection.

Offsets are typed `CodePointOffset` and `Utf16Offset`, so one cannot be passed for the other.

Every result says `attestation: "browser_advisory"`. The matcher cannot store a reference, set `matched_at`, assert a server match count, review a value, or say the quote supports the value. If the server's PR-A3 match disagrees, the server's refusal stands and the user resolves it.

## 8. Numbers

`suggestCount` suggests an integer only when the text holds exactly one plain number: `1,204` gives 1204, `n = 120` gives 120. Everything else is refused with its reason:

- words ("one hundred twenty");
- several numbers, and ranges;
- decimals, negatives and percentages;
- units ("120 mg", "12 weeks");
- qualifiers (`>`, `~`, `≈`) and exponents (`10⁵`);
- a number attached to a word ("COVID-19", "5th");
- malformed grouping, a leading zero, and non-ASCII digits;
- anything above 10,000,000.

The user always confirms the integer. `checkCountInQuote` warns, and never blocks, when the confirmed number appears in no quote under any reading of its digit groups. It is not a correctness check.

## 9. Identity, links and boundaries

A study is never a paper: the branded types differ, one paper can report several studies (`studiesOfPaper`), and nothing infers identity. `checkLinkAction` follows `evidence_set_link`. It acts on **existing** links only, since there is no add. It refuses removing the last link before checking references, as the RPC does. A study keeps at least one paper; deleting the study frees its only paper. `papersHeldByStudies` names the papers a delete or duplicate merge would be refused for.

The boundary test parses the library's source. Every module must stay inside an import allow-list, with the generated types usable for types only. None may use a network, storage, browser, clock, randomness, crypto or reflection global, a dynamic import, `eval`, a write method, or a computed call. Pure modules may not touch `rpc` at all. The adapter may call only the four approved names, once each, as literals on the injected client. Across the web app, the extension and the Edge Functions, no other source may call an `evidence_` RPC or write an evidence table.

## 10. Lifecycle client and errors

`prepareCreateStudy`, `prepareUpdateStudy`, `prepareSetLink` and `prepareDeleteStudy` build frozen requests. Each holds the deployed argument names, typed by the generated function types, and the caller's request id. `p_notes` is the one widened argument: `null` means no notes.

`createEvidenceLifecycleClient(client)` sends only requests a `prepare*` function built. It returns the server's status (`applied`, `replayed`, `unchanged`, `deleted`, `already_absent`) or a classified error, and it checks each answer's exact shape, ids and version. A retry resends the **same** prepared request; the client never retries by itself.

| Error | `applied` | Retry |
|---|---|---|
| Any SQLSTATE or PostgREST code (the transaction rolled back) | no | per kind |
| No structured answer (network failure, gateway 5xx), or a malformed 2xx | unknown | the same request |
| `evidence_version_conflict` | no | a new request after reloading |
| `evidence_request_id_reused` | no | none |

Kinds are classified by SQLSTATE and message, never by HTTP status alone: PostgREST answers `P0002 evidence_not_found` with 500. `42501` is a sign-in problem when the status is 401 and a permission problem when it is 403. Only `PGRST202`/`42883` naming the RPC means the function is unavailable. `classifyEvidenceForeignKeyError` explains a `23503` on `evidence_study_reports_paper_fkey` (a paper with a study record) or on the two anchor keys, and returns null for any other key. `evidence_quote_not_found`, `evidence_source_changed_again` and `evidence_snapshot_limit` are **reserved** PR-A3 contracts, marked `reserved`, and not deployed.

## 11. Open contracts for PR-A3 and PR-C

- **Offsets.** Pin `match_start`/`match_end` as 0-based, half-open character offsets of the v1-normalized copy, as the TypeScript matcher and suite 032 use.
- **"A letter or digit".** Pin the server's definition; PostgreSQL `[[:alnum:]]` depends on the collation provider.
- **Blank and trim rules for values.** Decide whether "blank" means empty after v1, and which white space a list entry is trimmed of.
- **Confirming a judgement field.** Requirements-001 §H2 lets `design_classification` be confirmed with a note. FK-PROOF-001 §J requires current support for every Reported value. This library applies §J.
- **Unclear with only superseded quotes.** FK-PROOF-001 §J is silent. The browser applies 001A's amendment to 001 §J1, that only current-copy quotes count toward Confirm, so such a value cannot be confirmed until a quote is on the current copy or a source is marked examined. PR-A3's review RPC should adopt or amend this.
- **Counts.** Requirements-001 L10 proposes 20 groups, 50 outcomes, 400 values, 20 copies per link, and 64 KB / 200 changes per call. Q11 is still open, so none is enforced here.
- **The reserved errors.** Assign their SQLSTATEs.
