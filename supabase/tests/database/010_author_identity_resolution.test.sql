-- AUTHOR-IDENTITY-RESOLUTION-001C suite 010: user-scoped author identity.
--
-- This suite owns the database contract for the four identity tables, the six
-- client RPCs, the two internal helpers and the stale-link invalidation trigger.
-- Suite 003 keeps ownership of the least-privilege EXECUTE surface across the
-- whole SECURITY DEFINER inventory; only the invariants a careless change to
-- THESE objects could break are asserted here.
--
-- What 001C is:
--   the first layer permitted to say that two authorship mentions are the same
--   person, and only because a user explicitly said so. 001A compares author
--   *strings*; 001B records what a *source* stated, ORCID included. Neither
--   resolves a person, and this layer only does so on an explicit action.
--
-- The rule every assertion below serves:
--   Paperlume may SUGGEST an identity relationship from deterministic evidence.
--   It must never silently ASSERT one. So the database refuses to create an
--   identity except through a call naming one specific mention; refuses a
--   mention whose text has moved since the user read it; refuses an explicitly
--   collective author; and clears every link on a paper whose author array
--   changes, because a link is bound to the text it names.
--
-- Proves:
--   * shape and posture: four tables, RLS enabled AND forced, the exact
--     authenticated surface, nothing for anon or service_role, and no global
--     uniqueness on a name;
--   * user scoping enforced structurally — a cross-user alias, link or merge
--     edge is rejected by a composite foreign key, not merely by policy, and a
--     link's PAPER endpoint is composite too, so a privileged direct write
--     cannot attach one user's person to another user's paper;
--   * create/link validation: ownership, index bounds, the exact expected-author
--     guard, blank mentions, explicitly collective provenance, and that NULL or
--     `unknown` provenance stays manually resolvable;
--   * one link per (paper, author_index), and that the same identity may
--     legitimately hold two mentions on one paper;
--   * replacement requires an explicit flag, so a candidate action cannot
--     silently overwrite a decision;
--   * the merge graph: root resolution through a chain, cycle rejection, the
--     one-outgoing-edge rule, and that unmerge removes exactly one edge while
--     leaving the rest of the chain standing;
--   * merges move nothing — the source keeps its links and aliases, which is
--     what makes undo a deletion rather than a reconstruction;
--   * deletion semantics: an identity carrying anything is refused, an empty one
--     is removed, and `authenticated` cannot bypass either by deleting the row;
--   * stale-link invalidation: any real change to papers.authors clears that
--     paper's links atomically; an unrelated column, an identical re-assignment
--     and a provenance-only change do not;
--   * duplicate-paper merge interaction: discarded papers' links cascade, a kept
--     paper whose authors changed loses its links, and identities survive both;
--   * paper deletion cascades links and leaves the identity alone;
--   * a stale saved link is repairable: an explicitly requested create replaces
--     a row the SERVER proves stale, refuses one whose snapshot still matches,
--     and an out-of-range saved row is removable through the plain unlink path;
--   * account deletion removes every identity row through the auth.users cascade,
--     with no Edge Function enumerating tables.
--
-- Deterministic UUIDs; explicit fixtures; no TODO/SKIP; no remote calls; no
-- Production data; no real credentials. pgTAP is created inside the transaction
-- and rolled back with it.

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SET LOCAL search_path TO extensions, public, pg_temp;

-- ── Helpers ─────────────────────────────────────────────────────────────────

-- Execute p_sql as p_role with p_claims; return the resulting SQLSTATE
-- ('00000' when the statement succeeded).
CREATE FUNCTION pg_temp.errcode_as(p_role text, p_claims text, p_sql text)
RETURNS text LANGUAGE plpgsql AS $hlp$
DECLARE v_state text;
BEGIN
  PERFORM set_config('request.jwt.claims', COALESCE(p_claims, ''), true);
  EXECUTE 'SET LOCAL ROLE ' || quote_ident(p_role);
  BEGIN
    EXECUTE p_sql;
    v_state := '00000';
  EXCEPTION WHEN others THEN
    GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE;
  END;
  RESET ROLE;
  PERFORM set_config('request.jwt.claims', '', true);
  RETURN v_state;
END;
$hlp$;

CREATE FUNCTION pg_temp.claims_u1() RETURNS text LANGUAGE sql AS
$hlp$ SELECT '{"sub":"0a000000-0000-0000-0000-000000000001","role":"authenticated"}'::text $hlp$;
CREATE FUNCTION pg_temp.claims_u2() RETURNS text LANGUAGE sql AS
$hlp$ SELECT '{"sub":"0a000000-0000-0000-0000-000000000002","role":"authenticated"}'::text $hlp$;

-- Run a statement as U1/U2 and discard the result. Raises on failure, so it is
-- used only where the call is expected to succeed.
CREATE FUNCTION pg_temp.run_as(p_claims text, p_sql text)
RETURNS void LANGUAGE plpgsql AS $hlp$
BEGIN
  PERFORM set_config('request.jwt.claims', p_claims, true);
  SET LOCAL ROLE authenticated;
  EXECUTE p_sql;
  RESET ROLE;
  PERFORM set_config('request.jwt.claims', '', true);
END;
$hlp$;

-- Create an identity from a mention as U1 and return the new identity id.
CREATE FUNCTION pg_temp.create_identity_u1(
  p_paper uuid, p_index int, p_expected text, p_name text DEFAULT NULL)
RETURNS uuid LANGUAGE plpgsql AS $hlp$
DECLARE v_out jsonb;
BEGIN
  PERFORM set_config('request.jwt.claims', pg_temp.claims_u1(), true);
  SET LOCAL ROLE authenticated;
  SELECT public.create_author_identity_from_mention(p_paper, p_index, p_expected, p_name)
  INTO v_out;
  RESET ROLE;
  PERFORM set_config('request.jwt.claims', '', true);
  RETURN (v_out->>'identity_id')::uuid;
END;
$hlp$;

-- Count helpers, read with the suite's own (postgres) privileges.
CREATE FUNCTION pg_temp.link_count(p_paper uuid)
RETURNS int LANGUAGE sql AS
$hlp$ SELECT count(*)::int FROM public.author_identity_links WHERE paper_id = p_paper $hlp$;

CREATE FUNCTION pg_temp.identity_count(p_user uuid)
RETURNS int LANGUAGE sql AS
$hlp$ SELECT count(*)::int FROM public.author_identities WHERE user_id = p_user $hlp$;

-- The effective root of an identity, via the shipped helper.
CREATE FUNCTION pg_temp.root_of(p_user uuid, p_identity uuid)
RETURNS uuid LANGUAGE sql AS
$hlp$ SELECT public.author_identity_effective_root(p_user, p_identity) $hlp$;

-- ── Fixtures ────────────────────────────────────────────────────────────────

INSERT INTO auth.users (id, email) VALUES
  ('0a000000-0000-0000-0000-000000000001','identity-U1@paperlume.test'),
  ('0a000000-0000-0000-0000-000000000002','identity-U2@paperlume.test');

-- P1: a personal mention with a valid ORCID, plus an explicitly collective one.
INSERT INTO public.papers (id, user_id, title, authors, insert_order, created_at, author_provenance)
VALUES (
  '0a000000-0000-0000-0000-0000000000a1','0a000000-0000-0000-0000-000000000001',
  'Owned paper one', '["Stuart M Phillips","The GRADE Working Group"]'::jsonb, 401, '2026-01-01T00:00:00Z',
  '[{"source":"pubmed_api","source_field":"Author","kind":"personal","source_name":"Stuart M Phillips",
     "given_name":"Stuart","family_name":"Phillips","initials":"SM","suffix":null,"collective_name":null,
     "affiliations":[],"identifiers":[{"scheme":"ORCID","value":"0000-0002-1825-0097"}],
     "orcid":"0000-0002-1825-0097","orcid_authenticated":null},
    {"source":"pubmed_api","source_field":"CollectiveName","kind":"collective",
     "source_name":"The GRADE Working Group","given_name":null,"family_name":null,"initials":null,
     "suffix":null,"collective_name":"The GRADE Working Group","affiliations":[],"identifiers":[],
     "orcid":null,"orcid_authenticated":null}]'::jsonb);

-- P2: a historical row with NULL provenance — most of a real library.
INSERT INTO public.papers (id, user_id, title, authors, insert_order, created_at)
VALUES ('0a000000-0000-0000-0000-0000000000a2','0a000000-0000-0000-0000-000000000001',
        'Owned paper two', '["S M Phillips","Jane Roe"]'::jsonb, 402, '2026-01-02T00:00:00Z');

-- P3: another owned paper, used for merge/duplicate scenarios.
INSERT INTO public.papers (id, user_id, title, authors, insert_order, created_at)
VALUES ('0a000000-0000-0000-0000-0000000000a3','0a000000-0000-0000-0000-000000000001',
        'Owned paper three', '["A One","B Two"]'::jsonb, 403, '2026-01-03T00:00:00Z');

-- A paper belonging to the OTHER user. Never linkable by U1.
INSERT INTO public.papers (id, user_id, title, authors, insert_order, created_at)
VALUES ('0a000000-0000-0000-0000-0000000000b1','0a000000-0000-0000-0000-000000000002',
        'Foreign paper', '["Someone Else"]'::jsonb, 404, '2026-01-04T00:00:00Z');

SELECT plan(134);

-- ══ 1. Shape and security posture ═══════════════════════════════════════════

SELECT has_table('public', 'author_identities', 'table: author_identities exists');
SELECT has_table('public', 'author_identity_aliases', 'table: author_identity_aliases exists');
SELECT has_table('public', 'author_identity_links', 'table: author_identity_links exists');
SELECT has_table('public', 'author_identity_merges', 'table: author_identity_merges exists');

SELECT ok(
  (SELECT bool_and(c.relrowsecurity AND c.relforcerowsecurity)
   FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public'
     AND c.relname IN ('author_identities','author_identity_aliases',
                       'author_identity_links','author_identity_merges')),
  'rls: enabled AND forced on all four identity tables');

SELECT ok(
  NOT EXISTS (
    SELECT 1 FROM information_schema.role_table_grants
    WHERE table_schema = 'public'
      AND table_name IN ('author_identities','author_identity_aliases',
                         'author_identity_links','author_identity_merges')
      AND grantee IN ('anon', 'service_role', 'PUBLIC')),
  'grants: anon, service_role and PUBLIC hold nothing on any identity table');

-- Links and merge edges are read-only to clients so no row write can bypass the
-- validation the RPCs perform.
SELECT ok(
  NOT has_table_privilege('authenticated', 'public.author_identity_links', 'INSERT, UPDATE, DELETE')
  AND NOT has_table_privilege('authenticated', 'public.author_identity_merges', 'INSERT, UPDATE, DELETE'),
  'grants: authenticated cannot write links or merge edges directly');

-- Deleting an identity row directly would cascade its links and aliases away.
SELECT ok(
  NOT has_table_privilege('authenticated', 'public.author_identities', 'DELETE')
  AND NOT has_table_privilege('authenticated', 'public.author_identities', 'INSERT'),
  'grants: authenticated cannot insert or delete an identity row directly');

SELECT ok(
  has_column_privilege('authenticated', 'public.author_identities', 'preferred_name', 'UPDATE')
  AND NOT has_column_privilege('authenticated', 'public.author_identities', 'user_id', 'UPDATE'),
  'grants: renaming is permitted; re-owning the row is not');

-- Two people genuinely share a name, and two users may reach different
-- conclusions about the same ORCID. Either uniqueness rule would turn this
-- user-scoped feature into a global registry.
-- Matched on the indexed COLUMN, not on the index definition text: every index
-- on `author_identity_aliases` mentions the word "alias" in its own name.
SELECT ok(
  NOT EXISTS (
    SELECT 1 FROM pg_index i
    JOIN pg_class c ON c.oid = i.indrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = ANY (i.indkey)
    WHERE n.nspname = 'public'
      AND c.relname IN ('author_identities','author_identity_aliases')
      AND i.indisunique
      AND a.attname IN ('preferred_name', 'alias')),
  'schema: no global uniqueness on a preferred name or an alias');

SELECT ok(
  (SELECT count(*)::int FROM public.author_identities)
  + (SELECT count(*)::int FROM public.author_identity_links) = 0,
  'migration: no identity or link was backfilled from existing papers');


-- ══ 2. Creating an identity from a mention ══════════════════════════════════

-- Authentication is the boundary, not RLS: these functions run as an owner that
-- bypasses RLS, so a null auth.uid() must be refused explicitly.
SELECT is(pg_temp.errcode_as('authenticated', NULL,
  $q$SELECT public.create_author_identity_from_mention(
       '0a000000-0000-0000-0000-0000000000a1'::uuid, 0, 'Stuart M Phillips', NULL)$q$),
  'P0001', 'create: an unauthenticated caller is refused');

SELECT is(pg_temp.errcode_as('anon', NULL,
  $q$SELECT public.create_author_identity_from_mention(
       '0a000000-0000-0000-0000-0000000000a1'::uuid, 0, 'Stuart M Phillips', NULL)$q$),
  '42501', 'create: anon cannot execute the function at all');

SELECT is(pg_temp.errcode_as('authenticated', pg_temp.claims_u1(),
  $q$SELECT public.create_author_identity_from_mention(
       '0a000000-0000-0000-0000-0000000000b1'::uuid, 0, 'Someone Else', NULL)$q$),
  'P0001', 'create: another user''s paper is not found');

SELECT is(pg_temp.errcode_as('authenticated', pg_temp.claims_u1(),
  $q$SELECT public.create_author_identity_from_mention(
       '0a000000-0000-0000-0000-0000000000a1'::uuid, 7, 'Stuart M Phillips', NULL)$q$),
  'P0001', 'create: an out-of-range author index is refused');

SELECT is(pg_temp.errcode_as('authenticated', pg_temp.claims_u1(),
  $q$SELECT public.create_author_identity_from_mention(
       '0a000000-0000-0000-0000-0000000000a1'::uuid, -1, 'Stuart M Phillips', NULL)$q$),
  'P0001', 'create: a negative author index is refused');

-- The stale-mention guard. Exact, not the 001A fold: the point is to detect that
-- the stored text moved under the user, and a punctuation-only edit moved it.
SELECT is(pg_temp.errcode_as('authenticated', pg_temp.claims_u1(),
  $q$SELECT public.create_author_identity_from_mention(
       '0a000000-0000-0000-0000-0000000000a1'::uuid, 0, 'Stuart M. Phillips', NULL)$q$),
  'P0001', 'create: an expected author that differs from current state is refused');

-- An explicitly collective author is not a person, and no user intent makes it
-- one. Only `kind = collective` is refused; wording is never inspected.
SELECT is(pg_temp.errcode_as('authenticated', pg_temp.claims_u1(),
  $q$SELECT public.create_author_identity_from_mention(
       '0a000000-0000-0000-0000-0000000000a1'::uuid, 1, 'The GRADE Working Group', NULL)$q$),
  'P0001', 'create: an explicitly collective mention cannot become a person');

SELECT is(
  (SELECT count(*)::int FROM public.author_identities),
  0,
  'create: every rejection so far was provably side-effect free');

-- The happy path, and the one that matters most: a historical row with NULL
-- provenance stays manually resolvable. Refusing it would make the feature
-- useless on a real library.
SELECT lives_ok(
  $q$SELECT pg_temp.create_identity_u1(
       '0a000000-0000-0000-0000-0000000000a2'::uuid, 0, 'S M Phillips', 'Stuart M Phillips')$q$,
  'create: a mention with no provenance at all is resolvable by hand');

SELECT is(
  (SELECT count(*)::int FROM public.author_identity_links
   WHERE paper_id = '0a000000-0000-0000-0000-0000000000a2' AND author_index = 0),
  1,
  'create: the identity arrives with the link that justifies it');

SELECT is(
  (SELECT resolution_basis FROM public.author_identity_links
   WHERE paper_id = '0a000000-0000-0000-0000-0000000000a2' AND author_index = 0),
  'created_from_mention',
  'create: the link records the path the decision came through');

SELECT is(
  (SELECT author_name_snapshot FROM public.author_identity_links
   WHERE paper_id = '0a000000-0000-0000-0000-0000000000a2' AND author_index = 0),
  'S M Phillips',
  'create: the snapshot records what the mention said, not the person''s name');

SELECT is(
  (SELECT preferred_name FROM public.author_identities LIMIT 1),
  'Stuart M Phillips',
  'create: the preferred name is the label the user confirmed');

-- Blank falls back to the current author string, so the RPC is correct alone.
-- Created in its own statement: a row a function inserts mid-query is not
-- visible to that same query's snapshot, so asserting on it inline would read
-- nothing however correct the function is.
SELECT lives_ok(
  $q$SELECT pg_temp.create_identity_u1(
       '0a000000-0000-0000-0000-0000000000a2'::uuid, 1, 'Jane Roe', '   ')$q$,
  'create: a blank preferred name is accepted');

SELECT is(
  (SELECT count(*)::int FROM public.author_identities
   WHERE user_id = '0a000000-0000-0000-0000-000000000001' AND preferred_name = 'Jane Roe'),
  1,
  'create: a blank preferred name falls back to the current author string');

-- ══ 3. Linking an existing identity ═════════════════════════════════════════

-- U2 creates an identity of their own; U1 must never reach it.
INSERT INTO public.author_identities (id, user_id, preferred_name)
VALUES ('0a000000-0000-0000-0000-00000000c002','0a000000-0000-0000-0000-000000000002','Foreign Person');

SELECT is(pg_temp.errcode_as('authenticated', pg_temp.claims_u1(),
  $q$SELECT public.link_author_mention_to_identity(
       '0a000000-0000-0000-0000-0000000000a1'::uuid, 0, 'Stuart M Phillips',
       '0a000000-0000-0000-0000-00000000c002'::uuid, 'manual', false)$q$),
  'P0001', 'link: another user''s identity is not found');

SELECT is(pg_temp.errcode_as('authenticated', pg_temp.claims_u2(),
  $q$SELECT public.link_author_mention_to_identity(
       '0a000000-0000-0000-0000-0000000000a1'::uuid, 0, 'Stuart M Phillips',
       '0a000000-0000-0000-0000-00000000c002'::uuid, 'manual', false)$q$),
  'P0001', 'link: another user''s paper cannot be attached to an owned identity');

SELECT is(
  (SELECT count(*)::int FROM public.author_identity_links
   WHERE identity_id = '0a000000-0000-0000-0000-00000000c002'),
  0,
  'link: no cross-user link was created by either attempt');

-- The same guards as create, because the same thing is being asserted.
SELECT is(pg_temp.errcode_as('authenticated', pg_temp.claims_u1(),
  $q$SELECT public.link_author_mention_to_identity(
       '0a000000-0000-0000-0000-0000000000a1'::uuid, 1, 'The GRADE Working Group',
       (SELECT id FROM public.author_identities
        WHERE user_id = '0a000000-0000-0000-0000-000000000001'
          AND preferred_name = 'Stuart M Phillips'),
       'manual', false)$q$),
  'P0001', 'link: an explicitly collective mention is refused here too');

SELECT is(pg_temp.errcode_as('authenticated', pg_temp.claims_u1(),
  $q$SELECT public.link_author_mention_to_identity(
       '0a000000-0000-0000-0000-0000000000a1'::uuid, 0, 'Stuart M. Phillips',
       (SELECT id FROM public.author_identities
        WHERE user_id = '0a000000-0000-0000-0000-000000000001'
          AND preferred_name = 'Stuart M Phillips'),
       'manual', false)$q$),
  'P0001', 'link: a stale expected author is refused here too');

-- A basis outside the closed set is a caller bug, not data to store.
SELECT is(pg_temp.errcode_as('authenticated', pg_temp.claims_u1(),
  $q$SELECT public.link_author_mention_to_identity(
       '0a000000-0000-0000-0000-0000000000a1'::uuid, 0, 'Stuart M Phillips',
       (SELECT id FROM public.author_identities
        WHERE user_id = '0a000000-0000-0000-0000-000000000001'
          AND preferred_name = 'Stuart M Phillips'),
       'ai_guess', false)$q$),
  'P0001', 'link: an unknown resolution basis is refused');

-- 'created_from_mention' is reserved for the create RPC, so a link's basis
-- always names the path that actually produced it.
SELECT is(pg_temp.errcode_as('authenticated', pg_temp.claims_u1(),
  $q$SELECT public.link_author_mention_to_identity(
       '0a000000-0000-0000-0000-0000000000a1'::uuid, 0, 'Stuart M Phillips',
       (SELECT id FROM public.author_identities
        WHERE user_id = '0a000000-0000-0000-0000-000000000001'
          AND preferred_name = 'Stuart M Phillips'),
       'created_from_mention', false)$q$),
  'P0001', 'link: the create-only basis cannot be claimed by a link');

SELECT lives_ok(
  $q$SELECT pg_temp.run_as(pg_temp.claims_u1(),
       $inner$SELECT public.link_author_mention_to_identity(
         '0a000000-0000-0000-0000-0000000000a1'::uuid, 0, 'Stuart M Phillips',
         (SELECT id FROM public.author_identities
          WHERE user_id = '0a000000-0000-0000-0000-000000000001'
            AND preferred_name = 'Stuart M Phillips'),
         'orcid_candidate', false)$inner$)$q$,
  'link: an owned mention links to an owned identity');

SELECT is(
  (SELECT count(*)::int FROM public.author_identity_links
   WHERE identity_id = (SELECT id FROM public.author_identities
                        WHERE user_id = '0a000000-0000-0000-0000-000000000001'
                          AND preferred_name = 'Stuart M Phillips')),
  2,
  'link: the identity now holds both mentions the user resolved to it');

-- A candidate action, a search result or a stray double-click must never
-- silently displace a decision the user already made about that mention.
SELECT is(pg_temp.errcode_as('authenticated', pg_temp.claims_u1(),
  $q$SELECT public.link_author_mention_to_identity(
       '0a000000-0000-0000-0000-0000000000a1'::uuid, 0, 'Stuart M Phillips',
       (SELECT id FROM public.author_identities
        WHERE user_id = '0a000000-0000-0000-0000-000000000001'
          AND preferred_name = 'Jane Roe'),
       'manual', false)$q$),
  'P0001', 'link: replacing an existing link without the explicit flag is refused');

SELECT lives_ok(
  $q$SELECT pg_temp.run_as(pg_temp.claims_u1(),
       $inner$SELECT public.link_author_mention_to_identity(
         '0a000000-0000-0000-0000-0000000000a1'::uuid, 0, 'Stuart M Phillips',
         (SELECT id FROM public.author_identities
          WHERE user_id = '0a000000-0000-0000-0000-000000000001'
            AND preferred_name = 'Jane Roe'),
         'manual', true)$inner$)$q$,
  'link: replacement succeeds when the caller asks for it explicitly');

SELECT is(pg_temp.link_count('0a000000-0000-0000-0000-0000000000a1'), 1,
  'link: replacement left exactly one link on that position');

-- Two mentions on ONE paper may resolve to one person: a paper may genuinely
-- list someone twice. Restore the first link and add a second position.
SELECT lives_ok(
  $q$SELECT pg_temp.run_as(pg_temp.claims_u1(),
       $inner$SELECT public.link_author_mention_to_identity(
         '0a000000-0000-0000-0000-0000000000a3'::uuid, 0, 'A One',
         (SELECT id FROM public.author_identities
          WHERE user_id = '0a000000-0000-0000-0000-000000000001'
            AND preferred_name = 'Jane Roe'),
         'manual', false)$inner$);
     SELECT pg_temp.run_as(pg_temp.claims_u1(),
       $inner$SELECT public.link_author_mention_to_identity(
         '0a000000-0000-0000-0000-0000000000a3'::uuid, 1, 'B Two',
         (SELECT id FROM public.author_identities
          WHERE user_id = '0a000000-0000-0000-0000-000000000001'
            AND preferred_name = 'Jane Roe'),
         'manual', false)$inner$)$q$,
  'link: one identity may hold two positions on the same paper');

SELECT is(pg_temp.link_count('0a000000-0000-0000-0000-0000000000a3'), 2,
  'link: both positions on that paper are linked');

-- The uniqueness constraint is also the concurrency boundary: two tabs racing
-- to resolve one mention produce a winner and a conflict, not a silent
-- last-write-wins over someone's decision.
SELECT throws_ok(
  $q$INSERT INTO public.author_identity_links
       (user_id, identity_id, paper_id, author_index, author_name_snapshot, resolution_basis)
     VALUES ('0a000000-0000-0000-0000-000000000001',
             (SELECT id FROM public.author_identities
              WHERE user_id = '0a000000-0000-0000-0000-000000000001' LIMIT 1),
             '0a000000-0000-0000-0000-0000000000a3', 0, 'A One', 'manual')$q$,
  '23505',
  NULL,
  'link: a second link on the same (paper, author_index) is rejected');

-- ══ 4. Aliases ══════════════════════════════════════════════════════════════

SELECT lives_ok(
  $q$SELECT pg_temp.run_as(pg_temp.claims_u1(),
       $inner$INSERT INTO public.author_identity_aliases (user_id, identity_id, alias)
              VALUES ('0a000000-0000-0000-0000-000000000001',
                      (SELECT id FROM public.author_identities
                       WHERE user_id = '0a000000-0000-0000-0000-000000000001'
                         AND preferred_name = 'Stuart M Phillips'),
                      'Phillips SM')$inner$)$q$,
  'alias: a user may name their own identity directly');

-- Composite foreign key: an alias and the identity it names must belong to the
-- same account, so a cross-user pair cannot be STORED, not merely cannot be
-- reached through the API.
SELECT isnt(pg_temp.errcode_as('authenticated', pg_temp.claims_u1(),
  $q$INSERT INTO public.author_identity_aliases (user_id, identity_id, alias)
     VALUES ('0a000000-0000-0000-0000-000000000001',
             '0a000000-0000-0000-0000-00000000c002', 'Stolen Name')$q$),
  '00000', 'alias: attaching an alias to another user''s identity is rejected');

SELECT isnt(pg_temp.errcode_as('authenticated', pg_temp.claims_u1(),
  $q$INSERT INTO public.author_identity_aliases (user_id, identity_id, alias)
     VALUES ('0a000000-0000-0000-0000-000000000002',
             '0a000000-0000-0000-0000-00000000c002', 'Stolen Name')$q$),
  '00000', 'alias: a user cannot write a row owned by another user');

SELECT isnt(pg_temp.errcode_as('authenticated', pg_temp.claims_u1(),
  $q$INSERT INTO public.author_identity_aliases (user_id, identity_id, alias)
     VALUES ('0a000000-0000-0000-0000-000000000001',
             (SELECT id FROM public.author_identities
              WHERE user_id = '0a000000-0000-0000-0000-000000000001' LIMIT 1), '   ')$q$),
  '00000', 'alias: a blank alias is rejected');

-- ══ 5. Cross-user reads ═════════════════════════════════════════════════════

SELECT lives_ok(
  $q$SELECT pg_temp.run_as(pg_temp.claims_u2(),
       $inner$DO $chk$
         BEGIN
           IF (SELECT count(*) FROM public.author_identities) <> 1 THEN
             RAISE EXCEPTION 'U2 sees % identities, expected only their own',
               (SELECT count(*) FROM public.author_identities);
           END IF;
           IF (SELECT count(*) FROM public.author_identity_links) <> 0 THEN
             RAISE EXCEPTION 'U2 can see another user''s links';
           END IF;
           IF (SELECT count(*) FROM public.author_identity_aliases) <> 0 THEN
             RAISE EXCEPTION 'U2 can see another user''s aliases';
           END IF;
           IF (SELECT count(*) FROM public.author_identity_merges) <> 0 THEN
             RAISE EXCEPTION 'U2 can see another user''s merge edges';
           END IF;
         END
       $chk$$inner$)$q$,
  'rls: U2 sees only their own identity data across all four tables');

-- ══ 5b. Structural ownership — the graph cannot HOLD a cross-account edge ═══
--
-- Everything above proves the RPCs refuse a cross-user relationship and that RLS
-- hides one. Both are policy: they describe what the application and the policy
-- engine will do, not what the database is capable of storing. This section
-- proves the stronger claim the migration header makes — that the row is not
-- representable — by writing it DIRECTLY as a privileged role, with RLS bypassed
-- and no RPC involved. If only policy stood in the way, these inserts would
-- succeed here.

SELECT ok(
  EXISTS (SELECT 1 FROM pg_constraint
          WHERE conrelid = 'public.papers'::regclass
            AND conname  = 'papers_user_id_id_key'
            AND contype  = 'u'
            AND pg_get_constraintdef(oid) = 'UNIQUE (user_id, id)'),
  'ownership: papers carries the (user_id, id) key a composite reference needs');

-- Additive, never a replacement. `papers.id` remains the primary key, so every
-- existing single-column reference to a paper is untouched.
SELECT ok(
  EXISTS (SELECT 1 FROM pg_constraint
          WHERE conrelid = 'public.papers'::regclass
            AND contype  = 'p'
            AND pg_get_constraintdef(oid) = 'PRIMARY KEY (id)'),
  'ownership: papers keeps its original PRIMARY KEY (id)');

SELECT is(
  (SELECT pg_get_constraintdef(oid) FROM pg_constraint
   WHERE conrelid = 'public.author_identity_links'::regclass
     AND conname  = 'author_identity_links_paper_fk'),
  'FOREIGN KEY (user_id, paper_id) REFERENCES papers(user_id, id) ON DELETE CASCADE',
  'ownership: the link→paper edge is user-scoped and cascades');

-- A surviving single-column reference would make the composite one decorative:
-- the row would satisfy the loose constraint and never be checked against the
-- strict one.
SELECT is(
  (SELECT count(*)::int
     FROM pg_constraint c
    WHERE c.contype   = 'f'
      AND c.conrelid  = 'public.author_identity_links'::regclass
      AND c.confrelid = 'public.papers'::regclass
      AND array_length(c.conkey, 1) = 1),
  0,
  'ownership: no single-column paper reference survives alongside it');

-- The general rule, so a future edge added without `user_id` fails here rather
-- than silently reopening the hole.
SELECT is(
  (SELECT count(*)::int
     FROM pg_constraint c
     JOIN pg_class ch      ON ch.oid = c.conrelid
     JOIN pg_namespace chn ON chn.oid = ch.relnamespace
    WHERE c.contype = 'f'
      AND chn.nspname = 'public'
      AND ch.relname IN ('author_identities', 'author_identity_aliases',
                         'author_identity_links', 'author_identity_merges')
      AND NOT EXISTS (
        SELECT 1
          FROM unnest(c.conkey) AS k(attnum)
          JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum
         WHERE a.attname = 'user_id')),
  0,
  'ownership: every foreign key out of the identity tables carries user_id');

-- A paper of U1's that nothing else in this suite touches, so the positive
-- control below cannot disturb any later section. Removed again at the end.
INSERT INTO public.papers (id, user_id, title, authors, insert_order, created_at)
VALUES ('0a000000-0000-0000-0000-0000000000a9','0a000000-0000-0000-0000-000000000001',
        'Ownership probe paper', '["Probe Author"]'::jsonb, 409, '2026-01-09T00:00:00Z');

-- THE TEST THAT MATTERS. U1's own user_id, U1's own identity, U2's paper: every
-- value individually legitimate, the combination a relationship across an
-- account boundary. Written as `postgres`, which holds BYPASSRLS — so RLS is not
-- what rejects it, and neither is an RPC, because none is called.
SELECT is(pg_temp.errcode_as('postgres', NULL, $q$
    INSERT INTO public.author_identity_links
      (user_id, identity_id, paper_id, author_index, author_name_snapshot, resolution_basis)
    SELECT '0a000000-0000-0000-0000-000000000001'::uuid,
           (SELECT id FROM public.author_identities
             WHERE user_id = '0a000000-0000-0000-0000-000000000001'
             ORDER BY created_at, id LIMIT 1),
           '0a000000-0000-0000-0000-0000000000b1'::uuid,
           0, 'Someone Else', 'manual'
  $q$),
  '23503',
  'ownership: a privileged direct write cannot link U1''s person to U2''s paper');

-- The positive control. Identical statement, U1's own paper: it succeeds. So the
-- rejection above is about ownership, not about the statement being malformed or
-- the role lacking privilege.
SELECT is(pg_temp.errcode_as('postgres', NULL, $q$
    INSERT INTO public.author_identity_links
      (user_id, identity_id, paper_id, author_index, author_name_snapshot, resolution_basis)
    SELECT '0a000000-0000-0000-0000-000000000001'::uuid,
           (SELECT id FROM public.author_identities
             WHERE user_id = '0a000000-0000-0000-0000-000000000001'
             ORDER BY created_at, id LIMIT 1),
           '0a000000-0000-0000-0000-0000000000a9'::uuid,
           0, 'Probe Author', 'manual'
  $q$),
  '00000',
  'ownership: the same write against the caller''s own paper is accepted');

SELECT is(pg_temp.link_count('0a000000-0000-0000-0000-0000000000b1'), 0,
  'ownership: the rejected cross-account write stored nothing');

-- Deleting the probe paper cascades its one link away through the composite FK,
-- which also demonstrates the cascade still works in its new two-column form.
DELETE FROM public.papers WHERE id = '0a000000-0000-0000-0000-0000000000a9';

SELECT is(pg_temp.link_count('0a000000-0000-0000-0000-0000000000a9'), 0,
  'ownership: the composite foreign key still cascades on paper delete');


-- ══ 6. Unlinking ════════════════════════════════════════════════════════════

SELECT lives_ok(
  $q$SELECT pg_temp.run_as(pg_temp.claims_u1(),
       $inner$SELECT public.unlink_author_mention_identity(
         '0a000000-0000-0000-0000-0000000000a3'::uuid, 1)$inner$)$q$,
  'unlink: a user can reverse their own link');

SELECT is(pg_temp.link_count('0a000000-0000-0000-0000-0000000000a3'), 1,
  'unlink: exactly the named position was released');

SELECT is(
  (SELECT authors::text FROM public.papers WHERE id = '0a000000-0000-0000-0000-0000000000a3'),
  '["A One", "B Two"]',
  'unlink: no paper data was touched');

-- U2 must not be able to release U1's decision.
SELECT lives_ok(
  $q$SELECT pg_temp.run_as(pg_temp.claims_u2(),
       $inner$SELECT public.unlink_author_mention_identity(
         '0a000000-0000-0000-0000-0000000000a3'::uuid, 0)$inner$)$q$,
  'unlink: another user''s call is accepted but scoped');

SELECT is(pg_temp.link_count('0a000000-0000-0000-0000-0000000000a3'), 1,
  'unlink: it deleted nothing, because the predicate is scoped to the caller');


-- ══ 7. The merge graph ══════════════════════════════════════════════════════
-- Three fresh identities on paper three, so the merge scenarios are independent
-- of everything above.

INSERT INTO public.author_identities (id, user_id, preferred_name) VALUES
  ('0a000000-0000-0000-0000-0000000000e1','0a000000-0000-0000-0000-000000000001','Merge A'),
  ('0a000000-0000-0000-0000-0000000000e2','0a000000-0000-0000-0000-000000000001','Merge B'),
  ('0a000000-0000-0000-0000-0000000000e3','0a000000-0000-0000-0000-000000000001','Merge C');

SELECT is(pg_temp.errcode_as('authenticated', pg_temp.claims_u1(),
  $q$SELECT public.merge_author_identities(
       '0a000000-0000-0000-0000-0000000000e1'::uuid,
       '0a000000-0000-0000-0000-0000000000e1'::uuid)$q$),
  'P0001', 'merge: an identity cannot be merged into itself');

SELECT is(pg_temp.errcode_as('authenticated', pg_temp.claims_u1(),
  $q$SELECT public.merge_author_identities(
       '0a000000-0000-0000-0000-0000000000e1'::uuid,
       '0a000000-0000-0000-0000-00000000c002'::uuid)$q$),
  'P0001', 'merge: a target owned by another user is not found');

SELECT is(pg_temp.errcode_as('authenticated', pg_temp.claims_u2(),
  $q$SELECT public.merge_author_identities(
       '0a000000-0000-0000-0000-00000000c002'::uuid,
       '0a000000-0000-0000-0000-0000000000e1'::uuid)$q$),
  'P0001', 'merge: a source owned by the caller cannot reach another user''s target');

SELECT is((SELECT count(*)::int FROM public.author_identity_merges), 0,
  'merge: no cross-user edge was created');

SELECT lives_ok(
  $q$SELECT pg_temp.run_as(pg_temp.claims_u1(),
       $inner$SELECT public.merge_author_identities(
         '0a000000-0000-0000-0000-0000000000e1'::uuid,
         '0a000000-0000-0000-0000-0000000000e2'::uuid)$inner$)$q$,
  'merge: A into B succeeds');

SELECT lives_ok(
  $q$SELECT pg_temp.run_as(pg_temp.claims_u1(),
       $inner$SELECT public.merge_author_identities(
         '0a000000-0000-0000-0000-0000000000e2'::uuid,
         '0a000000-0000-0000-0000-0000000000e3'::uuid)$inner$)$q$,
  'merge: B into C succeeds, forming a chain');

SELECT is(pg_temp.root_of('0a000000-0000-0000-0000-000000000001',
                          '0a000000-0000-0000-0000-0000000000e1'),
          '0a000000-0000-0000-0000-0000000000e3'::uuid,
  'merge: A resolves through B to C');

SELECT is(pg_temp.root_of('0a000000-0000-0000-0000-000000000001',
                          '0a000000-0000-0000-0000-0000000000e2'),
          '0a000000-0000-0000-0000-0000000000e3'::uuid,
  'merge: B resolves to C');

SELECT is(pg_temp.root_of('0a000000-0000-0000-0000-000000000001',
                          '0a000000-0000-0000-0000-0000000000e3'),
          '0a000000-0000-0000-0000-0000000000e3'::uuid,
  'merge: C is its own root');

-- One outgoing edge per identity: enforced by the primary key, and reported as
-- an explanation rather than a constraint violation.
SELECT is(pg_temp.errcode_as('authenticated', pg_temp.claims_u1(),
  $q$SELECT public.merge_author_identities(
       '0a000000-0000-0000-0000-0000000000e1'::uuid,
       '0a000000-0000-0000-0000-0000000000e3'::uuid)$q$),
  'P0001', 'merge: an identity that already has an outgoing edge is refused');

-- C already resolves through nothing, but A resolves to C — so merging C into A
-- would close a loop and leave no identity in it with a root.
SELECT is(pg_temp.errcode_as('authenticated', pg_temp.claims_u1(),
  $q$SELECT public.merge_author_identities(
       '0a000000-0000-0000-0000-0000000000e3'::uuid,
       '0a000000-0000-0000-0000-0000000000e1'::uuid)$q$),
  'P0001', 'merge: an edge that would create a cycle is refused');

SELECT is((SELECT count(*)::int FROM public.author_identity_merges), 2,
  'merge: the refused attempts left the graph exactly as it was');

-- Merging into an already-merged identity records the ROOT, because choosing a
-- member of a cluster means choosing the cluster.
INSERT INTO public.author_identities (id, user_id, preferred_name)
VALUES ('0a000000-0000-0000-0000-0000000000e4','0a000000-0000-0000-0000-000000000001','Merge D');

SELECT lives_ok(
  $q$SELECT pg_temp.run_as(pg_temp.claims_u1(),
       $inner$SELECT public.merge_author_identities(
         '0a000000-0000-0000-0000-0000000000e4'::uuid,
         '0a000000-0000-0000-0000-0000000000e1'::uuid)$inner$)$q$,
  'merge: D into A (which is merged away) succeeds');

SELECT is(
  (SELECT target_identity_id FROM public.author_identity_merges
   WHERE source_identity_id = '0a000000-0000-0000-0000-0000000000e4'),
  '0a000000-0000-0000-0000-0000000000e3'::uuid,
  'merge: the stored edge points at the cluster''s root, not the named member');

-- ══ 8. Unmerge removes exactly one edge ═════════════════════════════════════

SELECT lives_ok(
  $q$SELECT pg_temp.run_as(pg_temp.claims_u1(),
       $inner$SELECT public.unmerge_author_identity(
         '0a000000-0000-0000-0000-0000000000e1'::uuid)$inner$)$q$,
  'unmerge: A''s own edge is removed');

SELECT is(pg_temp.root_of('0a000000-0000-0000-0000-000000000001',
                          '0a000000-0000-0000-0000-0000000000e1'),
          '0a000000-0000-0000-0000-0000000000e1'::uuid,
  'unmerge: A is its own identity again');

-- The rest of the chain is untouched: B -> C was always an independent row.
SELECT is(pg_temp.root_of('0a000000-0000-0000-0000-000000000001',
                          '0a000000-0000-0000-0000-0000000000e2'),
          '0a000000-0000-0000-0000-0000000000e3'::uuid,
  'unmerge: B still resolves to C');

SELECT is(
  (SELECT count(*)::int FROM public.author_identity_merges
   WHERE source_identity_id = '0a000000-0000-0000-0000-0000000000e1'),
  0, 'unmerge: exactly one edge was deleted');

SELECT lives_ok(
  $q$SELECT pg_temp.run_as(pg_temp.claims_u2(),
       $inner$SELECT public.unmerge_author_identity(
         '0a000000-0000-0000-0000-0000000000e2'::uuid)$inner$)$q$,
  'unmerge: another user''s call is accepted but scoped');

SELECT is(
  (SELECT count(*)::int FROM public.author_identity_merges
   WHERE source_identity_id = '0a000000-0000-0000-0000-0000000000e2'),
  1, 'unmerge: it removed nothing belonging to U1');

-- Nothing was ever moved, which is what makes the undo above a restoration
-- rather than a reconstruction.
SELECT is(
  (SELECT count(*)::int FROM public.author_identity_links
   WHERE identity_id = '0a000000-0000-0000-0000-0000000000e1'),
  0, 'merge: a merge moved no link onto or off the source identity');

-- ══ 9. Deletion semantics ═══════════════════════════════════════════════════

SELECT is(pg_temp.errcode_as('authenticated', pg_temp.claims_u1(),
  $q$SELECT public.delete_empty_author_identity(
       (SELECT id FROM public.author_identities
        WHERE user_id = '0a000000-0000-0000-0000-000000000001'
          AND preferred_name = 'Stuart M Phillips'))$q$),
  'P0001', 'delete: an identity holding linked mentions is refused');

SELECT is(pg_temp.errcode_as('authenticated', pg_temp.claims_u1(),
  $q$SELECT public.delete_empty_author_identity(
       '0a000000-0000-0000-0000-0000000000e2'::uuid)$q$),
  'P0001', 'delete: an identity with an outgoing merge edge is refused');

SELECT is(pg_temp.errcode_as('authenticated', pg_temp.claims_u1(),
  $q$SELECT public.delete_empty_author_identity(
       '0a000000-0000-0000-0000-0000000000e3'::uuid)$q$),
  'P0001', 'delete: an identity with an incoming merge edge is refused');

SELECT is(pg_temp.errcode_as('authenticated', pg_temp.claims_u1(),
  $q$SELECT public.delete_empty_author_identity(
       '0a000000-0000-0000-0000-00000000c002'::uuid)$q$),
  'P0001', 'delete: another user''s identity is not found');

INSERT INTO public.author_identities (id, user_id, preferred_name)
VALUES ('0a000000-0000-0000-0000-0000000000e9','0a000000-0000-0000-0000-000000000001','Quite Empty');

SELECT lives_ok(
  $q$SELECT pg_temp.run_as(pg_temp.claims_u1(),
       $inner$SELECT public.delete_empty_author_identity(
         '0a000000-0000-0000-0000-0000000000e9'::uuid)$inner$)$q$,
  'delete: an identity carrying nothing is removed');

SELECT is(
  (SELECT count(*)::int FROM public.author_identities
   WHERE id = '0a000000-0000-0000-0000-0000000000e9'),
  0, 'delete: the empty identity is gone');

-- An alias alone is enough to refuse, so "Delete person" can never become an
-- implicit "discard every name I recorded for them".
INSERT INTO public.author_identities (id, user_id, preferred_name)
VALUES ('0a000000-0000-0000-0000-0000000000ea','0a000000-0000-0000-0000-000000000001','Alias Only');
INSERT INTO public.author_identity_aliases (user_id, identity_id, alias)
VALUES ('0a000000-0000-0000-0000-000000000001','0a000000-0000-0000-0000-0000000000ea','Only A Name');

SELECT is(pg_temp.errcode_as('authenticated', pg_temp.claims_u1(),
  $q$SELECT public.delete_empty_author_identity(
       '0a000000-0000-0000-0000-0000000000ea'::uuid)$q$),
  'P0001', 'delete: an identity holding only an alias is still refused');

-- ══ 10. Stale-link invalidation ═════════════════════════════════════════════
-- A link means "the author at index i of this paper is this person", so it is
-- only as valid as the text it names.

SELECT is(pg_temp.link_count('0a000000-0000-0000-0000-0000000000a2'), 2,
  'invalidation: paper two starts with both positions linked');

-- Unrelated columns must not disturb a decision. `UPDATE OF authors` plus the
-- WHEN clause means the function body is never even entered.
SELECT lives_ok(
  $q$SELECT pg_temp.run_as(pg_temp.claims_u1(),
       $inner$UPDATE public.papers SET notes = 'a note', year = 2021, title = 'Owned paper two (v2)'
              WHERE id = '0a000000-0000-0000-0000-0000000000a2'$inner$)$q$,
  'invalidation: editing notes, year and title is allowed');

SELECT is(pg_temp.link_count('0a000000-0000-0000-0000-0000000000a2'), 2,
  'invalidation: an unrelated column change preserves every link');

-- Re-assigning the identical value is a no-op. This matters: the paper edit path
-- submits the authors array on every save, and merge_exact_duplicates re-assigns
-- it unconditionally.
SELECT lives_ok(
  $q$SELECT pg_temp.run_as(pg_temp.claims_u1(),
       $inner$UPDATE public.papers SET authors = authors
              WHERE id = '0a000000-0000-0000-0000-0000000000a2'$inner$)$q$,
  'invalidation: re-assigning the same authors value is allowed');

SELECT is(pg_temp.link_count('0a000000-0000-0000-0000-0000000000a2'), 2,
  'invalidation: an identical re-assignment preserves every link');

-- Provenance is what a source stated; a link is what the USER decided. Re-fetching
-- metadata must not silently discard a human decision.
SELECT lives_ok(
  $q$SELECT pg_temp.run_as(pg_temp.claims_u1(),
       $inner$UPDATE public.papers
              SET author_provenance = '[{"source":"manual","source_field":"authors","kind":"unknown",
                    "source_name":"S M Phillips","given_name":null,"family_name":null,"initials":null,
                    "suffix":null,"collective_name":null,"affiliations":[],"identifiers":[],
                    "orcid":null,"orcid_authenticated":null},
                   {"source":"manual","source_field":"authors","kind":"unknown",
                    "source_name":"Jane Roe","given_name":null,"family_name":null,"initials":null,
                    "suffix":null,"collective_name":null,"affiliations":[],"identifiers":[],
                    "orcid":null,"orcid_authenticated":null}]'::jsonb
              WHERE id = '0a000000-0000-0000-0000-0000000000a2'$inner$)$q$,
  'invalidation: provenance may be replaced on its own');

SELECT is(pg_temp.link_count('0a000000-0000-0000-0000-0000000000a2'), 2,
  'invalidation: a provenance-only change preserves the user''s decisions');

-- A reorder is the dangerous case: every index now names a different human.
SELECT lives_ok(
  $q$SELECT pg_temp.run_as(pg_temp.claims_u1(),
       $inner$UPDATE public.papers SET authors = '["Jane Roe","S M Phillips"]'::jsonb
              WHERE id = '0a000000-0000-0000-0000-0000000000a2'$inner$)$q$,
  'invalidation: reordering the authors array is allowed');

SELECT is(pg_temp.link_count('0a000000-0000-0000-0000-0000000000a2'), 0,
  'invalidation: a reorder clears every link on that paper, atomically');

SELECT is(pg_temp.link_count('0a000000-0000-0000-0000-0000000000a3'), 1,
  'invalidation: links on other papers are untouched');

SELECT is(pg_temp.identity_count('0a000000-0000-0000-0000-000000000001') > 0, true,
  'invalidation: the identities themselves survive their links being cleared');

-- A spelling edit invalidates too: provenance and identity alike are bound to
-- the literal string, so a punctuation-only change is still a rewrite.
SELECT lives_ok(
  $q$SELECT pg_temp.run_as(pg_temp.claims_u1(),
       $inner$UPDATE public.papers SET authors = '["A One","B. Two"]'::jsonb
              WHERE id = '0a000000-0000-0000-0000-0000000000a3'$inner$)$q$,
  'invalidation: a spelling edit is allowed');

SELECT is(pg_temp.link_count('0a000000-0000-0000-0000-0000000000a3'), 0,
  'invalidation: a spelling edit clears that paper''s links');

-- ══ 11. Duplicate-paper merge interaction ═══════════════════════════════════
-- merge_exact_duplicates re-assigns the keep paper's authors unconditionally and
-- deletes the discards, so both halves of the invalidation contract are exercised.

INSERT INTO public.papers (id, user_id, title, authors, insert_order, created_at) VALUES
  ('0a000000-0000-0000-0000-0000000000d1','0a000000-0000-0000-0000-000000000001',
   'Duplicate keep', '["Keep Author"]'::jsonb, 411, '2026-02-01T00:00:00Z'),
  ('0a000000-0000-0000-0000-0000000000d2','0a000000-0000-0000-0000-000000000001',
   'Duplicate discard', '["Discard Author"]'::jsonb, 412, '2026-02-02T00:00:00Z');

SELECT lives_ok(
  $q$SELECT pg_temp.create_identity_u1(
       '0a000000-0000-0000-0000-0000000000d1'::uuid, 0, 'Keep Author', 'Keep Person');
     SELECT pg_temp.create_identity_u1(
       '0a000000-0000-0000-0000-0000000000d2'::uuid, 0, 'Discard Author', 'Discard Person')$q$,
  'duplicates: both papers have a linked identity before the merge');

SELECT lives_ok(
  $q$SELECT pg_temp.run_as(pg_temp.claims_u1(),
       $inner$SELECT public.merge_exact_duplicates(
         '0a000000-0000-0000-0000-0000000000d1'::uuid,
         ARRAY['0a000000-0000-0000-0000-0000000000d2'::uuid])$inner$)$q$,
  'duplicates: the merge succeeds');

SELECT is(pg_temp.link_count('0a000000-0000-0000-0000-0000000000d2'), 0,
  'duplicates: the discarded paper''s link disappeared with it, by cascade');

-- The keep paper's non-empty author list wins unchanged, so `IS DISTINCT FROM`
-- is false and its own link survives — the user's decision about a paper that
-- still exists is not collateral damage.
SELECT is(pg_temp.link_count('0a000000-0000-0000-0000-0000000000d1'), 1,
  'duplicates: the kept paper''s authors did not change, so its link survives');

SELECT is(
  (SELECT count(*)::int FROM public.author_identities
   WHERE user_id = '0a000000-0000-0000-0000-000000000001'
     AND preferred_name IN ('Keep Person','Discard Person')),
  2,
  'duplicates: neither identity was deleted because a paper disappeared');

-- Now the other half: a keep paper whose author list DOES change loses its links.
INSERT INTO public.papers (id, user_id, title, authors, insert_order, created_at) VALUES
  ('0a000000-0000-0000-0000-0000000000d3','0a000000-0000-0000-0000-000000000001',
   'Empty-author keep', '[]'::jsonb, 413, '2026-02-03T00:00:00Z'),
  ('0a000000-0000-0000-0000-0000000000d4','0a000000-0000-0000-0000-000000000001',
   'Author-bearing discard', '["Adopted Author"]'::jsonb, 414, '2026-02-04T00:00:00Z');

SELECT lives_ok(
  $q$SELECT pg_temp.create_identity_u1(
       '0a000000-0000-0000-0000-0000000000d4'::uuid, 0, 'Adopted Author', 'Adopted Person')$q$,
  'duplicates: the author-bearing discard has a linked identity');

SELECT lives_ok(
  $q$SELECT pg_temp.run_as(pg_temp.claims_u1(),
       $inner$SELECT public.merge_exact_duplicates(
         '0a000000-0000-0000-0000-0000000000d3'::uuid,
         ARRAY['0a000000-0000-0000-0000-0000000000d4'::uuid])$inner$)$q$,
  'duplicates: a keep paper with no authors adopts the discard''s list');

SELECT is(
  (SELECT authors::text FROM public.papers WHERE id = '0a000000-0000-0000-0000-0000000000d3'),
  '["Adopted Author"]',
  'duplicates: the keep paper''s authors really did change');

-- The adopted author string is identical, but it arrived on a DIFFERENT paper.
-- No link may survive by index onto text that moved between rows.
SELECT is(pg_temp.link_count('0a000000-0000-0000-0000-0000000000d3'), 0,
  'duplicates: a link is never inherited by the paper that adopted the authors');

-- ══ 12. Paper deletion ══════════════════════════════════════════════════════

SELECT lives_ok(
  $q$SELECT pg_temp.run_as(pg_temp.claims_u1(),
       $inner$DELETE FROM public.papers
              WHERE id = '0a000000-0000-0000-0000-0000000000d1'$inner$)$q$,
  'paper delete: the owner may delete their paper');

SELECT is(pg_temp.link_count('0a000000-0000-0000-0000-0000000000d1'), 0,
  'paper delete: its links cascade away');

SELECT is(
  (SELECT count(*)::int FROM public.author_identities
   WHERE user_id = '0a000000-0000-0000-0000-000000000001' AND preferred_name = 'Keep Person'),
  1,
  'paper delete: the identity survives — a person is not deleted with a paper');

-- ══ 12b. Repairing a stale link that survived the trigger ═══════════════════
--
-- Section 10 proves the trigger deletes a paper's links whenever its authors
-- change, so a link whose snapshot no longer matches its mention is unreachable
-- through this application. This section is about what happens if one exists
-- anyway — a privileged write, a restored backup, a future bug.
--
-- The read layer already refuses to obey such a row. The gap this closes is that
-- the user could then not REPAIR it: the UI correctly re-offered the mention as
-- unresolved, and every action it offered collided with the unique
-- (paper_id, author_index) constraint.
--
-- The repair is deliberately narrow. `p_replace_stale_existing` displaces only a
-- row the SERVER can prove is stale, from data it reads itself inside the locked
-- transaction. A valid decision is never overwritten by this path.

-- A fresh paper and a fresh identity, so nothing above or below is disturbed.
INSERT INTO public.papers (id, user_id, title, authors, insert_order, created_at)
VALUES ('0a000000-0000-0000-0000-0000000000e1','0a000000-0000-0000-0000-000000000001',
        'Stale repair paper', '["Current Author","Valid Author"]'::jsonb, 411, '2026-01-11T00:00:00Z');

-- A link recorded against text the paper no longer holds. Written directly,
-- because the application cannot produce this state — which is the point.
INSERT INTO public.author_identities (id, user_id, preferred_name)
VALUES ('0a000000-0000-0000-0000-0000000000f1','0a000000-0000-0000-0000-000000000001','Stale Person');

INSERT INTO public.author_identity_links
  (user_id, identity_id, paper_id, author_index, author_name_snapshot, resolution_basis)
VALUES ('0a000000-0000-0000-0000-000000000001','0a000000-0000-0000-0000-0000000000f1',
        '0a000000-0000-0000-0000-0000000000e1', 0, 'Author As Written Before', 'manual');

-- Without the flag the collision is reported as a decision that already exists,
-- rather than as a raw unique-constraint failure.
SELECT is(pg_temp.errcode_as('authenticated', pg_temp.claims_u1(),
  $q$SELECT public.create_author_identity_from_mention(
       '0a000000-0000-0000-0000-0000000000e1'::uuid, 0, 'Current Author', 'New Person')$q$),
  'P0001', 'stale repair: create without the flag refuses rather than colliding');

SELECT is(
  (SELECT author_name_snapshot FROM public.author_identity_links
   WHERE paper_id = '0a000000-0000-0000-0000-0000000000e1' AND author_index = 0),
  'Author As Written Before',
  'stale repair: the refused call left the stale row exactly as it was');

SELECT is(
  (SELECT count(*)::int FROM public.author_identities
   WHERE user_id = '0a000000-0000-0000-0000-000000000001' AND preferred_name = 'New Person'),
  0,
  'stale repair: and created no identity — the rejection is side-effect free');

-- A VALID link must survive the same call. This is the guard that keeps
-- `p_replace_stale_existing` from becoming a general overwrite switch: the
-- server compares the stored snapshot against the paper's current text itself,
-- so asking to replace a row that still matches is refused however the caller
-- asks.
SELECT lives_ok(
  $q$SELECT pg_temp.create_identity_u1(
       '0a000000-0000-0000-0000-0000000000e1'::uuid, 1, 'Valid Author', 'Valid Person')$q$,
  'stale repair: a second, valid decision is recorded normally');

SELECT is(pg_temp.errcode_as('authenticated', pg_temp.claims_u1(),
  $q$SELECT public.create_author_identity_from_mention(
       '0a000000-0000-0000-0000-0000000000e1'::uuid, 1, 'Valid Author',
       'Should Not Exist', true)$q$),
  'P0001', 'stale repair: a link that still matches is NOT replaceable by this path');

SELECT is(
  (SELECT preferred_name FROM public.author_identities i
   JOIN public.author_identity_links l ON l.identity_id = i.id
   WHERE l.paper_id = '0a000000-0000-0000-0000-0000000000e1' AND l.author_index = 1),
  'Valid Person',
  'stale repair: the valid decision is untouched');

SELECT is(
  (SELECT count(*)::int FROM public.author_identities
   WHERE user_id = '0a000000-0000-0000-0000-000000000001' AND preferred_name = 'Should Not Exist'),
  0,
  'stale repair: the refused overwrite created no orphan identity');

-- The repair itself.
SELECT lives_ok(
  $q$SELECT pg_temp.run_as(pg_temp.claims_u1(),
       $inner$SELECT public.create_author_identity_from_mention(
         '0a000000-0000-0000-0000-0000000000e1'::uuid, 0, 'Current Author',
         'Repaired Person', true)$inner$)$q$,
  'stale repair: an explicitly requested replacement of a provably stale row succeeds');

SELECT is(pg_temp.link_count('0a000000-0000-0000-0000-0000000000e1'), 2,
  'stale repair: one link per position — the stale row was replaced, not joined');

SELECT is(
  (SELECT author_name_snapshot FROM public.author_identity_links
   WHERE paper_id = '0a000000-0000-0000-0000-0000000000e1' AND author_index = 0),
  'Current Author',
  'stale repair: the surviving link describes the mention as it reads now');

SELECT is(
  (SELECT preferred_name FROM public.author_identities i
   JOIN public.author_identity_links l ON l.identity_id = i.id
   WHERE l.paper_id = '0a000000-0000-0000-0000-0000000000e1' AND l.author_index = 0),
  'Repaired Person',
  'stale repair: the mention now resolves to the person the user just created');

-- The displaced identity is NOT deleted. A merge or a rename may still reference
-- it, and destroying a person as a side effect of repairing a link would be the
-- silent assertion this whole feature refuses.
SELECT is(
  (SELECT count(*)::int FROM public.author_identities
   WHERE id = '0a000000-0000-0000-0000-0000000000f1'),
  1,
  'stale repair: the previously linked person still exists, now carrying nothing');

-- Out-of-range stale rows: nothing can render a mention for them, so the plain
-- unlink path is the repair. It needs no author text, which is exactly why it
-- works here.
INSERT INTO public.author_identity_links
  (user_id, identity_id, paper_id, author_index, author_name_snapshot, resolution_basis)
VALUES ('0a000000-0000-0000-0000-000000000001','0a000000-0000-0000-0000-0000000000f1',
        '0a000000-0000-0000-0000-0000000000e1', 9, 'Author At A Gone Position', 'manual');

SELECT lives_ok(
  $q$SELECT pg_temp.run_as(pg_temp.claims_u1(),
       $inner$SELECT public.unlink_author_mention_identity(
         '0a000000-0000-0000-0000-0000000000e1'::uuid, 9)$inner$)$q$,
  'stale repair: an out-of-range saved link can be removed without any author text');

SELECT is(pg_temp.link_count('0a000000-0000-0000-0000-0000000000e1'), 2,
  'stale repair: exactly the out-of-range row went');

SELECT is(
  (SELECT authors::text FROM public.papers
   WHERE id = '0a000000-0000-0000-0000-0000000000e1'),
  '["Current Author", "Valid Author"]',
  'stale repair: no paper data was touched by any of it');

-- U2 must not be able to remove U1's stale row.
INSERT INTO public.author_identity_links
  (user_id, identity_id, paper_id, author_index, author_name_snapshot, resolution_basis)
VALUES ('0a000000-0000-0000-0000-000000000001','0a000000-0000-0000-0000-0000000000f1',
        '0a000000-0000-0000-0000-0000000000e1', 9, 'Author At A Gone Position', 'manual');

SELECT lives_ok(
  $q$SELECT pg_temp.run_as(pg_temp.claims_u2(),
       $inner$SELECT public.unlink_author_mention_identity(
         '0a000000-0000-0000-0000-0000000000e1'::uuid, 9)$inner$)$q$,
  'stale repair: another user''s removal call is accepted but scoped');

SELECT is(pg_temp.link_count('0a000000-0000-0000-0000-0000000000e1'), 3,
  'stale repair: it deleted nothing, because the predicate is scoped to the caller');

-- Clean up so sections 13 onward see the state they expect.
DELETE FROM public.papers WHERE id = '0a000000-0000-0000-0000-0000000000e1';
DELETE FROM public.author_identities
 WHERE preferred_name IN ('Stale Person', 'Valid Person', 'Repaired Person');


-- ══ 13. Account deletion ════════════════════════════════════════════════════
-- delete-account removes Storage objects and the Auth user and enumerates no
-- tables, so identity data must disappear through the FK cascade alone. If this
-- fails, the Edge Function would need changing — a new Production deployment
-- dependency this task is explicitly designed to avoid.

SELECT ok(pg_temp.identity_count('0a000000-0000-0000-0000-000000000001') > 0,
  'account delete: U1 has identity data before the account is removed');

SELECT lives_ok(
  $q$DELETE FROM auth.users WHERE id = '0a000000-0000-0000-0000-000000000001'$q$,
  'account delete: removing the auth user succeeds despite the identity graph');

SELECT is(
  (SELECT count(*)::int FROM public.author_identities
   WHERE user_id = '0a000000-0000-0000-0000-000000000001')
  + (SELECT count(*)::int FROM public.author_identity_aliases
     WHERE user_id = '0a000000-0000-0000-0000-000000000001')
  + (SELECT count(*)::int FROM public.author_identity_links
     WHERE user_id = '0a000000-0000-0000-0000-000000000001')
  + (SELECT count(*)::int FROM public.author_identity_merges
     WHERE user_id = '0a000000-0000-0000-0000-000000000001'),
  0,
  'account delete: every identity row is gone, by cascade, with no Edge change');

SELECT is(
  (SELECT count(*)::int FROM public.author_identities
   WHERE user_id = '0a000000-0000-0000-0000-000000000002'),
  1,
  'account delete: the other user''s identity data is untouched');


SELECT * FROM finish();
ROLLBACK;
