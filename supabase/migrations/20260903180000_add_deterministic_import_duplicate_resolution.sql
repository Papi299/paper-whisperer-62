-- CHROME-EXTENSION-IMPORT-001D — deterministic import duplicate resolution
--
-- Two capabilities, both deliberately narrow:
--
--   1. safe_bulk_insert_papers now answers a duplicate with the EXISTING
--      paper's id — but only when exactly one owned row can be proven to be
--      the row that collided.
--   2. bulk_add_paper_projects / bulk_add_paper_tags add memberships to
--      papers that already exist, without removing any.
--
-- Nothing else about either surface changes.
--
--
-- What "the row that collided" is allowed to mean
-- ───────────────────────────────────────────────
-- The database already states paper identity, and it states it in exactly two
-- places:
--
--   idx_papers_user_pmid_unique  ON papers (user_id, pmid)        WHERE pmid IS NOT NULL
--   idx_papers_user_doi_unique   ON papers (user_id, lower(doi))  WHERE doi  IS NOT NULL
--
-- Those two indexes are the whole contract. The resolver below MIRRORS them —
-- same columns, same per-user scope, same case rule (PMID exact, DOI folded
-- with lower()), same "only when non-null" restriction — because a resolver
-- that used any other rule would be inventing a second, unenforced definition
-- of what makes two papers the same paper.
--
-- So: no title. No fuzzy or trigram comparison. No author, year, journal or
-- abstract similarity. No URL matching. No prefix stripping or trimming that
-- the stored, indexed value does not already have. No Crossref or PubMed
-- lookup — this function makes no network request and never has. Duplicate
-- DETECTION was already PMID/DOI-only by standing product decision; duplicate
-- RESOLUTION is the same decision applied to the same two columns.
--
--
-- Why exactly one candidate, and not "the best" candidate
-- ──────────────────────────────────────────────────────
-- An incoming record can carry both a PMID and a DOI, and those two
-- identifiers can belong to two DIFFERENT existing rows:
--
--   paper A owns PMID  '12345678'
--   paper B owns DOI   '10.1000/xyz'
--   the incoming row carries BOTH
--
-- Both unique indexes are violated, by different rows. There is no fact in the
-- database that says which of A or B the user meant, and every tie-break
-- available here is an accident rather than an answer: whichever constraint
-- happened to be checked first, whichever id sorts lower, whichever row was
-- created earlier, whichever title looks closer. Choosing one would attach the
-- user's Projects and Tags to a paper they did not pick, silently.
--
-- Two or more distinct candidates therefore resolves to NOTHING. The row is
-- still reported as a duplicate — it genuinely is one — but with no id, which
-- the caller must treat as "not safely identifiable" and act on by doing
-- nothing. Zero provable candidates behaves identically: a unique_violation
-- from some other constraint resolves nothing rather than guessing.
--
-- Exactly one distinct owned row is the only proof this function accepts.
--
--
-- Cross-user leakage is structurally impossible here
-- ──────────────────────────────────────────────────
-- The candidate query is scoped to `user_id = p_user_id`, and p_user_id has
-- already been checked to equal auth.uid() by the guard at the top of the
-- function, which this migration leaves exactly as it was. Uniqueness is
-- per-user, so another account owning the same PMID is not a collision and not
-- a candidate; a returned id is always the caller's own row.
--
--
-- Backward compatibility of the result contract
-- ─────────────────────────────────────────────
-- The result rows keep their existing shape:
--
--   inserted             → { index, id, status: 'inserted' }
--   duplicate (resolved) → { index, id, status: 'duplicate', error_message }
--   duplicate (not)      → { index,     status: 'duplicate', error_message }
--   error                → { index,     status: 'error',     error_message }
--
-- No status value is added or renamed. A caller that reads only `status` — the
-- parsed-file importer, and every historical caller — is unaffected: it sees
-- the same statuses in the same order and continues to skip duplicates. The
-- new `id` on a duplicate is purely additive, and a caller that does not look
-- for it cannot be changed by it.
--
--
-- Additive assignment is a separate function, not a flag on the setter
-- ───────────────────────────────────────────────────────────────────
-- bulk_set_paper_projects / bulk_set_paper_tags are REPLACE-ALL setters: they
-- DELETE the paper's memberships and insert the supplied set. That is correct
-- for a row that was just created and owns nothing yet, and it is exactly wrong
-- for a paper that has existed for months — calling it with only the handoff's
-- selection would delete every Project and Tag the user had already filed that
-- paper under. Those two functions are therefore not touched, not parameterised
-- and not weakened by this migration.
--
-- The new pair adds and only adds. They contain no DELETE statement at all,
-- which is a property this migration's verification block checks rather than
-- asserts in prose.
--
--
-- What this migration does NOT do
-- ───────────────────────────────
-- No column is added, altered or dropped. No paper row is written, backfilled
-- or repaired. No unique index is created, dropped or redefined. No RLS policy
-- changes. No existing grant is loosened. Nothing about statistical-method
-- canonicalization, publication-type provenance or author provenance changes.
-- Historical duplicates stay exactly as they are — this function decides
-- nothing about papers nobody is currently importing.

-- ══ 1. safe_bulk_insert_papers ══════════════════════════════════════════════
--
-- Identical to the definition installed by
-- 20260817120000_add_structured_author_provenance.sql — same signature, same
-- SECURITY DEFINER posture, same `search_path=public`, same ownership guard,
-- same statistical-method canonicalization, same structured publication-type
-- and author-provenance handling, same column list, same per-row exception
-- isolation, same inserted and error results — except for the `unique_violation`
-- handler, which now attempts the bounded resolution described above.

CREATE OR REPLACE FUNCTION public.safe_bulk_insert_papers(p_user_id uuid, p_papers jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_paper jsonb;
  v_index int := 0;
  v_results jsonb := '[]'::jsonb;
  v_inserted_id uuid;
  v_statistical_methods jsonb;
  v_raw_publication_types jsonb;
  v_author_provenance jsonb;
  v_duplicate_pmid text;
  v_duplicate_doi text;
  v_duplicate_candidates uuid[];
  v_duplicate_result jsonb;
BEGIN
  IF p_user_id IS NULL
     OR auth.uid() IS NULL
     OR p_user_id <> auth.uid()
  THEN
    RAISE EXCEPTION 'Unauthorized: user mismatch';
  END IF;

  FOR v_paper IN SELECT jsonb_array_elements(p_papers)
  LOOP
    BEGIN
      -- Canonical C20 storage: SQL NULL or one JSON string.
      v_statistical_methods := v_paper->'statistical_methods';
      IF v_statistical_methods IS NULL
         OR jsonb_typeof(v_statistical_methods) = 'null' THEN
        v_statistical_methods := NULL;
      ELSIF jsonb_typeof(v_statistical_methods) = 'string' THEN
        NULL; -- already canonical
      ELSIF jsonb_typeof(v_statistical_methods) = 'array' THEN
        SELECT to_jsonb(COALESCE(string_agg(e.elem #>> '{}', ', ' ORDER BY e.ord), ''))
        INTO v_statistical_methods
        FROM jsonb_array_elements(v_statistical_methods) WITH ORDINALITY AS e(elem, ord);
      ELSE
        RAISE EXCEPTION 'statistical_methods must be null, a JSON string, or a JSON array; got %',
          jsonb_typeof(v_statistical_methods);
      END IF;

      -- Canonical structured provenance: SQL NULL, or a non-empty JSON array of
      -- non-blank strings in source order. A missing key and JSON null both mean
      -- "this source stated no boundaries"; anything that is not an array of
      -- strings is malformed input and fails the row rather than being coerced.
      v_raw_publication_types := v_paper->'raw_publication_types';
      IF v_raw_publication_types IS NULL
         OR jsonb_typeof(v_raw_publication_types) = 'null' THEN
        v_raw_publication_types := NULL;
      ELSIF jsonb_typeof(v_raw_publication_types) = 'array' THEN
        IF jsonb_path_exists(v_raw_publication_types, '$[*] ? (@.type() != "string")') THEN
          RAISE EXCEPTION 'raw_publication_types must be a JSON array of strings';
        END IF;
        -- Trim, drop blanks, preserve order. An array that holds nothing usable
        -- collapses to NULL, because it carries no more provenance than absence.
        SELECT jsonb_agg(t.trimmed ORDER BY e.ord)
        INTO v_raw_publication_types
        FROM jsonb_array_elements_text(v_raw_publication_types) WITH ORDINALITY AS e(elem, ord)
        CROSS JOIN LATERAL (SELECT btrim(e.elem) AS trimmed) t
        WHERE t.trimmed <> '';
      ELSE
        RAISE EXCEPTION 'raw_publication_types must be null or a JSON array of strings; got %',
          jsonb_typeof(v_raw_publication_types);
      END IF;

      -- Canonical authorship provenance: SQL NULL, or an ordered array aligned
      -- with `authors`. A missing key, JSON null and an empty array all mean
      -- "no structured provenance" and collapse to the one representation of
      -- that. A non-array is malformed input and fails the row here; the deeper
      -- structure (entry shape, kind, identifiers, ORCID canonicality, and the
      -- length-equals-authors rule) is enforced by the column CHECK, whose
      -- violation is caught by the same per-row handler below. Nothing is
      -- coerced into a fake entry, and the joined `authors` strings are never a
      -- source for it — provenance is only ever what a source stated.
      v_author_provenance := v_paper->'author_provenance';
      IF v_author_provenance IS NULL
         OR jsonb_typeof(v_author_provenance) = 'null' THEN
        v_author_provenance := NULL;
      ELSIF jsonb_typeof(v_author_provenance) = 'array' THEN
        IF jsonb_array_length(v_author_provenance) = 0 THEN
          v_author_provenance := NULL;
        END IF;
      ELSE
        RAISE EXCEPTION 'author_provenance must be null or a JSON array; got %',
          jsonb_typeof(v_author_provenance);
      END IF;

      INSERT INTO papers (
        user_id, title, authors, author_provenance, year, journal, pmid, doi,
        abstract, study_type, raw_study_type, raw_publication_types,
        statistical_methods,
        keywords, raw_keywords, mesh_terms, substances,
        pubmed_url, journal_url, drive_url
      ) VALUES (
        p_user_id,
        v_paper->>'title',
        COALESCE(v_paper->'authors', '[]'::jsonb),
        v_author_provenance,
        (v_paper->>'year')::int,
        v_paper->>'journal',
        v_paper->>'pmid',
        v_paper->>'doi',
        v_paper->>'abstract',
        v_paper->>'study_type',
        v_paper->>'raw_study_type',
        v_raw_publication_types,
        v_statistical_methods,
        COALESCE(v_paper->'keywords', '[]'::jsonb),
        COALESCE(v_paper->'raw_keywords', '[]'::jsonb),
        COALESCE(v_paper->'mesh_terms', '[]'::jsonb),
        COALESCE(v_paper->'substances', '[]'::jsonb),
        v_paper->>'pubmed_url',
        v_paper->>'journal_url',
        v_paper->>'drive_url'
      )
      RETURNING id INTO v_inserted_id;

      v_results := v_results || jsonb_build_object(
        'index', v_index,
        'id', v_inserted_id,
        'status', 'inserted'
      );

    EXCEPTION
      WHEN unique_violation THEN
        -- Deterministic duplicate resolution, on exactly the two canonical
        -- identifiers this row was attempted with, under exactly the semantics
        -- the two per-user unique indexes enforce:
        --
        --   pmid       — equality on the stored value, as indexed
        --   lower(doi) — equality on the folded value, as indexed
        --
        -- Both are compared as the same expressions the INSERT above used
        -- (`v_paper->>'pmid'`, `v_paper->>'doi'`), so the resolver asks about
        -- the identifiers that actually collided rather than about some
        -- reinterpretation of them. A NULL identifier contributes no predicate:
        -- `NULL = anything` is NULL, never true, which is the same restriction
        -- the partial indexes carry.
        --
        -- The candidate set is DISTINCT ids, so a single row matched by BOTH
        -- its PMID and its DOI is one candidate, not two.
        v_duplicate_pmid := v_paper->>'pmid';
        v_duplicate_doi  := v_paper->>'doi';

        SELECT array_agg(DISTINCT c.id)
        INTO v_duplicate_candidates
        FROM papers c
        WHERE c.user_id = p_user_id
          AND (
                (v_duplicate_pmid IS NOT NULL AND c.pmid = v_duplicate_pmid)
             OR (v_duplicate_doi  IS NOT NULL AND lower(c.doi) = lower(v_duplicate_doi))
          );

        v_duplicate_result := jsonb_build_object(
          'index', v_index,
          'status', 'duplicate',
          'error_message', SQLERRM
        );

        -- One distinct owned row is the only proof sufficient to name it.
        -- Zero (some other unique constraint) and two or more (a PMID and a DOI
        -- naming different rows) both stay unresolved, and the caller must then
        -- treat the duplicate exactly as it did before this migration existed.
        IF v_duplicate_candidates IS NOT NULL
           AND cardinality(v_duplicate_candidates) = 1 THEN
          v_duplicate_result := v_duplicate_result
            || jsonb_build_object('id', v_duplicate_candidates[1]);
        END IF;

        v_results := v_results || v_duplicate_result;
      WHEN OTHERS THEN
        v_results := v_results || jsonb_build_object(
          'index', v_index,
          'status', 'error',
          'error_message', SQLERRM
        );
    END;

    v_index := v_index + 1;
  END LOOP;

  RETURN v_results;
END;
$function$;

COMMENT ON FUNCTION public.safe_bulk_insert_papers(uuid, jsonb) IS
  'Bulk-inserts papers for the authenticated caller, isolating each row so one '
  'bad record cannot fail the batch. A unique_violation is reported as '
  'status=duplicate, and carries the existing paper id ONLY when exactly one '
  'row owned by the caller matches the attempted PMID or DOI under the same '
  'semantics idx_papers_user_pmid_unique and idx_papers_user_doi_unique '
  'enforce. Zero or several distinct candidates return no id — identity is '
  'never guessed, and title/fuzzy/metadata similarity is never consulted. '
  'SECURITY DEFINER + fixed search_path; rejects null auth and any p_user_id '
  'that is not auth.uid(); EXECUTE granted to authenticated only.';

-- ══ 2. bulk_add_paper_projects ══════════════════════════════════════════════
--
-- The additive counterpart to bulk_set_paper_projects, for papers that already
-- exist. Same authorization shape as the setter — caller from auth.uid(), all
-- referenced papers and Projects validated as the caller's own BEFORE any
-- mutation, so a single foreign or unknown id rejects the whole call rather
-- than producing a partially applied one.
--
-- It differs from the setter in exactly one way, and that difference is the
-- entire point: there is no DELETE. Memberships the paper already has are left
-- alone, and requested memberships it already has are satisfied by
-- ON CONFLICT DO NOTHING rather than reported as a failure.

CREATE OR REPLACE FUNCTION public.bulk_add_paper_projects(p_paper_ids uuid[], p_project_ids uuid[])
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Unauthorized: no authenticated user';
  END IF;

  -- A NULL element is malformed input, not an empty selection. It is rejected
  -- explicitly and before anything is written, rather than left to surface as
  -- a NOT NULL violation partway through the insert.
  IF array_position(p_paper_ids, NULL) IS NOT NULL THEN
    RAISE EXCEPTION 'Invalid input: p_paper_ids contains a NULL paper id';
  END IF;
  IF array_position(p_project_ids, NULL) IS NOT NULL THEN
    RAISE EXCEPTION 'Invalid input: p_project_ids contains a NULL project id';
  END IF;

  -- All-or-nothing ownership validation BEFORE any mutation: a single foreign
  -- or unknown paper rejects the entire call (no silent filtering).
  IF EXISTS (
    SELECT 1
    FROM unnest(p_paper_ids) AS pid
    WHERE NOT EXISTS (SELECT 1 FROM papers p WHERE p.id = pid AND p.user_id = auth.uid())
  ) THEN
    RAISE EXCEPTION 'Unauthorized: one or more papers not found or not owned by the caller';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM unnest(p_project_ids) AS projid
    WHERE NOT EXISTS (SELECT 1 FROM projects pr WHERE pr.id = projid AND pr.user_id = auth.uid())
  ) THEN
    RAISE EXCEPTION 'Unauthorized: one or more projects not found or not owned by the caller';
  END IF;

  IF COALESCE(array_length(p_paper_ids, 1), 0) = 0
     OR COALESCE(array_length(p_project_ids, 1), 0) = 0 THEN
    RETURN; -- nothing requested; no write, no error
  END IF;

  -- DISTINCT so a repeated id in either array cannot produce the same pair
  -- twice, and ON CONFLICT so a membership that already exists is a no-op
  -- rather than an error. Together these make the call idempotent.
  INSERT INTO paper_projects (paper_id, project_id)
  SELECT DISTINCT pid, projid
  FROM unnest(p_paper_ids) AS pid
  CROSS JOIN unnest(p_project_ids) AS projid
  ON CONFLICT (paper_id, project_id) DO NOTHING;
END;
$function$;

COMMENT ON FUNCTION public.bulk_add_paper_projects(uuid[], uuid[]) IS
  'ADDS Project memberships to papers that already exist, preserving every '
  'membership they already have — there is no DELETE in this function. '
  'Idempotent: a requested membership that exists is a no-op. Validates that '
  'every paper and every Project belongs to auth.uid() before any write, so a '
  'foreign or unknown id rejects the whole call. Does not replace '
  'bulk_set_paper_projects, whose replace-all semantics remain correct for '
  'newly inserted rows. SECURITY DEFINER + fixed search_path; EXECUTE granted '
  'to authenticated only.';

-- ══ 3. bulk_add_paper_tags ══════════════════════════════════════════════════
-- Exactly the Project function above, over the Tag taxonomy.

CREATE OR REPLACE FUNCTION public.bulk_add_paper_tags(p_paper_ids uuid[], p_tag_ids uuid[])
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Unauthorized: no authenticated user';
  END IF;

  IF array_position(p_paper_ids, NULL) IS NOT NULL THEN
    RAISE EXCEPTION 'Invalid input: p_paper_ids contains a NULL paper id';
  END IF;
  IF array_position(p_tag_ids, NULL) IS NOT NULL THEN
    RAISE EXCEPTION 'Invalid input: p_tag_ids contains a NULL tag id';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM unnest(p_paper_ids) AS pid
    WHERE NOT EXISTS (SELECT 1 FROM papers p WHERE p.id = pid AND p.user_id = auth.uid())
  ) THEN
    RAISE EXCEPTION 'Unauthorized: one or more papers not found or not owned by the caller';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM unnest(p_tag_ids) AS tid
    WHERE NOT EXISTS (SELECT 1 FROM tags t WHERE t.id = tid AND t.user_id = auth.uid())
  ) THEN
    RAISE EXCEPTION 'Unauthorized: one or more tags not found or not owned by the caller';
  END IF;

  IF COALESCE(array_length(p_paper_ids, 1), 0) = 0
     OR COALESCE(array_length(p_tag_ids, 1), 0) = 0 THEN
    RETURN;
  END IF;

  INSERT INTO paper_tags (paper_id, tag_id)
  SELECT DISTINCT pid, tid
  FROM unnest(p_paper_ids) AS pid
  CROSS JOIN unnest(p_tag_ids) AS tid
  ON CONFLICT (paper_id, tag_id) DO NOTHING;
END;
$function$;

COMMENT ON FUNCTION public.bulk_add_paper_tags(uuid[], uuid[]) IS
  'ADDS Tag memberships to papers that already exist, preserving every '
  'membership they already have — there is no DELETE in this function. '
  'Idempotent: a requested membership that exists is a no-op. Validates that '
  'every paper and every Tag belongs to auth.uid() before any write, so a '
  'foreign or unknown id rejects the whole call. Does not replace '
  'bulk_set_paper_tags, whose replace-all semantics remain correct for newly '
  'inserted rows. SECURITY DEFINER + fixed search_path; EXECUTE granted to '
  'authenticated only.';

-- ══ 4. Grants — the repository's REVOKE-first least-privilege posture ═══════
--
-- Same shape as every RPC hardened by
-- 20260802025704_harden_rpc_and_relational_ownership.sql. REVOKE FIRST is
-- load-bearing: PostgreSQL grants EXECUTE to PUBLIC by default on a new
-- function, so an additive GRANT alone would describe a narrower surface than
-- the database actually has. service_role is revoked because no repository
-- path invokes these as service_role and a SECURITY DEFINER function reachable
-- by the service key would bypass its own auth.uid() guard's purpose.

REVOKE ALL ON FUNCTION public.bulk_add_paper_projects(uuid[], uuid[]) FROM PUBLIC, anon, service_role;
GRANT  EXECUTE ON FUNCTION public.bulk_add_paper_projects(uuid[], uuid[]) TO authenticated;

REVOKE ALL ON FUNCTION public.bulk_add_paper_tags(uuid[], uuid[]) FROM PUBLIC, anon, service_role;
GRANT  EXECUTE ON FUNCTION public.bulk_add_paper_tags(uuid[], uuid[]) TO authenticated;

-- safe_bulk_insert_papers keeps the grants it already had. CREATE OR REPLACE
-- preserves an existing function's ACL, but re-stating it costs nothing and
-- makes the intended posture explicit at the point of change.
REVOKE ALL ON FUNCTION public.safe_bulk_insert_papers(uuid, jsonb) FROM PUBLIC, anon, service_role;
GRANT  EXECUTE ON FUNCTION public.safe_bulk_insert_papers(uuid, jsonb) TO authenticated;

-- ══ 5. Verification ════════════════════════════════════════════════════════
-- Fails the migration rather than leaving a silently wrong deployment behind.

DO $verify$
DECLARE
  v_fn text;
  v_fns text[] := ARRAY[
    'public.safe_bulk_insert_papers(uuid,jsonb)',
    'public.bulk_add_paper_projects(uuid[],uuid[])',
    'public.bulk_add_paper_tags(uuid[],uuid[])'
  ];
  v_secdef boolean;
  v_cfg text[];
  v_src text;
  v_count int;
BEGIN
  FOREACH v_fn IN ARRAY v_fns LOOP
    SELECT p.prosecdef, p.proconfig, p.prosrc
      INTO v_secdef, v_cfg, v_src
    FROM pg_proc p
    WHERE p.oid = v_fn::regprocedure;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'import_duplicate_resolution: function % was not created', v_fn;
    END IF;
    IF NOT v_secdef THEN
      RAISE EXCEPTION 'import_duplicate_resolution: % is not SECURITY DEFINER', v_fn;
    END IF;
    IF v_cfg IS NULL OR NOT (v_cfg @> ARRAY['search_path=public']) THEN
      RAISE EXCEPTION 'import_duplicate_resolution: % does not pin search_path=public', v_fn;
    END IF;
    IF NOT has_function_privilege('authenticated', v_fn::regprocedure, 'EXECUTE') THEN
      RAISE EXCEPTION 'import_duplicate_resolution: authenticated cannot execute %', v_fn;
    END IF;
    IF has_function_privilege('anon', v_fn::regprocedure, 'EXECUTE') THEN
      RAISE EXCEPTION 'import_duplicate_resolution: anon can execute %', v_fn;
    END IF;
    IF has_function_privilege('service_role', v_fn::regprocedure, 'EXECUTE') THEN
      RAISE EXCEPTION 'import_duplicate_resolution: service_role can execute %', v_fn;
    END IF;
    IF EXISTS (
      SELECT 1 FROM pg_proc p, aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
      WHERE p.oid = v_fn::regprocedure AND a.grantee = 0 AND a.privilege_type = 'EXECUTE'
    ) THEN
      RAISE EXCEPTION 'import_duplicate_resolution: PUBLIC can execute %', v_fn;
    END IF;
  END LOOP;

  -- ── The additive functions really are additive ──
  -- A DELETE or TRUNCATE anywhere in either body would make the "existing
  -- Projects and Tags are preserved" claim false, so it is checked rather than
  -- trusted to review.
  FOREACH v_fn IN ARRAY ARRAY[
    'public.bulk_add_paper_projects(uuid[],uuid[])',
    'public.bulk_add_paper_tags(uuid[],uuid[])'
  ] LOOP
    SELECT p.prosrc INTO v_src FROM pg_proc p WHERE p.oid = v_fn::regprocedure;
    IF v_src ~* '\mdelete\M' OR v_src ~* '\mtruncate\M' THEN
      RAISE EXCEPTION 'import_duplicate_resolution: % contains a delete/truncate; it must be purely additive', v_fn;
    END IF;
  END LOOP;

  -- ── The replace-all setters are untouched and still delete ──
  -- Their semantics are correct for newly inserted rows and this migration must
  -- not have quietly converted them.
  FOREACH v_fn IN ARRAY ARRAY[
    'public.bulk_set_paper_projects(uuid[],uuid[])',
    'public.bulk_set_paper_tags(uuid[],uuid[])'
  ] LOOP
    SELECT p.prosrc INTO v_src FROM pg_proc p WHERE p.oid = v_fn::regprocedure;
    IF v_src !~* '\mdelete\M' THEN
      RAISE EXCEPTION 'import_duplicate_resolution: % no longer replaces; the setter semantics were altered', v_fn;
    END IF;
  END LOOP;

  -- ── The identity contract this resolver mirrors still exists, unchanged ──
  SELECT count(*) INTO v_count
  FROM pg_indexes
  WHERE schemaname = 'public'
    AND tablename = 'papers'
    AND indexname IN ('idx_papers_user_pmid_unique', 'idx_papers_user_doi_unique');
  IF v_count <> 2 THEN
    RAISE EXCEPTION 'import_duplicate_resolution: the per-user PMID/DOI unique indexes are not both present';
  END IF;

END
$verify$;
