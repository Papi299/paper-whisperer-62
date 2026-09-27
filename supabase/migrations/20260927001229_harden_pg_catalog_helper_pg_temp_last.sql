-- DB-PG-CATALOG-HELPER-PG-TEMP-LAST-001 — the four `search_path=pg_catalog`
-- helpers whose bodies name built-in data types place `pg_temp` last.
--
-- WHAT CHANGES
-- ─────────────────────────────────────────────────────────────────────────────
-- Exactly one catalog attribute on exactly four functions, `proconfig`:
--
--   {search_path=pg_catalog}  →  {"search_path=pg_catalog, pg_temp"}
--
--   public.attachment_cleanup_path_is_safe(uuid,text,uuid)
--   public.immutable_english_tsvector_text(text)
--   public.immutable_english_tsvector_textarr(text[])
--   public.immutable_english_tsvector_jsonb(jsonb)
--
-- via four exact-signature `ALTER FUNCTION ... SET search_path = pg_catalog,
-- pg_temp` statements (section 2). Nothing else moves: not a body, OID,
-- signature, argument, return type, language, volatility, parallel mode,
-- strictness, leakproofness, cost, security mode (all four stay SECURITY
-- INVOKER), owner or EXECUTE ACL; not `public.set_updated_at()`, which is
-- deliberately not touched; not a caller, trigger, generated column, index,
-- policy, grant, relation or row. Section 3 proves every one of those facts
-- before COMMIT.
--
-- WHY — deterministic built-in type resolution, not incident remediation
-- ─────────────────────────────────────────────────────────────────────────────
-- PostgreSQL 17 (runtime-config-client.html, `search_path`): `pg_catalog` is
-- always searched, and so is the session's temporary schema. When the temporary
-- schema is not listed it is searched FIRST, before `pg_catalog`, for relation
-- and data-type names (never for function or operator names). All four bodies
-- name built-in data types, so `search_path=pg_catalog` alone does not make
-- those names resolve to `pg_catalog` in every session. Listing `pg_temp`
-- explicitly LAST puts `pg_catalog` ahead of it, which makes built-in type-name
-- resolution deterministic.
--
--   * attachment_cleanup_path_is_safe is the attachment-namespace predicate
--     evaluated inside the three SECURITY DEFINER attachment lifecycle RPCs
--     (delete_attachment_with_cleanup, delete_papers_with_attachment_cleanup,
--     finalize_attachment_upload). Its resolution environment is part of that
--     privileged boundary: for it this is SECURITY-BOUNDARY hardening.
--   * the three immutable_english_tsvector_* wrappers build search vectors: for
--     them this is SEMANTIC-INTEGRITY / defense-in-depth hardening.
--
-- There is no evidence of exploitation, and no ordinary PaperLume route has been
-- identified that provides the arbitrary SQL/DDL prerequisite (PostgREST exposes
-- RPC calls, not DDL). This is not a response to an incident, and it does not
-- change what any legitimate call returns.
--
-- This refines PFA-C08 (20260810152125), whose hardening outcome stands and
-- whose function/operator reasoning was correct; its broader statement that
-- unqualified type lookups resolve `pg_catalog` first was incomplete. That file
-- is history and is not edited. It is the `search_path=pg_catalog` counterpart
-- of C50 (20260926202754), which placed `pg_temp` last for SECURITY DEFINER
-- functions.
--
-- THE DELIBERATE NON-TARGET — `public.set_updated_at()`
-- ─────────────────────────────────────────────────────────────────────────────
-- Stays at exactly `search_path=pg_catalog`. Its reviewed body (md5
-- 301a884953d37769916294bb60562e05) names no data type: it assigns now() to
-- NEW.updated_at and returns NEW. Section 1 refuses to run on any other digest
-- or shape, and section 3 proves its whole `pg_proc` row is unchanged.
--
-- TWO REVIEWED ENVIRONMENT DIFFERENCES — each accepted in exactly two shapes
-- ─────────────────────────────────────────────────────────────────────────────
-- 1. EXECUTE ACL of the three wrappers and set_updated_at(). A clean replay
--    stores `proacl IS NULL` (PostgreSQL's default: owner + PUBLIC EXECUTE).
--    Hosted Production stores the same effective posture as the explicit
--    `{=X/postgres,postgres=X/postgres,anon=X/postgres,authenticated=X/postgres,service_role=X/postgres}`
--    (see scripts/acl-parity/hosted-baseline-20260904120000.sql). Either is
--    accepted, the four must share one of them, and the literal value is
--    preserved as found — neither is normalised into the other. Any third
--    shape is refused. The attachment helper has one exact owner-only ACL,
--    `{postgres=X/postgres}`, in both environments.
-- 2. The `papers.search_vector` generation expression
--    (DB-SEARCH-VECTOR-EXPRESSION-PARITY-001, tracked separately and NOT
--    resolved here). A clean replay stores calls to the text and jsonb
--    wrappers; hosted Production stores the inlined built-in form. Rendered
--    under this file's pinned `search_path` they are, exactly:
--      clean replay  dd69f099a274a9cdc0f174ae0883ddb6  (depends on the text and jsonb wrappers)
--      hosted        8ddd960b4f4b11dd7afd35485d01fd25  (depends on no function)
--    Any third shape is refused. The column, its expression, the stored
--    tsvectors and idx_papers_search_vector are not modified.
--
-- CONCURRENCY AND ROLLOUT
-- ─────────────────────────────────────────────────────────────────────────────
-- Migration-only. No Edge Function, client or generated-type change: no
-- signature changes. A call already executing when this commits finishes under
-- the configuration it started with; the next call applies the new one. With no
-- temporary object present both configurations resolve every name identically,
-- so no ordering or lock barrier is needed. The file is explicitly
-- transactional (see 20260910212202 for why `supabase db reset` requires that):
-- the preconditions, the four ALTERs and the verification commit together or
-- not at all.
--
-- ROLLBACK
-- ─────────────────────────────────────────────────────────────────────────────
-- Forward-fix preferred. The reviewed restoration is exactly the same four
-- statements with `SET search_path = pg_catalog`, which returns them to their
-- pre-change shape (bodies, ACLs and modes were never touched). It removes a
-- hardening layer; it opens no grant. See docs/deployment.md §6.12.
--
-- Durable decision: C51.

BEGIN;

-- Every catalog value this file renders and compares (signatures, argument
-- lists, the generation expression, the trigger definition) is computed under
-- one fixed path, so the comparison reads the same under any migration runner.
-- `pg_temp` is last here for the same reason it is last in section 2. The ALTER
-- statements below are fully qualified and unaffected. Transaction-local:
-- COMMIT restores the runner's own setting.
SET LOCAL search_path = pg_catalog, pg_temp;


-- ═════════════════════════════════════════════════════════════════════════════
-- 0. Execution context, and this transaction's own write counters
-- ═════════════════════════════════════════════════════════════════════════════
--
-- Only a function's owner can change its configuration, and all five are owned
-- by `postgres`. Section 3 proves this transaction wrote no row to any table in
-- `public`, `auth` or `storage`, from PostgreSQL's per-transaction statistics
-- (see 20260924193915 §0 for why the baseline is taken here).

DO $ctx$
BEGIN
  IF current_user <> 'postgres' THEN
    RAISE EXCEPTION
      'pg_catalog_helper_pg_temp_last: must run as postgres (current_user is %) — only the owner can change the configuration of the four helpers',
      current_user;
  END IF;

  IF NOT current_setting('track_counts')::boolean THEN
    RAISE EXCEPTION 'pg_catalog_helper_pg_temp_last: track_counts is off, so the no-write self-check could not observe anything';
  END IF;

  IF current_setting('search_path') IS DISTINCT FROM 'pg_catalog, pg_temp' THEN
    RAISE EXCEPTION 'pg_catalog_helper_pg_temp_last: the pinned rendering path is not in effect (search_path is %) — this file must run as one transaction',
      current_setting('search_path');
  END IF;

  PERFORM set_config(
    'paperlume.pg_catalog_helper_pg_temp_last.xact_writes_at_start',
    (SELECT string_agg(
              n.nspname || '.' || c.relname || '=' || (pg_stat_get_xact_tuples_inserted(c.oid)
                                                       + pg_stat_get_xact_tuples_updated(c.oid)
                                                       + pg_stat_get_xact_tuples_deleted(c.oid)),
              ' ' ORDER BY n.nspname, c.relname)
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname IN ('public', 'auth', 'storage') AND c.relkind IN ('r', 'p')),
    true);
END
$ctx$;


-- ═════════════════════════════════════════════════════════════════════════════
-- 1. Preconditions — the exact state this change was reviewed against
-- ═════════════════════════════════════════════════════════════════════════════
--
-- Verified read-only against Production on 2026-09-27 (PostgreSQL 17.6; ledger
-- 90, latest 20260926202754 harden_security_definer_pg_temp_last; exactly these
-- five `public` functions at `{search_path=pg_catalog}`) and on a clean local
-- replay. Nothing here repairs unexpected state: any mismatch rolls the whole
-- file back before a single attribute changes. The snapshots at the end of this
-- block are what section 3 compares against.

DO $pre$
DECLARE
  v_count      INTEGER;
  v_text       TEXT;
  v_want       TEXT;
  -- The four hardening targets, and the one deliberate non-target.
  v_targets    CONSTANT TEXT[] := ARRAY[
    'public.attachment_cleanup_path_is_safe(uuid,text,uuid)',
    'public.immutable_english_tsvector_text(text)',
    'public.immutable_english_tsvector_textarr(text[])',
    'public.immutable_english_tsvector_jsonb(jsonb)'];
  v_nontarget  CONSTANT TEXT := 'public.set_updated_at()';
  -- The three privileged callers of the attachment helper — never altered.
  v_callers    CONSTANT TEXT[] := ARRAY[
    'public.delete_attachment_with_cleanup(uuid)',
    'public.delete_papers_with_attachment_cleanup(uuid[])',
    'public.finalize_attachment_upload(uuid,text,text,text,integer)'];
  -- The two reviewed representations of the default-EXECUTE posture.
  v_hosted_acl CONSTANT TEXT :=
    '{=X/postgres,postgres=X/postgres,anon=X/postgres,authenticated=X/postgres,service_role=X/postgres}';
  v_expr_md5   TEXT;
  v_expr_deps  TEXT;
BEGIN
  -- ── 1a. Roles ───────────────────────────────────────────────────────────────
  IF to_regrole('authenticated') IS NULL OR to_regrole('anon') IS NULL OR to_regrole('service_role') IS NULL THEN
    RAISE EXCEPTION 'pg_catalog_helper_pg_temp_last: one of the roles authenticated / anon / service_role does not exist';
  END IF;

  -- ── 1b. Every reviewed function resolves ────────────────────────────────────
  SELECT coalesce(string_agg(s, ', ' ORDER BY s), '') INTO v_text
  FROM unnest(v_targets || v_nontarget || v_callers) s WHERE to_regprocedure(s) IS NULL;
  IF v_text <> '' THEN
    RAISE EXCEPTION 'pg_catalog_helper_pg_temp_last: reviewed function(s) missing: %', v_text;
  END IF;

  -- ── 1c. The five bodies are exactly the reviewed ones ───────────────────────
  -- Checked on its own, before the full shape, so drift here says what it means.
  SELECT coalesce(string_agg(e.sig || ' (found ' || coalesce(md5(p.prosrc), '<missing>') || ', reviewed ' || e.body_md5 || ')',
                             ', ' ORDER BY e.sig), '') INTO v_text
  FROM (VALUES
    ('public.attachment_cleanup_path_is_safe(uuid,text,uuid)', '2c2f2ff508d1550f780987641aadedd7'),
    ('public.immutable_english_tsvector_text(text)',           '26edc211280ccfa3050b5d16f3caa75d'),
    ('public.immutable_english_tsvector_textarr(text[])',      '19261084e62e923f83ab83abb7d5ed66'),
    ('public.immutable_english_tsvector_jsonb(jsonb)',         '30c015cd34f5ed6cbe9b1e8f0626cd5e'),
    ('public.set_updated_at()',                                '301a884953d37769916294bb60562e05')
  ) AS e(sig, body_md5)
  LEFT JOIN pg_proc p ON p.oid = to_regprocedure(e.sig)
  WHERE md5(p.prosrc) IS DISTINCT FROM e.body_md5;
  IF v_text <> '' THEN
    RAISE EXCEPTION 'pg_catalog_helper_pg_temp_last: STOP — a reviewed helper body has drifted, so the reviewed classification no longer applies; re-review before changing it: %', v_text;
  END IF;

  -- ── 1d. The five: exactly the reviewed shape ────────────────────────────────
  -- One overload; owner postgres; SECURITY INVOKER; a plain function; the
  -- reviewed language, volatility, parallel mode, strictness (not strict),
  -- leakproofness (not leakproof), SETOF posture, result, arguments,
  -- `{search_path=pg_catalog}` and nothing else, the effective EXECUTE class
  -- across PUBLIC / anon / authenticated / service_role, and the body digest.
  -- One readable line per function, so a failure names the attribute that
  -- moved. The literal ACL is checked in 1e, because it has two reviewed forms.
  WITH e(sig, lang, vol, par, result, args, exec, body_md5) AS (VALUES
    ('public.attachment_cleanup_path_is_safe(uuid,text,uuid)', 'sql', 'i', 's', 'boolean',
     'p_user_id uuid, p_file_path text, p_paper_id uuid', '<nobody>', '2c2f2ff508d1550f780987641aadedd7'),
    ('public.immutable_english_tsvector_text(text)', 'sql', 'i', 's', 'tsvector',
     't text', 'PUBLIC,anon,authenticated,service_role', '26edc211280ccfa3050b5d16f3caa75d'),
    ('public.immutable_english_tsvector_textarr(text[])', 'sql', 'i', 's', 'tsvector',
     'arr text[]', 'PUBLIC,anon,authenticated,service_role', '19261084e62e923f83ab83abb7d5ed66'),
    ('public.immutable_english_tsvector_jsonb(jsonb)', 'sql', 'i', 's', 'tsvector',
     'j jsonb', 'PUBLIC,anon,authenticated,service_role', '30c015cd34f5ed6cbe9b1e8f0626cd5e'),
    -- The non-target, pinned just as tightly.
    ('public.set_updated_at()', 'plpgsql', 'v', 'u', 'trigger',
     '', 'PUBLIC,anon,authenticated,service_role', '301a884953d37769916294bb60562e05')
  ),
  cmp AS (
    SELECT e.sig,
           (SELECT format('overloads=%s owner=%s secdef=%s kind=%s lang=%s vol=%s parallel=%s strict=%s leakproof=%s setof=%s result=%s args=[%s] config=%s exec=%s body=%s',
                          (SELECT count(*) FROM pg_proc p2 WHERE p2.pronamespace = p.pronamespace AND p2.proname = p.proname),
                          pg_get_userbyid(p.proowner), p.prosecdef, p.prokind, l.lanname, p.provolatile, p.proparallel,
                          p.proisstrict, p.proleakproof, p.proretset,
                          pg_get_function_result(p.oid), pg_get_function_arguments(p.oid),
                          coalesce(p.proconfig::text, '<none>'),
                          (SELECT coalesce(string_agg(r, ',' ORDER BY r COLLATE "C"), '<nobody>')
                             FROM unnest(ARRAY['PUBLIC', 'anon', 'authenticated', 'service_role']) r
                            WHERE CASE WHEN r = 'PUBLIC'
                                       THEN EXISTS (SELECT 1 FROM aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                                                     WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE')
                                       ELSE has_function_privilege(r, p.oid, 'EXECUTE') END),
                          md5(p.prosrc))
              FROM pg_proc p JOIN pg_language l ON l.oid = p.prolang
             WHERE p.oid = to_regprocedure(e.sig)) AS found,
           -- (format's %s renders a boolean with its output function: t / f)
           format('overloads=1 owner=postgres secdef=f kind=f lang=%s vol=%s parallel=%s strict=f leakproof=f setof=f result=%s args=[%s] config={search_path=pg_catalog} exec=%s body=%s',
                  e.lang, e.vol, e.par, e.result, e.args, e.exec, e.body_md5) AS expected
      FROM e
  )
  SELECT (SELECT count(*) FROM e),
         coalesce(string_agg(cmp.sig || E'\n  found:    ' || coalesce(cmp.found, '<missing>')
                                     || E'\n  expected: ' || cmp.expected, E'\n' ORDER BY cmp.sig), '')
    INTO v_count, v_text
  FROM cmp WHERE cmp.found IS DISTINCT FROM cmp.expected;
  IF v_count <> 5 THEN
    RAISE EXCEPTION 'pg_catalog_helper_pg_temp_last: the reviewed shape table has % rows, not 5', v_count;
  END IF;
  IF v_text <> '' THEN
    RAISE EXCEPTION E'pg_catalog_helper_pg_temp_last: function(s) not in the reviewed shape:\n%', v_text;
  END IF;

  -- These five, and only these, are at `{search_path=pg_catalog}`: a sixth such
  -- function is outside the reviewed scope and must be classified first.
  SELECT coalesce(string_agg(p.oid::regprocedure::text, ', ' ORDER BY p.oid::regprocedure::text), '') INTO v_text
  FROM pg_proc p
  WHERE p.pronamespace = 'public'::regnamespace
    AND p.proconfig::text LIKE '%pg_catalog%'
    AND p.oid <> ALL (SELECT to_regprocedure(s) FROM unnest(v_targets || v_nontarget) s);
  IF v_text <> '' THEN
    RAISE EXCEPTION 'pg_catalog_helper_pg_temp_last: unreviewed pg_catalog-pinned function(s) in public — classify before any change: %', v_text;
  END IF;

  -- ── 1e. EXECUTE ACL — only the reviewed representations ─────────────────────
  -- The attachment helper: exactly owner-only, in every environment.
  SELECT coalesce(proacl::text, '<default>') INTO v_text
  FROM pg_proc WHERE oid = to_regprocedure('public.attachment_cleanup_path_is_safe(uuid,text,uuid)');
  IF v_text IS DISTINCT FROM '{postgres=X/postgres}' THEN
    RAISE EXCEPTION 'pg_catalog_helper_pg_temp_last: attachment_cleanup_path_is_safe ACL is %, reviewed {postgres=X/postgres}', v_text;
  END IF;

  -- The three wrappers and set_updated_at(): the clean-replay default (NULL) or
  -- the hosted explicit form, and all four the same one of those two.
  SELECT coalesce(string_agg(s || ' = ' || coalesce(p.proacl::text, '<default>'), ', ' ORDER BY s), '') INTO v_text
  FROM unnest(v_targets[2:4] || v_nontarget) s JOIN pg_proc p ON p.oid = to_regprocedure(s)
  WHERE NOT (p.proacl IS NULL OR p.proacl::text = v_hosted_acl);
  IF v_text <> '' THEN
    RAISE EXCEPTION 'pg_catalog_helper_pg_temp_last: unreviewed ACL shape (reviewed: <default> on a clean replay, or % on hosted): %', v_hosted_acl, v_text;
  END IF;
  SELECT count(DISTINCT coalesce(p.proacl::text, '<default>')) INTO v_count
  FROM unnest(v_targets[2:4] || v_nontarget) s JOIN pg_proc p ON p.oid = to_regprocedure(s);
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'pg_catalog_helper_pg_temp_last: the wrappers and set_updated_at() mix the two reviewed ACL representations — an unreviewed shape';
  END IF;

  -- ── 1f. The attachment helper's privileged callers ──────────────────────────
  -- Exactly these three bodies call it, schema-qualified; each is the reviewed
  -- SECURITY DEFINER shape (C50 path, owner + authenticated EXECUTE, body digest).
  SELECT coalesce(string_agg(p.oid::regprocedure::text, ',' ORDER BY p.oid::regprocedure::text), '') INTO v_text
  FROM pg_proc p WHERE p.prosrc LIKE '%attachment_cleanup_path_is_safe%';
  SELECT string_agg(to_regprocedure(s)::text, ',' ORDER BY to_regprocedure(s)::text) INTO v_want
  FROM unnest(v_callers) s;
  IF v_text IS DISTINCT FROM v_want THEN
    RAISE EXCEPTION 'pg_catalog_helper_pg_temp_last: the functions calling attachment_cleanup_path_is_safe are [%], reviewed [%]', v_text, v_want;
  END IF;

  SELECT coalesce(string_agg(e.sig || ' = ' || coalesce(
           (SELECT format('secdef=%s owner=%s vol=%s parallel=%s config=%s acl=%s calls_qualified=%s body=%s',
                          p.prosecdef, pg_get_userbyid(p.proowner), p.provolatile, p.proparallel,
                          coalesce(p.proconfig::text, '<none>'), coalesce(p.proacl::text, '<default>'),
                          p.prosrc LIKE '%public.attachment_cleanup_path_is_safe(%', md5(p.prosrc))
              FROM pg_proc p WHERE p.oid = to_regprocedure(e.sig)), '<missing>'), E'\n' ORDER BY e.sig), '') INTO v_text
  FROM (VALUES
    ('public.delete_attachment_with_cleanup(uuid)',                     '23833e1f7971c8d68d118f546f9b86d5'),
    ('public.delete_papers_with_attachment_cleanup(uuid[])',            '91bf1072ea5a3e19adbf7aa4b344c47f'),
    ('public.finalize_attachment_upload(uuid,text,text,text,integer)',  '4bdcc81492bc35022f01c930fdb91521')
  ) AS e(sig, body_md5)
  WHERE (SELECT format('secdef=%s owner=%s vol=%s parallel=%s config=%s acl=%s calls_qualified=%s body=%s',
                       p.prosecdef, pg_get_userbyid(p.proowner), p.provolatile, p.proparallel,
                       coalesce(p.proconfig::text, '<none>'), coalesce(p.proacl::text, '<default>'),
                       p.prosrc LIKE '%public.attachment_cleanup_path_is_safe(%', md5(p.prosrc))
           FROM pg_proc p WHERE p.oid = to_regprocedure(e.sig))
        IS DISTINCT FROM format('secdef=t owner=postgres vol=v parallel=u config={"search_path=public, pg_temp"} acl={postgres=X/postgres,authenticated=X/postgres} calls_qualified=t body=%s', e.body_md5);
  IF v_text <> '' THEN
    RAISE EXCEPTION E'pg_catalog_helper_pg_temp_last: an attachment lifecycle caller is not in its reviewed shape:\n%', v_text;
  END IF;

  -- ── 1g. papers.search_vector — only the two reviewed shapes ─────────────────
  IF (SELECT format('generated=%s type=%s notnull=%s dropped=%s', a.attgenerated, format_type(a.atttypid, a.atttypmod),
                    a.attnotnull, a.attisdropped)
        FROM pg_attribute a WHERE a.attrelid = 'public.papers'::regclass AND a.attname = 'search_vector')
     IS DISTINCT FROM 'generated=s type=tsvector notnull=f dropped=f' THEN
    RAISE EXCEPTION 'pg_catalog_helper_pg_temp_last: papers.search_vector is no longer the stored generated tsvector column';
  END IF;

  SELECT md5(pg_get_expr(d.adbin, d.adrelid)),
         (SELECT coalesce(string_agg(dd.refobjid::regprocedure::text || '|' || dd.deptype::text, ','
                                     ORDER BY dd.refobjid::regprocedure::text), '')
            FROM pg_depend dd
           WHERE dd.classid = 'pg_attrdef'::regclass AND dd.objid = d.oid AND dd.refclassid = 'pg_proc'::regclass)
    INTO v_expr_md5, v_expr_deps
  FROM pg_attrdef d JOIN pg_attribute a ON a.attrelid = d.adrelid AND a.attnum = d.adnum
  WHERE d.adrelid = 'public.papers'::regclass AND a.attname = 'search_vector';
  IF NOT (   (v_expr_md5 = 'dd69f099a274a9cdc0f174ae0883ddb6'
              AND v_expr_deps = 'public.immutable_english_tsvector_jsonb(jsonb)|n,public.immutable_english_tsvector_text(text)|n')
          OR (v_expr_md5 = '8ddd960b4f4b11dd7afd35485d01fd25' AND v_expr_deps = '')) THEN
    RAISE EXCEPTION 'pg_catalog_helper_pg_temp_last: STOP — papers.search_vector is an unreviewed shape (expression %, function dependencies [%]); reviewed: clean replay dd69f099… on the text+jsonb wrappers, or hosted 8ddd960b… on none (DB-SEARCH-VECTOR-EXPRESSION-PARITY-001)',
      coalesce(v_expr_md5, '<missing>'), coalesce(v_expr_deps, '<missing>');
  END IF;

  IF (SELECT format('rel=%s valid=%s ready=%s def=%s', i.indrelid::regclass, i.indisvalid, i.indisready,
                    md5(pg_get_indexdef(i.indexrelid)))
        FROM pg_index i WHERE i.indexrelid = to_regclass('public.idx_papers_search_vector'))
     IS DISTINCT FROM 'rel=public.papers valid=t ready=t def=447b923097a20e377d6b1b6e74760783' THEN
    RAISE EXCEPTION 'pg_catalog_helper_pg_temp_last: idx_papers_search_vector is missing or not in its reviewed shape';
  END IF;

  -- Nothing else depends on the four targets: at most the search_vector
  -- expression on a clean replay (checked above).
  SELECT coalesce(string_agg(d.classid::regclass::text || ':' || d.objid::text || ' -> ' || d.refobjid::regprocedure::text,
                             ', ' ORDER BY d.refobjid::regprocedure::text), '') INTO v_text
  FROM pg_depend d
  WHERE d.refclassid = 'pg_proc'::regclass
    AND d.refobjid = ANY (SELECT to_regprocedure(s) FROM unnest(v_targets) s)
    AND NOT (d.classid = 'pg_attrdef'::regclass
             AND d.objid = (SELECT ad.oid FROM pg_attrdef ad JOIN pg_attribute a ON a.attrelid = ad.adrelid AND a.attnum = ad.adnum
                             WHERE ad.adrelid = 'public.papers'::regclass AND a.attname = 'search_vector'));
  IF v_text <> '' THEN
    RAISE EXCEPTION 'pg_catalog_helper_pg_temp_last: unreviewed dependent(s) on a target: %', v_text;
  END IF;

  -- ── 1h. set_updated_at() is bound exactly by papers.trg_papers_updated_at ───
  SELECT coalesce(string_agg(format('%s.%s|%s|%s|%s|%s', t.tgrelid::regclass, t.tgname, t.tgenabled, t.tgtype,
                                    t.tgisinternal, md5(pg_get_triggerdef(t.oid))), ',' ORDER BY t.tgname), '') INTO v_text
  FROM pg_trigger t WHERE t.tgfoid = to_regprocedure(v_nontarget);
  IF v_text IS DISTINCT FROM 'public.papers.trg_papers_updated_at|O|19|f|64efa17c0852ae9a5d30cc42d2edbba2' THEN
    RAISE EXCEPTION 'pg_catalog_helper_pg_temp_last: the triggers bound to set_updated_at() are [%], reviewed exactly papers.trg_papers_updated_at', v_text;
  END IF;

  SELECT coalesce(string_agg(d.classid::regclass::text || ':' || d.objid::text, ', '), '') INTO v_text
  FROM pg_depend d
  WHERE d.refclassid = 'pg_proc'::regclass AND d.refobjid = to_regprocedure(v_nontarget)
    AND NOT (d.classid = 'pg_trigger'::regclass
             AND d.objid = (SELECT t.oid FROM pg_trigger t
                             WHERE t.tgrelid = 'public.papers'::regclass AND t.tgname = 'trg_papers_updated_at'));
  IF v_text <> '' THEN
    RAISE EXCEPTION 'pg_catalog_helper_pg_temp_last: unreviewed dependent(s) on set_updated_at(): %', v_text;
  END IF;

  -- ── 1i. Snapshots for section 3 ────────────────────────────────────────────
  -- Transaction-local; read back in section 3.

  -- Each target as its WHOLE pg_proc row except proconfig — oid included, so a
  -- drop-and-recreate could not pass as an ALTER.
  PERFORM set_config('paperlume.pg_catalog_helper_pg_temp_last.pre_targets',
    (SELECT string_agg(p.oid::regprocedure::text || '=' || md5((to_jsonb(p.*) - 'proconfig')::text), E'\n'
                       ORDER BY p.oid::regprocedure::text)
       FROM pg_proc p WHERE p.oid = ANY (SELECT to_regprocedure(s) FROM unnest(v_targets) s)), true);

  -- Each target's literal ACL (its reviewed representation, as found).
  PERFORM set_config('paperlume.pg_catalog_helper_pg_temp_last.pre_acls',
    (SELECT string_agg(p.oid::regprocedure::text || '=' || coalesce(p.proacl::text, '<default>'), E'\n'
                       ORDER BY p.oid::regprocedure::text)
       FROM pg_proc p WHERE p.oid = ANY (SELECT to_regprocedure(s) FROM unnest(v_targets) s)), true);

  -- The non-target as its WHOLE row, proconfig included: nothing moves.
  PERFORM set_config('paperlume.pg_catalog_helper_pg_temp_last.pre_nontarget',
    (SELECT md5(to_jsonb(p.*)::text) FROM pg_proc p WHERE p.oid = to_regprocedure(v_nontarget)), true);

  -- Every OTHER function in public, whole rows: set_updated_at(), the three
  -- attachment callers and every remaining routine.
  PERFORM set_config('paperlume.pg_catalog_helper_pg_temp_last.pre_others',
    (SELECT md5(string_agg(p.oid::text || '=' || md5(to_jsonb(p.*)::text), E'\n' ORDER BY p.oid))
       FROM pg_proc p
      WHERE p.pronamespace = 'public'::regnamespace
        AND p.oid <> ALL (SELECT to_regprocedure(s) FROM unnest(v_targets) s)), true);

  -- The relations the helpers serve, with their OIDs and storage: the
  -- search_vector column and its default, the GIN index, papers' storage, the
  -- updated-at trigger, and every pg_depend edge into the five.
  PERFORM set_config('paperlume.pg_catalog_helper_pg_temp_last.pre_relations',
    (SELECT concat_ws(E'\n',
       (SELECT 'att|' || md5(to_jsonb(a.*)::text) FROM pg_attribute a
         WHERE a.attrelid = 'public.papers'::regclass AND a.attname = 'search_vector'),
       (SELECT 'def|' || ad.oid::text || '|' || md5(ad.adbin::text) || '|' || md5(pg_get_expr(ad.adbin, ad.adrelid))
          FROM pg_attrdef ad JOIN pg_attribute a ON a.attrelid = ad.adrelid AND a.attnum = ad.adnum
         WHERE ad.adrelid = 'public.papers'::regclass AND a.attname = 'search_vector'),
       (SELECT 'idx|' || md5(to_jsonb(i.*)::text) || '|' || c.relfilenode::text || '|' || md5(pg_get_indexdef(i.indexrelid))
          FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
         WHERE i.indexrelid = 'public.idx_papers_search_vector'::regclass),
       (SELECT 'papers|' || c.oid::text || '|' || c.relfilenode::text FROM pg_class c WHERE c.oid = 'public.papers'::regclass),
       (SELECT 'trg|' || md5(to_jsonb(t.*)::text) || '|' || md5(pg_get_triggerdef(t.oid))
          FROM pg_trigger t WHERE t.tgrelid = 'public.papers'::regclass AND t.tgname = 'trg_papers_updated_at'),
       (SELECT 'dep|' || coalesce(string_agg(d.classid::text || ':' || d.objid::text || ':' || d.objsubid::text
                                             || '->' || d.refobjid::text || ':' || d.deptype::text, ','
                                             ORDER BY d.classid, d.objid, d.objsubid, d.refobjid), '')
          FROM pg_depend d
         WHERE d.refclassid = 'pg_proc'::regclass
           AND d.refobjid = ANY (SELECT to_regprocedure(s) FROM unnest(v_targets || v_nontarget) s)))), true);
END
$pre$;


-- ═════════════════════════════════════════════════════════════════════════════
-- 2. The change
-- ═════════════════════════════════════════════════════════════════════════════
--
-- Four statements, one attribute each, exact signatures. No CREATE OR REPLACE:
-- the reviewed bodies are kept byte-for-byte, and section 3 proves it.
-- `public.set_updated_at()` has no statement here by design.

ALTER FUNCTION public.attachment_cleanup_path_is_safe(uuid,text,uuid)
  SET search_path = pg_catalog, pg_temp;

ALTER FUNCTION public.immutable_english_tsvector_text(text)
  SET search_path = pg_catalog, pg_temp;

ALTER FUNCTION public.immutable_english_tsvector_textarr(text[])
  SET search_path = pg_catalog, pg_temp;

ALTER FUNCTION public.immutable_english_tsvector_jsonb(jsonb)
  SET search_path = pg_catalog, pg_temp;


-- ═════════════════════════════════════════════════════════════════════════════
-- 3. Fail-closed verification — inside the same transaction
-- ═════════════════════════════════════════════════════════════════════════════

DO $verify$
DECLARE
  v_text       TEXT;
  v_base       TEXT;
  v_targets    CONSTANT TEXT[] := ARRAY[
    'public.attachment_cleanup_path_is_safe(uuid,text,uuid)',
    'public.immutable_english_tsvector_text(text)',
    'public.immutable_english_tsvector_textarr(text[])',
    'public.immutable_english_tsvector_jsonb(jsonb)'];
  v_nontarget  CONSTANT TEXT := 'public.set_updated_at()';
  v_hosted_acl CONSTANT TEXT :=
    '{=X/postgres,postgres=X/postgres,anon=X/postgres,authenticated=X/postgres,service_role=X/postgres}';
BEGIN
  -- ── 3a. Exactly the four carry `pg_catalog, pg_temp`; set_updated_at() keeps
  --        `pg_catalog` ───────────────────────────────────────────────────────
  -- Literal comparison of the whole array: `pg_catalog` first, `pg_temp`
  -- present and last, no other schema, no second GUC.
  SELECT coalesce(string_agg(s || ' = ' || coalesce(p.proconfig::text, '<none>'), ', ' ORDER BY s), '') INTO v_text
  FROM unnest(v_targets) s LEFT JOIN pg_proc p ON p.oid = to_regprocedure(s)
  WHERE p.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog, pg_temp'];
  IF v_text <> '' THEN
    RAISE EXCEPTION 'pg_catalog_helper_pg_temp_last: target(s) without exactly search_path=pg_catalog, pg_temp: %', v_text;
  END IF;

  IF (SELECT proconfig FROM pg_proc WHERE oid = to_regprocedure(v_nontarget))
     IS DISTINCT FROM ARRAY['search_path=pg_catalog'] THEN
    RAISE EXCEPTION 'pg_catalog_helper_pg_temp_last: set_updated_at() is no longer at exactly search_path=pg_catalog';
  END IF;

  -- The distribution over public: 4 + 1, nothing else pinned to pg_catalog.
  SELECT string_agg(cfg || '=' || n, ' ' ORDER BY cfg) INTO v_text
  FROM (SELECT proconfig::text AS cfg, count(*) AS n FROM pg_proc
         WHERE pronamespace = 'public'::regnamespace AND proconfig::text LIKE '%pg_catalog%' GROUP BY 1) d;
  IF v_text IS DISTINCT FROM '{"search_path=pg_catalog, pg_temp"}=4 {search_path=pg_catalog}=1' THEN
    RAISE EXCEPTION 'pg_catalog_helper_pg_temp_last: public pg_catalog search_path distribution is %, expected 4 hardened + set_updated_at()', v_text;
  END IF;

  -- ── 3b. Targets: the whole row except proconfig is unchanged ────────────────
  -- oid, body, signature, argument names/modes/defaults, result, language,
  -- volatility, parallel, strictness, leakproofness, SETOF, cost/rows, owner,
  -- SECURITY INVOKER and ACL all sit in that row.
  v_base := current_setting('paperlume.pg_catalog_helper_pg_temp_last.pre_targets', true);
  SELECT string_agg(p.oid::regprocedure::text || '=' || md5((to_jsonb(p.*) - 'proconfig')::text), E'\n'
                    ORDER BY p.oid::regprocedure::text) INTO v_text
  FROM pg_proc p WHERE p.oid = ANY (SELECT to_regprocedure(s) FROM unnest(v_targets) s);
  IF coalesce(v_base, '') = '' OR v_text IS DISTINCT FROM v_base THEN
    RAISE EXCEPTION E'pg_catalog_helper_pg_temp_last: an attribute other than proconfig changed on a target.\nbefore:\n%\nafter:\n%', v_base, v_text;
  END IF;

  -- Restated literally, because review cares most about these: no body changed,
  -- all five are still SECURITY INVOKER, and each literal ACL is exactly what it
  -- was — still one of its reviewed representations, never normalised.
  IF (SELECT string_agg(md5(prosrc), ',' ORDER BY md5(prosrc) COLLATE "C") FROM pg_proc
       WHERE oid = ANY (SELECT to_regprocedure(s) FROM unnest(v_targets || v_nontarget) s))
     IS DISTINCT FROM '19261084e62e923f83ab83abb7d5ed66,26edc211280ccfa3050b5d16f3caa75d,2c2f2ff508d1550f780987641aadedd7,301a884953d37769916294bb60562e05,30c015cd34f5ed6cbe9b1e8f0626cd5e' THEN
    RAISE EXCEPTION 'pg_catalog_helper_pg_temp_last: a helper body changed';
  END IF;

  IF EXISTS (SELECT 1 FROM pg_proc WHERE oid = ANY (SELECT to_regprocedure(s) FROM unnest(v_targets || v_nontarget) s)
                                     AND prosecdef) THEN
    RAISE EXCEPTION 'pg_catalog_helper_pg_temp_last: a helper is no longer SECURITY INVOKER';
  END IF;

  v_base := current_setting('paperlume.pg_catalog_helper_pg_temp_last.pre_acls', true);
  SELECT string_agg(p.oid::regprocedure::text || '=' || coalesce(p.proacl::text, '<default>'), E'\n'
                    ORDER BY p.oid::regprocedure::text) INTO v_text
  FROM pg_proc p WHERE p.oid = ANY (SELECT to_regprocedure(s) FROM unnest(v_targets) s);
  IF coalesce(v_base, '') = '' OR v_text IS DISTINCT FROM v_base
     OR (SELECT coalesce(proacl::text, '<default>') FROM pg_proc
          WHERE oid = to_regprocedure('public.attachment_cleanup_path_is_safe(uuid,text,uuid)')) IS DISTINCT FROM '{postgres=X/postgres}'
     OR EXISTS (SELECT 1 FROM pg_proc p
                 WHERE p.oid = ANY (SELECT to_regprocedure(s) FROM unnest(v_targets[2:4]) s)
                   AND NOT (p.proacl IS NULL OR p.proacl::text = v_hosted_acl)) THEN
    RAISE EXCEPTION E'pg_catalog_helper_pg_temp_last: a target ACL changed.\nbefore:\n%\nafter:\n%', v_base, v_text;
  END IF;

  -- Effective callers, stated directly: nobody but its owner for the attachment
  -- helper; PUBLIC (hence anon / authenticated / service_role) for the wrappers.
  IF has_function_privilege('anon', 'public.attachment_cleanup_path_is_safe(uuid,text,uuid)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.attachment_cleanup_path_is_safe(uuid,text,uuid)', 'EXECUTE')
     OR has_function_privilege('service_role', 'public.attachment_cleanup_path_is_safe(uuid,text,uuid)', 'EXECUTE')
     OR NOT (SELECT bool_and(has_function_privilege(r, to_regprocedure(s), 'EXECUTE'))
               FROM unnest(v_targets[2:4]) s, unnest(ARRAY['anon', 'authenticated', 'service_role']) r) THEN
    RAISE EXCEPTION 'pg_catalog_helper_pg_temp_last: the effective EXECUTE callers of a target changed';
  END IF;

  -- ── 3c. set_updated_at() and every other function in public are unchanged ──
  v_base := current_setting('paperlume.pg_catalog_helper_pg_temp_last.pre_nontarget', true);
  IF coalesce(v_base, '') = ''
     OR (SELECT md5(to_jsonb(p.*)::text) FROM pg_proc p WHERE p.oid = to_regprocedure(v_nontarget)) IS DISTINCT FROM v_base THEN
    RAISE EXCEPTION 'pg_catalog_helper_pg_temp_last: set_updated_at() changed';
  END IF;

  -- (Covers the three attachment lifecycle callers, whose rows are unchanged.)
  v_base := current_setting('paperlume.pg_catalog_helper_pg_temp_last.pre_others', true);
  IF coalesce(v_base, '') = ''
     OR (SELECT md5(string_agg(p.oid::text || '=' || md5(to_jsonb(p.*)::text), E'\n' ORDER BY p.oid))
           FROM pg_proc p
          WHERE p.pronamespace = 'public'::regnamespace
            AND p.oid <> ALL (SELECT to_regprocedure(s) FROM unnest(v_targets) s)) IS DISTINCT FROM v_base THEN
    RAISE EXCEPTION 'pg_catalog_helper_pg_temp_last: a function outside the four targets changed';
  END IF;

  -- ── 3d. search_vector, its index, papers' storage, the trigger and every
  --        dependency edge are unchanged, with their OIDs ─────────────────────
  v_base := current_setting('paperlume.pg_catalog_helper_pg_temp_last.pre_relations', true);
  IF coalesce(v_base, '') = ''
     OR (SELECT concat_ws(E'\n',
          (SELECT 'att|' || md5(to_jsonb(a.*)::text) FROM pg_attribute a
            WHERE a.attrelid = 'public.papers'::regclass AND a.attname = 'search_vector'),
          (SELECT 'def|' || ad.oid::text || '|' || md5(ad.adbin::text) || '|' || md5(pg_get_expr(ad.adbin, ad.adrelid))
             FROM pg_attrdef ad JOIN pg_attribute a ON a.attrelid = ad.adrelid AND a.attnum = ad.adnum
            WHERE ad.adrelid = 'public.papers'::regclass AND a.attname = 'search_vector'),
          (SELECT 'idx|' || md5(to_jsonb(i.*)::text) || '|' || c.relfilenode::text || '|' || md5(pg_get_indexdef(i.indexrelid))
             FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
            WHERE i.indexrelid = 'public.idx_papers_search_vector'::regclass),
          (SELECT 'papers|' || c.oid::text || '|' || c.relfilenode::text FROM pg_class c WHERE c.oid = 'public.papers'::regclass),
          (SELECT 'trg|' || md5(to_jsonb(t.*)::text) || '|' || md5(pg_get_triggerdef(t.oid))
             FROM pg_trigger t WHERE t.tgrelid = 'public.papers'::regclass AND t.tgname = 'trg_papers_updated_at'),
          (SELECT 'dep|' || coalesce(string_agg(d.classid::text || ':' || d.objid::text || ':' || d.objsubid::text
                                                || '->' || d.refobjid::text || ':' || d.deptype::text, ','
                                                ORDER BY d.classid, d.objid, d.objsubid, d.refobjid), '')
             FROM pg_depend d
            WHERE d.refclassid = 'pg_proc'::regclass
              AND d.refobjid = ANY (SELECT to_regprocedure(s) FROM unnest(v_targets || v_nontarget) s))))
        IS DISTINCT FROM v_base THEN
    RAISE EXCEPTION 'pg_catalog_helper_pg_temp_last: papers.search_vector, idx_papers_search_vector, papers storage, trg_papers_updated_at or a dependency edge changed';
  END IF;

  -- ── 3e. Catalog-only: this transaction wrote no row ─────────────────────────
  v_base := current_setting('paperlume.pg_catalog_helper_pg_temp_last.xact_writes_at_start', true);
  IF coalesce(v_base, '') = '' THEN
    RAISE EXCEPTION 'pg_catalog_helper_pg_temp_last: the write baseline from section 0 is missing — this file must run as one transaction';
  END IF;
  SELECT string_agg(
           n.nspname || '.' || c.relname || '=' || (pg_stat_get_xact_tuples_inserted(c.oid)
                                                    + pg_stat_get_xact_tuples_updated(c.oid)
                                                    + pg_stat_get_xact_tuples_deleted(c.oid)),
           ' ' ORDER BY n.nspname, c.relname) INTO v_text
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname IN ('public', 'auth', 'storage') AND c.relkind IN ('r', 'p');
  IF v_text IS DISTINCT FROM v_base THEN
    RAISE EXCEPTION 'pg_catalog_helper_pg_temp_last: this transaction wrote application rows (row writes at start: %; now: %)', v_base, v_text;
  END IF;
END
$verify$;

COMMIT;
