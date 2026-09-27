-- DB-BULK-METADATA-WRITE-INVOKER-001 — the two caller-owned bulk paper metadata
-- writes run as SECURITY INVOKER.
--
-- WHAT CHANGES
-- ─────────────────────────────────────────────────────────────────────────────
-- Exactly one catalog attribute on exactly two functions, `prosecdef`
-- true → false:
--
--   public.bulk_update_keywords(jsonb)
--   public.bulk_update_study_types(jsonb)
--
-- Nothing else moves: not a body, OID, signature, argument, return type,
-- language, volatility, parallel mode, cost, strictness, owner, EXECUTE ACL or
-- `search_path` of these two (both keep exactly `public, pg_temp`, from C50);
-- not another function; not a table grant, RLS flag, policy, trigger, generated
-- column, index or row. `authenticated` keeps EXECUTE on both, and `anon`,
-- `service_role` and PUBLIC still hold none. Section 3 proves every one of those
-- facts before COMMIT, comparing each function's whole `pg_proc` row except
-- `prosecdef` against its pre-change snapshot.
--
-- WHY
-- ─────────────────────────────────────────────────────────────────────────────
-- DB-BULK-METADATA-WRITE-INVOKER-AUDIT-001 classified both SAFE TO CONVERT TO
-- SECURITY INVOKER. Each body is one statement:
--
--   UPDATE papers SET <keywords | study_type> = u.<…>, updated_at = now()
--   FROM jsonb_to_recordset(updates) AS u(id uuid, <…>)
--   WHERE papers.id = u.id AND papers.user_id = auth.uid();
--
-- It writes only the caller's own `papers` rows — which `authenticated` may
-- already update on its own, through its table SELECT and UPDATE grants and the
-- caller-owned RLS SELECT and UPDATE policies. Running them as the owner
-- (`postgres`, which has BYPASSRLS) added authority nothing in their contract
-- needs, and made the body's `papers.user_id = auth.uid()` predicate the ONLY
-- database boundary between one account and another's library. As SECURITY
-- INVOKER the ordinary table grants and RLS become the primary boundary again;
-- the body predicate stays as defense-in-depth. This is the write-side sequel to
-- C49 (20260926152414), which did the same for five read RPCs.
--
-- WHY THIS IS SAFE — the boundary the two now rely on
-- ─────────────────────────────────────────────────────────────────────────────
-- A SECURITY INVOKER function runs with the CALLER's privileges. Through
-- PostgREST that is `authenticated`, which is neither superuser nor BYPASSRLS.
-- What the UPDATE needs, and what section 1 refuses to run without:
--
--   * SELECT and UPDATE on `public.papers` — table-level, so they cover the
--     columns the WHERE clause reads and the columns the SET list writes;
--   * the caller-owned policies
--       "Users can view their own papers"    FOR SELECT  USING (auth.uid() = user_id)
--       "Users can update their own papers"  FOR UPDATE  USING (auth.uid() = user_id)
--     both PERMISSIVE, for PUBLIC, and no RESTRICTIVE policy beside them. The
--     UPDATE policy has no WITH CHECK, so PostgreSQL applies its USING
--     expression to the new row as well; and because the WHERE clause reads the
--     table, the SELECT policy filters the target rows too. A foreign id is
--     therefore skipped silently, exactly as the body predicate skips it today;
--   * USAGE on schemas `public` and `auth`, and EXECUTE on `auth.uid()` — the
--     policies already need exactly these;
--   * EXECUTE on every function the `papers.search_vector` generation
--     expression calls. `papers` has a BEFORE UPDATE row trigger
--     (trg_papers_updated_at), so PostgreSQL recomputes that stored column on
--     EVERY update, and checks EXECUTE on its functions as the current user —
--     as it does for the built-ins `papers`' CHECK constraints and index
--     expressions call. This is not a new dependency: a direct browser UPDATE
--     of `papers` has always carried it.
--
-- Triggers: trg_papers_updated_at (BEFORE UPDATE → set_updated_at(), SECURITY
-- INVOKER, `search_path=pg_catalog`) now runs as the caller and only assigns
-- now(); papers_clear_author_identity_links_on_authors_change fires AFTER
-- UPDATE OF authors, WHEN authors changed, and neither function writes
-- `authors`. The internal foreign-key triggers run as the table owner in either
-- mode. Section 1 pins all twelve; none is modified.
--
-- Unchanged caller-visible contract: both still return void; an own id updates
-- the row and sets updated_at; a foreign or unknown id is a silent no-op; the
-- body is byte-for-byte the same, `updated_at = now()` included (redundant with
-- the trigger and deliberately not cleaned up here).
--
-- ONE REVIEWED ENVIRONMENT DIFFERENCE — accepted in exactly two shapes
-- ─────────────────────────────────────────────────────────────────────────────
-- The `papers.search_vector` generation expression
-- (DB-SEARCH-VECTOR-EXPRESSION-PARITY-001, tracked separately and NOT resolved
-- here). Rendered under this file's pinned `search_path`, exactly as C51
-- (20260927001229) pins it:
--   clean replay  dd69f099a274a9cdc0f174ae0883ddb6  — calls the text and jsonb
--                 wrappers, setweight and tsvector_concat
--   hosted        8ddd960b4f4b11dd7afd35485d01fd25  — calls to_tsvector,
--                 setweight and tsvector_concat
-- In both shapes every called function must be executable by `authenticated`
-- (the wrappers through PUBLIC, stored as a NULL ACL on a replay and explicitly
-- on hosted; the built-ins through their default PUBLIC EXECUTE). Any third
-- shape is refused. The column, its expression, the stored tsvectors and
-- idx_papers_search_vector are not modified.
--
-- NOT IN SCOPE — `public.safe_bulk_insert_papers(uuid,jsonb)`
-- ─────────────────────────────────────────────────────────────────────────────
-- The last of C49's three write candidates stays SECURITY DEFINER, untouched.
-- Its contract (a p_user_id identity guard, INSERT, per-row exception handling,
-- unique-violation handling, a duplicate lookup and a JSONB result) needs its
-- own audit: its broad exception handling could turn an RLS or permission
-- failure into a row-level result object under INVOKER. Section 3 proves its
-- row did not move.
--
-- CONCURRENCY AND ROLLOUT
-- ─────────────────────────────────────────────────────────────────────────────
-- Migration-only. No Edge Function calls these two, and no client or generated
-- type change is needed: the browser (src/hooks/papers/useBulkMutations.ts)
-- calls both with an authenticated session, for ids it read from its own
-- library, and uses only the error. A call already executing when this commits
-- finishes under the mode it started with; the next call resolves the function
-- afresh. For a legitimate caller both modes update the same rows, so no
-- ordering or lock barrier is needed.
--
-- The file is explicitly transactional (see 20260910212202 for why
-- `supabase db reset` requires that): the preconditions, the two ALTERs and the
-- verification commit together or not at all.
--
-- ROLLBACK
-- ─────────────────────────────────────────────────────────────────────────────
-- Forward-fix preferred. The reviewed restoration is exactly the two
--   ALTER FUNCTION ... SECURITY DEFINER;
-- statements, which returns them to their pre-change shape (bodies, ACL and
-- configuration were never touched). It re-adds authority, it does not remove a
-- boundary. See docs/deployment.md §6.13.
--
-- Durable decision: C52 (narrows the S1 inventory; S1 itself is unchanged).

BEGIN;

-- Every catalog value this file renders and compares (signatures, policy and
-- trigger text, the generation expression) is computed under one fixed path, so
-- the comparison reads the same under any migration runner. The ALTER
-- statements below are fully qualified and unaffected. Transaction-local:
-- COMMIT restores the runner's own setting.
SET LOCAL search_path = pg_catalog, pg_temp;


-- ═════════════════════════════════════════════════════════════════════════════
-- 0. Execution context, and this transaction's own write counters
-- ═════════════════════════════════════════════════════════════════════════════
--
-- Only a function's owner can change its security mode, and both are owned by
-- `postgres`. Section 3 proves this transaction wrote no row to any table in
-- `public`, `auth` or `storage`, from PostgreSQL's per-transaction statistics
-- (see 20260924193915 §0 for why the baseline is taken here).

DO $ctx$
BEGIN
  IF current_user <> 'postgres' THEN
    RAISE EXCEPTION
      'bulk_metadata_write_invoker: must run as postgres (current_user is %) — only the owner can change the security mode of the two bulk metadata RPCs',
      current_user;
  END IF;

  IF NOT current_setting('track_counts')::boolean THEN
    RAISE EXCEPTION 'bulk_metadata_write_invoker: track_counts is off, so the no-write self-check could not observe anything';
  END IF;

  IF current_setting('search_path') IS DISTINCT FROM 'pg_catalog, pg_temp' THEN
    RAISE EXCEPTION 'bulk_metadata_write_invoker: the pinned rendering path is not in effect (search_path is %) — this file must run as one transaction',
      current_setting('search_path');
  END IF;

  PERFORM set_config(
    'paperlume.bulk_metadata_write_invoker.xact_writes_at_start',
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
-- 91, latest 20260927001229 harden_pg_catalog_helper_pg_temp_last; 35 public
-- SECURITY DEFINER functions, 27 of them executable by authenticated; the two
-- targets at OIDs 46223 and 19998) and on a clean local replay. OIDs differ
-- between environments, so they are not pinned here; section 3 proves each
-- target keeps the OID it had when this file started. Nothing here repairs
-- unexpected state: any mismatch rolls the whole file back before a single
-- attribute changes. The snapshots at the end of this block are what section 3
-- compares against.

DO $pre$
DECLARE
  v_count     INTEGER;
  v_text      TEXT;
  v_want      TEXT;
  v_expr_md5  TEXT;
  v_expr_deps TEXT;
  v_expr_fns  TEXT;
  v_all       CONSTANT TEXT[] := ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER','MAINTAIN'];
  v_targets   CONSTANT TEXT[] := ARRAY[
    'public.bulk_update_keywords(jsonb)',
    'public.bulk_update_study_types(jsonb)'];
BEGIN
  -- ── 1a. Roles: the caller is an ordinary, RLS-subject role ──────────────────
  IF to_regrole('authenticated') IS NULL OR to_regrole('anon') IS NULL OR to_regrole('service_role') IS NULL THEN
    RAISE EXCEPTION 'bulk_metadata_write_invoker: one of the roles authenticated / anon / service_role does not exist';
  END IF;

  -- If `authenticated` could bypass RLS, SECURITY INVOKER would leave the body
  -- predicate as the only boundary again — the state this change removes.
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated' AND (rolsuper OR rolbypassrls)) THEN
    RAISE EXCEPTION 'bulk_metadata_write_invoker: authenticated is SUPERUSER or BYPASSRLS, so RLS could not be its boundary';
  END IF;

  -- What the caller needs to run the bodies and their RLS predicates at all.
  IF NOT has_schema_privilege('authenticated', 'public', 'USAGE')
     OR NOT has_schema_privilege('authenticated', 'auth', 'USAGE')
     OR NOT has_function_privilege('authenticated', 'auth.uid()', 'EXECUTE') THEN
    RAISE EXCEPTION 'bulk_metadata_write_invoker: authenticated lacks USAGE on public/auth or EXECUTE on auth.uid(), which the INVOKER bodies and their RLS predicates need';
  END IF;

  -- ── 1b. Both targets resolve, and their bodies are exactly the reviewed ones ─
  -- Checked on its own, before the full shape, so drift here says what it means.
  SELECT coalesce(string_agg(s, ', ' ORDER BY s), '') INTO v_text
  FROM unnest(v_targets) s WHERE to_regprocedure(s) IS NULL;
  IF v_text <> '' THEN
    RAISE EXCEPTION 'bulk_metadata_write_invoker: target function(s) missing: %', v_text;
  END IF;

  SELECT coalesce(string_agg(e.sig || ' (found ' || coalesce(md5(p.prosrc), '<missing>') || ', reviewed ' || e.body_md5 || ')',
                             ', ' ORDER BY e.sig), '') INTO v_text
  FROM (VALUES
    ('public.bulk_update_keywords(jsonb)',    'c002702d05a14e7febd00feaf1e97786'),
    ('public.bulk_update_study_types(jsonb)', '6086d69c0915c8a7c67089556b40041b')
  ) AS e(sig, body_md5)
  LEFT JOIN pg_proc p ON p.oid = to_regprocedure(e.sig)
  WHERE md5(p.prosrc) IS DISTINCT FROM e.body_md5;
  IF v_text <> '' THEN
    RAISE EXCEPTION 'bulk_metadata_write_invoker: STOP — a target body has drifted, so the audit''s SAFE classification no longer applies; re-audit before changing it: %', v_text;
  END IF;

  -- ── 1c. The two: exactly the reviewed shape ─────────────────────────────────
  -- One overload; owner postgres; SECURITY DEFINER; a plain plpgsql function;
  -- VOLATILE; PARALLEL UNSAFE; not strict, not leakproof, not SETOF; cost 100;
  -- `void` result; the one argument `updates jsonb`; `search_path=public,
  -- pg_temp` and no other GUC; the literal EXECUTE ACL; exactly
  -- `authenticated` among PUBLIC / anon / authenticated / service_role; and the
  -- body digest. One readable line per function, so a failure names the
  -- attribute that moved.
  WITH e(sig, body_md5) AS (VALUES
    ('public.bulk_update_keywords(jsonb)',    'c002702d05a14e7febd00feaf1e97786'),
    ('public.bulk_update_study_types(jsonb)', '6086d69c0915c8a7c67089556b40041b')
  ),
  cmp AS (
    SELECT e.sig,
           (SELECT format('overloads=%s owner=%s secdef=%s kind=%s lang=%s vol=%s parallel=%s strict=%s leakproof=%s setof=%s cost=%s result=%s args=[%s] config=%s acl=%s exec=%s body=%s',
                          (SELECT count(*) FROM pg_proc p2 WHERE p2.pronamespace = p.pronamespace AND p2.proname = p.proname),
                          pg_get_userbyid(p.proowner), p.prosecdef, p.prokind, l.lanname, p.provolatile, p.proparallel,
                          p.proisstrict, p.proleakproof, p.proretset, p.procost,
                          pg_get_function_result(p.oid), pg_get_function_arguments(p.oid),
                          coalesce(p.proconfig::text, '<none>'), coalesce(p.proacl::text, '<default>'),
                          (SELECT coalesce(string_agg(r, ',' ORDER BY r COLLATE "C"), '<nobody>')
                             FROM unnest(ARRAY['PUBLIC', 'anon', 'authenticated', 'service_role']) r
                            WHERE CASE WHEN r = 'PUBLIC'
                                       THEN EXISTS (SELECT 1 FROM aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                                                     WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE')
                                       ELSE has_function_privilege(r, p.oid, 'EXECUTE') END),
                          md5(p.prosrc))
              FROM pg_proc p JOIN pg_language l ON l.oid = p.prolang
             WHERE p.oid = to_regprocedure(e.sig)
               AND p.pronamespace = 'public'::regnamespace) AS found,
           -- (format's %s renders a boolean with its output function: t / f)
           format('overloads=1 owner=postgres secdef=t kind=f lang=plpgsql vol=v parallel=u strict=f leakproof=f setof=f cost=100 result=void args=[updates jsonb] config={"search_path=public, pg_temp"} acl={postgres=X/postgres,authenticated=X/postgres} exec=authenticated body=%s',
                  e.body_md5) AS expected
      FROM e
  )
  SELECT (SELECT count(*) FROM e),
         coalesce(string_agg(cmp.sig || E'\n  found:    ' || coalesce(cmp.found, '<missing>')
                                     || E'\n  expected: ' || cmp.expected, E'\n' ORDER BY cmp.sig), '')
    INTO v_count, v_text
  FROM cmp WHERE cmp.found IS DISTINCT FROM cmp.expected;
  IF v_count <> 2 THEN
    RAISE EXCEPTION 'bulk_metadata_write_invoker: the reviewed shape table has % rows, not 2', v_count;
  END IF;
  IF v_text <> '' THEN
    RAISE EXCEPTION E'bulk_metadata_write_invoker: target(s) not in the reviewed shape:\n%', v_text;
  END IF;

  -- ── 1d. public.papers — the relation both bodies read and write ─────────────
  -- An ordinary postgres-owned table, RLS enabled AND forced. `authenticated`
  -- holds exactly its reviewed grant, direct and effective: SELECT and UPDATE
  -- are the two these functions need, INSERT is pinned so section 3 can prove
  -- nothing moved, and DELETE / TRUNCATE are absent (since 20260904120000).
  -- anon holds nothing, and nobody outside postgres / authenticated /
  -- service_role is a grantee (PUBLIC included). No column-level grant exists,
  -- so the table-level grants are the whole story. Checked by privilege rather
  -- than by the literal ACL text, because hosted Production and a replay reach
  -- this ACL from different starting states (see 20260910212202); section 3
  -- still proves the literal text did not move.
  IF NOT EXISTS (SELECT 1 FROM pg_class c
                  WHERE c.oid = 'public.papers'::regclass AND c.relkind = 'r'
                    AND c.relowner = 'postgres'::regrole) THEN
    RAISE EXCEPTION 'bulk_metadata_write_invoker: public.papers is not an ordinary table owned by postgres';
  END IF;

  IF (SELECT format('rls=%s force=%s', c.relrowsecurity, c.relforcerowsecurity)
        FROM pg_class c WHERE c.oid = 'public.papers'::regclass) IS DISTINCT FROM 'rls=t force=t' THEN
    RAISE EXCEPTION 'bulk_metadata_write_invoker: public.papers must have row level security ENABLED and FORCED (found %)',
      (SELECT format('rls=%s force=%s', c.relrowsecurity, c.relforcerowsecurity) FROM pg_class c WHERE c.oid = 'public.papers'::regclass);
  END IF;

  SELECT format('direct=%s effective=%s',
           (SELECT coalesce(string_agg(a.privilege_type, ',' ORDER BY a.privilege_type), '')
              FROM pg_class c, aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) a
             WHERE c.oid = 'public.papers'::regclass AND a.grantee = 'authenticated'::regrole),
           (SELECT coalesce(string_agg(pr, ',' ORDER BY pr), '')
              FROM unnest(v_all) pr WHERE has_table_privilege('authenticated', 'public.papers', pr)))
    INTO v_text;
  IF v_text IS DISTINCT FROM 'direct=INSERT,SELECT,UPDATE effective=INSERT,SELECT,UPDATE' THEN
    RAISE EXCEPTION 'bulk_metadata_write_invoker: authenticated''s privileges on public.papers are not the reviewed INSERT,SELECT,UPDATE (found %) — SELECT and UPDATE are what the INVOKER bodies need',
      v_text;
  END IF;

  IF EXISTS (SELECT 1 FROM unnest(v_all) pr WHERE has_table_privilege('anon', 'public.papers', pr))
     OR EXISTS (SELECT 1 FROM pg_class c, aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) a
                 WHERE c.oid = 'public.papers'::regclass
                   AND a.grantee NOT IN ('postgres'::regrole, 'authenticated'::regrole, 'service_role'::regrole))
     OR EXISTS (SELECT 1 FROM pg_attribute att WHERE att.attrelid = 'public.papers'::regclass AND att.attacl IS NOT NULL) THEN
    RAISE EXCEPTION 'bulk_metadata_write_invoker: public.papers has an anon privilege, a grantee outside postgres/authenticated/service_role (PUBLIC included), or a column-level grant';
  END IF;

  -- ── 1e. The papers RLS policies are exactly the reviewed caller-owned four ──
  -- The SELECT and UPDATE policies are now the primary boundary of both
  -- functions, so a policy that was broadened, narrowed, renamed, re-targeted,
  -- made restrictive or joined by another is a reason to stop. A RESTRICTIVE
  -- policy is named on its own first, for a clear message; then the readable
  -- comparison; then the digest (identical in Production and on a replay).
  SELECT coalesce(string_agg(pol.polname || ' (' || pol.polcmd::text || ')', ', ' ORDER BY pol.polname), '') INTO v_text
  FROM pg_policy pol WHERE pol.polrelid = 'public.papers'::regclass AND NOT pol.polpermissive;
  IF v_text <> '' THEN
    RAISE EXCEPTION 'bulk_metadata_write_invoker: unreviewed RESTRICTIVE polic(ies) on public.papers: %', v_text;
  END IF;

  SELECT coalesce(string_agg(pol.polname || '|' || pol.polcmd::text || '|' || pol.polpermissive::text || '|'
                             || (SELECT string_agg(CASE WHEN r = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(r) END, ',' ORDER BY r)
                                   FROM unnest(pol.polroles) r) || '|'
                             || coalesce(pg_get_expr(pol.polqual, pol.polrelid), '<null>') || '|'
                             || coalesce(pg_get_expr(pol.polwithcheck, pol.polrelid), '<null>'),
                             E'\n' ORDER BY pol.polname), '') INTO v_text
  FROM pg_policy pol WHERE pol.polrelid = 'public.papers'::regclass;
  SELECT string_agg(w.line, E'\n' ORDER BY w.line) INTO v_want
  FROM (VALUES
    ('Users can create their own papers|a|true|PUBLIC|<null>|(auth.uid() = user_id)'),
    ('Users can delete their own papers|d|true|PUBLIC|(auth.uid() = user_id)|<null>'),
    ('Users can update their own papers|w|true|PUBLIC|(auth.uid() = user_id)|<null>'),
    ('Users can view their own papers|r|true|PUBLIC|(auth.uid() = user_id)|<null>')
  ) AS w(line);
  IF v_text IS DISTINCT FROM v_want THEN
    RAISE EXCEPTION E'bulk_metadata_write_invoker: the public.papers RLS policies are not the reviewed caller-owned set.\nfound:\n%\nexpected:\n%', v_text, v_want;
  END IF;

  IF (SELECT md5(string_agg(format('%s|%s|%s|%s|%s|%s', pol.polname, pol.polcmd, pol.polpermissive,
                                   (SELECT string_agg(CASE WHEN r = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(r) END, ',' ORDER BY r)
                                      FROM unnest(pol.polroles) r),
                                   coalesce(pg_get_expr(pol.polqual, pol.polrelid), '<null>'),
                                   coalesce(pg_get_expr(pol.polwithcheck, pol.polrelid), '<null>')),
                            E'\n' ORDER BY pol.polname))
        FROM pg_policy pol WHERE pol.polrelid = 'public.papers'::regclass)
     IS DISTINCT FROM '83aefa941c0457380be04b51c131ed5d' THEN
    RAISE EXCEPTION 'bulk_metadata_write_invoker: the public.papers RLS policy digest is not the reviewed one';
  END IF;

  -- ── 1f. Every trigger on public.papers — exactly the reviewed twelve ────────
  -- Under INVOKER each UPDATE trigger fires as the caller instead of the owner,
  -- so a new or widened one is a reason to stop and re-review. The two named
  -- triggers are pinned by definition digest (which covers timing, events,
  -- column list and WHEN clause) and bound column list; the ten internal
  -- foreign-key triggers, whose names embed environment-specific OIDs, by
  -- kind, function and the relation at the other end.
  SELECT coalesce(string_agg(format('%s|%s|%s|%s|%s|%s', t.tgname, t.tgenabled, t.tgtype, t.tgfoid::regprocedure,
                                    (SELECT coalesce(string_agg(a.attname, ',' ORDER BY a.attnum), '')
                                       FROM unnest(t.tgattr::int2[]) k
                                       JOIN pg_attribute a ON a.attrelid = t.tgrelid AND a.attnum = k),
                                    md5(pg_get_triggerdef(t.oid))), E'\n' ORDER BY t.tgname), '') INTO v_text
  FROM pg_trigger t WHERE t.tgrelid = 'public.papers'::regclass AND NOT t.tgisinternal;
  v_want := 'papers_clear_author_identity_links_on_authors_change|O|17|public.clear_author_identity_links_on_authors_change()|authors|df324456e1798618b83342b7376698d9'
            || E'\n' || 'trg_papers_updated_at|O|19|public.set_updated_at()||64efa17c0852ae9a5d30cc42d2edbba2';
  IF v_text IS DISTINCT FROM v_want THEN
    RAISE EXCEPTION E'bulk_metadata_write_invoker: the named triggers on public.papers are not the reviewed two.\nfound:\n%\nexpected:\n%', v_text, v_want;
  END IF;

  SELECT coalesce(string_agg(format('%s|%s|%s|%s|%s|%s', t.tgtype, t.tgfoid::regprocedure, t.tgconstrrelid::regclass,
                                    t.tgenabled, t.tgdeferrable, t.tginitdeferred), E'\n'
                             ORDER BY t.tgconstrrelid::regclass::text COLLATE "C", t.tgtype, t.tgfoid::regprocedure::text COLLATE "C"), '')
    INTO v_text
  FROM pg_trigger t WHERE t.tgrelid = 'public.papers'::regclass AND t.tgisinternal;
  SELECT string_agg(w.line, E'\n' ORDER BY w.ord) INTO v_want
  FROM (VALUES
    (1,  '5|"RI_FKey_check_ins"()|auth.users|O|f|f'),
    (2,  '17|"RI_FKey_check_upd"()|auth.users|O|f|f'),
    (3,  '9|"RI_FKey_cascade_del"()|public.author_identity_links|O|f|f'),
    (4,  '17|"RI_FKey_noaction_upd"()|public.author_identity_links|O|f|f'),
    (5,  '9|"RI_FKey_cascade_del"()|public.paper_attachments|O|f|f'),
    (6,  '17|"RI_FKey_noaction_upd"()|public.paper_attachments|O|f|f'),
    (7,  '9|"RI_FKey_cascade_del"()|public.paper_projects|O|f|f'),
    (8,  '17|"RI_FKey_noaction_upd"()|public.paper_projects|O|f|f'),
    (9,  '9|"RI_FKey_cascade_del"()|public.paper_tags|O|f|f'),
    (10, '17|"RI_FKey_noaction_upd"()|public.paper_tags|O|f|f')
  ) AS w(ord, line);
  IF v_text IS DISTINCT FROM v_want THEN
    RAISE EXCEPTION E'bulk_metadata_write_invoker: the internal foreign-key triggers on public.papers are not the reviewed ten.\nfound:\n%\nexpected:\n%', v_text, v_want;
  END IF;

  -- The two trigger functions: set_updated_at() runs as the caller (INVOKER, the
  -- C51 path, its reviewed body); the author-link invalidation stays the C50
  -- audited SECURITY DEFINER exception, owner-only EXECUTE, its reviewed body.
  SELECT coalesce(string_agg(e.sig || E'\n  found:    ' || coalesce(
           (SELECT format('secdef=%s owner=%s config=%s body=%s', p.prosecdef, pg_get_userbyid(p.proowner),
                          coalesce(p.proconfig::text, '<none>'), md5(p.prosrc))
              FROM pg_proc p WHERE p.oid = to_regprocedure(e.sig)), '<missing>')
           || E'\n  expected: ' || e.expected, E'\n' ORDER BY e.sig), '') INTO v_text
  FROM (VALUES
    ('public.set_updated_at()',
     'secdef=f owner=postgres config={search_path=pg_catalog} body=301a884953d37769916294bb60562e05'),
    ('public.clear_author_identity_links_on_authors_change()',
     'secdef=t owner=postgres config={search_path=public} body=a14c92dbd8485afff4d1600684b37565')
  ) AS e(sig, expected)
  WHERE (SELECT format('secdef=%s owner=%s config=%s body=%s', p.prosecdef, pg_get_userbyid(p.proowner),
                       coalesce(p.proconfig::text, '<none>'), md5(p.prosrc))
           FROM pg_proc p WHERE p.oid = to_regprocedure(e.sig)) IS DISTINCT FROM e.expected;
  IF v_text <> '' THEN
    RAISE EXCEPTION E'bulk_metadata_write_invoker: a papers trigger function is not in its reviewed shape:\n%', v_text;
  END IF;

  IF (SELECT coalesce(proacl::text, '<default>') FROM pg_proc
       WHERE oid = 'public.clear_author_identity_links_on_authors_change()'::regprocedure)
     IS DISTINCT FROM '{postgres=X/postgres}' THEN
    RAISE EXCEPTION 'bulk_metadata_write_invoker: clear_author_identity_links_on_authors_change() is no longer owner-only EXECUTE';
  END IF;

  -- Neither target body writes `authors`, so the author-link trigger cannot fire
  -- for them. The body digests above pin that; this says it in words.
  IF EXISTS (SELECT 1 FROM pg_proc p WHERE p.oid = ANY (SELECT to_regprocedure(s) FROM unnest(v_targets) s)
                                       AND p.prosrc ~* '\mauthors\M') THEN
    RAISE EXCEPTION 'bulk_metadata_write_invoker: a target body mentions authors, so the author-link trigger could fire under the caller';
  END IF;

  -- ── 1g. papers.search_vector — only the two reviewed shapes ─────────────────
  IF (SELECT format('generated=%s type=%s notnull=%s dropped=%s', a.attgenerated, format_type(a.atttypid, a.atttypmod),
                    a.attnotnull, a.attisdropped)
        FROM pg_attribute a WHERE a.attrelid = 'public.papers'::regclass AND a.attname = 'search_vector')
     IS DISTINCT FROM 'generated=s type=tsvector notnull=f dropped=f' THEN
    RAISE EXCEPTION 'bulk_metadata_write_invoker: papers.search_vector is no longer the stored generated tsvector column';
  END IF;

  -- The expression digest, its recorded function dependencies, and every
  -- function (or operator function) its node tree actually calls — each of
  -- which the caller must be able to EXECUTE once the UPDATE runs as the caller.
  SELECT md5(pg_get_expr(d.adbin, d.adrelid)),
         (SELECT coalesce(string_agg(dd.refobjid::regprocedure::text || '|' || dd.deptype::text, ','
                                     ORDER BY dd.refobjid::regprocedure::text COLLATE "C"), '')
            FROM pg_depend dd
           WHERE dd.classid = 'pg_attrdef'::regclass AND dd.objid = d.oid AND dd.refclassid = 'pg_proc'::regclass),
         (SELECT coalesce(string_agg(f.oid::regprocedure::text, ',' ORDER BY f.oid::regprocedure::text COLLATE "C"), '')
            FROM (SELECT DISTINCT m[1]::oid AS fid
                    FROM regexp_matches(d.adbin::text, ':(?:funcid|opfuncid) ([0-9]+)', 'g') AS m) x
            JOIN pg_proc f ON f.oid = x.fid)
    INTO v_expr_md5, v_expr_deps, v_expr_fns
  FROM pg_attrdef d JOIN pg_attribute a ON a.attrelid = d.adrelid AND a.attnum = d.adnum
  WHERE d.adrelid = 'public.papers'::regclass AND a.attname = 'search_vector';
  IF NOT (   (v_expr_md5 = 'dd69f099a274a9cdc0f174ae0883ddb6'
              AND v_expr_deps = 'public.immutable_english_tsvector_jsonb(jsonb)|n,public.immutable_english_tsvector_text(text)|n'
              AND v_expr_fns = 'public.immutable_english_tsvector_jsonb(jsonb),public.immutable_english_tsvector_text(text),setweight(tsvector,"char"),tsvector_concat(tsvector,tsvector)')
          OR (v_expr_md5 = '8ddd960b4f4b11dd7afd35485d01fd25'
              AND v_expr_deps = ''
              AND v_expr_fns = 'setweight(tsvector,"char"),to_tsvector(regconfig,text),tsvector_concat(tsvector,tsvector)')) THEN
    RAISE EXCEPTION 'bulk_metadata_write_invoker: STOP — papers.search_vector is an unreviewed shape (expression %, dependencies [%], calls [%]); reviewed: clean replay dd69f099… on the text+jsonb wrappers, or hosted 8ddd960b… on built-ins only (DB-SEARCH-VECTOR-EXPRESSION-PARITY-001)',
      coalesce(v_expr_md5, '<missing>'), coalesce(v_expr_deps, '<missing>'), coalesce(v_expr_fns, '<missing>');
  END IF;

  SELECT coalesce(string_agg(s, ', ' ORDER BY s), '') INTO v_text
  FROM unnest(string_to_array(v_expr_fns, ',')) s
  WHERE NOT has_function_privilege('authenticated', to_regprocedure(s), 'EXECUTE');
  IF v_text <> '' THEN
    RAISE EXCEPTION 'bulk_metadata_write_invoker: authenticated cannot EXECUTE function(s) papers.search_vector calls, so every INVOKER update of papers would fail: %', v_text;
  END IF;

  -- The same holds for everything else an UPDATE of papers evaluates as the
  -- current user: its CHECK constraints and its index expressions and
  -- predicates. Reviewed as built-ins only (lower, jsonb_path_exists,
  -- jsonb_typeof, …), identical in both environments; required here only to be
  -- executable by the caller, as a direct browser UPDATE already needs them.
  SELECT coalesce(string_agg(f.oid::regprocedure::text, ', ' ORDER BY f.oid::regprocedure::text COLLATE "C"), '') INTO v_text
  FROM (SELECT DISTINCT m[1]::oid AS fid
          FROM pg_constraint c, regexp_matches(c.conbin::text, ':(?:funcid|opfuncid) ([0-9]+)', 'g') AS m
         WHERE c.conrelid = 'public.papers'::regclass AND c.contype = 'c'
        UNION
        SELECT DISTINCT m[1]::oid
          FROM pg_index i, regexp_matches(coalesce(i.indexprs::text, '') || coalesce(i.indpred::text, ''),
                                          ':(?:funcid|opfuncid) ([0-9]+)', 'g') AS m
         WHERE i.indrelid = 'public.papers'::regclass) x
  JOIN pg_proc f ON f.oid = x.fid
  WHERE NOT has_function_privilege('authenticated', f.oid, 'EXECUTE');
  IF v_text <> '' THEN
    RAISE EXCEPTION 'bulk_metadata_write_invoker: authenticated cannot EXECUTE function(s) a papers CHECK constraint or index expression calls, so every INVOKER update of papers would fail: %', v_text;
  END IF;

  IF (SELECT format('rel=%s valid=%s ready=%s def=%s', i.indrelid::regclass, i.indisvalid, i.indisready,
                    md5(pg_get_indexdef(i.indexrelid)))
        FROM pg_index i WHERE i.indexrelid = to_regclass('public.idx_papers_search_vector'))
     IS DISTINCT FROM 'rel=public.papers valid=t ready=t def=447b923097a20e377d6b1b6e74760783' THEN
    RAISE EXCEPTION 'bulk_metadata_write_invoker: idx_papers_search_vector is missing or not in its reviewed shape';
  END IF;

  -- ── 1h. The SECURITY DEFINER inventory this change is carved out of ─────────
  -- 35 in public, 27 of them authenticated-executable, and the two are among
  -- the 27 (1c). A different count means the surface drifted after the audit
  -- and must be re-reviewed before anything leaves it.
  SELECT count(*) INTO v_count FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND prosecdef;
  IF v_count <> 35 THEN
    RAISE EXCEPTION 'bulk_metadata_write_invoker: % SECURITY DEFINER functions in public; the reviewed inventory is 35', v_count;
  END IF;
  SELECT count(*) INTO v_count FROM pg_proc
   WHERE pronamespace = 'public'::regnamespace AND prosecdef AND has_function_privilege('authenticated', oid, 'EXECUTE');
  IF v_count <> 27 THEN
    RAISE EXCEPTION 'bulk_metadata_write_invoker: % authenticated-executable SECURITY DEFINER functions in public; the reviewed inventory is 27', v_count;
  END IF;

  -- ── 1i. Snapshots of everything this migration must NOT change ─────────────
  -- Transaction-local; read back in section 3.

  -- Each target as its WHOLE pg_proc row except prosecdef — oid included, so a
  -- drop-and-recreate could not pass as an ALTER.
  PERFORM set_config('paperlume.bulk_metadata_write_invoker.pre_targets',
    (SELECT string_agg(p.oid::regprocedure::text || '=' || p.oid::text || '=' || md5((to_jsonb(p.*) - 'prosecdef')::text), E'\n'
                       ORDER BY p.oid::regprocedure::text)
       FROM pg_proc p WHERE p.oid = ANY (SELECT to_regprocedure(s) FROM unnest(v_targets) s)), true);

  -- Every OTHER function in public, whole rows, prosecdef included — the 25
  -- retained client definer RPCs (safe_bulk_insert_papers among them), the
  -- server-only, trigger and internal functions, and every existing INVOKER
  -- routine.
  PERFORM set_config('paperlume.bulk_metadata_write_invoker.pre_others',
    (SELECT md5(string_agg(p.oid::text || '=' || md5(to_jsonb(p.*)::text), E'\n' ORDER BY p.oid))
       FROM pg_proc p
      WHERE p.pronamespace = 'public'::regnamespace
        AND p.oid <> ALL (SELECT to_regprocedure(s) FROM unnest(v_targets) s)), true);

  -- The authenticated-executable SECURITY DEFINER functions that STAY (25).
  PERFORM set_config('paperlume.bulk_metadata_write_invoker.pre_retained_definer',
    (SELECT string_agg(p.oid::regprocedure::text, ',' ORDER BY p.oid::regprocedure::text)
       FROM pg_proc p
      WHERE p.pronamespace = 'public'::regnamespace AND p.prosecdef
        AND has_function_privilege('authenticated', p.oid, 'EXECUTE')
        AND p.oid <> ALL (SELECT to_regprocedure(s) FROM unnest(v_targets) s)), true);

  -- The authenticated-executable SECURITY INVOKER routines that already exist.
  -- Newline-separated, because section 3 splits this list and a signature with
  -- more than one argument contains commas.
  PERFORM set_config('paperlume.bulk_metadata_write_invoker.pre_invoker',
    (SELECT coalesce(string_agg(p.oid::regprocedure::text, E'\n' ORDER BY p.oid::regprocedure::text), '')
       FROM pg_proc p
      WHERE p.pronamespace = 'public'::regnamespace AND NOT p.prosecdef
        AND has_function_privilege('authenticated', p.oid, 'EXECUTE')), true);

  -- The boundary: papers' own row (owner, RLS flags, the WHOLE ACL as stored,
  -- storage) and every column ACL; each policy and each trigger as its whole
  -- catalog row; the search_vector column, its default and its index; and the
  -- whole rows of the two trigger functions.
  PERFORM set_config('paperlume.bulk_metadata_write_invoker.pre_boundary',
    (SELECT concat_ws(E'\n',
       (SELECT 'papers|' || c.oid::text || '|' || pg_get_userbyid(c.relowner) || '|' || c.relrowsecurity::text || '|'
               || c.relforcerowsecurity::text || '|' || coalesce(c.relacl::text, 'NULL') || '|' || c.relfilenode::text
          FROM pg_class c WHERE c.oid = 'public.papers'::regclass),
       (SELECT 'colacl|' || coalesce(string_agg(a.attname || '=' || a.attacl::text, ',' ORDER BY a.attnum), '')
          FROM pg_attribute a WHERE a.attrelid = 'public.papers'::regclass AND a.attacl IS NOT NULL),
       (SELECT 'pol|' || coalesce(string_agg(md5(to_jsonb(pol.*)::text), ',' ORDER BY pol.oid), '')
          FROM pg_policy pol WHERE pol.polrelid = 'public.papers'::regclass),
       (SELECT 'trg|' || coalesce(string_agg(md5(to_jsonb(t.*)::text), ',' ORDER BY t.oid), '')
          FROM pg_trigger t WHERE t.tgrelid = 'public.papers'::regclass),
       (SELECT 'att|' || md5(to_jsonb(a.*)::text) FROM pg_attribute a
         WHERE a.attrelid = 'public.papers'::regclass AND a.attname = 'search_vector'),
       (SELECT 'def|' || ad.oid::text || '|' || md5(ad.adbin::text) || '|' || md5(pg_get_expr(ad.adbin, ad.adrelid))
          FROM pg_attrdef ad JOIN pg_attribute a ON a.attrelid = ad.adrelid AND a.attnum = ad.adnum
         WHERE ad.adrelid = 'public.papers'::regclass AND a.attname = 'search_vector'),
       (SELECT 'idx|' || md5(to_jsonb(i.*)::text) || '|' || c.relfilenode::text || '|' || md5(pg_get_indexdef(i.indexrelid))
          FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
         WHERE i.indexrelid = 'public.idx_papers_search_vector'::regclass))), true);
END
$pre$;


-- ═════════════════════════════════════════════════════════════════════════════
-- 2. The change
-- ═════════════════════════════════════════════════════════════════════════════
--
-- Two statements, one attribute each, exact signatures. No CREATE OR REPLACE:
-- the reviewed bodies are kept byte-for-byte, and section 3 proves it.

ALTER FUNCTION public.bulk_update_keywords(jsonb)
  SECURITY INVOKER;

ALTER FUNCTION public.bulk_update_study_types(jsonb)
  SECURITY INVOKER;


-- ═════════════════════════════════════════════════════════════════════════════
-- 3. Fail-closed verification — inside the same transaction
-- ═════════════════════════════════════════════════════════════════════════════

DO $verify$
DECLARE
  v_sig     TEXT;
  v_text    TEXT;
  v_base    TEXT;
  v_count   INTEGER;
  v_targets CONSTANT TEXT[] := ARRAY[
    'public.bulk_update_keywords(jsonb)',
    'public.bulk_update_study_types(jsonb)'];
BEGIN
  -- ── 3a. Both are SECURITY INVOKER, with the EXECUTE posture unchanged ───────
  FOREACH v_sig IN ARRAY v_targets LOOP
    IF (SELECT prosecdef FROM pg_proc WHERE oid = to_regprocedure(v_sig)) IS DISTINCT FROM false THEN
      RAISE EXCEPTION 'bulk_metadata_write_invoker: % is not SECURITY INVOKER after the change', v_sig;
    END IF;

    IF (SELECT proacl::text FROM pg_proc WHERE oid = to_regprocedure(v_sig))
         IS DISTINCT FROM '{postgres=X/postgres,authenticated=X/postgres}'
       OR NOT has_function_privilege('postgres', to_regprocedure(v_sig), 'EXECUTE')
       OR NOT has_function_privilege('authenticated', to_regprocedure(v_sig), 'EXECUTE')
       OR has_function_privilege('anon', to_regprocedure(v_sig), 'EXECUTE')
       OR has_function_privilege('service_role', to_regprocedure(v_sig), 'EXECUTE')
       OR EXISTS (SELECT 1 FROM pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                   WHERE p.oid = to_regprocedure(v_sig) AND a.grantee = 0 AND a.privilege_type = 'EXECUTE') THEN
      RAISE EXCEPTION 'bulk_metadata_write_invoker: the EXECUTE ACL or effective posture of % changed', v_sig;
    END IF;

    -- Restated literally, so a failure names the attribute rather than a digest.
    -- The C50 path stays exactly as it was: `public` first, `pg_temp` last.
    IF NOT EXISTS (SELECT 1 FROM pg_proc p
                    WHERE p.oid = to_regprocedure(v_sig)
                      AND p.proowner = 'postgres'::regrole
                      AND p.proconfig = ARRAY['search_path=public, pg_temp']
                      AND p.prolang = (SELECT oid FROM pg_language WHERE lanname = 'plpgsql')
                      AND p.provolatile = 'v' AND p.proparallel = 'u') THEN
      RAISE EXCEPTION 'bulk_metadata_write_invoker: the owner, search_path, language, volatility or parallel mode of % changed', v_sig;
    END IF;
  END LOOP;

  -- ── 3b. OID, body, signature, result, arguments, volatility, parallel,
  --        strictness, cost, config, owner and ACL: the whole row except
  --        prosecdef is unchanged ─────────────────────────────────────────────
  v_base := current_setting('paperlume.bulk_metadata_write_invoker.pre_targets', true);
  SELECT string_agg(p.oid::regprocedure::text || '=' || p.oid::text || '=' || md5((to_jsonb(p.*) - 'prosecdef')::text), E'\n'
                    ORDER BY p.oid::regprocedure::text) INTO v_text
  FROM pg_proc p WHERE p.oid = ANY (SELECT to_regprocedure(s) FROM unnest(v_targets) s);
  IF coalesce(v_base, '') = '' OR v_text IS DISTINCT FROM v_base THEN
    RAISE EXCEPTION E'bulk_metadata_write_invoker: an attribute other than prosecdef changed on a target.\nbefore:\n%\nafter:\n%', v_base, v_text;
  END IF;

  -- Belt and braces on the fact review cares most about.
  IF (SELECT string_agg(md5(prosrc), ',' ORDER BY md5(prosrc) COLLATE "C") FROM pg_proc
       WHERE oid = ANY (SELECT to_regprocedure(s) FROM unnest(v_targets) s))
     IS DISTINCT FROM '6086d69c0915c8a7c67089556b40041b,c002702d05a14e7febd00feaf1e97786' THEN
    RAISE EXCEPTION 'bulk_metadata_write_invoker: a function body changed';
  END IF;

  -- ── 3c. No other function in public moved ───────────────────────────────────
  -- (safe_bulk_insert_papers, which stays SECURITY DEFINER, is among these.)
  v_base := current_setting('paperlume.bulk_metadata_write_invoker.pre_others', true);
  IF coalesce(v_base, '') = ''
     OR (SELECT md5(string_agg(p.oid::text || '=' || md5(to_jsonb(p.*)::text), E'\n' ORDER BY p.oid))
           FROM pg_proc p
          WHERE p.pronamespace = 'public'::regnamespace
            AND p.oid <> ALL (SELECT to_regprocedure(s) FROM unnest(v_targets) s)) IS DISTINCT FROM v_base THEN
    RAISE EXCEPTION 'bulk_metadata_write_invoker: a function outside the two targets changed';
  END IF;

  IF NOT (SELECT prosecdef FROM pg_proc WHERE oid = 'public.safe_bulk_insert_papers(uuid,jsonb)'::regprocedure) THEN
    RAISE EXCEPTION 'bulk_metadata_write_invoker: safe_bulk_insert_papers is no longer SECURITY DEFINER — it is out of this change''s scope';
  END IF;

  -- ── 3d. The inventory moved by exactly these two: 35 → 33, 27 → 25 ──────────
  SELECT count(*) INTO v_count FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND prosecdef;
  IF v_count <> 33 THEN
    RAISE EXCEPTION 'bulk_metadata_write_invoker: % SECURITY DEFINER functions in public after the change; expected 33', v_count;
  END IF;

  SELECT count(*), string_agg(p.oid::regprocedure::text, ',' ORDER BY p.oid::regprocedure::text) INTO v_count, v_text
  FROM pg_proc p
  WHERE p.pronamespace = 'public'::regnamespace AND p.prosecdef
    AND has_function_privilege('authenticated', p.oid, 'EXECUTE');
  IF v_count <> 25 OR v_text IS DISTINCT FROM current_setting('paperlume.bulk_metadata_write_invoker.pre_retained_definer', true) THEN
    RAISE EXCEPTION 'bulk_metadata_write_invoker: the authenticated-executable SECURITY DEFINER set is not exactly the 25 retained functions (count %)', v_count;
  END IF;

  SELECT string_agg(s, E'\n' ORDER BY s) INTO v_base
  FROM (SELECT unnest(string_to_array(current_setting('paperlume.bulk_metadata_write_invoker.pre_invoker', true), E'\n')) AS s
        UNION
        SELECT to_regprocedure(f)::regprocedure::text FROM unnest(v_targets) f) u
  WHERE s <> '';
  SELECT string_agg(p.oid::regprocedure::text, E'\n' ORDER BY p.oid::regprocedure::text) INTO v_text
  FROM pg_proc p
  WHERE p.pronamespace = 'public'::regnamespace AND NOT p.prosecdef
    AND has_function_privilege('authenticated', p.oid, 'EXECUTE');
  IF v_text IS DISTINCT FROM v_base THEN
    RAISE EXCEPTION 'bulk_metadata_write_invoker: the authenticated-executable SECURITY INVOKER set did not grow by exactly the two (expected %; found %)', v_base, v_text;
  END IF;

  -- ── 3e. The boundary the two now rely on is unchanged ───────────────────────
  v_base := current_setting('paperlume.bulk_metadata_write_invoker.pre_boundary', true);
  IF coalesce(v_base, '') = ''
     OR (SELECT concat_ws(E'\n',
          (SELECT 'papers|' || c.oid::text || '|' || pg_get_userbyid(c.relowner) || '|' || c.relrowsecurity::text || '|'
                  || c.relforcerowsecurity::text || '|' || coalesce(c.relacl::text, 'NULL') || '|' || c.relfilenode::text
             FROM pg_class c WHERE c.oid = 'public.papers'::regclass),
          (SELECT 'colacl|' || coalesce(string_agg(a.attname || '=' || a.attacl::text, ',' ORDER BY a.attnum), '')
             FROM pg_attribute a WHERE a.attrelid = 'public.papers'::regclass AND a.attacl IS NOT NULL),
          (SELECT 'pol|' || coalesce(string_agg(md5(to_jsonb(pol.*)::text), ',' ORDER BY pol.oid), '')
             FROM pg_policy pol WHERE pol.polrelid = 'public.papers'::regclass),
          (SELECT 'trg|' || coalesce(string_agg(md5(to_jsonb(t.*)::text), ',' ORDER BY t.oid), '')
             FROM pg_trigger t WHERE t.tgrelid = 'public.papers'::regclass),
          (SELECT 'att|' || md5(to_jsonb(a.*)::text) FROM pg_attribute a
            WHERE a.attrelid = 'public.papers'::regclass AND a.attname = 'search_vector'),
          (SELECT 'def|' || ad.oid::text || '|' || md5(ad.adbin::text) || '|' || md5(pg_get_expr(ad.adbin, ad.adrelid))
             FROM pg_attrdef ad JOIN pg_attribute a ON a.attrelid = ad.adrelid AND a.attnum = ad.adnum
            WHERE ad.adrelid = 'public.papers'::regclass AND a.attname = 'search_vector'),
          (SELECT 'idx|' || md5(to_jsonb(i.*)::text) || '|' || c.relfilenode::text || '|' || md5(pg_get_indexdef(i.indexrelid))
             FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
            WHERE i.indexrelid = 'public.idx_papers_search_vector'::regclass)))
        IS DISTINCT FROM v_base THEN
    RAISE EXCEPTION 'bulk_metadata_write_invoker: papers'' owner, RLS flags, ACL, storage, a column grant, a policy, a trigger, search_vector or idx_papers_search_vector changed';
  END IF;

  IF NOT has_table_privilege('authenticated', 'public.papers', 'SELECT')
     OR NOT has_table_privilege('authenticated', 'public.papers', 'UPDATE') THEN
    RAISE EXCEPTION 'bulk_metadata_write_invoker: authenticated lost SELECT or UPDATE on papers, which the INVOKER functions now require';
  END IF;

  IF (SELECT md5(string_agg(format('%s|%s|%s|%s|%s|%s', pol.polname, pol.polcmd, pol.polpermissive,
                                   (SELECT string_agg(CASE WHEN r = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(r) END, ',' ORDER BY r)
                                      FROM unnest(pol.polroles) r),
                                   coalesce(pg_get_expr(pol.polqual, pol.polrelid), '<null>'),
                                   coalesce(pg_get_expr(pol.polwithcheck, pol.polrelid), '<null>')),
                            E'\n' ORDER BY pol.polname))
        FROM pg_policy pol WHERE pol.polrelid = 'public.papers'::regclass)
     IS DISTINCT FROM '83aefa941c0457380be04b51c131ed5d' THEN
    RAISE EXCEPTION 'bulk_metadata_write_invoker: an RLS policy on public.papers changed';
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated' AND (rolsuper OR rolbypassrls)) THEN
    RAISE EXCEPTION 'bulk_metadata_write_invoker: authenticated became SUPERUSER or BYPASSRLS';
  END IF;

  -- ── 3f. Catalog-only: this transaction wrote no row ─────────────────────────
  v_base := current_setting('paperlume.bulk_metadata_write_invoker.xact_writes_at_start', true);
  IF coalesce(v_base, '') = '' THEN
    RAISE EXCEPTION 'bulk_metadata_write_invoker: the write baseline from section 0 is missing — this file must run as one transaction';
  END IF;
  SELECT string_agg(
           n.nspname || '.' || c.relname || '=' || (pg_stat_get_xact_tuples_inserted(c.oid)
                                                    + pg_stat_get_xact_tuples_updated(c.oid)
                                                    + pg_stat_get_xact_tuples_deleted(c.oid)),
           ' ' ORDER BY n.nspname, c.relname) INTO v_text
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname IN ('public', 'auth', 'storage') AND c.relkind IN ('r', 'p');
  IF v_text IS DISTINCT FROM v_base THEN
    RAISE EXCEPTION 'bulk_metadata_write_invoker: this transaction wrote application rows (row writes at start: %; now: %)', v_base, v_text;
  END IF;
END
$verify$;

COMMIT;
