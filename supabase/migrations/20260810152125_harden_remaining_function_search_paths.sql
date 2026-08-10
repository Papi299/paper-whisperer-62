-- PFA-C08 — pin the search_path on the four remaining `function_search_path_mutable`
-- Supabase Security Advisor findings.
--
-- Affected functions (all four are SECURITY INVOKER and stay that way):
--
--   • public.set_updated_at()                              — plpgsql BEFORE UPDATE trigger fn
--   • public.immutable_english_tsvector_text(text)         — sql IMMUTABLE search-vector helper
--   • public.immutable_english_tsvector_textarr(text[])    — sql IMMUTABLE search-vector helper
--   • public.immutable_english_tsvector_jsonb(jsonb)       — sql IMMUTABLE search-vector helper
--
-- ── Why ALTER FUNCTION rather than CREATE OR REPLACE ──
--
-- This is execution-environment hardening only. `ALTER FUNCTION … SET search_path`
-- writes `pg_proc.proconfig` and touches nothing else, so the body, language,
-- volatility, parallel-safety, SECURITY INVOKER status, owner, and EXECUTE ACL of
-- every function are preserved by construction. Replacing the bodies would put all
-- of those properties back in play for no benefit.
--
-- ── Why `pg_catalog` is the correct bounded value ──
--
-- None of the four functions references an application relation, and none calls an
-- unqualified non-built-in function. Their entire external surface is PostgreSQL
-- built-ins:
--
--   set_updated_at()                  → now()
--   immutable_english_tsvector_*(…)   → to_tsvector(), COALESCE, the ::text casts,
--                                       and the 'english'::regconfig lookup
--
-- `english` is a pg_catalog text-search configuration, and unqualified type/function
-- lookups resolve pg_catalog first, so `pg_catalog` is sufficient. It is also the
-- narrowest sufficient value: `public` — the convention used by the SECURITY DEFINER
-- RPCs, which genuinely do read public tables — would grant these four functions
-- schema visibility none of them needs.
--
-- ── Why this does not touch papers.search_vector ──
--
-- PostgreSQL inlines simple SQL functions when it stores a generated-column
-- expression, so `papers.search_vector` was frozen in its inlined
-- `to_tsvector('english'::regconfig, COALESCE(…, ''))` form when the column was
-- built — it holds no reference to the three wrapper functions. Read-only
-- inspection of the linked project confirms this: all three wrappers report zero
-- dependent catalog objects, and the stored generation expression names
-- to_tsvector directly. A non-NULL `proconfig` makes a SQL function ineligible for
-- inlining, but that only governs expressions parsed *after* this migration; an
-- expression already stored in inlined form is not re-derived. So no generated
-- column is recomputed, no GIN index is rebuilt, no table is rewritten, and every
-- stored tsvector keeps its exact prior value.
--
-- Tokenization, the English text-search configuration, field weighting, ranking,
-- and the jsonb/text[] serialization semantics are all unchanged — this migration
-- changes only where these four functions may resolve unqualified names.
--
-- Note for future work: because the wrappers are no longer inlinable, a later
-- migration that rebuilds `search_vector` through them would store function calls
-- rather than the inlined form. That is semantically equivalent but not
-- byte-identical in `pg_attrdef`, so such a migration should assert the resulting
-- expression deliberately.

ALTER FUNCTION public.set_updated_at()
  SET search_path = pg_catalog;

ALTER FUNCTION public.immutable_english_tsvector_text(text)
  SET search_path = pg_catalog;

ALTER FUNCTION public.immutable_english_tsvector_textarr(text[])
  SET search_path = pg_catalog;

ALTER FUNCTION public.immutable_english_tsvector_jsonb(jsonb)
  SET search_path = pg_catalog;
