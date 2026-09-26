-- DB-SECURITY-DEFINER-PG-TEMP-LAST-001 suite 021: retained SECURITY DEFINER
-- functions whose bodies resolve names through search_path place `pg_temp`
-- last; the audited exceptions stay exact, and only for their audited bodies.
--
-- Migration 20260926202754_harden_security_definer_pg_temp_last changed exactly
-- one attribute — proconfig {search_path=public} → {"search_path=public, pg_temp"}
-- — on 32 of the 35 public SECURITY DEFINER functions, and deliberately left
-- three trigger functions at `search_path=public` (C50). This suite owns that
-- decision end to end:
--
--   1. the hardened 32 — each carries exactly `search_path=public, pg_temp`
--      (`public` first, `pg_temp` present and LAST, no other schema, no second
--      GUC); every public SECURITY DEFINER function is classified into exactly
--      one of the two groups, so a new one cannot arrive unreviewed;
--   2. the checks are sensitive: under transaction-local mutations (config
--      reset, reverted to `public`, `pg_temp` moved first, an extra schema,
--      `pg_temp` not last; an exception's body edited or its path changed) the
--      same predicates report failure, and every probe is rolled back;
--   3. the 3 audited exceptions — path AND body digest pinned together, plus
--      their full posture and trigger binding. A future body edit breaks this
--      suite on purpose: a reviewer must re-audit and either keep the exception
--      (updating the digest here and in docs/decisions-and-triggers.md C50) or
--      move the function into the hardened group. The exemption is never by
--      name alone;
--   4. the hardened 32 kept their security posture — SECURITY DEFINER, owner
--      postgres, literal EXECUTE ACL and effective EXECUTE class (so C47's
--      service-role-only refund_ai_quota and the authenticated-only
--      attachment_object_has_live_metadata are pinned here too);
--   5. BEHAVIOUR — a caller-created temporary `papers` table, holding a forged
--      ownership row, cannot steer set_paper_tags(uuid,uuid[]) (Tier 1:
--      unqualified `papers` on the junction write boundary). As hardened, the
--      function resolves `public.papers`: the caller's own call works and the
--      foreign paper is refused. NEGATIVE CONTROL: with only that function
--      transaction-locally reverted to `search_path=public`, the SAME shadow
--      wins — the caller's own paper is refused and the forged row lets the
--      caller replace another account's tag links. That proves this section
--      detects the old posture, not merely that it passes on the new one;
--   6. every trigger and Storage-policy binding of the 35 is unchanged.
--
-- This is local, rolled-back regression evidence for a defense-in-depth
-- change. It is not a Production exploit: the audit found no route by which an
-- ordinary PaperLume caller can run the arbitrary SQL (CREATE TEMP TABLE) that
-- section 5 runs directly. Per-function behaviour of the 32 stays owned by the
-- suites that already cover them; the definer inventory counts and EXECUTE
-- matrix stay owned by 003; C49's INVOKER read RPCs by 020; the pg_catalog
-- helpers by 007.
--
-- Deterministic UUIDs; explicit fixtures; no TODO/SKIP; no remote calls; no
-- Production data; no real credentials. pgTAP is created inside the transaction
-- and rolled back with it; every temp object, ALTER and row is undone by the
-- ROLLBACK.

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SET LOCAL search_path TO extensions, public, pg_temp;

-- ── Helpers ─────────────────────────────────────────────────────────────────
-- The hardened 32, by exact signature, with the effective EXECUTE class each
-- must keep ('authenticated', '<nobody>' beyond the owner, or 'service_role').
CREATE FUNCTION pg_temp.hardened()
RETURNS TABLE (sig text, exec text) LANGUAGE sql AS $hlp$
  VALUES
    -- Tier 1 — relation resolution on the write boundary
    ('public.bulk_add_paper_projects(uuid[],uuid[])',                             'authenticated'),
    ('public.bulk_add_paper_tags(uuid[],uuid[])',                                 'authenticated'),
    ('public.bulk_set_paper_projects(uuid[],uuid[])',                             'authenticated'),
    ('public.bulk_set_paper_tags(uuid[],uuid[])',                                 'authenticated'),
    ('public.bulk_update_keywords(jsonb)',                                        'authenticated'),
    ('public.bulk_update_study_types(jsonb)',                                     'authenticated'),
    ('public.merge_exact_duplicates(uuid,uuid[])',                                'authenticated'),
    ('public.safe_bulk_insert_papers(uuid,jsonb)',                                'authenticated'),
    ('public.set_paper_projects(uuid,uuid[])',                                    'authenticated'),
    ('public.set_paper_tags(uuid,uuid[])',                                        'authenticated'),
    -- Tier 2 — type / transitive / path-resolution defense in depth
    ('public.attachment_object_has_live_metadata(text)',                          'authenticated'),
    ('public.author_identity_effective_root(uuid,uuid)',                          '<nobody>'),
    ('public.check_and_consume_storage_quota()',                                  '<nobody>'),
    ('public.clear_current_user_ai_model()',                                      'authenticated'),
    ('public.clear_current_user_ai_reasoning()',                                  'authenticated'),
    ('public.consume_ai_quota(uuid)',                                             'authenticated'),
    ('public.create_author_identity_from_mention(uuid,integer,text,text,boolean)', 'authenticated'),
    ('public.delete_attachment_with_cleanup(uuid)',                               'authenticated'),
    ('public.delete_empty_author_identity(uuid)',                                 'authenticated'),
    ('public.delete_papers_with_attachment_cleanup(uuid[])',                      'authenticated'),
    ('public.finalize_attachment_upload(uuid,text,text,text,integer)',            'authenticated'),
    ('public.get_ai_quota_status(uuid)',                                          'authenticated'),
    ('public.get_current_user_access()',                                          'authenticated'),
    ('public.handle_new_user()',                                                  '<nobody>'),
    ('public.link_author_mention_to_identity(uuid,integer,text,uuid,text,boolean)', 'authenticated'),
    ('public.merge_author_identities(uuid,uuid)',                                 'authenticated'),
    ('public.refund_ai_quota(uuid)',                                              'service_role'),
    ('public.set_current_user_ai_model(text)',                                    'authenticated'),
    ('public.set_current_user_ai_reasoning(text)',                                'authenticated'),
    ('public.unlink_author_mention_identity(uuid,integer)',                       'authenticated'),
    ('public.unmerge_author_identity(uuid)',                                      'authenticated'),
    ('public.validate_author_mention_for_identity(uuid,uuid,integer,text)',       '<nobody>');
$hlp$;

-- The 3 audited exceptions, each with the digest of the exact body the audit
-- classified SAFE UNDER CURRENT PRIVILEGES, and its one trigger binding.
CREATE FUNCTION pg_temp.exceptions()
RETURNS TABLE (sig text, body_md5 text, binding text) LANGUAGE sql AS $hlp$
  VALUES
    ('public.clear_author_identity_links_on_authors_change()', 'a14c92dbd8485afff4d1600684b37565',
     'public.papers|papers_clear_author_identity_links_on_authors_change|O|17'),
    ('public.refund_storage_quota()',                          '3e20f43b80a908b309cb6335d8eb9360',
     'public.paper_attachments|trg_paper_attachments_refund_storage_quota|O|9'),
    ('public.reject_attachment_over_cleanup_intent()',         '494f7297c23991bc8d28d4f81906e059',
     'public.paper_attachments|trg_paper_attachments_block_cleanup_intent|O|7');
$hlp$;

-- The hardened invariant for one function: exactly `public, pg_temp`.
CREATE FUNCTION pg_temp.hardened_ok(p_fn regprocedure) RETURNS boolean LANGUAGE sql AS $hlp$
  SELECT coalesce((SELECT p.proconfig = ARRAY['search_path=public, pg_temp']
                     FROM pg_proc p WHERE p.oid = p_fn), false)
$hlp$;

-- The exception invariant for one function: exactly `public` AND the audited body.
CREATE FUNCTION pg_temp.exception_ok(p_fn regprocedure, p_body_md5 text) RETURNS boolean LANGUAGE sql AS $hlp$
  SELECT coalesce((SELECT p.proconfig = ARRAY['search_path=public'] AND md5(p.prosrc) = p_body_md5
                     FROM pg_proc p WHERE p.oid = p_fn), false)
$hlp$;

-- Evaluate p_check after p_mutation, then roll the mutation back (a PL/pgSQL
-- exception block is a subtransaction; the local variable survives it).
CREATE FUNCTION pg_temp.check_under(p_mutation text, p_check text) RETURNS boolean
LANGUAGE plpgsql AS $hlp$
DECLARE v boolean;
BEGIN
  BEGIN
    EXECUTE p_mutation;
    EXECUTE 'SELECT (' || p_check || ')' INTO v;
    RAISE EXCEPTION USING ERRCODE = 'P0C50', MESSAGE = 'suite 021: roll the probe back';
  EXCEPTION WHEN SQLSTATE 'P0C50' THEN
    NULL;
  END;
  RETURN v;
END;
$hlp$;

-- Run p_sql as p_role with the given JWT claims; return '<SQLSTATE> <message>'
-- ('00000 ' on success) instead of raising, so one regression is reported by
-- every assertion it affects rather than aborting the suite.
CREATE FUNCTION pg_temp.err_as(p_role text, p_claims text, p_sql text)
RETURNS text LANGUAGE plpgsql AS $hlp$
DECLARE v_state text; v_msg text;
BEGIN
  PERFORM set_config('request.jwt.claims', COALESCE(p_claims, ''), true);
  EXECUTE 'SET LOCAL ROLE ' || quote_ident(p_role);
  BEGIN
    EXECUTE p_sql;
    v_state := '00000';
    v_msg := '';
  EXCEPTION WHEN others THEN
    GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE, v_msg = MESSAGE_TEXT;
  END;
  RESET ROLE;
  PERFORM set_config('request.jwt.claims', '', true);
  RETURN v_state || ' ' || v_msg;
END;
$hlp$;

-- The schema an unqualified relation name resolves to under p_path, as PostgreSQL
-- itself resolves it; the session's search_path is restored before returning.
CREATE FUNCTION pg_temp.resolves_to(p_path text, p_name text) RETURNS oid
LANGUAGE plpgsql AS $hlp$
DECLARE v_old text := current_setting('search_path'); v_rel regclass;
BEGIN
  PERFORM set_config('search_path', p_path, true);
  v_rel := to_regclass(p_name);
  PERFORM set_config('search_path', v_old, true);
  RETURN (SELECT c.relnamespace FROM pg_class c WHERE c.oid = v_rel);
END;
$hlp$;

CREATE FUNCTION pg_temp.claims_a() RETURNS text LANGUAGE sql AS
  $$ SELECT '{"sub":"21a00000-0000-0000-0000-00000000000a","role":"authenticated"}' $$;

-- A paper's tag links, read as the table owner (RLS bypassed), sorted.
CREATE FUNCTION pg_temp.tag_ids(p_paper uuid) RETURNS uuid[] LANGUAGE sql AS $hlp$
  SELECT coalesce(array_agg(tag_id ORDER BY tag_id), ARRAY[]::uuid[])
    FROM public.paper_tags WHERE paper_id = p_paper
$hlp$;

-- 32 + 3 (section 1)  + 8 (section 2) + 9 (section 3) + 32 (section 4)
--   + 16 (section 5) + 1 (section 6) = 101
SELECT plan(101);

-- ══ 1. The hardened 32: exactly `public, pg_temp` ═══════════════════════════
-- Literal array equality: `public` first, `pg_temp` present and last, no other
-- schema, and no second GUC in proconfig.
SELECT ok(pg_temp.hardened_ok(to_regprocedure(h.sig)),
  'hardened: ' || h.sig || ' has exactly search_path=public, pg_temp')
FROM pg_temp.hardened() h ORDER BY h.sig;

-- Every public SECURITY DEFINER function is classified: hardened or audited
-- exception, nothing else. A new definer function fails here until a reviewer
-- decides, from its body and execution context, which group it belongs to.
SELECT set_eq(
  $$SELECT p.oid FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.prosecdef$$,
  $$SELECT to_regprocedure(sig)::oid FROM pg_temp.hardened()
    UNION ALL SELECT to_regprocedure(sig)::oid FROM pg_temp.exceptions()$$,
  'classified: the public SECURITY DEFINER functions are exactly the hardened 32 plus the 3 audited exceptions');

-- The rule, stated generally over the whole inventory: outside the audited
-- exceptions, a definer's search_path is trusted schemas with `pg_temp` last —
-- `public` first, `pg_temp` last, nothing but those two, and one GUC.
SELECT is(
  (SELECT coalesce(string_agg(p.oid::regprocedure::text, ', ' ORDER BY p.oid::regprocedure::text), '')
     FROM pg_proc p
     LEFT JOIN LATERAL (
       SELECT string_to_array(regexp_replace(substr(c, length('search_path=') + 1), '\s', '', 'g'), ',') AS path
         FROM unnest(p.proconfig) c WHERE c LIKE 'search_path=%') sp ON true
    WHERE p.pronamespace = 'public'::regnamespace AND p.prosecdef
      AND p.oid <> ALL (SELECT to_regprocedure(sig) FROM pg_temp.exceptions())
      AND NOT coalesce(cardinality(p.proconfig) = 1
                       AND sp.path[1] = 'public'
                       AND sp.path[cardinality(sp.path)] = 'pg_temp'
                       AND sp.path <@ ARRAY['public', 'pg_temp'], false)),
  '',
  'rule: every non-exception public SECURITY DEFINER function has public first and pg_temp last, and nothing else');

SELECT is(
  (SELECT string_agg(cfg || '=' || n, ' ' ORDER BY cfg)
     FROM (SELECT coalesce(proconfig::text, '<none>') AS cfg, count(*) AS n FROM pg_proc
            WHERE pronamespace = 'public'::regnamespace AND prosecdef GROUP BY 1) d),
  '{"search_path=public, pg_temp"}=32 {search_path=public}=3',
  'distribution: 32 definers at public, pg_temp and exactly 3 at public');

-- ══ 2. The checks detect every regression they exist for ════════════════════
-- Each probe mutates one function inside a subtransaction, evaluates the same
-- predicate as sections 1 and 3, and is rolled back before the next assertion.
SELECT ok(NOT pg_temp.check_under(
    'ALTER FUNCTION public.set_paper_tags(uuid,uuid[]) SET search_path = public',
    $$pg_temp.hardened_ok('public.set_paper_tags(uuid,uuid[])')$$),
  'sensitivity: a hardened function changed back to search_path=public fails the invariant');
SELECT ok(NOT pg_temp.check_under(
    'ALTER FUNCTION public.set_paper_tags(uuid,uuid[]) RESET search_path',
    $$pg_temp.hardened_ok('public.set_paper_tags(uuid,uuid[])')$$),
  'sensitivity: a hardened function that drops its search_path (and pg_temp) fails the invariant');
SELECT ok(NOT pg_temp.check_under(
    'ALTER FUNCTION public.set_paper_tags(uuid,uuid[]) SET search_path = pg_temp, public',
    $$pg_temp.hardened_ok('public.set_paper_tags(uuid,uuid[])')$$),
  'sensitivity: pg_temp moved before public fails the invariant');
SELECT ok(NOT pg_temp.check_under(
    'ALTER FUNCTION public.set_paper_tags(uuid,uuid[]) SET search_path = public, extensions, pg_temp',
    $$pg_temp.hardened_ok('public.set_paper_tags(uuid,uuid[])')$$),
  'sensitivity: an added unapproved schema fails the invariant');
SELECT ok(NOT pg_temp.check_under(
    'ALTER FUNCTION public.refund_ai_quota(uuid) SET search_path = public, pg_temp, extensions',
    $$pg_temp.hardened_ok('public.refund_ai_quota(uuid)')$$),
  'sensitivity: pg_temp present but not last fails the invariant');
-- An exception whose body changes loses its exemption even though its path did not.
SELECT ok(NOT pg_temp.check_under(
    $m$CREATE OR REPLACE FUNCTION public.refund_storage_quota() RETURNS trigger
         LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
       AS $b$ BEGIN UPDATE user_storage_usage SET used_bytes = 0 WHERE user_id = OLD.user_id; RETURN OLD; END; $b$$m$,
    $$pg_temp.exception_ok('public.refund_storage_quota()', '3e20f43b80a908b309cb6335d8eb9360')$$),
  'sensitivity: an exception whose body changed fails the exception invariant (re-audit required)');
SELECT ok(NOT pg_temp.check_under(
    'ALTER FUNCTION public.refund_storage_quota() SET search_path = public, pg_temp',
    $$pg_temp.exception_ok('public.refund_storage_quota()', '3e20f43b80a908b309cb6335d8eb9360')$$),
  'sensitivity: an exception moved to another path fails until it is reclassified here');
-- ...and every probe was rolled back.
SELECT ok(
  (SELECT bool_and(pg_temp.hardened_ok(to_regprocedure(sig))) FROM pg_temp.hardened())
  AND (SELECT bool_and(pg_temp.exception_ok(to_regprocedure(sig), body_md5)) FROM pg_temp.exceptions()),
  'sensitivity: every probe rolled back — all 32 hardened and all 3 exceptions intact');

-- ══ 3. The 3 audited exceptions: path AND body, together ════════════════════
SELECT is(
  (SELECT p.proconfig FROM pg_proc p WHERE p.oid = to_regprocedure(x.sig)),
  ARRAY['search_path=public'],
  'exception: ' || x.sig || ' stays at exactly search_path=public (deliberately not normalised)')
FROM pg_temp.exceptions() x ORDER BY x.sig;

SELECT is(
  (SELECT md5(p.prosrc) FROM pg_proc p WHERE p.oid = to_regprocedure(x.sig)),
  x.body_md5,
  'exception: ' || x.sig || ' still has its audited body — a change here requires a search-path re-audit')
FROM pg_temp.exceptions() x ORDER BY x.sig;

-- The rest of the audited posture: SECURITY DEFINER trigger function owned by
-- postgres, no argument, owner-only EXECUTE, and its one trigger binding.
SELECT is(
  (SELECT pg_get_userbyid(p.proowner)
          || ' | ' || CASE WHEN p.prosecdef THEN 'SECURITY DEFINER' ELSE 'SECURITY INVOKER' END
          || ' | ' || l.lanname || ' | ' || pg_get_function_result(p.oid)
          || ' | args [' || pg_get_function_arguments(p.oid) || ']'
          || ' | acl ' || coalesce(p.proacl::text, 'NULL')
          || ' | ' || (SELECT coalesce(string_agg(rn.nspname || '.' || c.relname || '|' || t.tgname || '|'
                                                  || t.tgenabled::text || '|' || t.tgtype::text, ';' ORDER BY t.tgname), '<unbound>')
                         FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
                         JOIN pg_namespace rn ON rn.oid = c.relnamespace
                        WHERE t.tgfoid = p.oid AND NOT t.tgisinternal)
     FROM pg_proc p JOIN pg_language l ON l.oid = p.prolang
    WHERE p.oid = to_regprocedure(x.sig)),
  'postgres | SECURITY DEFINER | plpgsql | trigger | args [] | acl {postgres=X/postgres} | ' || x.binding,
  'exception: ' || x.sig || ' keeps its owner, mode, owner-only ACL and trigger binding')
FROM pg_temp.exceptions() x ORDER BY x.sig;

-- ══ 4. The hardened 32 kept their security posture ══════════════════════════
-- SECURITY DEFINER stays intentional (C50 changes only the path); owner
-- postgres; the literal ACL; and who can execute, across the four grantees that
-- matter. refund_ai_quota keeps C47's service-role-only contract.
SELECT is(
  (SELECT pg_get_userbyid(p.proowner)
          || ' | ' || CASE WHEN p.prosecdef THEN 'SECURITY DEFINER' ELSE 'SECURITY INVOKER' END
          || ' | acl ' || coalesce(p.proacl::text, 'NULL')
          || ' | exec ' || (SELECT coalesce(string_agg(r, ',' ORDER BY r COLLATE "C"), '<nobody>')
                              FROM unnest(ARRAY['PUBLIC', 'anon', 'authenticated', 'service_role']) r
                             WHERE CASE WHEN r = 'PUBLIC'
                                        THEN EXISTS (SELECT 1 FROM aclexplode(coalesce(p.proacl, acldefault('f'::"char", p.proowner))) a
                                                      WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE')
                                        ELSE has_function_privilege(to_regrole(r)::oid, p.oid, 'EXECUTE') END)
     FROM pg_proc p WHERE p.oid = to_regprocedure(h.sig)),
  'postgres | SECURITY DEFINER | acl '
    || CASE h.exec WHEN 'authenticated' THEN '{postgres=X/postgres,authenticated=X/postgres}'
                   WHEN 'service_role'  THEN '{postgres=X/postgres,service_role=X/postgres}'
                   ELSE '{postgres=X/postgres}' END
    || ' | exec ' || h.exec,
  'posture: ' || h.sig || ' stays SECURITY DEFINER, owned by postgres, EXECUTE ' || h.exec)
FROM pg_temp.hardened() h ORDER BY h.sig;

-- ══ 5. Behaviour: a caller's temp `papers` cannot steer set_paper_tags ══════
-- Fixtures, as the table owner. A owns paper A1 (linked to tag TA1) and tags
-- TA1, TA2; B owns paper B1 (linked to tag TB).
INSERT INTO auth.users (id, email) VALUES
  ('21a00000-0000-0000-0000-00000000000a', 'c50-A@paperlume.test'),
  ('21b00000-0000-0000-0000-00000000000b', 'c50-B@paperlume.test');
INSERT INTO public.papers (id, user_id, title) VALUES
  ('21a00000-0000-0000-0000-0000000000a1', '21a00000-0000-0000-0000-00000000000a', 'C50 paper of A'),
  ('21b00000-0000-0000-0000-0000000000b1', '21b00000-0000-0000-0000-00000000000b', 'C50 paper of B');
INSERT INTO public.tags (id, user_id, name) VALUES
  ('21a00000-0000-0000-0000-0000000000c1', '21a00000-0000-0000-0000-00000000000a', 'c50-a-one'),
  ('21a00000-0000-0000-0000-0000000000c2', '21a00000-0000-0000-0000-00000000000a', 'c50-a-two'),
  ('21b00000-0000-0000-0000-0000000000d1', '21b00000-0000-0000-0000-00000000000b', 'c50-b-one');
INSERT INTO public.paper_tags (paper_id, tag_id) VALUES
  ('21a00000-0000-0000-0000-0000000000a1', '21a00000-0000-0000-0000-0000000000c1'),
  ('21b00000-0000-0000-0000-0000000000b1', '21b00000-0000-0000-0000-0000000000d1');

-- The shadow. Created BY the caller — `authenticated`, holding A's claims —
-- in its own session's temporary schema, with the name of the relation the
-- function's ownership guard reads unqualified. It is observably different from
-- public.papers: it claims A owns B1, and it does not contain A1.
SELECT is(
  pg_temp.err_as('authenticated', pg_temp.claims_a(),
    $q$CREATE TEMP TABLE papers (id uuid, user_id uuid);
       INSERT INTO pg_temp.papers VALUES ('21b00000-0000-0000-0000-0000000000b1', '21a00000-0000-0000-0000-00000000000a')$q$),
  '00000 ',
  'shadow: the authenticated caller can create a temp papers table holding a forged ownership row');

SELECT is(
  (SELECT pg_get_userbyid(c.relowner) || '|' || c.relpersistence::text || '|' || (c.relnamespace = pg_my_temp_schema())::text
     FROM pg_class c WHERE c.oid = to_regclass('pg_temp.papers')),
  'authenticated|t|true',
  'shadow: pg_temp.papers is a temporary relation owned by the caller, in this session''s temp schema');

-- The mechanism, exactly as the PostgreSQL 17 search_path documentation states
-- it: an unlisted temp schema is searched FIRST; listed last, it loses to public.
SELECT is(pg_temp.resolves_to('public', 'papers'), pg_my_temp_schema(),
  'mechanism: under search_path=public an unqualified papers resolves to the temp shadow');
SELECT is(pg_temp.resolves_to('public, pg_temp', 'papers'), 'public'::regnamespace::oid,
  'mechanism: under search_path=public, pg_temp an unqualified papers resolves to public.papers');

-- 5a. HARDENED (C50): the function reads public.papers despite the shadow.
SELECT is(
  pg_temp.err_as('authenticated', pg_temp.claims_a(),
    $q$SELECT public.set_paper_tags('21a00000-0000-0000-0000-0000000000a1'::uuid,
                                    ARRAY['21a00000-0000-0000-0000-0000000000c2']::uuid[])$q$),
  '00000 ',
  'hardened: the caller''s own paper (absent from the shadow) is found in public.papers and updated');
SELECT is(pg_temp.tag_ids('21a00000-0000-0000-0000-0000000000a1'),
  ARRAY['21a00000-0000-0000-0000-0000000000c2']::uuid[],
  'hardened: the caller''s paper now carries exactly the requested tag');
SELECT is(
  pg_temp.err_as('authenticated', pg_temp.claims_a(),
    $q$SELECT public.set_paper_tags('21b00000-0000-0000-0000-0000000000b1'::uuid,
                                    ARRAY['21a00000-0000-0000-0000-0000000000c1']::uuid[])$q$),
  'P0001 Paper not found or access denied',
  'hardened: the forged shadow row does not make another account''s paper pass the ownership guard');
SELECT is(pg_temp.tag_ids('21b00000-0000-0000-0000-0000000000b1'),
  ARRAY['21b00000-0000-0000-0000-0000000000d1']::uuid[],
  'hardened: the other account''s tag links are untouched');

-- 5b. NEGATIVE CONTROL: only this function, transaction-locally, back to the
-- pre-C50 posture. The same shadow and the same calls must now behave
-- differently, or this section could not have detected the old posture.
ALTER FUNCTION public.set_paper_tags(uuid,uuid[]) SET search_path = public;
SELECT is((SELECT proconfig FROM pg_proc WHERE oid = 'public.set_paper_tags(uuid,uuid[])'::regprocedure),
  ARRAY['search_path=public'],
  'negative control: set_paper_tags is transaction-locally back at search_path=public');
SELECT is(
  pg_temp.err_as('authenticated', pg_temp.claims_a(),
    $q$SELECT public.set_paper_tags('21a00000-0000-0000-0000-0000000000a1'::uuid,
                                    ARRAY['21a00000-0000-0000-0000-0000000000c1']::uuid[])$q$),
  'P0001 Paper not found or access denied',
  'negative control: the guard now reads the temp shadow — the caller''s own real paper is refused');
SELECT is(pg_temp.tag_ids('21a00000-0000-0000-0000-0000000000a1'),
  ARRAY['21a00000-0000-0000-0000-0000000000c2']::uuid[],
  'negative control: the refused call changed nothing on the caller''s paper');
SELECT is(
  pg_temp.err_as('authenticated', pg_temp.claims_a(),
    $q$SELECT public.set_paper_tags('21b00000-0000-0000-0000-0000000000b1'::uuid,
                                    ARRAY['21a00000-0000-0000-0000-0000000000c1']::uuid[])$q$),
  '00000 ',
  'negative control: the forged shadow row passes the ownership guard for another account''s paper');
SELECT is(pg_temp.tag_ids('21b00000-0000-0000-0000-0000000000b1'),
  ARRAY['21a00000-0000-0000-0000-0000000000c1']::uuid[],
  'negative control: with the owner''s authority the call replaced the other account''s tag links');

-- Restore C50 for this function and show the same forged call is refused again.
ALTER FUNCTION public.set_paper_tags(uuid,uuid[]) SET search_path = public, pg_temp;
SELECT ok(pg_temp.hardened_ok('public.set_paper_tags(uuid,uuid[])'),
  'restored: set_paper_tags is back at search_path=public, pg_temp');
SELECT is(
  pg_temp.err_as('authenticated', pg_temp.claims_a(),
    $q$SELECT public.set_paper_tags('21b00000-0000-0000-0000-0000000000b1'::uuid,
                                    ARRAY['21a00000-0000-0000-0000-0000000000c2']::uuid[])$q$),
  'P0001 Paper not found or access denied',
  'restored: with pg_temp last the same forged call is refused again');

SELECT is(
  pg_temp.err_as('authenticated', pg_temp.claims_a(), 'DROP TABLE pg_temp.papers'),
  '00000 ',
  'cleanup: the caller dropped its shadow (the ROLLBACK undoes everything else)');

-- ══ 6. Where the 35 are bound is unchanged ══════════════════════════════════
-- The five trigger bindings — two on hardened trigger functions
-- (handle_new_user, check_and_consume_storage_quota) and one on each of the
-- three exceptions — and the Storage policy that evaluates
-- attachment_object_has_live_metadata(text). Rendered from the catalogs, not
-- from search_path-dependent text.
SELECT is(
  (SELECT string_agg(x.line, E'\n' ORDER BY x.line)
     FROM (SELECT rn.nspname || '.' || c.relname || '|' || t.tgname || '|' || fn.nspname || '.' || f.proname
                  || '|' || t.tgenabled::text || '|' || t.tgtype::text AS line
             FROM pg_trigger t
             JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace rn ON rn.oid = c.relnamespace
             JOIN pg_proc f ON f.oid = t.tgfoid JOIN pg_namespace fn ON fn.oid = f.pronamespace
            WHERE f.pronamespace = 'public'::regnamespace AND f.prosecdef AND NOT t.tgisinternal
           UNION ALL
           SELECT 'policy|' || pn.nspname || '.' || pc.relname || '.' || pol.polname || '|' || pol.polcmd::text
                  || '|' || fn.nspname || '.' || f.proname
             FROM pg_depend d
             JOIN pg_policy pol ON d.classid = 'pg_policy'::regclass AND pol.oid = d.objid
             JOIN pg_class pc ON pc.oid = pol.polrelid JOIN pg_namespace pn ON pn.oid = pc.relnamespace
             JOIN pg_proc f ON f.oid = d.refobjid JOIN pg_namespace fn ON fn.oid = f.pronamespace
            WHERE d.refclassid = 'pg_proc'::regclass
              AND f.pronamespace = 'public'::regnamespace AND f.prosecdef) x),
  'auth.users|on_auth_user_created|public.handle_new_user|O|5' || E'\n'
  || 'policy|storage.objects.attachments_owner_delete|d|public.attachment_object_has_live_metadata' || E'\n'
  || 'public.paper_attachments|trg_paper_attachments_block_cleanup_intent|public.reject_attachment_over_cleanup_intent|O|7' || E'\n'
  || 'public.paper_attachments|trg_paper_attachments_check_storage_quota|public.check_and_consume_storage_quota|O|7' || E'\n'
  || 'public.paper_attachments|trg_paper_attachments_refund_storage_quota|public.refund_storage_quota|O|9' || E'\n'
  || 'public.papers|papers_clear_author_identity_links_on_authors_change|public.clear_author_identity_links_on_authors_change|O|17',
  'bindings: the five trigger bindings and the Storage-policy binding of the 35 are unchanged');

SELECT * FROM finish();
ROLLBACK;
