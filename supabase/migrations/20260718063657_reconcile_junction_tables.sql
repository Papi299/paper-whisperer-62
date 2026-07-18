-- RECON-JUNCTIONS-001 — reconcile paper_tags / paper_projects to the
-- approved composite-primary-key model (decision C22; plan in
-- docs/schema-reconciliation.md; remote application mandated by C24).
--
-- Two supported starting states, converged to one canonical result:
--
--   * Clean local replay (migrations 20260203072053 / 20260301124539):
--     surrogate `id uuid` PRIMARY KEY, UNIQUE(pair), `created_at`,
--     plus legacy idx_<tbl>_paper_id indexes.
--   * Current production (predates the first tracked migration):
--     composite PRIMARY KEY on the pair, no `id`, no `created_at`,
--     no pair UNIQUE, no idx_<tbl>_paper_id; paper_tags is missing
--     the reverse index idx_paper_tags_tag_id.
--
-- Canonical end state (both environments):
--   paper_tags(paper_id, tag_id)         PK (paper_id, tag_id)
--   paper_projects(paper_id, project_id) PK (paper_id, project_id)
--   FKs to papers/tags/projects ON DELETE CASCADE (unchanged);
--   reverse indexes idx_paper_tags_tag_id / idx_paper_projects_project_id;
--   no surrogate id, no created_at, no redundant pair UNIQUE, no
--   redundant paper_id index (the composite PK covers paper_id-leading
--   lookups);
--   the four assignment RPCs re-declared in one canonical text form
--   (bodies were already semantically identical local-vs-remote; only
--   blank-line formatting differed, which kept schema diffs noisy).
--
-- Safety: metadata-driven; fails BEFORE any destructive DDL when the
-- starting state cannot be classified, pair data is unsound (NULL
-- members / duplicate pairs), an FK is not the expected canonical
-- definition, an external object depends on id/created_at, or a
-- required index name exists with a conflicting definition. Never uses
-- CASCADE, never deletes or rewrites junction rows, never touches RLS
-- or policies.

DO $$
DECLARE
  t record;
  v_relid oid;
  v_pk_cols text;
  v_pk_name text;
  v_cnt bigint;
  v_conname text;
  v_indexdef text;
  v_expected_fk text;
  v_fk_def text;
BEGIN
  FOR t IN
    SELECT * FROM (VALUES
      ('paper_tags',     'tag_id',     'tags',     'idx_paper_tags_tag_id'),
      ('paper_projects', 'project_id', 'projects', 'idx_paper_projects_project_id')
    ) AS v(tbl, col2, ref_tbl, rev_idx)
  LOOP
    -- ── 1. Table and pair columns must exist ────────────────────────
    SELECT c.oid INTO v_relid
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = t.tbl AND c.relkind = 'r';
    IF v_relid IS NULL THEN
      RAISE EXCEPTION 'RECON-JUNCTIONS: table public.% is missing', t.tbl;
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_attribute
                   WHERE attrelid = v_relid AND attname = 'paper_id'
                     AND attnum > 0 AND NOT attisdropped)
       OR NOT EXISTS (SELECT 1 FROM pg_attribute
                   WHERE attrelid = v_relid AND attname = t.col2
                     AND attnum > 0 AND NOT attisdropped) THEN
      RAISE EXCEPTION 'RECON-JUNCTIONS: %.% pair columns missing', t.tbl, t.col2;
    END IF;

    -- ── 2. Pair data must be sound (no NULLs, no duplicate pairs) ───
    EXECUTE format(
      'SELECT count(*) FROM public.%I WHERE paper_id IS NULL OR %I IS NULL',
      t.tbl, t.col2) INTO v_cnt;
    IF v_cnt > 0 THEN
      RAISE EXCEPTION 'RECON-JUNCTIONS: % has % rows with NULL pair members', t.tbl, v_cnt;
    END IF;

    EXECUTE format(
      'SELECT count(*) FROM (SELECT 1 FROM public.%I GROUP BY paper_id, %I HAVING count(*) > 1) d',
      t.tbl, t.col2) INTO v_cnt;
    IF v_cnt > 0 THEN
      RAISE EXCEPTION 'RECON-JUNCTIONS: % has % duplicate pairs', t.tbl, v_cnt;
    END IF;

    -- ── 3. Both canonical FKs must already exist with CASCADE ───────
    FOREACH v_expected_fk IN ARRAY ARRAY['paper_id:papers', t.col2 || ':' || t.ref_tbl]
    LOOP
      SELECT pg_get_constraintdef(con.oid) INTO v_fk_def
      FROM pg_constraint con
      WHERE con.conrelid = v_relid AND con.contype = 'f'
        AND con.confrelid = ('public.' || quote_ident(split_part(v_expected_fk, ':', 2)))::regclass
        AND (SELECT attname FROM pg_attribute
             WHERE attrelid = v_relid AND attnum = con.conkey[1]) = split_part(v_expected_fk, ':', 1)
        AND array_length(con.conkey, 1) = 1;
      IF v_fk_def IS NULL OR v_fk_def NOT LIKE '%ON DELETE CASCADE%' THEN
        RAISE EXCEPTION 'RECON-JUNCTIONS: %.% FK to % missing or not ON DELETE CASCADE (found: %)',
          t.tbl, split_part(v_expected_fk, ':', 1), split_part(v_expected_fk, ':', 2), coalesce(v_fk_def, 'none');
      END IF;
      v_fk_def := NULL;
    END LOOP;

    -- ── 4. No external object may depend on id / created_at ─────────
    -- (a) no FK in another table may reference this table's id column;
    IF EXISTS (
      SELECT 1 FROM pg_constraint con
      WHERE con.confrelid = v_relid AND con.contype = 'f'
        AND (SELECT attname FROM pg_attribute
             WHERE attrelid = v_relid AND attnum = con.confkey[1]) = 'id'
    ) THEN
      RAISE EXCEPTION 'RECON-JUNCTIONS: external FK references %.id', t.tbl;
    END IF;
    -- (b) no view/rule may depend on id or created_at.
    IF EXISTS (
      SELECT 1
      FROM pg_attribute a
      JOIN pg_depend d ON d.refobjid = a.attrelid AND d.refobjsubid = a.attnum
      JOIN pg_rewrite rw ON rw.oid = d.objid
      WHERE a.attrelid = v_relid AND a.attname IN ('id', 'created_at')
        AND NOT a.attisdropped
    ) THEN
      RAISE EXCEPTION 'RECON-JUNCTIONS: a view depends on %.id/created_at', t.tbl;
    END IF;

    -- ── 5. Classify and convert the primary key ─────────────────────
    SELECT con.conname,
           (SELECT string_agg(att.attname, ',' ORDER BY ord.n)
            FROM unnest(con.conkey) WITH ORDINALITY AS ord(attnum, n)
            JOIN pg_attribute att ON att.attrelid = v_relid AND att.attnum = ord.attnum)
    INTO v_pk_name, v_pk_cols
    FROM pg_constraint con
    WHERE con.conrelid = v_relid AND con.contype = 'p';

    IF v_pk_cols = 'paper_id,' || t.col2 THEN
      -- Already canonical (production path): nothing to convert.
      NULL;
    ELSIF v_pk_cols = 'id' THEN
      -- Surrogate path (clean local replay): convert.
      EXECUTE format('ALTER TABLE public.%I DROP CONSTRAINT %I', t.tbl, v_pk_name);
      EXECUTE format('ALTER TABLE public.%I DROP COLUMN id', t.tbl);
      IF EXISTS (SELECT 1 FROM pg_attribute
                 WHERE attrelid = v_relid AND attname = 'created_at'
                   AND attnum > 0 AND NOT attisdropped) THEN
        EXECUTE format('ALTER TABLE public.%I DROP COLUMN created_at', t.tbl);
      END IF;
      EXECUTE format('ALTER TABLE public.%I ADD CONSTRAINT %I PRIMARY KEY (paper_id, %I)',
                     t.tbl, t.tbl || '_pkey', t.col2);
    ELSE
      RAISE EXCEPTION 'RECON-JUNCTIONS: % has unexpected primary key (%) on columns (%)',
        t.tbl, coalesce(v_pk_name, 'none'), coalesce(v_pk_cols, 'none');
    END IF;

    -- ── 6. Drop the now-redundant UNIQUE constraint on the same pair ─
    SELECT con.conname INTO v_conname
    FROM pg_constraint con
    WHERE con.conrelid = v_relid AND con.contype = 'u'
      AND (SELECT string_agg(att.attname, ',' ORDER BY ord.n)
           FROM unnest(con.conkey) WITH ORDINALITY AS ord(attnum, n)
           JOIN pg_attribute att ON att.attrelid = v_relid AND att.attnum = ord.attnum)
          = 'paper_id,' || t.col2;
    IF v_conname IS NOT NULL THEN
      EXECUTE format('ALTER TABLE public.%I DROP CONSTRAINT %I', t.tbl, v_conname);
      v_conname := NULL;
    END IF;

    -- ── 7. Indexes ──────────────────────────────────────────────────
    -- Redundant paper_id-leading index (covered by the composite PK;
    -- absent in production): drop when present.
    EXECUTE format('DROP INDEX IF EXISTS public.%I', 'idx_' || t.tbl || '_paper_id');

    -- Required reverse index: verify definition when present, create
    -- when absent, fail on a conflicting definition.
    SELECT indexdef INTO v_indexdef
    FROM pg_indexes
    WHERE schemaname = 'public' AND tablename = t.tbl AND indexname = t.rev_idx;
    IF v_indexdef IS NULL THEN
      EXECUTE format('CREATE INDEX %I ON public.%I USING btree (%I)',
                     t.rev_idx, t.tbl, t.col2);
    ELSIF v_indexdef <> format('CREATE INDEX %s ON public.%s USING btree (%s)',
                               t.rev_idx, t.tbl, t.col2) THEN
      RAISE EXCEPTION 'RECON-JUNCTIONS: index % exists with conflicting definition: %',
        t.rev_idx, v_indexdef;
    END IF;

    v_relid := NULL;
    v_pk_cols := NULL;
    v_pk_name := NULL;
    v_indexdef := NULL;
  END LOOP;
END;
$$;

-- ── 8. Canonical text form for the four assignment RPCs ─────────────
-- Semantics are unchanged (bodies were already identical on both
-- sides); this normalizes the body text to production's exact form so
-- schema diffs stop reporting formatting-only function differences.
-- Signatures, return types, language, SECURITY DEFINER, search_path,
-- ownership, and grants are all preserved by CREATE OR REPLACE.

CREATE OR REPLACE FUNCTION "public"."set_paper_tags"("p_paper_id" "uuid", "p_tag_ids" "uuid"[]) RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM papers WHERE id = p_paper_id AND user_id = auth.uid()
  ) THEN
    RAISE EXCEPTION 'Paper not found or access denied';
  END IF;
  DELETE FROM paper_tags WHERE paper_id = p_paper_id;
  IF array_length(p_tag_ids, 1) > 0 THEN
    INSERT INTO paper_tags (paper_id, tag_id)
    SELECT p_paper_id, unnest(p_tag_ids);
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION "public"."set_paper_projects"("p_paper_id" "uuid", "p_project_ids" "uuid"[]) RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM papers WHERE id = p_paper_id AND user_id = auth.uid()
  ) THEN
    RAISE EXCEPTION 'Paper not found or access denied';
  END IF;
  DELETE FROM paper_projects WHERE paper_id = p_paper_id;
  IF array_length(p_project_ids, 1) > 0 THEN
    INSERT INTO paper_projects (paper_id, project_id)
    SELECT p_paper_id, unnest(p_project_ids);
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION "public"."bulk_set_paper_tags"("p_paper_ids" "uuid"[], "p_tag_ids" "uuid"[]) RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
BEGIN
  DELETE FROM paper_tags
  WHERE paper_id = ANY(p_paper_ids)
    AND paper_id IN (SELECT id FROM papers WHERE user_id = auth.uid());
  IF array_length(p_tag_ids, 1) > 0 THEN
    INSERT INTO paper_tags (paper_id, tag_id)
    SELECT pid, tid
    FROM unnest(p_paper_ids) AS pid
    CROSS JOIN unnest(p_tag_ids) AS tid
    WHERE pid IN (SELECT id FROM papers WHERE user_id = auth.uid());
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION "public"."bulk_set_paper_projects"("p_paper_ids" "uuid"[], "p_project_ids" "uuid"[]) RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
BEGIN
  DELETE FROM paper_projects
  WHERE paper_id = ANY(p_paper_ids)
    AND paper_id IN (SELECT id FROM papers WHERE user_id = auth.uid());
  IF array_length(p_project_ids, 1) > 0 THEN
    INSERT INTO paper_projects (paper_id, project_id)
    SELECT pid, projid
    FROM unnest(p_paper_ids) AS pid
    CROSS JOIN unnest(p_project_ids) AS projid
    WHERE pid IN (SELECT id FROM papers WHERE user_id = auth.uid());
  END IF;
END;
$$;
