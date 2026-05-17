# Start Here — Fresh Chat Handoff

## What this app is

Paper Whisperer is a single-user academic paper library manager. Users import papers (via PubMed/DOI/manual entry), organize them with tags/projects, filter by keywords/year/study-type, search full-text, and run AI-powered study-type classification. Backend is Supabase (Postgres + Edge Functions). Frontend is React + TypeScript.

## What was completed (PRs #56–#65)

The entire **read-path performance track** is done:

1. **Server-side short search** (#56) — ILIKE RPC for queries < 3 chars
2. **Full-screen spinner fix** (#57) — no flash during filter transitions
3. **Keyword enrichment** (#58) — `raw_keywords` source-of-truth + reevaluation
4. **Server-side keyword filter** (#59) — RPC with cross-column synonym normalization
5. **Lazy loading / infinite scroll** (#60) — replaced eager-load-all with PAGE_SIZE=100
6. **Lazy loading fixes** (#61) — server-side sidebar data, stable select-all, E2E tests
7. **Query timing + sort/filter split** (#62) — sort changes don't refetch keyword/count queries
8. **search_vector removal from list** (#63) — dropped ~44% payload size
9. **Short search bug fix** (#64) — correct jsonb handling in RPC
10. **Abstract on-demand loading** (#65) — `has_abstract` boolean column, lazy abstract fetch

## Edge function logging hardening (post-PR #65)

Both edge functions (`analyze-paper` and `fetch-paper-metadata`) had a logging hardening pass. All sensitive data (auth tokens, user IDs, paper titles/content, raw API responses, full error objects) was removed from logs. Only operational markers (flow steps, retry counts, HTTP status codes, generic success/failure) remain. No behavior changes. See [migration-history.md](migration-history.md) for details.

## PubMed API key migration (post-logging hardening)

PubMed API key storage moved from browser `localStorage` to the server-side `profiles` table. The edge function (`fetch-paper-metadata`) now reads the key directly from the DB after authenticating, so the client never sends the key in request bodies. Settings dialog updated for async operations with loading states. See [migration-history.md](migration-history.md) for details.

## Manual-add dialog UX fix (post-API key migration)

Fixed a bug where the Add Paper dialog would close even when manual paper creation failed (validation errors, duplicate detection, DB errors). The dialog now stays open with the user's data preserved on failure, so they can correct issues and retry. `addPaperManually` returns `boolean` (true = success, false = failure); the dialog only calls `resetAndClose()` on success.

## Bulk import assignment-failure visibility (post-dialog fix)

Project/tag assignment RPCs after bulk import (identifier-based and file-based) previously failed silently. Now, if `bulk_set_paper_projects` or `bulk_set_paper_tags` returns an error, the user sees a warning toast explaining which assignment(s) failed. Papers are never rolled back — the user knows papers were imported but may need manual project/tag assignment. See [migration-history.md](migration-history.md) for details.

## Cross-user uniqueness fix for pool/exclusion tables (post-assignment fix)

Fixed a database-layer bug where global `UNIQUE` constraints on `keyword_pool`, `study_type_pool`, `keyword_exclusion_pool`, and `study_type_exclusion_pool` prevented different users from adding the same keyword or study type to their own independent pools. Replaced with per-user unique indexes on `(user_id, lower(column))`. No frontend changes needed. See [migration-history.md](migration-history.md) for details.

## Schema drift audit fix — projects/tags uniqueness + RLS tightening (post-pool fix)

Comprehensive remote-DB audit found two more critical drift issues:
1. **Global UNIQUE on `projects.name` and `tags.name`** — same bug class as pools. Different users couldn't create projects/tags with the same name. Fixed with per-user indexes.
2. **"Allow all access" RLS policies on 9 tables** — projects, tags, keyword_pool, keyword_exclusion_pool, study_type_pool, study_type_exclusion_pool, synonym_pool, paper_projects, paper_tags all had wide-open RLS. Any authenticated user could read/write any other user's data. Fixed by dropping permissive policies and recreating correct per-user policies. SECURITY DEFINER RPCs are unaffected.

See [migration-history.md](migration-history.md) for details.

## FK cascade fixes (post-schema-drift fix)

Restored `ON DELETE CASCADE` on all user-scoped table FK constraints to `auth.users(id)`. The Supabase dashboard had overwritten these with `NO ACTION`.

- **Pool tables** (keyword_pool, keyword_exclusion_pool, study_type_pool, study_type_exclusion_pool, synonym_pool): Fixed in migration `20260412040000`.
- **papers, projects, tags**: Fixed in migration `20260412060000`.
- **paper_attachments, profiles**: Already had correct CASCADE — not touched.

See [migration-history.md](migration-history.md) for details.

## Title-import warning (post-FK fix)

Added a static warning to the Import IDs tab in the Add Papers dialog: "Title-based import may match the wrong paper. PMID/DOI import is more reliable." This is the chosen handling for the title-import reliability concern — no mandatory preview/confirmation flow. See "Standing product decisions" below.

## Post-hardening correctness and hygiene fixes (PRs #78–#82)

After the security/integrity hardening wave, a focused round of correctness and code-hygiene fixes was completed:

1. **Worker error-handling fix** (#78) — Fixed a bug in `useNormalizationWorker.ts` where the Web Worker `onerror` handler resolved pending promises with `[]` instead of rejecting. A worker crash during batch normalization (>10 papers) would silently produce papers with missing normalized fields. Now the worker rejects on error, and both bulk import flows (`bulkImportPapers`, `bulkImportFromParsedData`) catch the rejection and surface a clear error toast. 5 unit tests added.

2. **Ghost `urls` field removal** (#79) — Removed `urls` from the papers list SELECT string in `usePapers.ts` and matching docs. The field was not in any type definition, not in any migration, and not read or written by any code. Dead query baggage.

3. **Client-side `decodeHtml` deduplication** (#80) — Replaced the local browser-only `decodeHtml` helper in `AnalyticsPanel.tsx` (using `document.createElement("textarea")`) with the shared `decodeHTMLEntities` utility from `src/lib/decodeHTMLEntities.ts`.

4. **Gemini API key transport hardening** (#81) — Moved the Gemini API key in `analyze-paper` edge function from URL query parameter (`?key=`) to HTTP header (`x-goog-api-key`). The key no longer appears in URL strings, reducing exposure in server logs. Same endpoint, same request shape, same response handling.

5. **analyze-paper log sanitization** (#82) — Removed `abstract.length` and `rawText.length` from `analyze-paper` log output. These were the last two content-adjacent metadata values appearing in logs.

**Post-deploy verification (analyze-paper):**
PRs #81 and #82 were deployed to Supabase and verified:
- Gemini analysis still succeeds (status 200, valid JSON response)
- Deployed source confirmed via `supabase functions download` — both fixes present
- Logs now contain only safe high-level stage markers and HTTP status codes
- No bearer tokens, user IDs, paper titles, abstract content, raw Gemini text, or content-length metadata appears in logs

**Audited and confirmed correct (no action needed):**
- `user_id` nullability — all user-scoped tables already have `user_id NOT NULL` at the DB level
- FK `ON DELETE CASCADE` — all user-scoped tables now have correct CASCADE behavior
- `paper_attachments` UPDATE RLS policy — no UPDATE code path exists in the app; the missing policy has zero real-world impact

## Paper notes — full feature wave (PRs #84–#87)

The notes feature was built and shipped as a four-step capability. All four steps are merged and live in production:

1. **Notes column + edit surface (PR #84).** A `notes text` column on `papers` (nullable, no default) and a free-text "Notes" `<Textarea>` in the Edit Paper dialog, placed between TL;DR and Study Type. Notes load with the existing list query and persist via the existing `updatePaper` mutation — no new RPCs, indexes, or RLS changes.
2. **List indicator + popover preview (PR #85).** A sticky-note icon appears in the action cell only for papers with non-whitespace notes. Clicking it opens a popover with the notes text. No extra fetch — uses the notes already loaded with the list.
3. **"Has Notes" filter (PR #86).** Tri-state `all | has | none` dropdown in the filter bar, implemented as a PostgREST predicate in `buildPapersQuery.ts` using POSIX regex (`[^[:space:]]` / `^[[:space:]]*$`) so NULL and whitespace-only notes both count as "no notes" — matches the list-indicator semantics exactly.
4. **Notes included in text search (PR #87).** Migration `20260417020000_add_notes_to_search.sql` regenerates `papers.search_vector` with `notes` at weight D and adds `OR p.notes ILIKE …` to `search_papers_short`. Zero frontend code changes; the existing search bar covers notes automatically. Ranking hierarchy: A = title, B = abstract, C = journal + authors, D = notes.

The migrations for both PR #86 (the regex predicate is client-side) and PR #87 (the `search_vector` rebuild + short-search RPC) have been applied to live Supabase and behavior verified end-to-end (edit → save → indicator → popover → filter → search-by-notes).

Out of scope for the notes feature and not planned: markdown rendering, export inclusion, AI processing of notes, version history, sharing, bulk edit, and any non-dialog editing surface.

## Search behavior — prefix-aware FTS (PR #88, applied + verified)

Migration `20260417030000_prefix_search.sql` replaces the body of the `search_papers` RPC so partial inputs match while typing. The RPC no longer calls `websearch_to_tsquery` — instead it splits the user's input on whitespace, strips only the ten tsquery operator/control characters (`& | ! ( ) : * < > ' " \`), appends `:*` to each non-empty token, `&`-joins, and feeds the result to `to_tsquery('english', …)`. `guideli` now matches `guideline` (lexeme `guidelin` starts with `guideli`), and result counts narrow monotonically as the user types. Unicode letters (Latin diacritics, Cyrillic, Hebrew, Arabic, CJK, etc.) are preserved — Postgres regex character classes match per codepoint, so the blacklist never accidentally strips multibyte characters. The existing `search_vector` column, `idx_papers_search_vector` GIN index, `search_papers_short` ILIKE path, and length-1-2 routing are all unchanged.

**Status:** The migration has been applied to live Supabase, and manual verification has been completed. Partial inputs ("Ast" → "Asth" → "Asthma") now match the corresponding paper at every step, monotonic narrowing is observed across multi-syllable terms, and the short-query (1–2 char) ILIKE path is unaffected.

**Dropped from the FTS path (PR #88):** `websearch_to_tsquery` sugar — explicit `OR`, and `-` exclusion. Quoted phrases were also dropped from this path, but were subsequently re-introduced via a separate ILIKE-based implementation in PR #92 (see next section). Explicit `OR` and `-` exclusion remain unsupported and are not planned.

## Search wave — keywords, server-side attribution, quoted phrases (PRs #91–#93, applied + verified)

Three back-to-back PRs extended search end-to-end. All are merged and live.

1. **Keywords in search + server-side match attribution (PR #91).** Migration `20260420010000_keywords_in_search_with_attribution.sql` rebuilds `papers.search_vector` to include `keywords::text` at weight C (alongside `authors::text` and `journal`; title stays A, abstract B, notes D) and recreates `idx_papers_search_vector` on the rebuilt column. Both search RPCs (`search_papers` FTS, `search_papers_short` ILIKE) were recreated to return six per-field attribution booleans — `matched_title`, `matched_abstract`, `matched_authors`, `matched_journal`, `matched_notes`, `matched_keywords` — computed server-side against each field's own `to_tsvector`/ILIKE test. Client side, `useFilterState.ts` now threads a `Map<paper_id, MatchFlags>` through to `PaperList`, which renders a read-only "Matched in: …" sub-line of outline `<Badge>`s on each matching row in fixed field order (Title → Abstract → Authors → Journal → Notes → Keywords). Attribution is authoritative — the client does not re-tokenize the query. The sub-line hides entirely when search is empty or only non-search filters are active.

2. **Quoted phrase search (PR #92).** Wrapping a query in double quotes (`"muscle protein synthesis"`) now performs a literal phrase match against title, abstract, authors (jsonb), journal, notes, and keywords (jsonb) — no stemming, no tokenization, Unicode-safe, punctuation-preserving (`"COX-2"` works). Implementation reuses `search_papers_short`'s per-field ILIKE + `EXISTS (SELECT 1 FROM jsonb_array_elements_text(...) WHERE elem ILIKE …)` structure with the phrase wrapped in `%…%`, so zero new SQL was needed and the same six `matched_*` columns flow through. `useFilterState.ts` detects the `"…"` wrapper and routes to a third mode (phrase) that takes priority over the FTS (≥3 chars) and short-query (1–2 chars) modes via mutually-exclusive `!usePhraseSearch` guards — unquoted behavior is bit-identical to PR #88/#91. A single quote character, an unterminated quote, or `""` all fall back to the regular FTS/short path.

3. **Placeholder-based discoverability (PR #93).** The search input placeholder reads `Search titles, authors, notes, keywords... Use "..." for exact phrase`. Net diff vs main is a single-line placeholder change in `SearchFilters.tsx`; no helper line, tooltip, popover, or docs link surface was added. This was the user's chosen direction after an initial helper-line prototype was rejected as scope creep.

**Status:** Migration `20260420010000_keywords_in_search_with_attribution.sql` has been applied to live Supabase and verified end-to-end. Manual verification covered keyword-only matches, phrase-only matches on multi-word phrases present as contiguous substrings, attribution chips rendering in fixed order on the row, and clean behavior when search is cleared.

## Current search behavior — at a glance

This is the authoritative summary of how the main search box behaves today. Treat it as the source of truth — do not re-derive it from the prose above.

**Search modes (mutually exclusive, selected by query shape):**

| Query shape | Mode | Backend |
|---|---|---|
| Empty | No search filtering | — |
| Unquoted, 1–2 characters | Short ILIKE search | `search_papers_short` RPC |
| Unquoted, 3+ characters | Prefix-aware FTS | `search_papers` RPC |
| Quoted (`"..."`) with non-empty inner string | Exact phrase (literal ILIKE, no stemming) | `search_papers_short` RPC with wrapped `%phrase%` |

An unterminated quote, a lone `"`, or `""` all fall back to the regular unquoted path for the inner length.

**Searchable fields (all six are covered by every non-empty mode):**

- title
- abstract
- authors
- journal
- notes
- keywords

**"Matched in:" sub-line:**

- **Server-driven**, not client-inferred. The per-row chips come from six boolean columns (`matched_title`, `matched_abstract`, `matched_authors`, `matched_journal`, `matched_notes`, `matched_keywords`) returned by the search RPCs. The client does not re-tokenize the query.
- Chip order is fixed: **Title → Abstract → Authors → Journal → Notes → Keywords**.
- Hidden when search is empty or only non-search filters are active.

**Discoverability:**

- The `"..."` phrase syntax is taught via the search input **placeholder**, not a helper line, tooltip, or docs link. The placeholder reads `Search titles, authors, notes, keywords... Use "..." for exact phrase`. Do not re-propose a separate helper line.

**Unsupported (not planned):** explicit `OR`, `-` exclusion, and any other `websearch_to_tsquery` sugar beyond quoted phrases.

## Docs normalization for the search wave (PR #94)

The handoff documentation was normalized to reflect PRs #91–#93 in PR #94 (merged). That work updated `docs/start-here.md`, `README.md`, and `docs/migration-history.md` — no code, schema, or behavior change. Future docs passes should only correct anything that remains stale; do not re-audit the same ground.

## Saved Searches / Filter Presets (PRs #96, #98, #99, #101, #102 — applied + verified)

Users can snapshot the current filter/search configuration under a name, list saved presets, load one with a click, update the currently-loaded one in place, see at a glance when the loaded preset has unsaved changes, rename any preset, and delete. **Treat this section as the authoritative description of the presets capability — do not re-derive scope from the prose around it.** Initial MVP shipped as PR #96; PR #98 added update-existing-loaded-preset; PR #99 added a count indicator in the dropdown label; PR #101 added the loaded-preset dirty-state / unsaved-changes indicator; PR #102 added per-preset rename.

**Persistence model.** Presets are **server-side, per user**. They are NOT in `localStorage`. The backing table is `public.filter_presets` (one JSONB `payload` column plus `id`/`user_id`/`name`/timestamps), with full RLS (`auth.uid() = user_id` for SELECT/INSERT/UPDATE/DELETE), `FORCE ROW LEVEL SECURITY`, a case-insensitive unique index `idx_filter_presets_user_name` on `(user_id, lower(name))`, and the standard `update_updated_at_column()` trigger. Migration: `supabase/migrations/20260421010000_add_filter_presets.sql`.

**Migration deployment status.** The migration has been applied to live Supabase. Post-deploy SQL spot-checks confirmed: 6 columns all `NOT NULL` with correct types (`uuid`, `text`, `jsonb`, `timestamptz`); both `relrowsecurity` and `relforcerowsecurity` are `true`; four policies exist (one each for SELECT/INSERT/UPDATE/DELETE); the case-insensitive unique index on `(user_id, lower(name))` is present alongside the user-id lookup index. **Cross-user RLS isolation has been empirically verified**: the user signed in as two separate accounts (one real, one test) and confirmed each account cannot see the other's rows in `filter_presets`. The earlier "not-yet-empirically-verified" caveat is no longer applicable.

**Current actions.** The Presets dropdown in the filters row supports the following user-visible actions:

- **Save** the current filter state under a user-supplied name (Dialog with a single Input; trim non-empty; ≤ 80 chars; duplicate name surfaces a toast and does NOT overwrite).
- **List** saved presets alphabetically (case-insensitive) inside the dropdown; empty state reads "No saved searches yet". The dropdown label reads `Saved searches · N` where N is the total preset count, so users see at a glance when more rows exist below the visible area (PR #99).
- **Load** a preset by clicking its row. After a successful load (and after a successful Save), that preset becomes the **currently loaded preset**.
- **Update the currently loaded preset** (PR #98, behavior refined in PR #101) — when a preset is loaded, the dropdown shows an extra `Update "<name>"` item directly under *Save current search…*. It opens an AlertDialog ("<name> will be overwritten with the current filters and search. The preset name stays the same. This cannot be undone.") and on confirm overwrites the preset's stored `payload` with the current dashboard state. The item is **disabled when the loaded preset is clean** (current filters/search exactly match the saved payload) and **enabled when dirty** (any payload field differs) — see "Loaded-preset dirty-state indicator" below. The update is targeted by `id`, not by name lookup. The preset name is preserved; the row's `updated_at` is refreshed by the existing trigger; the JSONB schema is unchanged (still `version: 1`, same 8 fields). The `Update` item is hidden entirely when no preset is loaded. The loaded-preset pointer is cleared on Clear Filters and on deleting the loaded preset.
- **Rename** a preset (PR #102) via a per-row pencil icon. Opens a small dedicated Rename dialog with the current name prefilled and selected. The rename targets the preset by stable `id` (never by old-name text lookup), updates only the `name` column, and leaves `payload`, `created_at`, and `id` untouched. Reuses the existing `validatePresetName` rules (trim, non-empty, ≤ 80 chars) and the existing `23505` → "Name already taken" toast pattern from the create flow. **No-op guard:** when the trimmed new name is byte-identical to the current name, no Supabase write happens, no `updated_at` bump, no list invalidation, and no success toast — the dialog just closes. The Save button is disabled in that state, and both the form's `onSubmit` and the hook's `renamePreset` short-circuit defensively if it's bypassed. **Case-only rename is allowed** (`"My Preset"` → `"my preset"` is a real rename, not a no-op). If the renamed preset is currently loaded, `loadedPresetId` does not change — `loadedPreset.name` and the `Update "<name>"` label update automatically after the list refetch. Rename does **not** touch payload, so the dirty-state dot is unaffected.
- **Delete** a preset via a trailing trash icon → AlertDialog confirmation.

**Loaded-preset dirty-state indicator (PR #101).** When a preset is loaded, the app derives `isLoadedPresetDirty` by comparing the current dashboard filter/search state against the loaded preset's stored `payload` via the pure helper `arePresetPayloadsEqual` in `useFilterPresets.ts`. The state is **derived, not stored** — there is no schema, no migration, no extra column. The comparison is over the 8 payload fields only (scalar fields with strict `===`; `selectedKeywords` compared **order-insensitively** as a set, so toggling a keyword off and back on does not register as dirty). When dirty, a small accent dot is rendered at the top-right of the Presets trigger button and the trigger's `aria-label` reads `Presets — unsaved changes`; when clean (or when no preset is loaded), the dot is absent. The dot is the at-a-glance signal; the disabled `Update "<name>"` item inside the menu is the redundant in-menu signal. **No tooltip / `title` is used on the disabled Update item** (Radix disabled menu items are not a reliable hover/focus target across browsers — that decision is final). Because rename is metadata-only, the dirty-state signal is **never affected by rename**.

**Saved payload — exactly these 8 fields plus a `version: 1` sentinel.** The Zod schema in `src/hooks/useFilterPresets.ts` is the source of truth. Do not assume any other field is in the payload.

| Field | Type | Notes |
|---|---|---|
| `searchQuery` | `string` | Saved **raw, verbatim** — surrounding double-quotes are preserved so quoted phrase searches like `"muscle protein synthesis"` round-trip exactly and re-trigger the phrase-search route on load |
| `yearFrom` | `string` | Raw text-input value; may be `""` |
| `yearTo` | `string` | Raw text-input value; may be `""` |
| `studyType` | `string` | `"all"` for the no-filter case |
| `notesPresence` | `"all" \| "has" \| "none"` | |
| `selectedKeywords` | `string[]` | Order preserved |
| `selectedProjectId` | `string \| null` | UUID or null |
| `selectedTagId` | `string \| null` | UUID or null |

**Load semantics — full replacement, not merge.** Loading a preset deterministically overwrites all 8 fields via direct setter calls. There is no partial merge, no "keep current keywords and add saved ones", and no diff. The preset name uniquely determines the resulting filter state.

**Sort state is NOT saved.** Sort order is a view concern, not filter intent. Loading a preset leaves the active sort key/direction untouched. Do not propose adding sort to the payload.

**Stale-ID guard.** If a saved `selectedProjectId` or `selectedTagId` no longer exists in the user's current `projects`/`tags` lists (e.g. they deleted the project after saving the preset), the field is silently set to `null` on load and a gentle toast surfaces ("The project/tag saved in this preset no longer exists — skipped"). The preset still loads — the missing reference is dropped, not an error.

**Invalid-payload guard.** `parsePresetPayload` runs `safeParse` on every row read from the DB. Rows that fail validation (future schema version, missing fields, corrupted write) are dropped from the menu with a `console.warn` so the rest of the menu keeps rendering.

**Explicit exclusions — do not re-propose as if they exist.** The presets capability deliberately omits all of the following. Each was discussed and excluded for scope reasons; do not assume any of them are present. (Note: rename was excluded in the original MVP and **has since been added in PR #102** — it is no longer on this list.)

- Overwrite-on-duplicate-name (duplicate save shows a toast and is rejected). The PR #98 update-loaded action is **not** an overwrite-by-name — it targets the currently loaded preset by `id`, never by name lookup. The PR #102 rename action also targets by `id`, never by old-name text.
- Sharing / public presets / collaboration.
- Import / export of presets.
- Version history / audit trail for preset edits (neither for `payload` overwrites via Update, nor for `name` changes via Rename).
- A dedicated preset management page or sidebar surface.
- Sort-state persistence in the payload.
- Auto-run / scheduled presets / saved-search alerts / smart folders / search-within-the-preset-list / drag-reorder / preset folders or tags.
- Bulk rename, search-and-replace rename, or multi-select rename (rename is one-row-at-a-time only).
- Inline / click-on-name rename (clicking a preset name still loads it; rename is exclusively via the per-row pencil icon).
- Any tooltip or `title` attribute on the disabled `Update "<name>"` menu item (the trigger dot's absence + shadcn's standard muted/disabled styling are the combined signal — see PR #101 above).
- Any change to the existing search routing, `Matched in:` attribution, or `onClearFilters` behavior (beyond the fact that Clear Filters also clears the "currently loaded preset" pointer so the `Update "<name>"` action disappears).

## E2E coverage + flake stabilization wave (PRs #104–#106)

A focused testing-only wave landed three PRs back-to-back. No product, schema, RPC, RLS, or UI behavior changed in any of them.

1. **Saved Searches / Filter Presets E2E coverage (PR #104).** New focused Playwright spec at `e2e/filter-presets.spec.ts` exercises the full presets workflow through the real UI: save preset, reload page, load preset back, quoted phrase query round-trip via `searchQuery`, dirty-state dot + `Update "<name>"` enabled-when-dirty / disabled-when-clean semantics, update-overwrites-payload, rename via the per-row pencil (no-op guard verified, case-only rename verified, dirty state unaffected), delete via trash + confirmation, count label `Saved searches · N`, and the empty-state `No saved searches yet` reading. All preset rows created by the spec use an `E2E-` prefix so the `beforeEach` cleanup can reliably remove leftovers from prior failed runs without touching the user's real presets. **Cross-user RLS isolation is intentionally NOT covered in this spec** — the existing E2E auth harness (`e2e/global-setup.ts`) signs in a single storageState account, and the empirical two-account RLS verification documented for PR #96 already covers that ground.

2. **Playwright flake stabilization (PR #105).** Two flakes observed after PR #104 were stabilized via test-side hardening plus one narrow accessibility-only product change.
   - `e2e/mutations.spec.ts:215` had a brittle selector that could resolve to a disabled shadcn `Button` ancestor instead of the actual icon-only X/remove button. Root cause: the project/tag remove buttons in `EditPaperDialog.tsx` were icon-only `<button>` elements with no accessible name, and the test was scoping by text-in-an-ancestor-div which matched the entire dialog body. Fix: added `aria-label="Remove project \"<name>\""` / `aria-label="Remove tag \"<name>\""` and explicit `type="button"` to both icon-only remove buttons (genuine WCAG improvement for icon-only buttons), and rewrote the test selectors to use `getByRole("button", { name: ... })`.
   - `e2e/filter-presets.spec.ts` count-label test occasionally flaked under full-suite load because a "Preset saved" / "Preset deleted" / "Preset updated" / "Preset renamed" toast from the previous mutation could still be animating out when the next click on the Presets trigger fired, intercepting the click. Fix: introduced `waitForToastDetached(page, title)` and called it at every mutation boundary in the spec's helpers (save, delete, update, rename). Also added a `dismissStaleOverlays` helper called in `beforeEach` that hammers Escape twice and asserts no `dialog` / `alertdialog` / `menu` remains.
   - **Verification:** focused specs passed; full Playwright suite ran twice consecutively at 60/60 each.

3. **Notes E2E coverage (PR #106).** New focused Playwright spec at `e2e/notes.spec.ts` exercises the full Notes workflow through the real UI: add note via the Edit dialog → row `StickyNote` indicator appears → popover preview shows the text verbatim (newline + Unicode round-tripped); edit an existing note (textarea round-trip + persistence on reopen); clear a note → indicator disappears (matches the `paper.notes?.trim()` product predicate); `Has notes` / `No notes` filter partitions papers correctly and `All Papers` resets; searching a unique notes-only token surfaces the paper with a `Matched in: Notes` badge in the row's attribution sub-line. UI-driven, single-account, serial mode. The spec picks two papers from the first ~30 visible rows that currently have no notes indicator on setup and uses them for the run; per-test cleanup plus a defensive `afterAll` restore to empty notes on both. Unique `E2E-NOTES-<timestamp>` tokens make search assertions immune to colliding with the user's real notes. The search test deliberately uses an alphanumeric marker (e.g. `zzqnote<base36-timestamp>`) so it is safely 3+ chars and survives FTS tokenization (a short pure-numeric segment was tried first and got dropped by the tokenizer — that path is now ruled out).

**Test counts after this wave:** Vitest at 228/228, Playwright at 65/65 (both confirmed locally on PR #106). The Playwright count subsequently grew to 71/71 with the addition of the search-attribution spec in PR #109 (see next section). Update test counts in this section if they drift further.

## `raw_keywords` nullable type alignment (PR #107)

Small type-hardening fix. Generated Supabase types declared `papers.raw_keywords` as `string[] | null`, but the hand-written `Paper` interface in `src/types/database.ts` had it as a non-nullable `string[]`. A local inline shape inside `useBulkMutations.reevaluateKeywords` had the same drift. Both were updated to `string[] | null` to match the generated type.

**Audit summary (do not re-audit):** all four insert payloads (in `usePaperMutations` and `useBulkMutations`) already produce a non-null array via `|| []`, and the single property-access read site (`useBulkMutations.ts:677`) already used `paper.raw_keywords || []`. No new null guards were required, no behavior change, no schema change, no migration, no generated-types regeneration. The drift is closed.

## `Matched in:` search-attribution E2E (PR #109)

New focused Playwright spec at `e2e/search-attribution.spec.ts` locks in the server-driven `Matched in:` UI shipped in PRs #91–#93. The spec covers all six supported attribution sources end-to-end: **Title, Abstract, Authors, Journal, Notes, Keywords**. For each source, it asserts that searching a token planted in only that field surfaces the seeded paper's row with the correct badge label.

**Strategy.** UI-driven seeding through the existing Edit Paper dialog (no service-role helpers in this repo). `beforeAll` opens the first paper, captures every searchable field's current value (waiting for the `useAbstract` hook to finish so the abstract read is the real DB value), and **appends** a per-field unique alphanumeric token (`e2eattr<field><base36-timestamp>`) to all six fields in a single Save. Each token appears in exactly one field, so a search for any one token exercises that field's `matched_*` flag in isolation. `afterAll` restores the captured originals via the same dialog → no persistent test pollution. Row scope: every test locates the seeded row via the **title token** because the title cell is the only cell guaranteed to render seeded text in the collapsed virtual table (abstract is fetched on demand for expanded rows, notes live in a popover, keywords live in a separately-toggled column).

**Test counts after this PR:** Vitest unchanged at 228/228; Playwright now at **71/71** (65 prior + 6 new attribution tests). Single-account `storageState`, serial mode, single worker — same convention as `e2e/filter-presets.spec.ts` and `e2e/notes.spec.ts`.

**Important:** PR #109 is testing-only. **No search behavior, RPC, SQL, schema, migration, or product UI changed.** The `Matched in:` sub-line remains **server-driven** (computed from the six `matched_*` booleans returned by `search_papers` / `search_papers_short`) — the client still does not re-tokenize the query. Do not re-propose search-attribution E2E as missing.

## Maintainability wave (PRs #111–#113, extended in PR #115)

A focused maintainability / refactor / lint-cleanup wave landed four PRs back-to-back. **No product behavior, no UI, no schema, no migration, no RPC, no RLS, no search/filter/presets/export behavior changed.** Test counts are unchanged (Vitest 228/228, Playwright 71/71).

1. **Internal `PresetNameForm` extraction (PR #111).** The Save Preset and Rename Preset dialogs in `src/components/papers/FilterPresetsMenu.tsx` previously duplicated a near-identical inner block (`<form>` → `<Input>` → `<DialogFooter>` → Cancel + Save). PR #111 extracts that block as a small **internal `PresetNameForm` component inside the same file** — not a new file. The parent retains all state, refs (Save: focus only; Rename: focus + select-all), the autofocus useEffects, both submit handlers (`handleSaveSubmit` / `handleRenameSubmit`), validation, the no-op rename guard, the case-only rename allowance, the `23505` → "Name already taken" handling, the `renameSubmitEnabled` memo, and the Rename `<Dialog>`'s `onOpenChange` `!isRenaming` guard. The parent also retains the `<Dialog>` / `<DialogContent>` / `<DialogHeader>` / `<DialogTitle>` / `<DialogDescription>` JSX verbatim, so the existing E2E selectors that filter on dialog title text (`Save current search`, `Rename saved search`) and on toast text (`Preset saved`, `Preset renamed`) are physically untouched. The shared form's `<form>` `onSubmit` defensively gates on `submitDisabled` before invoking the parent handler — for Save this was an **intentional defensive tightening** (Save's button was already disabled in the same condition; Rename already had this guard from PR #102), called out explicitly so reviewers do not read it as a new product behavior. Do not re-propose extracting `PresetNameForm`.

2. **Group `SearchFilters` preset props into one `filterPresets` prop (PR #112).** `SearchFilters` previously took **13 individual preset-related props** and forwarded each one (with five rename mappings) into `<FilterPresetsMenu />` without using any of them locally. PR #112 collapses those 13 props into a single `filterPresets: FilterPresetsMenuProps` prop, typed against the menu's existing interface (now `export`-ed from `FilterPresetsMenu.tsx`). `Dashboard.tsx` declares a typed named const `const filterPresets: FilterPresetsMenuProps = { /* 13 fields */ };` immediately above the `return (` JSX block (locked-in decision: not inline in JSX, easier to scan). `SearchFilters` spreads the bundle: `<FilterPresetsMenu {...filterPresets} />`. The five rename mappings (`isLoading: presetsLoading`, `getCurrentPayload: getCurrentPresetPayload`, `onSave: handleSavePreset`, `onLoad: handleLoadPreset`, `onUpdateLoaded: handleUpdateLoadedPreset`, `onRename: renamePreset`) now live in one place — Dashboard's named `const` — instead of being duplicated across `SearchFilters`'s prop interface AND its `<FilterPresetsMenu />` JSX. **No `useMemo`** wraps the bundle (locked-in decision: React compares spread props individually, all 13 inner values are already `useCallback` / `useMemo` / primitive, the wrapper isn't used in any dep array, so memoization would add cost without benefit). Do not re-propose grouping preset props through `SearchFilters`.

3. **Fix pre-existing `Dashboard.tsx` `react-hooks/exhaustive-deps` warning (PR #113).** The `handleBulkAnalyze` `useCallback` at `Dashboard.tsx:574` referenced `queryClient` inside its body (passed to `fetchAbstractsBatch` to prime / read the per-paper abstract cache) but did not declare it as a dependency. The sister callback `handleAnalyzePaper` (line 510, the single-paper version of the same flow) already included `queryClient` in its dep array — PR #113 aligns the two. **One-token diff:** `[papers, selectedPaperIds, updatePaper, toast]` → `[papers, selectedPaperIds, updatePaper, queryClient, toast]`. **Zero behavior change** — `useQueryClient()` returns a referentially-stable singleton for the lifetime of the surrounding `QueryClientProvider`, so adding it to deps does not cause additional callback recreations. No `eslint-disable` comment, no helper extraction, no hook extraction. The warning is closed; do not re-propose this fix.

4. **Collapse `SearchFilters` export callbacks into one `onExport(format)` (PR #115).** `SearchFilters` previously took **three named callback props** (`onExportCSV`, `onExportRIS`, `onExportBibTeX`), and `Dashboard` wrapped the `useExportPapers` hook's `exportPapers(format)` with three trivial one-line lambdas (`handleExportCSV`, `handleExportRIS`, `handleExportBibTeX`) to feed each named callback. PR #115 collapses the indirection layer:
   - `src/hooks/useExportPapers.ts` — promoted the inline parameter type union to a module-level `export type ExportFormat = "csv" | "ris" | "bibtex";` (single source of truth) and updated `exportPapers`'s signature to consume it. Type-promotion only — hook body and download behavior untouched.
   - `src/components/papers/SearchFilters.tsx` — replaced the three named callback props on `SearchFiltersProps` with one `onExport: (format: ExportFormat) => void`. Imports `ExportFormat` from `@/hooks/useExportPapers` (**no duplicate union declared here**). Each `<DropdownMenuItem onClick=>` now calls `onExport("csv" | "ris" | "bibtex")` directly.
   - `src/pages/Dashboard.tsx` — deleted the three wrapper lambdas (`handleExportCSV` / `handleExportRIS` / `handleExportBibTeX`); now passes `onExport={exportPapers}` directly (the hook's signature already matches the new prop's signature).

   Net diff: **+15 / −16 across 3 files**. Same hook call, same arguments, same downstream behavior in `src/lib/exportUtils.ts`. The Export button still reads `Export` / `Exporting…`, the dropdown still surfaces CSV → RIS → BibTeX in the same order with the same icons and labels (`Export as CSV` / `Export as RIS` / `Export as BibTeX`), and the same `exportDisabled = !isExportReady || isExporting` gating disables it when not ready. `isExporting` and `isExportReady` remain individual primitive flags on `SearchFiltersProps` (not bundled). PR #115 ran `npx playwright test e2e/filter-presets.spec.ts` (6/6) as the focused gate — full Playwright was deliberately not re-run because the change is structural and the focused presets spec is the spec that mounts the dashboard with the export button visible. Do not re-propose collapsing export callbacks; do not re-propose promoting `ExportFormat`.

## AI-analysis pre-refactor safety net (PR #117)

PR #117 created the **first deterministic safety net** for the AI-analysis block in `Dashboard.tsx`. It is a pure-helper extraction + Vitest unit-test PR — **no behavior change, no UI change**. The safety net was the prerequisite that enabled the subsequent `usePaperAnalysisActions` hook extraction in PR #119 (see next section).

**Three pure helpers + one type are now in `src/lib/studyTypeUtils.ts`** (new file):

- `isGenericStudyType(type: string | null | undefined): boolean` — null/undefined/empty/whitespace and the case-insensitive PubMed catch-all `"journal article"` return `true`. Lifted verbatim from the inline definitions that previously lived in **both** `Dashboard.tsx:457` and `EditPaperDialog.tsx:150` (exact duplicate).
- `resolveStudyTypeAfterAnalysis(existing, aiSuggested)` — the smart-merge ternary. Preserves the exact `??` (nullish-coalescing) operator from the original `Dashboard.tsx` code; only falls back to the existing value if the AI omitted `studyType`.
- `buildAnalysisUpdates(paper, aiData)` — returns `{ updates: AnalysisUpdates, keptStudyType: boolean }`. `updates` is typed narrowly as `Pick<Paper, "tldr" | "study_type" | "statistical_methods">` (not `Record<string, unknown>`). `keptStudyType` is a strict `boolean` derived from the exact `Dashboard.tsx:491` predicate `Boolean(!isGenericStudyType(existing) && aiData.studyType && aiData.studyType !== existing)`. Operator semantics preserved verbatim: `??` for `study_type` (only fall back if AI omitted), `||` for `tldr` and `statistical_methods` (truthy fallback, including on empty string).
- `type AnalysisUpdates = Pick<Paper, "tldr" | "study_type" | "statistical_methods">` — the narrow update payload shape.

**Dashboard.tsx now uses `buildAnalysisUpdates`.** The inline `isGenericStudyType`, both smart-merge ternaries, both payload literals, and the inline `keptStudyType` derivation were all deleted. Both `handleAnalyzePaper` and `handleBulkAnalyze` now call `buildAnalysisUpdates(paper, aiData)` and consume `{ updates, keptStudyType }`. **No async/orchestration change** — the `try/finally`, `setAnalyzingPaperId`, `setBulkAnalyzing`, `setBulkAnalyzeProgress`, `fetchAbstract` / `fetchAbstractsBatch`, `supabase.functions.invoke("analyze-paper", …)`, `updatePaper`, toast routing, and 3-second cooldown are all untouched.

**EditPaperDialog.tsx change was strictly an import-swap.** The duplicate inline `isGenericStudyType` (was lines 150–151) was deleted and replaced with `import { isGenericStudyType } from "@/lib/studyTypeUtils";`. **No other line of `handleAnalyze` was touched.** In particular, `EditPaperDialog`'s `"Not specified"` filtering on `data.studyType` and `data.statisticalMethods`, plus the unconditional `if (data.tldr) setTldr(data.tldr);`, all stay verbatim. `resolveStudyTypeAfterAnalysis` and `buildAnalysisUpdates` are NOT introduced in `EditPaperDialog`.

**Important — intentional asymmetry between Dashboard and EditPaperDialog on `"Not specified"`.** This is current behavior, preserved verbatim by PR #117:

- **`Dashboard.tsx` does NOT filter `"Not specified"`.** If existing `study_type` is generic / null and the AI returns `"Not specified"` as `studyType`, `updates.study_type === "Not specified"` and is persisted as such. Same pass-through for `statistical_methods` (the `||` operator treats the literal string as truthy). Tests in `studyTypeUtils.test.ts` explicitly document this as **"current behavior, not a contract"** with a comment header.
- **`EditPaperDialog.tsx` DOES filter `"Not specified"`.** Its `handleAnalyze` guards each AI field with `if (data.studyType && data.studyType !== "Not specified")` (and the equivalent for `data.statisticalMethods`); only `data.tldr` is set unconditionally.

This asymmetry is intentional and is the current state of the codebase. Do not unify the two surfaces in this PR or any incidental PR; if the team ever decides Dashboard should also filter the sentinel, that must be a **separate behavior-change PR with its own tests**.

**22 new Vitest unit tests** in `src/lib/__tests__/studyTypeUtils.test.ts`, broken down as:

- `isGenericStudyType`: null / undefined; empty / whitespace-only; `"Journal Article"` variants (case + whitespace tolerated); specific types (`"RCT"`, `"Cohort Study"`, etc.).
- `resolveStudyTypeAfterAnalysis`: kept-when-specific; adopted-when-null; adopted-when-generic-`"journal article"` (case-insensitive); `??` fallback when AI omits; `??` does NOT fall back on empty string (defensive).
- `buildAnalysisUpdates` happy paths: all AI fields populated × generic existing → all adopted; all AI fields populated × specific existing → AI tldr + AI methods adopted, existing study_type kept.
- `buildAnalysisUpdates` `||` fallback: empty AI tldr / methods → existing kept; AI omits tldr entirely → existing kept.
- `buildAnalysisUpdates` `"Not specified"` pass-through (current Dashboard behavior, intentionally documented): passes through to `study_type` and `statistical_methods` when truthy.
- `buildAnalysisUpdates.keptStudyType` truth table — full short-circuit coverage: true when specific × different AI; false when identical AI; false when AI omits; false when generic existing × any AI; false when generic `"journal article"` literal × any AI; false when AI returns empty string.

**Test counts after this PR:** Vitest **250/250** (228 prior + 22 new). Playwright unchanged at 71/71. PR #117 ran `npx playwright test e2e/filter-presets.spec.ts` (6/6) as a focused smoke confirmation that Dashboard still mounts; **full Playwright was not run** because pure helper extraction has no plausible E2E regression surface.

**Explicit non-goals at the time of PR #117 (some have since been delivered — see PR #119 below):**

- **`usePaperAnalysisActions` hook extraction** — was deferred at the time of PR #117; **subsequently delivered in PR #119**.
- **Tests for `handleAnalyzePaper` / `handleBulkAnalyze`** (the async, toast, mutation, cooldown layers) — also **delivered in PR #119**.
- **`vi.mock("@/integrations/supabase/client")`**, injected `sleep` for the 3-second cooldown, `renderHook` for an AI handler — **all introduced for the first time in PR #119**.
- **No real Gemini / Edge Function E2E**. AI analysis is intentionally not E2E-covered (Gemini-dependent, non-deterministic, rate-limited). Do not re-propose Playwright for the Sparkles button or the bulk-analyze toolbar.
- No changes to the `analyze-paper` Edge Function, `useAbstract.ts`, `<PaperList>` / `<BulkActionsToolbar>` JSX or props, toast text, button labels, or any UI surface.
- **No filtering of `"Not specified"` in `buildAnalysisUpdates`** (would be a behavior change — still out of scope; the Dashboard ↔ EditPaperDialog asymmetry is intentional).
- **No merge of `studyTypeUtils.ts` into `evaluateStudyType.ts`** (the two files own different domains: study-type-vs-pool evaluation vs. AI-merge helpers).

## AI-analysis hook extraction (PR #119)

PR #119 extracted the **async AI-analysis orchestration** from `Dashboard.tsx` into a dedicated hook `src/hooks/usePaperAnalysisActions.ts`, paired with **7 focused mocked-async Vitest tests** in `src/hooks/__tests__/usePaperAnalysisActions.test.ts`. This was the natural follow-on to PR #117's pure-helper safety net.

**What moved out of `Dashboard.tsx`** (and is now owned by the hook):

- State: `analyzingPaperId`, `bulkAnalyzing`, `bulkAnalyzeProgress`.
- Callbacks: `handleAnalyzePaper`, `handleBulkAnalyze`.

`Dashboard.tsx` now calls:

```ts
const {
  analyzingPaperId,
  bulkAnalyzing,
  bulkAnalyzeProgress,
  handleAnalyzePaper,
  handleBulkAnalyze,
} = usePaperAnalysisActions({
  papers,
  selectedPaperIds,
  updatePaper,
});
```

The same 5 returned values are passed unchanged into the same props on `<PaperList>` and `<BulkActionsToolbar>`. **No JSX / UI / props changed in those components.**

**Behavior preservation — verbatim.** PR #119 is structural-extraction-only:

- Toast titles/descriptions, state transitions, `try / catch / finally` boundaries, bulk processing order, `selectedPaperIds`-derived selection, `buildAnalysisUpdates` (PR #117), `"Not specified"` Dashboard-vs-EditPaperDialog asymmetry, missing-abstract behavior, progress reset behavior, and `<PaperList>` / `<BulkActionsToolbar>` props — all unchanged.
- The hardcoded `await new Promise(resolve => setTimeout(resolve, 3000))` cooldown is now `await sleep(3000)`, where `sleep` defaults to a real `setTimeout`-backed wait in production and tests inject a no-op (`vi.fn().mockResolvedValue(undefined)`). Production behavior is bit-equivalent to the prior code.

**Bulk cooldown truth table (intentionally preserved):**

| Bulk paper outcome | Cooldown? |
|---|---:|
| Successful analysis + update | yes |
| Caught per-paper invoke / update failure | yes |
| Missing abstract from `abstractMap` | **no** |

The `if (!abstract) { failCount++; continue; }` `continue` jumps to the next iteration **before** the `await sleep(3000)` line, so missing-abstract papers do NOT trigger the cooldown. Do not "simplify" this into a `finally` that would sleep after missing-abstract skips — that would be a behavior change.

**New test infrastructure introduced in PR #119** (first time in the repo):

- `vi.mock("@/integrations/supabase/client", () => ({ supabase: { functions: { invoke: mockInvoke } } }))` for `supabase.functions.invoke("analyze-paper", …)`.
- Injected `sleep` (passed as a hook arg) instead of `vi.useFakeTimers()` — tests pass `sleep: vi.fn().mockResolvedValue(undefined)` and assert call count + `3000` arg.
- `vi.mock("@/hooks/useAbstract")` for `fetchAbstract` / `fetchAbstractsBatch`.
- Standard `vi.mock("@/hooks/use-toast")` and `vi.mock("@tanstack/react-query")` overriding only `useQueryClient` (matches `usePaperMutations.test.ts` precedent).
- **No `renderHook` QueryClient wrapper** — bare `renderHook()` with module-level `useQueryClient` mock.

**The 7 tests.** Single-paper: (1) skips papers without abstracts; (2) analyzes one paper successfully and saves updates; (3) shows `"No abstract"` toast when `fetchAbstract` returns null; (4) handles invoke error and clears `analyzingPaperId`. Bulk: (5) exits early when selected papers have no abstracts; (6) analyzes 2 papers successfully and reports `2 succeeded, 0 failed`; (7) **mixed scenario** — paper1 success + paper2 missing abstract + paper3 caught invoke failure → `updatePaper` called once (paper1), per-paper failure toast for paper3, `sleep` called **exactly 2 times** (not 3 — missing abstract skip bypasses cooldown), final toast `"1 succeeded, 2 failed out of 3 papers."`. Test 7 is the locked-in regression check for the missing-abstract-skip-cooldown rule.

**Test counts after this PR:** Vitest **257/257** (250 prior + 7 new). Playwright unchanged at 71/71. PR #119 ran `npx playwright test e2e/filter-presets.spec.ts` (6/6) as a focused smoke confirmation that Dashboard still mounts; **full Playwright was not run**.

**Dashboard cleanup follow-up (commit `d368fb9` on the same PR):** removed the now-unused `useQueryClient` import + `const queryClient = useQueryClient()` from `Dashboard.tsx` (the value is owned inside the hook now).

**Explicit non-goals of PR #119 (still open boundaries to respect):**

- No real Gemini / Supabase Edge Function calls in tests (mocks only).
- No real Gemini / AI Playwright E2E — same boundary as PR #117.
- No changes to `studyTypeUtils.ts`, `useAbstract.ts`, `analyze-paper` Edge Function, `fetch-paper-metadata` Edge Function, `<PaperList>`, `<BulkActionsToolbar>`, UI / copy / layout, schema / migration / RPC / RLS, search / filter / presets / export behavior.

## PubMed import / Edge Function reliability (PRs #120–#121)

A two-PR import-reliability hotfix wave for the `fetch-paper-metadata` Supabase Edge Function. Both PRs touched only `supabase/functions/fetch-paper-metadata/index.ts`. **No client changes**, **no PR #119 connection**, **no schema / migration / RPC / RLS / UI / docs** in either PR (this section is the docs follow-up).

### PR #120 — PubMed XML CPU hardening (`546 WORKER_LIMIT` for PMID `41912805`)

Importing PMID **`41912805`** (a 2025+ assignment, paper authored as the consortium "GBD 2023 IHD & Dietary Risk Factors Collaborators") was killing the Edge Function with browser status `546` and Supabase logs reading:

```
User authenticated
Processing identifier 1/1 (type: pmid)
CPU Time exceeded
shutdown
```

The failure was **inside the Edge Function** — after auth + identifier-type detection succeeded — and was **NOT related to PR #119** (which only touched the AI-analysis hook + Dashboard; the import codepath via `fetchPaperMetadata` → `fetch-paper-metadata` Edge Function was not in PR #119's diff).

**Four small Edge-Function-only changes in PR #120:**

1. **Bounded PubMed author parsing.** Replaced the previous single cross-boundary author regex (which used three lazy `[\s\S]*?` quantifiers and could backtrack across `<Author>` boundaries when an author lacked `<ForeName>`) with a **bounded two-pass extraction**: first match each `<Author>...</Author>` block (the FIRST `</Author>` always closes — never spans siblings), then extract `<LastName>` and `<ForeName>` independently inside that block only. Personal-author behavior preserved: emit only when both fields exist; format `${foreName} ${lastName}`.
2. **Reduced PubMed retry budget from 3 → 1.** PubMed call sites (`fetchFromPubMed`, `searchPubMedByDoi`, `searchPubMedByTitle`) now pass `fetchWithRetry(url, {}, 1)`. Crossref retry behavior is **unchanged** (different code path, not implicated).
3. **Added `MAX_PUBMED_XML_BYTES = 2 * 1024 * 1024`.** Hard size guard immediately after `await response.text()`. Oversized XML logs `pubmed-parse pmid=… bytes=… skipped=oversize` and returns `null`, which surfaces as the existing per-identifier `"Could not find paper metadata"` error rather than killing the function.
4. **Added a concise structured `pubmed-parse` log line per successful PMID.** Format: `pubmed-parse pmid=… bytes=… fetch_ms=… parse_ms=… t_authors=… t_abstract=… t_mesh=… t_subs=…`. Sizes / timings only — no titles, abstracts, author names, API keys, or user data (per the logging-redaction policy from PRs #81 / #82).

**Behavior preservation:** auth, CORS, request shape (`{ identifiers: string[] }`), response shape (`{ results: PaperMetadata[] }`), per-identifier error envelope, PubMed-first / Crossref-fallback semantics, server-side-only PubMed API key, `MAX_IDENTIFIERS` validation, per-item sanitization, and the client-side wrapper in `src/lib/fetchPaperMetadataEdge.ts` — all unchanged.

### PR #121 — PubMed `<CollectiveName>` author support

After PR #120 was deployed, PMID `41912805` imported successfully but had an **empty `authors` array**. PubMed represents that paper's sole author as a `<CollectiveName>` element rather than a personal `<LastName>` + `<ForeName>` pair, and the bounded extractor from PR #120 only emitted personal authors.

PR #121 added `<CollectiveName>` support inside the existing per-`<Author>`-block loop:

```ts
const collectiveName = body
  .match(/<CollectiveName[^>]*>([\s\S]*?)<\/CollectiveName>/)?.[1]
  ?.replace(/<[^>]+>/g, "")
  .trim();
if (collectiveName) {
  authors.push(decodeHTMLEntities(collectiveName));
  continue;
}
// then the existing <LastName> + <ForeName> personal-author branch
```

The `decodeHTMLEntities` call decodes `&amp;` → `&` so the imported author reads `"GBD 2023 IHD & Dietary Risk Factors Collaborators"`. Personal-author papers are unaffected.

### Edge Function deploy is separate from frontend / Vercel deploy

PRs #120 and #121 changed Supabase Edge Function code. **These changes do NOT take effect from a GitHub merge or a Vercel frontend deploy alone.** They require an explicit Supabase Edge Function deploy:

```bash
supabase functions deploy fetch-paper-metadata --project-ref lioxtgiputfniqbktcsz
```

Future maintainers: any change under `supabase/functions/<name>/` requires this explicit deploy, separate from the regular frontend deploy pipeline. Same pattern as PRs #81 / #82 (which also touched only `supabase/functions/...`).

### Manual regression / smoke case — PMID `41912805`

PMID **`41912805`** is now the established manual smoke case for the `fetch-paper-metadata` Edge Function. Expected post-deploy behavior:

- Paper imports successfully.
- `authors` contains `["GBD 2023 IHD & Dietary Risk Factors Collaborators"]`.
- No `CPU Time exceeded`, no `546` status.
- The structured `pubmed-parse pmid=41912805 bytes=… fetch_ms=… parse_ms=… t_authors=… t_abstract=… t_mesh=… t_subs=…` log line appears once.

Future PubMed-import work that touches the parser should re-test this case. (Smoke a known-good simple PMID alongside, to confirm personal-author behavior is unchanged.)

## Manual add — assignment-failure visibility (May 2026)

Closed a silent-failure risk in `usePaperMutations.addPaperManually`: when a manually added paper inserted successfully but the follow-up `set_paper_projects` or `set_paper_tags` RPC failed, the `{ error }` return was discarded and the user saw a plain `"Paper added manually"` success toast — papers ended up in the library without their requested project / tag chips and no signal that anything had gone wrong. The fix mirrors the **same warning pattern already used by `useBulkMutations`** (`assignmentWarnings: string[]` accumulator → single destructive toast). The function still returns `true` and the dialog still closes when the paper itself was created — the destructive `"Paper added with warnings"` toast (`variant: "destructive"`, names the specific failed assignment(s)) plus the missing chips in the row are the user-visible signal that manual reassignment is needed. Five new Vitest cases pin the four toast shapes (both ok / project-only fails / tag-only fails / both fail) and the no-assignment-requested no-warning-toast invariant. Vitest **268/268** (263 prior + 5 new). Playwright unchanged at **71/71**. No DB / RPC / RLS / Edge Function / migration / commercial-doc changes. Symmetric with the Edit Paper save-failure fix below in the way it surfaces partial-success states. See [migration-history.md](migration-history.md) for the full entry.

## Edit Paper dialog stays open on save failure (May 2026)

Fixed the symmetric counterpart to the prior "Manual-add dialog UX fix": `EditPaperDialog` was closing even when the underlying update failed, losing the user's edited values and giving the impression the save had succeeded. `usePaperMutations.updatePaper` now returns `Promise<boolean>` — `false` on every handled failure path (missing `userId`, papers row UPDATE error, `set_paper_tags` error, `set_paper_projects` error), `true` only after every requested write succeeds. `EditPaperDialog.handleSave` reads the boolean and gates `onOpenChange(false)` on `true`; on `false` the dialog stays open with every edited field intact. Existing rollback, destructive-toast, and optimistic-update behavior are preserved verbatim — only the return contract changed.

`Dashboard.handleSavePaper` forwards the boolean. `usePaperAnalysisActions.UsePaperAnalysisActionsArgs.updatePaper` widened to `Promise<boolean>` so the real mutation drops in without a cast; the AI hook **does not** branch on the boolean (its existing error surface is unchanged). 6 new Vitest unit tests pin the contract: Vitest now **263/263** (257 prior + 6 new). Playwright unchanged at **71/71** — the new failure branch is unit-tested at the hook level rather than via synthetic Supabase failure injection in Playwright. No DB / RPC / RLS / Edge Function / migration / commercial-doc changes. See [migration-history.md](migration-history.md) for the full entry.

## Commercialization planning has started (docs-only PR)

Commercialization planning for Paper Whisperer has begun. **Nothing in this area is implemented yet** — no billing, no entitlements, no quotas, no paywall, no mobile packaging. The current PR is **documentation-only** and captures the intended direction so future implementation PRs can work from an agreed model.

Direction (planning, owner-confirmed):

- **Single-user MVP.** One subscription = one individual user. No teams, no shared libraries, no collaboration.
- **Plan structure.** **Core** plan (organize papers, search, filter, tags/projects, notes, presets, attachments, export) and **AI** plan (everything in Core plus a defined monthly AI analysis quota).
- **Cadence.** Monthly subscription primary; annual at a discount also offered. **7-day free trial** on first subscribe.
- **AI is premium.** Never unlimited; bounded by an explicit monthly quota in the AI plan.
- **Storage is bounded.** Each plan carries a per-user storage cap.
- **Architecture rule:** internal entitlements are decoupled from billing-provider state. Stripe / Apple IAP / Google Play / RevenueCat / future providers all feed the same internal model.
- **Architecture rule:** commercial state is **not** stored primarily in `profiles`. `profiles` continues to hold profile/settings (display name, PubMed API key, etc.). Commercial state lives in dedicated `user_entitlements` / `subscriptions` / `usage_counters` tables introduced in a later PR.

The four new planning docs are the source of truth for this direction:

- [commercial-architecture.md](commercial-architecture.md) — entitlement / billing-neutral architecture, table shapes, enforcement points, non-goals.
- [quotas-and-pricing.md](quotas-and-pricing.md) — provisional plan structure, quota ranges, and open pricing questions.
- [store-launch-checklist.md](store-launch-checklist.md) — App Store / Play Store readiness checklist; **policies must be re-verified before launch**.
- [documentation-policy.md](documentation-policy.md) — **active rule**: every meaningful change must update docs, and every Claude Code report must include a "Documentation updates" section.

**The next implementation step is undecided and must not start without explicit owner approval.** Reasonable next candidates after these docs are reviewed include:

1. A schema PR adding `user_entitlements`, `subscriptions`, `usage_counters` (and optionally `subscription_events`) with all-zero / `'free'` defaults, RLS locked down, no behavior change.
2. A read-only client hook (`useEntitlements`) consuming the new tables.
3. AI usage tracking + server-side quota enforcement inside `analyze-paper`.
4. Storage usage tracking + trigger-based enforcement on `paper_attachments`.
5. UI paywall / upgrade placeholders + `/privacy`, `/terms`, `/support` static pages.
6. A chosen billing-provider integration.

None of these are committed. They are options to discuss after [commercial-architecture.md](commercial-architecture.md) is owner-approved.

## Standing product decisions — do not re-propose

These decisions have been explicitly made by the user. Do not suggest revisiting them unless the user explicitly asks.

### Duplicate detection policy
- Duplicate detection is **PMID/DOI only**. This is intentional.
- Do NOT propose fuzzy or title-based duplicate detection.
- Do NOT propose extending `get_duplicate_papers` to match by title.
- The user has explicitly rejected this direction.

### Title-based import handling
- Title-based import auto-selects the first PubMed/Crossref match. This is known and accepted.
- The chosen mitigation is a **static warning in the Add Papers dialog**: "Title-based import may match the wrong paper. PMID/DOI import is more reliable." (PR #76)
- Do NOT propose mandatory per-paper preview/confirmation for title-based imports.
- Do NOT propose a review/approval workflow before title-imported papers are saved.
- The user has explicitly rejected these approaches.

### CORS policy for edge functions
- Both edge functions (`analyze-paper`, `fetch-paper-metadata`) use `Access-Control-Allow-Origin: "*"`. This is **intentional and correct** for the current auth model.
- Auth is **Bearer-token/header-based** (Supabase JWT via `Authorization` header), NOT cookie-based. Browsers never auto-attach `localStorage` tokens cross-origin, so CORS provides no meaningful protection here.
- Tightening CORS would add complexity (Vercel preview URL regex, origin reflection logic) for zero practical security gain.
- Do NOT propose CORS restriction for the current auth architecture.
- Revisit only if the auth model changes to cookie-based sessions.

## What is stable — do not reopen casually

- The read-path architecture (server-side filter/sort/paginate/lazy-load)
- The keyword filter RPC and keyword options RPC
- The abstract on-demand loading pattern
- The sort/filter cache key split
- The select-all-filtered-IDs mechanism
- The security/schema integrity layer (RLS, per-user uniqueness, FK cascades)

These were thoroughly measured and verified. Changing them requires new evidence.

## What is intentionally deferred

- **Phase C DB optimization** (GIN indexes on jsonb keyword columns, RPC rewrites). Not justified at current scale (~400 papers). See [decisions-and-triggers.md](decisions-and-triggers.md).
- **Unused index cleanup** (`idx_papers_user_doi_unique` has 0 scans but is harmless).
- **Write-path optimization** (not profiled, not a user complaint).

## What to read next

1. [architecture-read-path.md](architecture-read-path.md) — how the read path works now
2. [decisions-and-triggers.md](decisions-and-triggers.md) — what was deferred and when to revisit
3. [migration-history.md](migration-history.md) — chronological change history

## Current recommendation

The app is performant, secure, and feature-complete at current scale. The security/integrity hardening wave (PRs #67–#76), the follow-up correctness/hygiene fixes (PRs #78–#82), the notes feature wave (PRs #84–#87), the prefix-aware FTS upgrade (PR #88), the search wave (keywords in search + server-side attribution + quoted phrase search + placeholder discoverability, PRs #91–#93), the docs normalization for that wave (PR #94), the Saved Searches / Filter Presets capability — MVP plus the follow-up wave that added update-loaded (PR #98), the dropdown count label (PR #99), the loaded-preset dirty-state indicator (PR #101), and per-preset rename (PR #102) — the E2E + type-hardening wave (presets E2E in PR #104, Playwright flake stabilization in PR #105, Notes E2E in PR #106, `raw_keywords` nullable type alignment in PR #107), the search-attribution E2E spec for all six `Matched in:` sources (PR #109), the maintainability wave (`PresetNameForm` extraction in PR #111, `filterPresets` prop grouping in PR #112, `Dashboard.tsx` exhaustive-deps fix in PR #113, export callback collapse + `ExportFormat` type-promotion in PR #115), the AI-analysis pre-refactor safety net (pure-helper extraction + 22 Vitest unit tests in PR #117), the AI-analysis hook extraction (`usePaperAnalysisActions` + 7 mocked-async tests in PR #119), and the PubMed import / Edge Function reliability hotfix wave (CPU hardening for large PubMed XML in PR #120, `<CollectiveName>` author support in PR #121) are all complete and live. Migrations `20260417030000_prefix_search.sql`, `20260420010000_keywords_in_search_with_attribution.sql`, and `20260421010000_add_filter_presets.sql` are applied on Supabase and verified — the presets migration via post-deploy SQL spot-checks **and empirical cross-user RLS isolation** (two separate accounts, each sees only their own rows in `filter_presets`). The `fetch-paper-metadata` Edge Function is deployed with PRs #120 + #121 (Edge Function deploys are separate from frontend/Vercel deploys — see the PRs #120–#121 section above). The Playwright suite is currently green at **71/71** locally and the Vitest suite at **257/257** (250 prior + 7 new from PR #119). Network RTT to Supabase Mumbai (~200ms from Israel) continues to dominate wall time, not DB execution. Focus new work on **features**, not performance, schema cleanup, or further hardening, unless the paper count grows past ~2,000 or users report slowness.

**Already-completed items — do NOT re-propose as open:**
- Saved Searches / Filter Presets E2E coverage (`e2e/filter-presets.spec.ts`, PR #104)
- Playwright flake stabilization for the post-#104 suite (PR #105)
- Notes E2E coverage (`e2e/notes.spec.ts`, PR #106)
- `raw_keywords` nullable type drift between hand-written `Paper` and generated Supabase types (PR #107) — `Paper.raw_keywords` is now `string[] | null` in `src/types/database.ts`, and call sites were audited
- `Matched in:` server-driven search-attribution E2E coverage for all six sources (`e2e/search-attribution.spec.ts`, PR #109) — Title, Abstract, Authors, Journal, Notes, Keywords are all asserted end-to-end
- Internal `PresetNameForm` extraction inside `FilterPresetsMenu.tsx` deduplicating the Save Preset and Rename Preset inner form bodies (PR #111) — kept in the same file, no behavior change, no copy / accessibility / E2E-selector change
- `SearchFilters` preset prop grouping (PR #112) — the 13 individual preset-related props on `SearchFilters` are now one `filterPresets: FilterPresetsMenuProps` prop; `FilterPresetsMenuProps` is exported; `Dashboard.tsx` builds the bundle as a named `const` just above its `return (` JSX (no `useMemo`); `SearchFilters` spreads it into `<FilterPresetsMenu />`
- `Dashboard.tsx:574` `react-hooks/exhaustive-deps` warning on `handleBulkAnalyze` (PR #113) — `queryClient` added to the dep array; one-token fix; `useQueryClient()` returns a stable reference so no behavior change
- `SearchFilters` export callback collapse (PR #115) — the three named callback props (`onExportCSV`, `onExportRIS`, `onExportBibTeX`) are now one `onExport: (format: ExportFormat) => void`; `Dashboard.tsx` no longer owns the three wrapper lambdas (`handleExportCSV` / `handleExportRIS` / `handleExportBibTeX`) and passes `onExport={exportPapers}` directly
- `ExportFormat` type-promotion in `src/hooks/useExportPapers.ts` (PR #115) — `export type ExportFormat = "csv" | "ris" | "bibtex"` is the single source-of-truth union; `SearchFilters.tsx` and `Dashboard.tsx` import it from the hook (**no duplicate union declared in either consumer**)
- AI-analysis pure-helper extraction (PR #117) — `isGenericStudyType`, `resolveStudyTypeAfterAnalysis`, and `buildAnalysisUpdates` (returning `{ updates: AnalysisUpdates, keptStudyType: boolean }`) all live in `src/lib/studyTypeUtils.ts`. Dashboard's inline duplicate of `isGenericStudyType` was deleted; EditPaperDialog's inline duplicate was deleted via strict import-swap (no other line of `handleAnalyze` was touched, so EditPaperDialog still filters `"Not specified"` while Dashboard still does not). `buildAnalysisUpdates`'s `updates` is typed narrowly as `Pick<Paper, "tldr" | "study_type" | "statistical_methods">`; `keptStudyType` is a strict boolean derived from the exact `Dashboard.tsx:491` predicate.
- AI-analysis pure-helper Vitest coverage (PR #117) — 22 unit tests in `src/lib/__tests__/studyTypeUtils.test.ts` cover the predicate (case-insensitive, whitespace, null/undefined), the smart-merge ternary (kept-when-specific, adopted-when-generic, `??` fallback semantics), the `||` fallback for `tldr` / `statistical_methods`, the `"Not specified"` pass-through (Dashboard's current behavior, intentionally documented), and the full `keptStudyType` short-circuit truth table.
- AI-analysis hook extraction `usePaperAnalysisActions` (PR #119) — `src/hooks/usePaperAnalysisActions.ts` now owns `analyzingPaperId`, `bulkAnalyzing`, `bulkAnalyzeProgress`, `handleAnalyzePaper`, `handleBulkAnalyze`. `Dashboard.tsx` consumes the 5 returned values and threads them unchanged into `<PaperList>` and `<BulkActionsToolbar>` props (no JSX/UI/props change). Hardcoded 3s cooldown replaced with injected `await sleep(3000)` (production default is bit-equivalent; tests inject a no-op). **Cooldown truth table preserved verbatim:** success → cooldown; caught failure → cooldown; missing-abstract `continue` → NO cooldown.
- AI-analysis hook Vitest coverage (PR #119) — 7 mocked-async tests in `src/hooks/__tests__/usePaperAnalysisActions.test.ts` (4 single-paper + 3 bulk, including the locked-in 3-paper mixed scenario asserting `sleep` is called exactly **2 times**, not 3). Established the first repo-wide `vi.mock("@/integrations/supabase/client")` pattern for `supabase.functions.invoke`, plus injected `sleep` instead of `vi.useFakeTimers()`. **No real Gemini / Edge Function calls in tests; no Playwright AI E2E.**
- `fetch-paper-metadata` Edge Function CPU hardening (PR #120) — bounded PubMed `<Author>...</Author>` parsing (no cross-author backtracking), PubMed retry budget reduced to 1 retry on `fetchFromPubMed` / `searchPubMedByDoi` / `searchPubMedByTitle` (Crossref unchanged), `MAX_PUBMED_XML_BYTES = 2 * 1024 * 1024` size guard, and a concise `pubmed-parse pmid=… bytes=… fetch_ms=… parse_ms=… t_authors=… t_abstract=… t_mesh=… t_subs=…` structured timing log per successful PMID. Resolved the `546 WORKER_LIMIT` / `CPU Time exceeded` failure on PMID `41912805`. **Edge Function only — no client / PR #119 / Dashboard / `analyze-paper` / schema / RLS changes.**
- PubMed `<CollectiveName>` author support (PR #121) — inside the bounded `<Author>` block loop, before personal-author extraction, `<CollectiveName>` is now extracted with HTML-entity decoding (`&amp;` → `&`). Consortium / collaborator papers like PMID `41912805` ("GBD 2023 IHD & Dietary Risk Factors Collaborators") now produce a non-empty `authors` array. Personal-author papers unchanged.

**Remaining grounded next-candidates** (none urgent — only pursue if the user explicitly asks): broader `Dashboard.tsx` responsibility-split planning (it remains the orchestration hub for several non-AI flows); other small prop-grouping refactors only if a similar pass-through pattern is found in another component; analytics-section extraction planning (only if the analytics surface grows); a small ops note for the Edge Function deploy process (Supabase function deploys are separate from frontend/Vercel deploys); local working-tree cleanup for unrelated `jsdom` / `package-lock.json` leftovers in maintainer environments (cosmetic, not blocking); further metadata-parser hardening only if new evidence appears (PMID `41912805` is the established smoke case). **No real Gemini / Playwright AI E2E — that path is and remains rejected.** These are candidates, not commitments — do not invent a roadmap beyond this list.

## Key files

| File | Role |
|---|---|
| `src/hooks/usePapers.ts` | Core papers infinite query + server filter/sort |
| `src/hooks/useFilterState.ts` | Filter/search state + three-mode search routing (phrase / FTS / short) + `searchMatchFlags` map |
| `src/hooks/useAbstract.ts` | On-demand abstract fetch + batch fetch |
| `src/hooks/papers/useBulkSelection.ts` | Select-all via `allFilteredIds` |
| `src/hooks/papers/types.ts` | `MatchFlags`, `NotesPresence`, server filter/sort param types |
| `src/lib/buildPapersQuery.ts` | PostgREST query builder with filter predicates |
| `src/lib/queryKeys.ts` | React Query key structure |
| `src/pages/Dashboard.tsx` | Main page — orchestrates all hooks. AI-analysis state and async orchestration are NOT inline; they live in `src/hooks/usePaperAnalysisActions.ts` (PR #119). Dashboard consumes `{ analyzingPaperId, bulkAnalyzing, bulkAnalyzeProgress, handleAnalyzePaper, handleBulkAnalyze }` from the hook and threads them unchanged into `<PaperList>` and `<BulkActionsToolbar>` props. |
| `src/hooks/usePaperAnalysisActions.ts` | AI-analysis async orchestration hook (PR #119): owns `analyzingPaperId`, `bulkAnalyzing`, `bulkAnalyzeProgress`, `handleAnalyzePaper`, `handleBulkAnalyze`. Single-paper flow: `fetchAbstract` → `supabase.functions.invoke("analyze-paper", …)` → `buildAnalysisUpdates` → `updatePaper`. Bulk flow: `fetchAbstractsBatch` → per-paper `try/catch` invoke + update loop with `await sleep(3000)` cooldown after success / caught failure (NOT after missing-abstract skips). `sleep` is injectable for tests; defaults to `setTimeout`-backed wait. Tested by 7 mocked-async cases in `src/hooks/__tests__/usePaperAnalysisActions.test.ts`. |
| `src/lib/studyTypeUtils.ts` | AI-analysis pure helpers + types: `isGenericStudyType` (case-insensitive `"journal article"` predicate, also imported by `EditPaperDialog`), `resolveStudyTypeAfterAnalysis` (smart-merge ternary), `buildAnalysisUpdates` (returns `{ updates, keptStudyType }`), and `type AnalysisUpdates = Pick<Paper, "tldr" \| "study_type" \| "statistical_methods">`. Lifted verbatim from previously-inline `Dashboard.tsx` code. **Does not filter `"Not specified"`** — that is `EditPaperDialog`'s rule and the asymmetry is intentional. (PR #117) |
| `src/components/papers/PaperList.tsx` | Virtualized table with lazy abstract expand + "Matched in: …" sub-line |
| `src/components/papers/SearchFilters.tsx` | Search input (with quoted-phrase placeholder hint), filter controls, mounts the Presets dropdown. Receives Saved Searches state as one grouped `filterPresets: FilterPresetsMenuProps` prop and spreads it into `<FilterPresetsMenu {...filterPresets} />` (PR #112). Export menu now uses one typed `onExport: (format: ExportFormat) => void` callback (PR #115) instead of three named callbacks; `ExportFormat` is imported from `@/hooks/useExportPapers` |
| `src/hooks/useExportPapers.ts` | Export hook for CSV / RIS / BibTeX. Owns `exportPapers(format)`, `isExporting`, `isExportReady`. Exports `ExportFormat = "csv" \| "ris" \| "bibtex"` as the single source-of-truth union — imported by `Dashboard.tsx` and `SearchFilters.tsx` (PR #115) |
| `src/hooks/useFilterPresets.ts` | Saved Searches: Zod payload schema, list query + create / update-payload / rename / delete mutations, pure helpers — `applyPreset` (with stale project/tag-ID guard), `arePresetPayloadsEqual` (order-insensitive on `selectedKeywords`, drives the dirty-state dot), and `prepareRename` (returns `invalid` / `noop` / `ok`, drives the no-op short-circuit) (PRs #96, #98, #101, #102) |
| `src/components/papers/FilterPresetsMenu.tsx` | Presets DropdownMenu — Save Dialog, list with `Saved searches · N` count label, dirty-state dot on the trigger button + state-aware `aria-label`, `Update "<name>"` AlertDialog (visible when a preset is loaded; disabled when clean, enabled when dirty; no tooltip/title on the disabled state), per-row Pencil → Rename Dialog (with no-op-aware Save button + defensive submit guard), Delete AlertDialog. Internal `PresetNameForm` component (PR #111) renders the shared `<form>` + `<Input>` + Cancel/Save footer for both the Save and Rename dialogs. Exports `FilterPresetsMenuProps` so `Dashboard.tsx` can build the grouped `filterPresets` bundle (PR #112). (PRs #96, #98, #99, #101, #102, #111, #112) |
| `supabase/functions/fetch-paper-metadata/index.ts` | Supabase Edge Function for PubMed/Crossref metadata fetch. Hardened in PR #120 (bounded `<Author>...</Author>` parsing, 1-retry PubMed budget, `MAX_PUBMED_XML_BYTES = 2 * 1024 * 1024` size guard, concise `pubmed-parse` structured timing log) and extended in PR #121 (PubMed `<CollectiveName>` author support). PMID `41912805` ("GBD 2023 IHD & Dietary Risk Factors Collaborators") is the established manual smoke case. **Edge Function deploy is separate from frontend/Vercel deploy:** `supabase functions deploy fetch-paper-metadata --project-ref lioxtgiputfniqbktcsz`. |
| `supabase/migrations/20260417030000_prefix_search.sql` | Prefix-aware FTS (PR #88) |
| `supabase/migrations/20260420010000_keywords_in_search_with_attribution.sql` | Keywords in search_vector + 6 `matched_*` attribution flags (PR #91) |
| `supabase/migrations/20260421010000_add_filter_presets.sql` | `filter_presets` table + RLS + per-user case-insensitive unique name + `updated_at` trigger (PR #96) |
| `supabase/migrations/` | All DB schema + RPC definitions |
