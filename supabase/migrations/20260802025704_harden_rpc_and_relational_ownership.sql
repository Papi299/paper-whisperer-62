-- PFA-C03B1 pre-existing security remediation.
--
-- Closes confirmed cross-tenant defects in the current schema and normalizes
-- least-privilege EXECUTE across the complete public SECURITY DEFINER surface.
-- No function signature, return shape, default, volatility, or valid
-- authenticated behavior is changed. See
-- docs/pfa-c03-staging-and-security-test-plan.md for the full finding list.
--
-- Sections:
--   1. RPC authentication guards (explicit NULL-auth rejection + bounded
--      search_path for search_papers).
--   2. Attachment quota trigger — defense-in-depth ownership validation.
--   3. SECURITY DEFINER EXECUTE ACL hardening (complete surface).
--   4. paper_projects relational ownership policies.
--   5. paper_tags relational ownership policies.
--   6. paper_attachments ownership policies.

-- ─────────────────────────────────────────────────────────────────────────
-- 1. RPC AUTHENTICATION GUARDS
--
-- Each of these SECURITY DEFINER RPCs guarded ownership with
--   IF p_user_id IS NULL OR p_user_id <> auth.uid() THEN ...
-- For an unauthenticated (anon / no-JWT) caller auth.uid() is NULL, so the
-- comparison p_user_id <> NULL evaluates to NULL and the IF is not taken —
-- the guard is bypassed. Add the explicit auth.uid() IS NULL clause so a NULL
-- caller identity is always rejected. Bodies are otherwise byte-for-byte the
-- current definitions.
-- ─────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.search_papers(p_user_id uuid, p_query text, p_limit integer DEFAULT 1000, p_offset integer DEFAULT 0)
 RETURNS TABLE(paper_id uuid, rank real, matched_title boolean, matched_abstract boolean, matched_authors boolean, matched_journal boolean, matched_notes boolean, matched_keywords boolean)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_ts_query_text TEXT;
  v_ts_query      tsquery;
BEGIN
  -- Ownership guard: defense-in-depth on top of RLS. SECURITY DEFINER
  -- bypasses table-level RLS, so we must verify the caller owns the
  -- requested user_id ourselves.
  IF p_user_id IS NULL
     OR auth.uid() IS NULL
     OR p_user_id <> auth.uid()
  THEN
    RAISE EXCEPTION 'Unauthorized: user mismatch';
  END IF;

  -- Sanitize + tokenize identically to migration 20260417030000:
  -- strip the ten tsquery operator/control characters, whitespace-split,
  -- append :* to each non-empty token, &-join. Unicode passes through.
  SELECT string_agg(tok || ':*', ' & ')
    INTO v_ts_query_text
    FROM (
      SELECT token AS tok
      FROM regexp_split_to_table(
        regexp_replace(
          COALESCE(p_query, ''),
          '[&|!():*<>''"\\]',
          ' ',
          'g'
        ),
        '\s+'
      ) AS t(token)
      WHERE length(token) > 0
    ) s;

  -- Guard: empty / whitespace-only / all-blacklisted input → zero rows.
  IF v_ts_query_text IS NULL OR v_ts_query_text = '' THEN
    RETURN;
  END IF;

  v_ts_query := to_tsquery('english', v_ts_query_text);

  RETURN QUERY
  SELECT
    p.id AS paper_id,
    ts_rank(p.search_vector, v_ts_query) AS rank,
    -- Per-field attribution: each field's own tsvector tested against the
    -- same prefix-aware tsquery. If `search_vector @@ tsq` is true (WHERE
    -- clause), at least one of these will also be true (search_vector is
    -- the union of these per-field weighted tsvectors).
    to_tsvector('english', coalesce(p.title, ''))            @@ v_ts_query AS matched_title,
    to_tsvector('english', coalesce(p.abstract, ''))         @@ v_ts_query AS matched_abstract,
    to_tsvector('english', coalesce(p.authors::text, ''))    @@ v_ts_query AS matched_authors,
    to_tsvector('english', coalesce(p.journal, ''))          @@ v_ts_query AS matched_journal,
    to_tsvector('english', coalesce(p.notes, ''))            @@ v_ts_query AS matched_notes,
    to_tsvector('english', coalesce(p.keywords::text, ''))   @@ v_ts_query AS matched_keywords
  FROM papers p
  WHERE p.user_id = p_user_id
    AND p.search_vector @@ v_ts_query
  ORDER BY rank DESC
  LIMIT p_limit OFFSET p_offset;
END;
$function$;

CREATE OR REPLACE FUNCTION public.search_papers_short(p_user_id uuid, p_query text)
 RETURNS TABLE(paper_id uuid, matched_title boolean, matched_abstract boolean, matched_authors boolean, matched_journal boolean, matched_notes boolean, matched_keywords boolean)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  -- Ownership guard: defense-in-depth on top of RLS.
  IF p_user_id IS NULL
     OR auth.uid() IS NULL
     OR p_user_id <> auth.uid()
  THEN
    RAISE EXCEPTION 'Unauthorized: user mismatch';
  END IF;

  RETURN QUERY
  SELECT
    p.id AS paper_id,
    p.title    ILIKE '%' || p_query || '%' AS matched_title,
    p.abstract ILIKE '%' || p_query || '%' AS matched_abstract,
    EXISTS (
      SELECT 1 FROM jsonb_array_elements_text(COALESCE(p.authors, '[]'::jsonb)) AS a
      WHERE a ILIKE '%' || p_query || '%'
    ) AS matched_authors,
    p.journal  ILIKE '%' || p_query || '%' AS matched_journal,
    p.notes    ILIKE '%' || p_query || '%' AS matched_notes,
    EXISTS (
      SELECT 1 FROM jsonb_array_elements_text(COALESCE(p.keywords, '[]'::jsonb)) AS k
      WHERE k ILIKE '%' || p_query || '%'
    ) AS matched_keywords
  FROM papers p
  WHERE p.user_id = p_user_id
    AND (
      p.title    ILIKE '%' || p_query || '%'
      OR p.journal  ILIKE '%' || p_query || '%'
      OR p.abstract ILIKE '%' || p_query || '%'
      OR p.notes    ILIKE '%' || p_query || '%'
      OR EXISTS (
        SELECT 1 FROM jsonb_array_elements_text(COALESCE(p.authors, '[]'::jsonb)) AS a
        WHERE a ILIKE '%' || p_query || '%'
      )
      OR EXISTS (
        SELECT 1 FROM jsonb_array_elements_text(COALESCE(p.keywords, '[]'::jsonb)) AS k
        WHERE k ILIKE '%' || p_query || '%'
      )
    );
END;
$function$;

CREATE OR REPLACE FUNCTION public.filter_papers_by_keywords(p_user_id uuid, p_keywords text[])
 RETURNS TABLE(paper_id uuid)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  -- Ownership guard: defense-in-depth on top of RLS.
  IF p_user_id IS NULL
     OR auth.uid() IS NULL
     OR p_user_id <> auth.uid()
  THEN
    RAISE EXCEPTION 'Unauthorized: user mismatch';
  END IF;

  RETURN QUERY
  WITH synonym_map AS (
    -- Build synonym → canonical mapping from user's synonym pool
    SELECT lower(syn) AS synonym, lower(sp.canonical_term) AS canonical
    FROM synonym_pool sp,
    LATERAL unnest(sp.synonyms) AS syn
    WHERE sp.user_id = p_user_id
    UNION ALL
    -- Canonical terms map to themselves
    SELECT lower(sp.canonical_term), lower(sp.canonical_term)
    FROM synonym_pool sp
    WHERE sp.user_id = p_user_id
  )
  SELECT p.id AS paper_id
  FROM papers p
  WHERE p.user_id = p_user_id
  AND NOT EXISTS (
    -- Every selected keyword must be found in at least one column
    SELECT 1 FROM unnest(p_keywords) AS kw
    WHERE NOT (
      -- keywords: already enriched/synonym-normalized at import time
      EXISTS (
        SELECT 1 FROM jsonb_array_elements_text(COALESCE(p.keywords, '[]'::jsonb)) k
        WHERE lower(k) = lower(kw)
      )
      -- mesh_terms: normalize through synonym map at query time
      OR EXISTS (
        SELECT 1 FROM jsonb_array_elements_text(COALESCE(p.mesh_terms, '[]'::jsonb)) m
        LEFT JOIN synonym_map sm ON lower(m) = sm.synonym
        WHERE COALESCE(sm.canonical, lower(m)) = lower(kw)
      )
      -- substances: normalize through synonym map at query time
      OR EXISTS (
        SELECT 1 FROM jsonb_array_elements_text(COALESCE(p.substances, '[]'::jsonb)) s
        LEFT JOIN synonym_map sm ON lower(s) = sm.synonym
        WHERE COALESCE(sm.canonical, lower(s)) = lower(kw)
      )
    )
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.get_keyword_options(p_user_id uuid, p_paper_ids uuid[] DEFAULT NULL::uuid[], p_year_from integer DEFAULT NULL::integer, p_year_to integer DEFAULT NULL::integer, p_study_types text[] DEFAULT NULL::text[])
 RETURNS TABLE(keyword text)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  -- Ownership guard: defense-in-depth on top of RLS.
  IF p_user_id IS NULL
     OR auth.uid() IS NULL
     OR p_user_id <> auth.uid()
  THEN
    RAISE EXCEPTION 'Unauthorized: user mismatch';
  END IF;

  RETURN QUERY
  SELECT DISTINCT term AS keyword
  FROM papers p
  CROSS JOIN LATERAL (
    SELECT jsonb_array_elements_text(COALESCE(p.keywords, '[]'::jsonb)) AS term
    UNION ALL
    SELECT jsonb_array_elements_text(COALESCE(p.mesh_terms, '[]'::jsonb))
    UNION ALL
    SELECT jsonb_array_elements_text(COALESCE(p.substances, '[]'::jsonb))
  ) terms
  WHERE p.user_id = p_user_id
  AND (p_paper_ids IS NULL OR p.id = ANY(p_paper_ids))
  AND (p_year_from IS NULL OR p.year >= p_year_from)
  AND (p_year_to IS NULL OR p.year <= p_year_to)
  AND (p_study_types IS NULL OR p.study_type = ANY(p_study_types))
  ORDER BY keyword;
END;
$function$;

-- safe_bulk_insert_papers: the current guard is only
--   IF p_user_id <> auth.uid() THEN ...
-- which omits BOTH the p_user_id IS NULL and auth.uid() IS NULL clauses, so an
-- unauthenticated caller (auth.uid() = NULL) bypasses it entirely and can
-- create paper rows for an arbitrary user_id. Replace with the full guard.
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

      INSERT INTO papers (
        user_id, title, authors, year, journal, pmid, doi,
        abstract, study_type, raw_study_type, statistical_methods,
        keywords, raw_keywords, mesh_terms, substances,
        pubmed_url, journal_url, drive_url
      ) VALUES (
        p_user_id,
        v_paper->>'title',
        COALESCE(v_paper->'authors', '[]'::jsonb),
        (v_paper->>'year')::int,
        v_paper->>'journal',
        v_paper->>'pmid',
        v_paper->>'doi',
        v_paper->>'abstract',
        v_paper->>'study_type',
        v_paper->>'raw_study_type',
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
        v_results := v_results || jsonb_build_object(
          'index', v_index,
          'status', 'duplicate',
          'error_message', SQLERRM
        );
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

-- ─────────────────────────────────────────────────────────────────────────
-- 2. ATTACHMENT QUOTA TRIGGER — DEFENSE-IN-DEPTH OWNERSHIP VALIDATION
--
-- paper_attachments are inserted only through the caller-authenticated client
-- path (src/hooks/useAttachments.ts, useBulkMutations.ts, usePaperMutations.ts);
-- there is no server-only (service_role) attachment-insert path in the
-- repository. Add explicit ownership validation to the BEFORE INSERT trigger
-- so a mismatched owner or a paper owned by another user is rejected BEFORE
-- any storage quota is consumed. Explicit IS NULL checks prevent a NULL
-- auth.uid() from slipping through three-valued logic. All existing quota
-- accounting is preserved unchanged.
-- ─────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.check_and_consume_storage_quota()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_quota BIGINT;
  v_new_used BIGINT;
BEGIN
  -- Ownership guard (defense in depth; PFA-C03B1 remediation). Reject — before
  -- consuming any storage quota — any row whose declared owner is not the
  -- authenticated caller, or whose referenced paper is not owned by that same
  -- user. Attachments are inserted only through the caller-authenticated
  -- client path, so a NULL auth.uid() is never legitimate here.
  IF auth.uid() IS NULL
     OR NEW.user_id IS NULL
     OR NEW.user_id <> auth.uid() THEN
    RAISE EXCEPTION 'Unauthorized: attachment user mismatch';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.papers p
    WHERE p.id = NEW.paper_id
      AND p.user_id = NEW.user_id
  ) THEN
    RAISE EXCEPTION 'Unauthorized: attachment must reference a paper owned by the same user';
  END IF;

  -- Defensive: size_bytes must be non-negative. paper_attachments
  -- has no CHECK on this today; the trigger guards against a
  -- negative size that would otherwise inflate available quota for a
  -- later upload.
  IF NEW.size_bytes IS NULL OR NEW.size_bytes < 0 THEN
    RAISE EXCEPTION 'paper_attachments.size_bytes must be non-negative (got %)', NEW.size_bytes;
  END IF;

  -- Look up the storage quota. user_entitlements has FORCE ROW
  -- LEVEL SECURITY but this function is SECURITY DEFINER so it
  -- bypasses RLS. NEW.user_id is validated by the ownership guard
  -- above and by the paper_attachments RLS INSERT policy
  -- (auth.uid() = user_id).
  SELECT storage_quota_bytes INTO v_quota
  FROM public.user_entitlements
  WHERE user_id = NEW.user_id;

  IF v_quota IS NULL THEN
    RAISE EXCEPTION 'Missing entitlement: cannot upload attachment for user %', NEW.user_id;
  END IF;

  -- Ensure the usage row exists. Backfill should have created one
  -- for every existing user; this idempotent UPSERT covers any
  -- future user whose row wasn't created (defense in depth — the
  -- handle_new_user pipeline doesn't create user_storage_usage rows
  -- by default; the backfill on this migration plus this UPSERT
  -- cover both old and new users).
  INSERT INTO public.user_storage_usage (user_id, used_bytes)
  VALUES (NEW.user_id, 0)
  ON CONFLICT (user_id) DO NOTHING;

  -- Atomic check-and-increment. The WHERE clause is the quota
  -- gate; the UPDATE row-locks user_storage_usage for this user so
  -- two concurrent INSERTs serialize. If used_bytes +
  -- NEW.size_bytes would exceed quota, the UPDATE matches zero
  -- rows; v_new_used stays NULL; the trigger raises.
  UPDATE public.user_storage_usage
  SET used_bytes = user_storage_usage.used_bytes + NEW.size_bytes,
      updated_at = now()
  WHERE user_storage_usage.user_id = NEW.user_id
    AND user_storage_usage.used_bytes + NEW.size_bytes <= v_quota
  RETURNING user_storage_usage.used_bytes INTO v_new_used;

  IF v_new_used IS NULL THEN
    RAISE EXCEPTION 'Storage quota exceeded (quota %, attempted +% bytes)', v_quota, NEW.size_bytes;
  END IF;

  RETURN NEW;
END;
$function$;

COMMENT ON FUNCTION public.check_and_consume_storage_quota() IS
  'BEFORE INSERT trigger function for paper_attachments. First validates '
  'ownership (auth.uid() = NEW.user_id and NEW.paper_id owned by NEW.user_id), '
  'then atomically checks and consumes user_storage_usage against '
  'user_entitlements.storage_quota_bytes. Raises if unauthorized or if the '
  'quota would be exceeded, before any usage is consumed. SECURITY DEFINER + '
  'safe search_path.';

-- ─────────────────────────────────────────────────────────────────────────
-- 3. SECURITY DEFINER EXECUTE ACL HARDENING (COMPLETE SURFACE)
--
-- Intended ACL matrix (verified from repository usage: every directly-callable
-- RPC is invoked only from the caller-authenticated client or from Edge
-- Functions that forward the caller's JWT — none use service_role, and none
-- are called by anon):
--   directly-callable RPCs  -> EXECUTE = {owner(postgres), authenticated}
--   trigger-only functions  -> EXECUTE = {owner(postgres)} only
-- REVOKE from PUBLIC removes the implicit default grant; REVOKE from anon is
-- explicit/defensive. Statements are idempotent for functions already at the
-- intended ACL (consume_ai_quota, refund_ai_quota, get_ai_quota_status,
-- get_current_user_access).
-- ─────────────────────────────────────────────────────────────────────────

-- 3a. Directly-callable, signed-in-user-only RPCs → {owner, authenticated}
REVOKE ALL ON FUNCTION public.bulk_set_paper_projects(uuid[], uuid[]) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.bulk_set_paper_projects(uuid[], uuid[]) TO authenticated;

REVOKE ALL ON FUNCTION public.bulk_set_paper_tags(uuid[], uuid[]) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.bulk_set_paper_tags(uuid[], uuid[]) TO authenticated;

REVOKE ALL ON FUNCTION public.bulk_update_keywords(jsonb) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.bulk_update_keywords(jsonb) TO authenticated;

REVOKE ALL ON FUNCTION public.bulk_update_study_types(jsonb) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.bulk_update_study_types(jsonb) TO authenticated;

REVOKE ALL ON FUNCTION public.consume_ai_quota(uuid) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.consume_ai_quota(uuid) TO authenticated;

REVOKE ALL ON FUNCTION public.filter_papers_by_keywords(uuid, text[]) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.filter_papers_by_keywords(uuid, text[]) TO authenticated;

REVOKE ALL ON FUNCTION public.get_ai_quota_status(uuid) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.get_ai_quota_status(uuid) TO authenticated;

REVOKE ALL ON FUNCTION public.get_current_user_access() FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.get_current_user_access() TO authenticated;

REVOKE ALL ON FUNCTION public.get_duplicate_papers() FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.get_duplicate_papers() TO authenticated;

REVOKE ALL ON FUNCTION public.get_keyword_options(uuid, uuid[], integer, integer, text[]) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.get_keyword_options(uuid, uuid[], integer, integer, text[]) TO authenticated;

REVOKE ALL ON FUNCTION public.merge_exact_duplicates(uuid, uuid[]) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.merge_exact_duplicates(uuid, uuid[]) TO authenticated;

REVOKE ALL ON FUNCTION public.refund_ai_quota(uuid) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.refund_ai_quota(uuid) TO authenticated;

REVOKE ALL ON FUNCTION public.safe_bulk_insert_papers(uuid, jsonb) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.safe_bulk_insert_papers(uuid, jsonb) TO authenticated;

REVOKE ALL ON FUNCTION public.search_papers(uuid, text, integer, integer) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.search_papers(uuid, text, integer, integer) TO authenticated;

REVOKE ALL ON FUNCTION public.search_papers_short(uuid, text) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.search_papers_short(uuid, text) TO authenticated;

REVOKE ALL ON FUNCTION public.set_paper_projects(uuid, uuid[]) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.set_paper_projects(uuid, uuid[]) TO authenticated;

REVOKE ALL ON FUNCTION public.set_paper_tags(uuid, uuid[]) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.set_paper_tags(uuid, uuid[]) TO authenticated;

-- 3b. Trigger-only functions → {owner} only. Triggers fire via the trigger
-- mechanism (owner context) and do not require EXECUTE grants to client roles.
REVOKE ALL ON FUNCTION public.check_and_consume_storage_quota() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.handle_new_user() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.refund_storage_quota() FROM PUBLIC, anon, authenticated;

-- ─────────────────────────────────────────────────────────────────────────
-- 4. paper_projects RELATIONAL OWNERSHIP POLICIES
--
-- Prior policies checked only that the referenced PAPER belonged to auth.uid(),
-- allowing a user to link their own paper to another user's project. Require
-- BOTH the paper AND the project to belong to auth.uid() for SELECT / INSERT /
-- DELETE. RLS + FORCE RLS are preserved (unchanged by policy replacement).
-- ─────────────────────────────────────────────────────────────────────────

DROP POLICY IF EXISTS "Users can view their paper-project links" ON public.paper_projects;
DROP POLICY IF EXISTS "Users can add projects to their papers" ON public.paper_projects;
DROP POLICY IF EXISTS "Users can remove projects from their papers" ON public.paper_projects;

CREATE POLICY "paper_projects owner select" ON public.paper_projects
  FOR SELECT
  USING (
    EXISTS (SELECT 1 FROM public.papers p   WHERE p.id  = paper_projects.paper_id    AND p.user_id  = auth.uid())
    AND EXISTS (SELECT 1 FROM public.projects pr WHERE pr.id = paper_projects.project_id AND pr.user_id = auth.uid())
  );

CREATE POLICY "paper_projects owner insert" ON public.paper_projects
  FOR INSERT
  WITH CHECK (
    EXISTS (SELECT 1 FROM public.papers p   WHERE p.id  = paper_projects.paper_id    AND p.user_id  = auth.uid())
    AND EXISTS (SELECT 1 FROM public.projects pr WHERE pr.id = paper_projects.project_id AND pr.user_id = auth.uid())
  );

CREATE POLICY "paper_projects owner delete" ON public.paper_projects
  FOR DELETE
  USING (
    EXISTS (SELECT 1 FROM public.papers p   WHERE p.id  = paper_projects.paper_id    AND p.user_id  = auth.uid())
    AND EXISTS (SELECT 1 FROM public.projects pr WHERE pr.id = paper_projects.project_id AND pr.user_id = auth.uid())
  );

-- ─────────────────────────────────────────────────────────────────────────
-- 5. paper_tags RELATIONAL OWNERSHIP POLICIES
--
-- Mirror of section 4: require BOTH the paper AND the tag to belong to
-- auth.uid() for SELECT / INSERT / DELETE.
-- ─────────────────────────────────────────────────────────────────────────

DROP POLICY IF EXISTS "Users can view tags on their papers" ON public.paper_tags;
DROP POLICY IF EXISTS "Users can add tags to their papers" ON public.paper_tags;
DROP POLICY IF EXISTS "Users can remove tags from their papers" ON public.paper_tags;

CREATE POLICY "paper_tags owner select" ON public.paper_tags
  FOR SELECT
  USING (
    EXISTS (SELECT 1 FROM public.papers p WHERE p.id = paper_tags.paper_id AND p.user_id = auth.uid())
    AND EXISTS (SELECT 1 FROM public.tags t WHERE t.id = paper_tags.tag_id AND t.user_id = auth.uid())
  );

CREATE POLICY "paper_tags owner insert" ON public.paper_tags
  FOR INSERT
  WITH CHECK (
    EXISTS (SELECT 1 FROM public.papers p WHERE p.id = paper_tags.paper_id AND p.user_id = auth.uid())
    AND EXISTS (SELECT 1 FROM public.tags t WHERE t.id = paper_tags.tag_id AND t.user_id = auth.uid())
  );

CREATE POLICY "paper_tags owner delete" ON public.paper_tags
  FOR DELETE
  USING (
    EXISTS (SELECT 1 FROM public.papers p WHERE p.id = paper_tags.paper_id AND p.user_id = auth.uid())
    AND EXISTS (SELECT 1 FROM public.tags t WHERE t.id = paper_tags.tag_id AND t.user_id = auth.uid())
  );

-- ─────────────────────────────────────────────────────────────────────────
-- 6. paper_attachments OWNERSHIP POLICIES
--
-- Prior policies checked only auth.uid() = user_id, allowing a row to point at
-- another user's paper. Require the attachment owner to be the caller AND the
-- referenced paper to be owned by that same caller for SELECT / INSERT /
-- DELETE. RLS enablement is preserved (unchanged by policy replacement).
-- ─────────────────────────────────────────────────────────────────────────

DROP POLICY IF EXISTS "owner select" ON public.paper_attachments;
DROP POLICY IF EXISTS "owner insert" ON public.paper_attachments;
DROP POLICY IF EXISTS "owner delete" ON public.paper_attachments;

CREATE POLICY "owner select" ON public.paper_attachments
  FOR SELECT
  USING (
    auth.uid() = user_id
    AND EXISTS (
      SELECT 1 FROM public.papers p
      WHERE p.id = paper_attachments.paper_id
        AND p.user_id = auth.uid()
        AND p.user_id = paper_attachments.user_id
    )
  );

CREATE POLICY "owner insert" ON public.paper_attachments
  FOR INSERT
  WITH CHECK (
    auth.uid() = user_id
    AND EXISTS (
      SELECT 1 FROM public.papers p
      WHERE p.id = paper_attachments.paper_id
        AND p.user_id = auth.uid()
        AND p.user_id = paper_attachments.user_id
    )
  );

CREATE POLICY "owner delete" ON public.paper_attachments
  FOR DELETE
  USING (
    auth.uid() = user_id
    AND EXISTS (
      SELECT 1 FROM public.papers p
      WHERE p.id = paper_attachments.paper_id
        AND p.user_id = auth.uid()
        AND p.user_id = paper_attachments.user_id
    )
  );
