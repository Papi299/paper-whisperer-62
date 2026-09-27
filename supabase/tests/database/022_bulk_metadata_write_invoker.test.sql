-- DB-BULK-METADATA-WRITE-INVOKER-001 suite 022: the two caller-owned bulk paper
-- metadata writes run as SECURITY INVOKER, under the caller's table grants and
-- RLS.
--
-- Migration 20260927071803_convert_bulk_metadata_writes_security_invoker
-- changed exactly one attribute — prosecdef true → false — on:
--
--   bulk_update_keywords(jsonb)
--   bulk_update_study_types(jsonb)
--
-- Each body is one UPDATE of `papers` FROM jsonb_to_recordset(updates), scoped
-- by `papers.user_id = auth.uid()`. After the migration, `authenticated`'s
-- SELECT and UPDATE grants on `papers` and the caller-owned RLS SELECT and
-- UPDATE policies are the PRIMARY database boundary of both; the body predicate
-- stays as defense-in-depth. This suite owns that change end to end:
--
--   1. posture — one overload, owner, security mode, the C50 search_path
--      `public, pg_temp`, language, volatility, parallel mode, result,
--      arguments, body digest, stored ACL and effective EXECUTE; and the
--      boundary they rely on: papers' owner, RLS/FORCE RLS and grants, its four
--      policies exactly, an RLS-subject `authenticated`, and its two named
--      triggers and their functions;
--   2. anon and service_role are refused at the function ACL;
--   3. own row: the target column changes, updated_at becomes now(), every
--      other column is untouched, and the generated search_vector follows;
--   4/5. a foreign id is a silent no-op, alone or mixed with an own id;
--   6. an unknown id, an empty array, SQL NULL and missing claims are no-ops;
--   7. malformed input fails with a stable SQLSTATE and applies nothing;
--   8. duplicate ids: no error, no cross-user write. WHICH duplicate wins is
--      deliberately NOT asserted — PostgreSQL does not define it for
--      UPDATE ... FROM with several matching source rows;
--   9. the body still carries its ownership predicate and `updated_at = now()`;
--  10. RLS is live: a RESTRICTIVE deny policy turns the caller's own update into
--      a silent no-op (a DEFINER owner, with BYPASSRLS, would ignore it);
--  11. RLS IS THE PRIMARY BOUNDARY: controlled copies of both bodies with the
--      ownership predicate removed still cannot touch another account's row,
--      while either policy alone still blocks it; opening BOTH the SELECT and
--      the UPDATE policy lets the foreign write through (negative control), and
--      so does the same predicate-free body as SECURITY DEFINER — the posture
--      the migration left;
--  12. THE GRANTS ARE LIVE: revoking the caller's UPDATE, or SELECT, on papers
--      makes both fail with "permission denied for table papers"; the same call
--      as SECURITY DEFINER would not;
--  13. the generated-column dependency: every function papers.search_vector
--      calls is executable by the caller, and on this replay they are the
--      reviewed wrapper shape; revoking the jsonb wrapper's EXECUTE breaks the
--      INVOKER call exactly as it breaks a direct browser UPDATE;
--  14. neither write fires the author-link invalidation trigger, while a direct
--      authors edit still does (positive control).
--
-- Every probe policy, revoke, controlled copy and mode flip is transaction-local
-- and undone by the ROLLBACK. Deterministic UUIDs; explicit fixtures; no
-- TODO/SKIP; no remote calls; no Production data; no real credentials. pgTAP is
-- created inside the transaction and rolled back with it.

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SET LOCAL search_path TO extensions, public, pg_temp;

-- ── Helpers ─────────────────────────────────────────────────────────────────
-- Run p_sql as p_role with the given JWT claims; return '<SQLSTATE> <message>'
-- ('00000 ' on success). An EXECUTE refusal, a table-privilege refusal and an
-- RLS refusal can share SQLSTATE 42501; the message says which layer answered.
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

CREATE FUNCTION pg_temp.claims_a() RETURNS text LANGUAGE sql AS
  $$ SELECT '{"sub":"22a00000-0000-0000-0000-00000000000a","role":"authenticated"}' $$;

-- One call of each function with a JSON payload, as caller A.
CREATE FUNCTION pg_temp.as_a(p_fn text, p_payload text) RETURNS text LANGUAGE sql AS $hlp$
  SELECT pg_temp.err_as('authenticated', pg_temp.claims_a(),
                        format('SELECT public.%I(%L::jsonb)', p_fn, p_payload))
$hlp$;

-- Fixture rows as the table owner (RLS bypassed), whole, as jsonb.
CREATE TEMP TABLE c52_snap (label text, id uuid, row_j jsonb, PRIMARY KEY (label, id));
CREATE TEMP VIEW c52_rows AS
  SELECT p.id, to_jsonb(p.*) AS row_j FROM public.papers p
   WHERE p.id IN ('22a00000-0000-0000-0000-0000000000a1', '22a00000-0000-0000-0000-0000000000a2',
                  '22b00000-0000-0000-0000-0000000000b1');

-- True when the row equals its snapshot, ignoring p_except columns.
CREATE FUNCTION pg_temp.same(p_label text, p_id uuid, p_except text[] DEFAULT '{}') RETURNS boolean LANGUAGE sql AS $hlp$
  SELECT coalesce((SELECT (s.row_j - p_except) = (r.row_j - p_except)
                     FROM c52_snap s JOIN c52_rows r ON r.id = s.id
                    WHERE s.label = p_label AND s.id = p_id), false)
$hlp$;

-- True when all three fixture rows equal their snapshot.
CREATE FUNCTION pg_temp.all_same(p_label text) RETURNS boolean LANGUAGE sql AS $hlp$
  SELECT (SELECT count(*) FROM c52_snap WHERE label = p_label) = 3
     AND NOT EXISTS (SELECT 1 FROM c52_snap s LEFT JOIN c52_rows r ON r.id = s.id
                      WHERE s.label = p_label AND r.row_j IS DISTINCT FROM s.row_j)
$hlp$;

CREATE FUNCTION pg_temp.kw(p_id uuid) RETURNS text LANGUAGE sql AS
  $$ SELECT keywords::text FROM public.papers WHERE id = p_id $$;
CREATE FUNCTION pg_temp.st(p_id uuid) RETURNS text LANGUAGE sql AS
  $$ SELECT study_type FROM public.papers WHERE id = p_id $$;

-- ── Fixtures (as the table owner; RLS bypassed) ──────────────────────────────
-- A owns A1 and A2; B owns B1. Every row starts with an old updated_at, so a
-- write is visible as updated_at = now() (the transaction's start time), and
-- A1 carries one author-identity link for section 14.
INSERT INTO auth.users (id, email) VALUES
  ('22a00000-0000-0000-0000-00000000000a', 'c52-A@paperlume.test'),
  ('22b00000-0000-0000-0000-00000000000b', 'c52-B@paperlume.test');

INSERT INTO public.papers (id, user_id, title, abstract, authors, keywords, study_type, year, updated_at) VALUES
  ('22a00000-0000-0000-0000-0000000000a1', '22a00000-0000-0000-0000-00000000000a',
   'Zqcfiftytwo paper A1', 'A1 abstract', '["Zqcfiftytwo Author"]'::jsonb, '["zqcoldkeyword"]'::jsonb,
   'Cohort', 2021, '2020-01-01 00:00:00+00'),
  ('22a00000-0000-0000-0000-0000000000a2', '22a00000-0000-0000-0000-00000000000a',
   'Zqcfiftytwo paper A2', NULL, '[]'::jsonb, '["zqcatwokeyword"]'::jsonb,
   'RCT', 2022, '2020-01-01 00:00:00+00'),
  ('22b00000-0000-0000-0000-0000000000b1', '22b00000-0000-0000-0000-00000000000b',
   'Zqcfiftytwo foreign paper B1', 'B1 abstract', '["Foreign Author"]'::jsonb, '["zqcforeignkeyword"]'::jsonb,
   'Foreign', 2020, '2020-01-01 00:00:00+00');

INSERT INTO public.author_identities (id, user_id, preferred_name) VALUES
  ('22a00000-0000-0000-0000-0000000000e1', '22a00000-0000-0000-0000-00000000000a', 'Zqcfiftytwo Person');
INSERT INTO public.author_identity_links (user_id, identity_id, paper_id, author_index, author_name_snapshot, resolution_basis) VALUES
  ('22a00000-0000-0000-0000-00000000000a', '22a00000-0000-0000-0000-0000000000e1',
   '22a00000-0000-0000-0000-0000000000a1', 0, 'Zqcfiftytwo Author', 'manual');

SELECT plan(91);

-- ══ 1. Posture ══════════════════════════════════════════════════════════════
SELECT is(
  (SELECT (SELECT count(*) FROM pg_proc p2 WHERE p2.pronamespace = p.pronamespace AND p2.proname = p.proname) || ' overload'
          || ' | ' || pg_get_userbyid(p.proowner)
          || ' | ' || CASE WHEN p.prosecdef THEN 'SECURITY DEFINER' ELSE 'SECURITY INVOKER' END
          || ' | ' || coalesce(p.proconfig::text, '<no config>')
          || ' | ' || l.lanname || ' ' || p.provolatile::text || p.proparallel::text
          || ' strict ' || p.proisstrict::text
          || ' | ' || pg_get_function_result(p.oid) || ' (' || pg_get_function_arguments(p.oid) || ')'
          || ' | body ' || md5(p.prosrc)
          || ' | acl ' || coalesce(p.proacl::text, 'NULL')
          || ' | exec ' || (SELECT coalesce(string_agg(r, ',' ORDER BY r COLLATE "C"), '<nobody>')
                              FROM unnest(ARRAY['PUBLIC','anon','authenticated','service_role']) r
                             WHERE CASE WHEN r = 'PUBLIC'
                                        THEN EXISTS (SELECT 1 FROM aclexplode(coalesce(p.proacl, acldefault('f'::"char", p.proowner))) a
                                                      WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE')
                                        ELSE has_function_privilege(r, p.oid, 'EXECUTE') END)
     FROM pg_proc p JOIN pg_language l ON l.oid = p.prolang WHERE p.oid = to_regprocedure(e.sig)),
  '1 overload | postgres | SECURITY INVOKER | {"search_path=public, pg_temp"} | plpgsql vu strict false'
    || ' | void (updates jsonb) | body ' || e.body_md5
    || ' | acl {postgres=X/postgres,authenticated=X/postgres} | exec authenticated',
  'posture: ' || e.sig)
FROM (VALUES
  ('public.bulk_update_keywords(jsonb)',    'c002702d05a14e7febd00feaf1e97786'),
  ('public.bulk_update_study_types(jsonb)', '6086d69c0915c8a7c67089556b40041b')
) AS e(sig, body_md5);

-- papers: owner, RLS enabled and forced, authenticated's grant (direct and
-- effective — SELECT and UPDATE are the two these functions need; DELETE and
-- TRUNCATE are absent) and anon's effective privileges.
SELECT is(
  (SELECT pg_get_userbyid(c.relowner) || ' | rls ' || c.relrowsecurity::text || ' | force ' || c.relforcerowsecurity::text
          || ' | authenticated direct ' ||
          (SELECT coalesce(string_agg(a.privilege_type, ',' ORDER BY a.privilege_type COLLATE "C"), '')
             FROM aclexplode(coalesce(c.relacl, acldefault('r'::"char", c.relowner))) a
            WHERE a.grantee = 'authenticated'::regrole)
          || ' | authenticated effective ' ||
          (SELECT coalesce(string_agg(pr, ',' ORDER BY pr COLLATE "C"), '')
             FROM unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER','MAINTAIN']) pr
            WHERE has_table_privilege('authenticated', c.oid, pr))
          || ' | anon effective ' ||
          (SELECT coalesce(string_agg(pr, ',' ORDER BY pr COLLATE "C"), '<none>')
             FROM unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER','MAINTAIN']) pr
            WHERE has_table_privilege('anon', c.oid, pr))
     FROM pg_class c WHERE c.oid = 'public.papers'::regclass),
  'postgres | rls true | force true | authenticated direct INSERT,SELECT,UPDATE | authenticated effective INSERT,SELECT,UPDATE | anon effective <none>',
  'boundary: papers owner, RLS, FORCE RLS and client grants');

-- Every policy on papers, exactly. The UPDATE policy has no WITH CHECK, so its
-- USING expression also checks the new row.
SELECT is(
  (SELECT string_agg(pol.polname || '|' || pol.polcmd::text || '|' || pol.polpermissive::text || '|'
                     || (SELECT string_agg(CASE WHEN r = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(r) END, ',' ORDER BY r)
                           FROM unnest(pol.polroles) r) || '|'
                     || coalesce(pg_get_expr(pol.polqual, pol.polrelid), '<null>') || '|'
                     || coalesce(pg_get_expr(pol.polwithcheck, pol.polrelid), '<null>'),
                     E'\n' ORDER BY pol.polname COLLATE "C")
     FROM pg_policy pol WHERE pol.polrelid = 'public.papers'::regclass),
  'Users can create their own papers|a|true|PUBLIC|<null>|(auth.uid() = user_id)' || E'\n' ||
  'Users can delete their own papers|d|true|PUBLIC|(auth.uid() = user_id)|<null>' || E'\n' ||
  'Users can update their own papers|w|true|PUBLIC|(auth.uid() = user_id)|<null>' || E'\n' ||
  'Users can view their own papers|r|true|PUBLIC|(auth.uid() = user_id)|<null>',
  'boundary: papers RLS policies are exactly the reviewed caller-owned four');

SELECT ok(
  (SELECT NOT rolsuper AND NOT rolbypassrls FROM pg_roles WHERE rolname = 'authenticated'),
  'boundary: authenticated is neither SUPERUSER nor BYPASSRLS');

-- The two named triggers now fire as the caller: the BEFORE UPDATE updated_at
-- trigger on every row, and the author-link invalidation only AFTER UPDATE OF
-- authors, WHEN authors changed.
SELECT is(
  (SELECT string_agg(t.tgenabled::text || '|' || pg_get_triggerdef(t.oid), E'\n' ORDER BY t.tgname COLLATE "C")
     FROM pg_trigger t WHERE t.tgrelid = 'public.papers'::regclass AND NOT t.tgisinternal),
  'O|CREATE TRIGGER papers_clear_author_identity_links_on_authors_change AFTER UPDATE OF authors ON public.papers '
    || 'FOR EACH ROW WHEN ((new.authors IS DISTINCT FROM old.authors)) EXECUTE FUNCTION clear_author_identity_links_on_authors_change()'
  || E'\n' || 'O|CREATE TRIGGER trg_papers_updated_at BEFORE UPDATE ON public.papers FOR EACH ROW EXECUTE FUNCTION set_updated_at()',
  'boundary: papers has exactly the reviewed two named triggers, enabled');

SELECT is(
  (SELECT string_agg(p.proname || '|' || CASE WHEN p.prosecdef THEN 'DEFINER' ELSE 'INVOKER' END
                     || '|' || coalesce(p.proconfig::text, '<none>') || '|' || md5(p.prosrc), E'\n' ORDER BY p.proname COLLATE "C")
     FROM pg_proc p
    WHERE p.oid IN ('public.set_updated_at()'::regprocedure,
                    'public.clear_author_identity_links_on_authors_change()'::regprocedure)),
  'clear_author_identity_links_on_authors_change|DEFINER|{search_path=public}|a14c92dbd8485afff4d1600684b37565'
  || E'\n' || 'set_updated_at|INVOKER|{search_path=pg_catalog}|301a884953d37769916294bb60562e05',
  'boundary: the two trigger functions keep their reviewed mode, path and body');

-- ══ 2. anon and service_role are refused at the function ACL ════════════════
SELECT is(pg_temp.err_as(r, '', format('SELECT public.%I(''[]''::jsonb)', f)),
  '42501 permission denied for function ' || f,
  r || ' refused at the function ACL: ' || f)
FROM unnest(ARRAY['anon', 'service_role']) r, unnest(ARRAY['bulk_update_keywords', 'bulk_update_study_types']) f
ORDER BY r, f;

-- ══ 3. Own row ══════════════════════════════════════════════════════════════
INSERT INTO c52_snap SELECT 'own', id, row_j FROM c52_rows;

SELECT is(pg_temp.as_a('bulk_update_keywords', '[{"id":"22a00000-0000-0000-0000-0000000000a1","keywords":["zqcnewkeyword"]}]'),
  '00000 ', 'own row: bulk_update_keywords on the caller''s paper succeeds');
SELECT is(pg_temp.kw('22a00000-0000-0000-0000-0000000000a1'), '["zqcnewkeyword"]',
  'own row: keywords replaced');
SELECT is((SELECT updated_at FROM public.papers WHERE id = '22a00000-0000-0000-0000-0000000000a1'), now(),
  'own row: updated_at set to now()');
SELECT ok(pg_temp.same('own', '22a00000-0000-0000-0000-0000000000a1', ARRAY['keywords', 'updated_at', 'search_vector']),
  'own row: every other column of the paper is unchanged');
SELECT ok((SELECT search_vector @@ plainto_tsquery('english', 'zqcnewkeyword')
              AND NOT search_vector @@ plainto_tsquery('english', 'zqcoldkeyword')
             FROM public.papers WHERE id = '22a00000-0000-0000-0000-0000000000a1'),
  'own row: the generated search_vector was recomputed from the new keywords');

SELECT is(pg_temp.as_a('bulk_update_study_types', '[{"id":"22a00000-0000-0000-0000-0000000000a2","study_type":"Meta-analysis"}]'),
  '00000 ', 'own row: bulk_update_study_types on the caller''s paper succeeds');
SELECT is(pg_temp.st('22a00000-0000-0000-0000-0000000000a2'), 'Meta-analysis',
  'own row: study_type replaced');
SELECT is((SELECT updated_at FROM public.papers WHERE id = '22a00000-0000-0000-0000-0000000000a2'), now(),
  'own row: updated_at set to now()');
-- search_vector is NOT excluded: study_type is not one of its inputs, so the
-- recomputation must reproduce it exactly.
SELECT ok(pg_temp.same('own', '22a00000-0000-0000-0000-0000000000a2', ARRAY['study_type', 'updated_at']),
  'own row: every other column, search_vector included, is unchanged');

SELECT ok(pg_temp.same('own', '22b00000-0000-0000-0000-0000000000b1'),
  'own row: the other account''s paper was not touched by either call');

-- ══ 4. Foreign row: a silent no-op ══════════════════════════════════════════
INSERT INTO c52_snap SELECT 'foreign', id, row_j FROM c52_rows;

SELECT is(pg_temp.as_a('bulk_update_keywords', '[{"id":"22b00000-0000-0000-0000-0000000000b1","keywords":["zqchacked"]}]'),
  '00000 ', 'foreign row: bulk_update_keywords with another account''s id returns normally');
SELECT is(pg_temp.as_a('bulk_update_study_types', '[{"id":"22b00000-0000-0000-0000-0000000000b1","study_type":"hacked"}]'),
  '00000 ', 'foreign row: bulk_update_study_types with another account''s id returns normally');
SELECT ok(pg_temp.all_same('foreign'),
  'foreign row: the other account''s paper — and every fixture row — is byte-for-byte unchanged');

-- ══ 5. Mixed payload: own ids update, foreign ids do not ════════════════════
INSERT INTO c52_snap SELECT 'mixed', id, row_j FROM c52_rows;

SELECT is(pg_temp.as_a('bulk_update_keywords',
    '[{"id":"22a00000-0000-0000-0000-0000000000a2","keywords":["zqcmixedkeyword"]},'
    '{"id":"22b00000-0000-0000-0000-0000000000b1","keywords":["zqchacked"]}]'),
  '00000 ', 'mixed: bulk_update_keywords with an own and a foreign id returns normally');
SELECT is(pg_temp.kw('22a00000-0000-0000-0000-0000000000a2'), '["zqcmixedkeyword"]',
  'mixed: the own paper''s keywords were updated');
SELECT is(pg_temp.as_a('bulk_update_study_types',
    '[{"id":"22b00000-0000-0000-0000-0000000000b1","study_type":"hacked"},'
    '{"id":"22a00000-0000-0000-0000-0000000000a1","study_type":"Case report"}]'),
  '00000 ', 'mixed: bulk_update_study_types with a foreign and an own id returns normally');
SELECT is(pg_temp.st('22a00000-0000-0000-0000-0000000000a1'), 'Case report',
  'mixed: the own paper''s study_type was updated');
SELECT ok(pg_temp.same('mixed', '22b00000-0000-0000-0000-0000000000b1'),
  'mixed: the foreign paper is byte-for-byte unchanged');

-- ══ 6. Unknown id, empty array, SQL NULL, missing claims: no-ops ════════════
INSERT INTO c52_snap SELECT 'noop', id, row_j FROM c52_rows;

SELECT is(pg_temp.as_a(f, '[{"id":"22c00000-0000-0000-0000-00000000dead","keywords":["x"],"study_type":"x"}]'),
  '00000 ', 'no-op: an id that matches no paper returns normally: ' || f)
FROM unnest(ARRAY['bulk_update_keywords', 'bulk_update_study_types']) f ORDER BY f;
SELECT is(pg_temp.as_a(f, '[]'), '00000 ', 'no-op: an empty array returns normally: ' || f)
FROM unnest(ARRAY['bulk_update_keywords', 'bulk_update_study_types']) f ORDER BY f;
SELECT is(pg_temp.err_as('authenticated', pg_temp.claims_a(), format('SELECT public.%I(NULL::jsonb)', f)),
  '00000 ', 'no-op: a SQL NULL payload returns normally (the function is not strict): ' || f)
FROM unnest(ARRAY['bulk_update_keywords', 'bulk_update_study_types']) f ORDER BY f;
-- No claims: auth.uid() is NULL, so neither the body predicate nor the RLS
-- policies match the caller's own paper.
SELECT is(pg_temp.err_as('authenticated', '',
    format('SELECT public.%I(%L::jsonb)', f, '[{"id":"22a00000-0000-0000-0000-0000000000a1","keywords":["x"],"study_type":"x"}]')),
  '00000 ', 'no-op: an authenticated call without claims returns normally: ' || f)
FROM unnest(ARRAY['bulk_update_keywords', 'bulk_update_study_types']) f ORDER BY f;
SELECT ok(pg_temp.all_same('noop'),
  'no-op: after all eight calls every fixture row is byte-for-byte unchanged');

-- ══ 7. Malformed input: a stable SQLSTATE, nothing applied ══════════════════
-- Only the SQLSTATE is pinned; PostgreSQL's message wording is not a contract.
INSERT INTO c52_snap SELECT 'malformed', id, row_j FROM c52_rows;

SELECT is(left(pg_temp.as_a(f, v.payload), 5), v.sqlstate,
  'malformed: ' || v.what || ' → ' || v.sqlstate || ': ' || f)
FROM unnest(ARRAY['bulk_update_keywords', 'bulk_update_study_types']) f,
     (VALUES
       ('a JSON object instead of an array', '{"id":"22a00000-0000-0000-0000-0000000000a1"}', '22023'),
       ('an array of non-objects',           '[1, 2]',                                        '22023'),
       ('an invalid uuid after a valid own row',
        '[{"id":"22a00000-0000-0000-0000-0000000000a1","keywords":["zqcpartial"],"study_type":"partial"},{"id":"not-a-uuid"}]',
        '22P02')
     ) AS v(what, payload, sqlstate)
ORDER BY f, v.what;
SELECT ok(pg_temp.all_same('malformed'),
  'malformed: no call applied anything — not even the valid own row before the invalid id');

-- ══ 8. Duplicate ids: no error and no cross-user write ══════════════════════
-- PostgreSQL does not define which of several matching source rows an
-- UPDATE ... FROM applies, so only "one of the supplied values" is asserted.
INSERT INTO c52_snap SELECT 'dup', id, row_j FROM c52_rows;

SELECT is(pg_temp.as_a('bulk_update_keywords',
    '[{"id":"22a00000-0000-0000-0000-0000000000a1","keywords":["zqcdupx"]},'
    '{"id":"22a00000-0000-0000-0000-0000000000a1","keywords":["zqcdupy"]}]'),
  '00000 ', 'duplicates: bulk_update_keywords with a repeated own id returns normally');
SELECT ok(pg_temp.kw('22a00000-0000-0000-0000-0000000000a1') IN ('["zqcdupx"]', '["zqcdupy"]'),
  'duplicates: the own paper holds one of the supplied keyword lists');
SELECT is(pg_temp.as_a('bulk_update_study_types',
    '[{"id":"22a00000-0000-0000-0000-0000000000a2","study_type":"Dup X"},'
    '{"id":"22a00000-0000-0000-0000-0000000000a2","study_type":"Dup Y"}]'),
  '00000 ', 'duplicates: bulk_update_study_types with a repeated own id returns normally');
SELECT ok(pg_temp.st('22a00000-0000-0000-0000-0000000000a2') IN ('Dup X', 'Dup Y'),
  'duplicates: the own paper holds one of the supplied study types');
SELECT is(pg_temp.as_a(f,
    '[{"id":"22b00000-0000-0000-0000-0000000000b1","keywords":["zqchacked"],"study_type":"hacked"},'
    '{"id":"22b00000-0000-0000-0000-0000000000b1","keywords":["zqchacked2"],"study_type":"hacked2"}]'),
  '00000 ', 'duplicates: a repeated foreign id returns normally: ' || f)
FROM unnest(ARRAY['bulk_update_keywords', 'bulk_update_study_types']) f ORDER BY f;
SELECT ok(pg_temp.same('dup', '22b00000-0000-0000-0000-0000000000b1'),
  'duplicates: the foreign paper is byte-for-byte unchanged');

-- ══ 9. The body keeps its ownership predicate and updated_at ════════════════
-- The digests in section 1 pin every byte; these say WHY in words.
SELECT ok(position('papers.user_id = auth.uid()' IN p.prosrc) > 0
          AND position('updated_at = now()' IN p.prosrc) > 0,
  'defense-in-depth retained: ' || p.oid::regprocedure::text || ' still scopes to auth.uid() and sets updated_at = now()')
FROM pg_proc p
WHERE p.oid IN ('public.bulk_update_keywords(jsonb)'::regprocedure, 'public.bulk_update_study_types(jsonb)'::regprocedure)
ORDER BY p.proname;

-- ══ 10. RLS is live inside the functions ════════════════════════════════════
-- A transaction-local RESTRICTIVE policy that admits no UPDATE to
-- `authenticated`. An INVOKER function runs as `authenticated`, so even the
-- caller's own paper is silently skipped. A DEFINER function runs as
-- `postgres`, which has BYPASSRLS, and would update it — so these fail if
-- either function is reverted.
INSERT INTO c52_snap SELECT 'rls_live', id, row_j FROM c52_rows;
CREATE POLICY zz_022_rls_probe_deny ON public.papers AS RESTRICTIVE FOR UPDATE TO authenticated USING (false);

SELECT is(pg_temp.as_a('bulk_update_keywords', '[{"id":"22a00000-0000-0000-0000-0000000000a1","keywords":["zqcdenied"]}]'),
  '00000 ', 'RLS is live: under the deny probe bulk_update_keywords returns normally');
SELECT is(pg_temp.as_a('bulk_update_study_types', '[{"id":"22a00000-0000-0000-0000-0000000000a1","study_type":"denied"}]'),
  '00000 ', 'RLS is live: under the deny probe bulk_update_study_types returns normally');
SELECT ok(pg_temp.all_same('rls_live'),
  'RLS is live: the deny probe kept the caller''s own paper unchanged (a DEFINER owner would bypass it)');

DROP POLICY zz_022_rls_probe_deny ON public.papers;

-- ══ 11. RLS, not the body predicate, is the primary boundary ════════════════
-- Controlled copies of both bodies with the ownership predicate removed —
-- byte-for-byte the real body otherwise — created as SECURITY INVOKER with the
-- same path and the same authenticated-only EXECUTE. Transaction-local.
DO $mk$
DECLARE r record; v_body text;
BEGIN
  FOR r IN SELECT * FROM (VALUES ('bulk_update_keywords', 'zz_022_keywords_nopred'),
                                 ('bulk_update_study_types', 'zz_022_study_types_nopred')) AS v(src, dst) LOOP
    SELECT replace(prosrc, E'\n    AND papers.user_id = auth.uid()', '') INTO v_body
      FROM pg_proc WHERE oid = to_regprocedure('public.' || r.src || '(jsonb)');
    EXECUTE format('CREATE FUNCTION public.%I(updates jsonb) RETURNS void LANGUAGE plpgsql '
                   'SECURITY INVOKER SET search_path = public, pg_temp AS %L', r.dst, v_body);
    EXECUTE format('REVOKE ALL ON FUNCTION public.%I(jsonb) FROM PUBLIC', r.dst);
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.%I(jsonb) TO authenticated', r.dst);
  END LOOP;
END
$mk$;

SELECT is(
  (SELECT CASE WHEN c.prosecdef THEN 'DEFINER' ELSE 'INVOKER' END || '|' || position('auth.uid()' IN c.prosrc)::text
          || '|' || (replace(o.prosrc, E'\n    AND papers.user_id = auth.uid()', '') = c.prosrc)::text
     FROM pg_proc c, pg_proc o
    WHERE c.oid = to_regprocedure('public.' || v.dst || '(jsonb)') AND o.oid = to_regprocedure('public.' || v.src || '(jsonb)')),
  'INVOKER|0|true',
  'control: ' || v.dst || ' is ' || v.src || '''s exact body minus the ownership predicate, as SECURITY INVOKER')
FROM (VALUES ('bulk_update_keywords', 'zz_022_keywords_nopred'),
             ('bulk_update_study_types', 'zz_022_study_types_nopred')) AS v(src, dst)
ORDER BY v.src;

-- 11a. Predicate removed, RLS intact: the foreign row is still out of reach.
INSERT INTO c52_snap SELECT 'nopred', id, row_j FROM c52_rows;
SELECT is(pg_temp.as_a('zz_022_keywords_nopred', '[{"id":"22b00000-0000-0000-0000-0000000000b1","keywords":["zqchacked"]}]'),
  '00000 ', 'no predicate, RLS intact: the keywords copy returns normally for a foreign id');
SELECT is(pg_temp.as_a('zz_022_study_types_nopred', '[{"id":"22b00000-0000-0000-0000-0000000000b1","study_type":"hacked"}]'),
  '00000 ', 'no predicate, RLS intact: the study_types copy returns normally for a foreign id');
SELECT ok(pg_temp.same('nopred', '22b00000-0000-0000-0000-0000000000b1'),
  'no predicate, RLS intact: RLS alone kept the foreign paper unchanged');
SELECT is(pg_temp.as_a('zz_022_keywords_nopred', '[{"id":"22a00000-0000-0000-0000-0000000000a2","keywords":["zqcnopredown"]}]')
          || pg_temp.kw('22a00000-0000-0000-0000-0000000000a2'),
  '00000 ["zqcnopredown"]', 'no predicate, RLS intact: the copy still updates the caller''s own paper');

-- 11b. Only the UPDATE policy opened: the SELECT policy still hides the row
-- from the UPDATE's WHERE clause.
CREATE POLICY zz_022_open_update ON public.papers AS PERMISSIVE FOR UPDATE TO authenticated USING (true) WITH CHECK (true);
SELECT is(pg_temp.as_a('zz_022_keywords_nopred', '[{"id":"22b00000-0000-0000-0000-0000000000b1","keywords":["zqchacked"]}]')
          || pg_temp.as_a('zz_022_study_types_nopred', '[{"id":"22b00000-0000-0000-0000-0000000000b1","study_type":"hacked"}]'),
  '00000 00000 ', 'UPDATE policy opened: both copies return normally for a foreign id');
SELECT ok(pg_temp.same('nopred', '22b00000-0000-0000-0000-0000000000b1'),
  'UPDATE policy opened: the caller-owned SELECT policy alone still blocks the foreign write');
DROP POLICY zz_022_open_update ON public.papers;

-- 11c. Only the SELECT policy opened: the UPDATE policy still refuses the row.
CREATE POLICY zz_022_open_select ON public.papers AS PERMISSIVE FOR SELECT TO authenticated USING (true);
SELECT is(pg_temp.as_a('zz_022_keywords_nopred', '[{"id":"22b00000-0000-0000-0000-0000000000b1","keywords":["zqchacked"]}]')
          || pg_temp.as_a('zz_022_study_types_nopred', '[{"id":"22b00000-0000-0000-0000-0000000000b1","study_type":"hacked"}]'),
  '00000 00000 ', 'SELECT policy opened: both copies return normally for a foreign id');
SELECT ok(pg_temp.same('nopred', '22b00000-0000-0000-0000-0000000000b1'),
  'SELECT policy opened: the caller-owned UPDATE policy alone still blocks the foreign write');

-- 11d. NEGATIVE CONTROL — both relevant RLS boundaries opened: now, and only
-- now, the predicate-free INVOKER body writes the foreign row. So it was RLS
-- that held the boundary in 11a–11c.
CREATE POLICY zz_022_open_update ON public.papers AS PERMISSIVE FOR UPDATE TO authenticated USING (true) WITH CHECK (true);
SELECT is(pg_temp.as_a('zz_022_keywords_nopred', '[{"id":"22b00000-0000-0000-0000-0000000000b1","keywords":["zqcopened"]}]')
          || pg_temp.kw('22b00000-0000-0000-0000-0000000000b1'),
  '00000 ["zqcopened"]', 'negative control: with both policies opened the keywords copy writes the foreign paper');
SELECT is(pg_temp.as_a('zz_022_study_types_nopred', '[{"id":"22b00000-0000-0000-0000-0000000000b1","study_type":"opened"}]')
          || pg_temp.st('22b00000-0000-0000-0000-0000000000b1'),
  '00000 opened', 'negative control: with both policies opened the study_types copy writes the foreign paper');
DROP POLICY zz_022_open_update ON public.papers;
DROP POLICY zz_022_open_select ON public.papers;

-- 11e. The posture the migration left: with RLS back in place, the same
-- predicate-free body as SECURITY DEFINER runs as `postgres` (BYPASSRLS) and
-- writes the foreign row. Under DEFINER the body predicate was the ONLY
-- boundary; under INVOKER (11a) it is defense-in-depth.
ALTER FUNCTION public.zz_022_keywords_nopred(jsonb) SECURITY DEFINER;
ALTER FUNCTION public.zz_022_study_types_nopred(jsonb) SECURITY DEFINER;
SELECT is(pg_temp.as_a('zz_022_keywords_nopred', '[{"id":"22b00000-0000-0000-0000-0000000000b1","keywords":["zqcdefiner"]}]')
          || pg_temp.kw('22b00000-0000-0000-0000-0000000000b1'),
  '00000 ["zqcdefiner"]', 'DEFINER contrast: without its predicate the keywords body writes the foreign paper despite RLS');
SELECT is(pg_temp.as_a('zz_022_study_types_nopred', '[{"id":"22b00000-0000-0000-0000-0000000000b1","study_type":"definer"}]')
          || pg_temp.st('22b00000-0000-0000-0000-0000000000b1'),
  '00000 definer', 'DEFINER contrast: without its predicate the study_types body writes the foreign paper despite RLS');
DROP FUNCTION public.zz_022_keywords_nopred(jsonb);
DROP FUNCTION public.zz_022_study_types_nopred(jsonb);

-- ══ 12. The caller's table grants are live inside the functions ═════════════
-- Revoked inside this transaction only. An INVOKER function needs the CALLER's
-- UPDATE (for the SET list) and SELECT (for the WHERE clause); a DEFINER
-- function would use the owner's and keep succeeding.
REVOKE UPDATE ON public.papers FROM authenticated;
SELECT is(pg_temp.as_a(f, '[{"id":"22a00000-0000-0000-0000-0000000000a1","keywords":["zqcg"],"study_type":"g"}]'),
  '42501 permission denied for table papers',
  'grant is live: without the caller''s UPDATE on papers, ' || f || ' is refused')
FROM unnest(ARRAY['bulk_update_keywords', 'bulk_update_study_types']) f ORDER BY f;
ALTER FUNCTION public.bulk_update_keywords(jsonb) SECURITY DEFINER;
SELECT is(pg_temp.as_a('bulk_update_keywords', '[{"id":"22a00000-0000-0000-0000-0000000000a1","keywords":["zqcg"]}]'),
  '00000 ', 'DEFINER contrast: the same call as SECURITY DEFINER ignores the missing caller UPDATE');
ALTER FUNCTION public.bulk_update_keywords(jsonb) SECURITY INVOKER;
GRANT UPDATE ON public.papers TO authenticated;

REVOKE SELECT ON public.papers FROM authenticated;
SELECT is(pg_temp.as_a(f, '[{"id":"22a00000-0000-0000-0000-0000000000a1","keywords":["zqcg"],"study_type":"g"}]'),
  '42501 permission denied for table papers',
  'grant is live: without the caller''s SELECT on papers, ' || f || ' is refused')
FROM unnest(ARRAY['bulk_update_keywords', 'bulk_update_study_types']) f ORDER BY f;
ALTER FUNCTION public.bulk_update_study_types(jsonb) SECURITY DEFINER;
SELECT is(pg_temp.as_a('bulk_update_study_types', '[{"id":"22a00000-0000-0000-0000-0000000000a1","study_type":"g"}]'),
  '00000 ', 'DEFINER contrast: the same call as SECURITY DEFINER ignores the missing caller SELECT');
ALTER FUNCTION public.bulk_update_study_types(jsonb) SECURITY INVOKER;
GRANT SELECT ON public.papers TO authenticated;

SELECT is(pg_temp.as_a(f, '[{"id":"22a00000-0000-0000-0000-0000000000a1","keywords":["zqcrestored"],"study_type":"restored"}]'),
  '00000 ', 'grants restored: ' || f || ' succeeds again, as SECURITY INVOKER')
FROM unnest(ARRAY['bulk_update_keywords', 'bulk_update_study_types']) f ORDER BY f;
SELECT is(
  (SELECT string_agg(proname || '=' || prosecdef::text, ',' ORDER BY proname) FROM pg_proc
    WHERE oid IN ('public.bulk_update_keywords(jsonb)'::regprocedure, 'public.bulk_update_study_types(jsonb)'::regprocedure)),
  'bulk_update_keywords=false,bulk_update_study_types=false',
  'grants restored: both functions are back to SECURITY INVOKER after the contrasts');

-- ══ 13. The search_vector EXECUTE dependency ════════════════════════════════
-- papers has a BEFORE UPDATE row trigger, so every UPDATE recomputes the stored
-- search_vector, and PostgreSQL checks EXECUTE on each function its expression
-- calls as the current user — the caller, now. Read from the expression's node
-- tree, so it covers whatever the expression calls.
SELECT is(
  (SELECT coalesce(string_agg(f.oid::regprocedure::text, ', ' ORDER BY f.oid::regprocedure::text COLLATE "C"), '')
     FROM pg_attrdef d JOIN pg_attribute a ON a.attrelid = d.adrelid AND a.attnum = d.adnum,
          LATERAL (SELECT DISTINCT m[1]::oid AS fid
                     FROM regexp_matches(d.adbin::text, ':(?:funcid|opfuncid) ([0-9]+)', 'g') AS m) x
     JOIN pg_proc f ON f.oid = x.fid
    WHERE d.adrelid = 'public.papers'::regclass AND a.attname = 'search_vector'
      AND NOT has_function_privilege('authenticated', f.oid, 'EXECUTE')),
  '',
  'dependency: authenticated can EXECUTE every function papers.search_vector calls');
-- The reviewed clean-replay shape (DB-SEARCH-VECTOR-EXPRESSION-PARITY-001 keeps
-- hosted Production on inlined built-ins; not resolved here).
SELECT is(
  (SELECT string_agg(f.oid::regprocedure::text, ', ' ORDER BY f.oid::regprocedure::text COLLATE "C")
     FROM pg_attrdef d JOIN pg_attribute a ON a.attrelid = d.adrelid AND a.attnum = d.adnum,
          LATERAL (SELECT DISTINCT m[1]::oid AS fid
                     FROM regexp_matches(d.adbin::text, ':(?:funcid|opfuncid) ([0-9]+)', 'g') AS m) x
     JOIN pg_proc f ON f.oid = x.fid
    WHERE d.adrelid = 'public.papers'::regclass AND a.attname = 'search_vector'),
  'immutable_english_tsvector_jsonb(jsonb), immutable_english_tsvector_text(text), setweight(tsvector,"char"), tsvector_concat(tsvector,tsvector)',
  'dependency: on a clean replay search_vector calls the reviewed text and jsonb wrappers');

-- Take EXECUTE on the jsonb wrapper away from the caller (PUBLIC on a replay,
-- where the ACL is the default; authenticated too, for the explicit hosted
-- form). The INVOKER calls now fail on the wrapper — and so does a plain
-- browser UPDATE, which is why this is not a new dependency.
REVOKE EXECUTE ON FUNCTION public.immutable_english_tsvector_jsonb(jsonb) FROM PUBLIC, authenticated;
SELECT is(pg_temp.as_a(f, '[{"id":"22a00000-0000-0000-0000-0000000000a1","keywords":["zqcw"],"study_type":"w"}]'),
  '42501 permission denied for function immutable_english_tsvector_jsonb',
  'dependency: without EXECUTE on the jsonb wrapper, ' || f || ' is refused — even for a column the wrapper does not read')
FROM unnest(ARRAY['bulk_update_keywords', 'bulk_update_study_types']) f ORDER BY f;
SELECT is(pg_temp.err_as('authenticated', pg_temp.claims_a(),
    $q$UPDATE public.papers SET study_type = 'w' WHERE id = '22a00000-0000-0000-0000-0000000000a1'$q$),
  '42501 permission denied for function immutable_english_tsvector_jsonb',
  'dependency: a direct browser UPDATE carries the same dependency (not introduced by INVOKER)');
GRANT EXECUTE ON FUNCTION public.immutable_english_tsvector_jsonb(jsonb) TO PUBLIC;
SELECT is(pg_temp.as_a('bulk_update_study_types', '[{"id":"22a00000-0000-0000-0000-0000000000a1","study_type":"wrapper back"}]')
          || pg_temp.st('22a00000-0000-0000-0000-0000000000a1'),
  '00000 wrapper back', 'dependency: with EXECUTE restored the INVOKER call succeeds again');

-- ══ 14. The author-link invalidation trigger does not fire ══════════════════
-- A1 carries one author-identity link. Neither function writes `authors`, so
-- `AFTER UPDATE OF authors … WHEN (authors changed)` must stay silent.
SELECT is((SELECT count(*)::int FROM public.author_identity_links WHERE paper_id = '22a00000-0000-0000-0000-0000000000a1'),
  1, 'author links: A1 carries its one link before the writes');
SELECT is(pg_temp.as_a('bulk_update_keywords', '[{"id":"22a00000-0000-0000-0000-0000000000a1","keywords":["zqclinks"]}]')
          || pg_temp.as_a('bulk_update_study_types', '[{"id":"22a00000-0000-0000-0000-0000000000a1","study_type":"links"}]'),
  '00000 00000 ', 'author links: both writes on A1 succeed');
SELECT is((SELECT count(*)::int FROM public.author_identity_links WHERE paper_id = '22a00000-0000-0000-0000-0000000000a1'),
  1, 'author links: neither write fired the invalidation trigger — the link survives');
-- Positive control: an authors edit by the same caller does fire it.
SELECT is(pg_temp.err_as('authenticated', pg_temp.claims_a(),
    $q$UPDATE public.papers SET authors = '["Someone Else"]'::jsonb WHERE id = '22a00000-0000-0000-0000-0000000000a1'$q$),
  '00000 ', 'author links (control): the caller edits A1''s authors directly');
SELECT is((SELECT count(*)::int FROM public.author_identity_links WHERE paper_id = '22a00000-0000-0000-0000-0000000000a1'),
  0, 'author links (control): the authors edit fired the trigger and removed the link');

SELECT * FROM finish();
ROLLBACK;
