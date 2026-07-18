-- RECON-JUNCTIONS-001 — reconcile paper_tags / paper_projects to the
-- approved composite-primary-key model (decision C22; plan in
-- docs/schema-reconciliation.md; remote application mandated by C24).
--
-- Two supported starting states, converged to one canonical result:
--
--   * Surrogate clean-replay state (migrations 20260203072053 /
--     20260301124539): live columns exactly {id, paper_id, <pair2>,
--     created_at}; id uuid NOT NULL single-column PRIMARY KEY named
--     <tbl>_pkey; exactly one pair UNIQUE constraint; optionally the
--     legacy idx_<tbl>_paper_id index (approved definition only);
--     reverse index absent or exactly canonical.
--   * Production composite state (predates the first tracked
--     migration): live columns exactly the uuid NOT NULL pair;
--     PRIMARY KEY (pair) named <tbl>_pkey; no id, no created_at, no
--     pair UNIQUE, no paper_id-only index; reverse index absent or
--     exactly canonical (production currently lacks
--     idx_paper_tags_tag_id, which this migration creates).
--
-- Canonical end state (both environments):
--   paper_tags(paper_id uuid NOT NULL, tag_id uuid NOT NULL)
--     PRIMARY KEY (paper_id, tag_id)  [paper_tags_pkey]
--   paper_projects(paper_id uuid NOT NULL, project_id uuid NOT NULL)
--     PRIMARY KEY (paper_id, project_id)  [paper_projects_pkey]
--   FKs to papers/tags/projects(id) ON DELETE CASCADE (unchanged);
--   reverse indexes idx_paper_tags_tag_id /
--   idx_paper_projects_project_id; no surrogate id, no created_at, no
--   redundant pair UNIQUE, no paper_id-only index; the four assignment
--   RPCs re-declared in one canonical text form (bodies already
--   semantically identical local-vs-remote; only blank-line formatting
--   differed, which kept schema diffs noisy).
--
-- Two-phase safety design:
--   Phase A classifies and fully validates BOTH tables (columns,
--   exact uuid/NOT NULL types, PK shape and name, UNIQUE inventory,
--   exact catalog-level FK validation, index-definition validation,
--   row soundness, and dependency inspection over id/created_at)
--   before ANY DDL runs against EITHER table. Phase B performs only
--   the conversion classified in Phase A. Phase C re-asserts the exact
--   canonical end state for both tables and fails on any residue.
--   Any state that does not classify as exactly one of the two
--   supported states raises in Phase A — before any destructive DDL.
--
--   Dependency inspection covers: external FKs referencing
--   id/created_at, views/materialized views/rules (pg_rewrite deps),
--   policies (pg_policy deps), triggers (pg_trigger deps), column
--   defaults of other columns (pg_attrdef deps), and any
--   constraint/index touching id/created_at beyond the classified
--   surrogate PK. For any dependency class not enumerated above,
--   PostgreSQL's restrictive (non-CASCADE) DROP COLUMN remains the
--   terminal backstop: an untracked dependent would abort the
--   transaction rather than be dropped silently.
--
--   Never uses CASCADE; never deletes or rewrites junction rows;
--   never touches RLS enablement, FORCE state, or policies.

DO $$
DECLARE
  t record;
  v_class jsonb := '{}'::jsonb;   -- per-table Phase A classification
  v_relid oid;
  v_cols text[];
  v_state text;
  v_pk_name text;
  v_pk_cols text[];
  v_pk_count int;
  v_pk_oid oid;
  v_uq_count int;
  v_uq_name text;
  v_uq_oid oid;
  v_uq_indexrelid oid;
  v_fk_oids oid[];
  v_fk_oid oid;
  v_cnt bigint;
  v_fk record;
  v_idx record;
  v_legacy_present boolean;
  v_rev_present boolean;
  v_col text;
  v_attnum int2;
BEGIN
  -- ════════════════════ PHASE A — classify and validate ════════════════════
  FOR t IN
    SELECT * FROM (VALUES
      ('paper_tags',     'tag_id',     'tags',     'idx_paper_tags_tag_id',         'idx_paper_tags_paper_id'),
      ('paper_projects', 'project_id', 'projects', 'idx_paper_projects_project_id', 'idx_paper_projects_paper_id')
    ) AS v(tbl, col2, ref_tbl, rev_idx, legacy_idx)
  LOOP
    -- A1. Table must exist.
    SELECT c.oid INTO v_relid
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = t.tbl AND c.relkind = 'r';
    IF v_relid IS NULL THEN
      RAISE EXCEPTION 'RECON-JUNCTIONS Phase A: table public.% is missing', t.tbl;
    END IF;

    -- A2. Exact live-column set decides the candidate state.
    SELECT array_agg(attname::text ORDER BY attname) INTO v_cols
    FROM pg_attribute
    WHERE attrelid = v_relid AND attnum > 0 AND NOT attisdropped;

    IF v_cols = (SELECT array_agg(x ORDER BY x) FROM unnest(ARRAY['paper_id', t.col2]) x) THEN
      v_state := 'composite';
    ELSIF v_cols = (SELECT array_agg(x ORDER BY x) FROM unnest(ARRAY['id', 'paper_id', t.col2, 'created_at']) x) THEN
      v_state := 'surrogate';
    ELSE
      RAISE EXCEPTION 'RECON-JUNCTIONS Phase A: % has unsupported column set (%)', t.tbl, v_cols;
    END IF;

    -- A3. Pair columns: exactly uuid, NOT NULL, plain (not generated /
    -- identity), not dropped.
    FOREACH v_col IN ARRAY ARRAY['paper_id', t.col2] LOOP
      PERFORM 1 FROM pg_attribute
      WHERE attrelid = v_relid AND attname = v_col AND attnum > 0
        AND NOT attisdropped
        AND atttypid = 'uuid'::regtype
        AND attnotnull
        AND attgenerated = ''
        AND attidentity = '';
      IF NOT FOUND THEN
        RAISE EXCEPTION 'RECON-JUNCTIONS Phase A: %.% is not a plain uuid NOT NULL column', t.tbl, v_col;
      END IF;
    END LOOP;

    -- A4. Surrogate-only column checks.
    IF v_state = 'surrogate' THEN
      PERFORM 1 FROM pg_attribute
      WHERE attrelid = v_relid AND attname = 'id'
        AND atttypid = 'uuid'::regtype AND attnotnull
        AND attgenerated = '' AND attidentity = '';
      IF NOT FOUND THEN
        RAISE EXCEPTION 'RECON-JUNCTIONS Phase A: %.id is not a plain uuid NOT NULL column', t.tbl;
      END IF;
      PERFORM 1 FROM pg_attribute
      WHERE attrelid = v_relid AND attname = 'created_at' AND attnum > 0
        AND NOT attisdropped
        AND atttypid = 'timestamptz'::regtype AND attnotnull
        AND attgenerated = '' AND attidentity = '';
      IF NOT FOUND THEN
        RAISE EXCEPTION 'RECON-JUNCTIONS Phase A: %.created_at is not a plain timestamptz NOT NULL column', t.tbl;
      END IF;
    END IF;

    -- A5. Exactly one primary key, with the exact expected shape+name.
    SELECT count(*) INTO v_pk_count FROM pg_constraint
    WHERE conrelid = v_relid AND contype = 'p';
    IF v_pk_count <> 1 THEN
      RAISE EXCEPTION 'RECON-JUNCTIONS Phase A: % has % primary keys', t.tbl, v_pk_count;
    END IF;

    SELECT con.oid, con.conname,
           (SELECT array_agg(att.attname::text ORDER BY ord.n)
            FROM unnest(con.conkey) WITH ORDINALITY AS ord(attnum, n)
            JOIN pg_attribute att ON att.attrelid = v_relid AND att.attnum = ord.attnum)
    INTO v_pk_oid, v_pk_name, v_pk_cols
    FROM pg_constraint con
    WHERE con.conrelid = v_relid AND con.contype = 'p';

    IF v_state = 'composite' THEN
      IF v_pk_cols <> ARRAY['paper_id', t.col2] OR v_pk_name <> t.tbl || '_pkey' THEN
        RAISE EXCEPTION 'RECON-JUNCTIONS Phase A: % composite PK mismatch (name=%, cols=%)', t.tbl, v_pk_name, v_pk_cols;
      END IF;
    ELSE
      IF v_pk_cols <> ARRAY['id'] OR v_pk_name <> t.tbl || '_pkey' THEN
        RAISE EXCEPTION 'RECON-JUNCTIONS Phase A: % surrogate PK mismatch (name=%, cols=%)', t.tbl, v_pk_name, v_pk_cols;
      END IF;
    END IF;

    -- A6. Pair UNIQUE inventory: exactly one in surrogate state, zero
    -- in composite state; never more than one (deterministic drop).
    -- The single surrogate constraint is bound to its backing unique
    -- index through pg_constraint.conindid, and that backing index is
    -- validated here; A9 then permits a unique pair index ONLY when
    -- its indexrelid equals this captured conindid.
    SELECT count(*) INTO v_uq_count
    FROM pg_constraint con
    WHERE con.conrelid = v_relid AND con.contype = 'u'
      AND (SELECT array_agg(att.attname::text ORDER BY att.attname)
           FROM unnest(con.conkey) ck(attnum)
           JOIN pg_attribute att ON att.attrelid = v_relid AND att.attnum = ck.attnum)
          = (SELECT array_agg(x ORDER BY x) FROM unnest(ARRAY['paper_id', t.col2]) x);
    IF (v_state = 'surrogate' AND v_uq_count <> 1)
       OR (v_state = 'composite' AND v_uq_count <> 0) THEN
      RAISE EXCEPTION 'RECON-JUNCTIONS Phase A: % has % pair UNIQUE constraints (state %)', t.tbl, v_uq_count, v_state;
    END IF;

    v_uq_oid := NULL; v_uq_name := NULL; v_uq_indexrelid := NULL;
    IF v_state = 'surrogate' THEN
      SELECT con.oid, con.conname::text, con.conindid
      INTO v_uq_oid, v_uq_name, v_uq_indexrelid
      FROM pg_constraint con
      WHERE con.conrelid = v_relid AND con.contype = 'u'
        AND (SELECT array_agg(att.attname::text ORDER BY att.attname)
             FROM unnest(con.conkey) ck(attnum)
             JOIN pg_attribute att ON att.attrelid = v_relid AND att.attnum = ck.attnum)
            = (SELECT array_agg(x ORDER BY x) FROM unnest(ARRAY['paper_id', t.col2]) x);

      IF v_uq_indexrelid IS NULL OR v_uq_indexrelid = 0 THEN
        RAISE EXCEPTION 'RECON-JUNCTIONS Phase A: % pair UNIQUE % has no backing index (conindid)', t.tbl, v_uq_name;
      END IF;
      PERFORM 1
      FROM pg_index i
      WHERE i.indexrelid = v_uq_indexrelid
        AND i.indrelid = v_relid
        AND i.indisunique AND i.indisvalid AND i.indisready
        AND i.indnatts = 2 AND i.indnkeyatts = 2
        AND i.indpred IS NULL AND i.indexprs IS NULL
        AND (SELECT array_agg(CASE WHEN k.attnum = 0 THEN '<expr>'
                                   ELSE (SELECT attname::text FROM pg_attribute
                                         WHERE attrelid = i.indrelid AND attnum = k.attnum) END
                              ORDER BY k.ord)
             FROM unnest(i.indkey::int2[]) WITH ORDINALITY k(attnum, ord))
            = ARRAY['paper_id', t.col2];
      IF NOT FOUND THEN
        RAISE EXCEPTION 'RECON-JUNCTIONS Phase A: % pair UNIQUE % backing index is not the canonical ordered pair index', t.tbl, v_uq_name;
      END IF;
    END IF;

    -- A7. Exact FK validation via catalog fields: exactly one FK per
    -- pair column; single-column; targets <ref>(id); ON DELETE
    -- CASCADE; ON UPDATE NO ACTION; validated; not deferrable; and no
    -- other FK exists on the table.
    SELECT count(*) INTO v_cnt FROM pg_constraint
    WHERE conrelid = v_relid AND contype = 'f';
    IF v_cnt <> 2 THEN
      RAISE EXCEPTION 'RECON-JUNCTIONS Phase A: % has % foreign keys (expected exactly 2)', t.tbl, v_cnt;
    END IF;

    v_fk_oids := ARRAY[]::oid[];
    FOR v_fk IN
      SELECT * FROM (VALUES
        ('paper_id', 'papers'),
        (t.col2,     t.ref_tbl)
      ) AS f(src_col, ref_tbl)
    LOOP
      SELECT count(*) INTO v_cnt
      FROM pg_constraint con
      WHERE con.conrelid = v_relid AND con.contype = 'f'
        AND con.conkey = ARRAY[(SELECT attnum FROM pg_attribute
                                WHERE attrelid = v_relid AND attname = v_fk.src_col)]::int2[];
      IF v_cnt <> 1 THEN
        RAISE EXCEPTION 'RECON-JUNCTIONS Phase A: %.% has % FKs (expected exactly 1)', t.tbl, v_fk.src_col, v_cnt;
      END IF;

      SELECT con.oid INTO v_fk_oid
      FROM pg_constraint con
      WHERE con.conrelid = v_relid AND con.contype = 'f'
        AND con.conkey = ARRAY[(SELECT attnum FROM pg_attribute
                                WHERE attrelid = v_relid AND attname = v_fk.src_col)]::int2[]
        AND con.confrelid = ('public.' || quote_ident(v_fk.ref_tbl))::regclass
        AND array_length(con.confkey, 1) = 1
        AND (SELECT attname FROM pg_attribute
             WHERE attrelid = con.confrelid AND attnum = con.confkey[1]) = 'id'
        AND con.confdeltype = 'c'     -- ON DELETE CASCADE
        AND con.confupdtype = 'a'     -- ON UPDATE NO ACTION
        AND con.convalidated
        AND NOT con.condeferrable
        AND NOT con.condeferred;
      IF v_fk_oid IS NULL THEN
        RAISE EXCEPTION 'RECON-JUNCTIONS Phase A: %.% FK is not the canonical validated single-column FK to %(id) ON DELETE CASCADE', t.tbl, v_fk.src_col, v_fk.ref_tbl;
      END IF;
      v_fk_oids := v_fk_oids || v_fk_oid;
      v_fk_oid := NULL;
    END LOOP;

    -- A7b. Exact constraint inventory: the identified canonical
    -- constraint OIDs (PK + 2 FKs, plus the single pair UNIQUE in the
    -- surrogate state) must account for EVERY pg_constraint row on the
    -- table. Any additional constraint of any type — CHECK, exclusion,
    -- extra UNIQUE/FK, or anything else — is an unsupported state.
    SELECT count(*) INTO v_cnt
    FROM pg_constraint con
    WHERE con.conrelid = v_relid
      AND con.oid <> ALL (v_fk_oids || v_pk_oid || COALESCE(v_uq_oid, 0::oid));
    IF v_cnt > 0 THEN
      RAISE EXCEPTION 'RECON-JUNCTIONS Phase A: % has % constraint(s) beyond the canonical inventory (types found: %)',
        t.tbl, v_cnt,
        (SELECT string_agg(DISTINCT con.contype::text, ',')
         FROM pg_constraint con
         WHERE con.conrelid = v_relid
           AND con.oid <> ALL (v_fk_oids || v_pk_oid || COALESCE(v_uq_oid, 0::oid)));
    END IF;

    -- A8. Row soundness (schema NOT NULL is asserted above; this
    -- guards data on the off-chance of an invalid constraint).
    EXECUTE format('SELECT count(*) FROM public.%I WHERE paper_id IS NULL OR %I IS NULL', t.tbl, t.col2) INTO v_cnt;
    IF v_cnt > 0 THEN
      RAISE EXCEPTION 'RECON-JUNCTIONS Phase A: % has % rows with NULL pair members', t.tbl, v_cnt;
    END IF;
    EXECUTE format('SELECT count(*) FROM (SELECT 1 FROM public.%I GROUP BY paper_id, %I HAVING count(*) > 1) d', t.tbl, t.col2) INTO v_cnt;
    IF v_cnt > 0 THEN
      RAISE EXCEPTION 'RECON-JUNCTIONS Phase A: % has % duplicate pairs', t.tbl, v_cnt;
    END IF;

    -- A9. Index inventory: every index must be one of (a) the PK
    -- index, (b) the legacy paper_id index under its exact approved
    -- definition, (c) the canonical reverse index. Equivalent indexes
    -- under other names, conflicting same-name definitions, and any
    -- unexpected index (including any on id/created_at) all fail.
    v_legacy_present := false;
    v_rev_present := false;
    FOR v_idx IN
      SELECT i.indexrelid,
             ic.relname AS idx_name,
             i.indisunique, i.indisprimary, i.indisvalid, i.indisready,
             am.amname,
             i.indnkeyatts,
             i.indnatts,
             (SELECT array_agg(CASE WHEN k.attnum = 0 THEN '<expr>'
                                    ELSE (SELECT attname::text FROM pg_attribute
                                          WHERE attrelid = i.indrelid AND attnum = k.attnum) END
                               ORDER BY k.ord)
              FROM unnest(i.indkey::int2[]) WITH ORDINALITY k(attnum, ord)) AS keycols,
             (i.indpred IS NOT NULL) AS haspred,
             (i.indexprs IS NOT NULL) AS hasexpr
      FROM pg_index i
      JOIN pg_class ic ON ic.oid = i.indexrelid
      JOIN pg_am am ON am.oid = ic.relam
      WHERE i.indrelid = v_relid
    LOOP
      IF v_idx.indisprimary THEN
        CONTINUE;  -- PK index shape is governed by the PK checks above.
      ELSIF v_idx.idx_name = t.legacy_idx THEN
        IF v_state <> 'surrogate'
           OR v_idx.indisunique OR v_idx.amname <> 'btree'
           OR v_idx.indnatts <> 1 OR v_idx.indnkeyatts <> 1
           OR v_idx.keycols <> ARRAY['paper_id']
           OR v_idx.haspred OR v_idx.hasexpr
           OR NOT v_idx.indisvalid OR NOT v_idx.indisready THEN
          RAISE EXCEPTION 'RECON-JUNCTIONS Phase A: index % exists with a conflicting definition (state=%, unique=%, am=%, keys=%, pred=%, expr=%)',
            v_idx.idx_name, v_state, v_idx.indisunique, v_idx.amname, v_idx.keycols, v_idx.haspred, v_idx.hasexpr;
        END IF;
        v_legacy_present := true;
      ELSIF v_idx.idx_name = t.rev_idx THEN
        IF v_idx.indisunique OR v_idx.amname <> 'btree'
           OR v_idx.indnatts <> 1 OR v_idx.indnkeyatts <> 1
           OR v_idx.keycols <> ARRAY[t.col2]
           OR v_idx.haspred OR v_idx.hasexpr
           OR NOT v_idx.indisvalid OR NOT v_idx.indisready THEN
          RAISE EXCEPTION 'RECON-JUNCTIONS Phase A: reverse index % exists with a conflicting definition (unique=%, am=%, keys=%, pred=%, expr=%)',
            v_idx.idx_name, v_idx.indisunique, v_idx.amname, v_idx.keycols, v_idx.haspred, v_idx.hasexpr;
        END IF;
        v_rev_present := true;
      ELSIF NOT v_idx.indisunique AND v_idx.indnatts = 1 AND v_idx.keycols = ARRAY['paper_id'] THEN
        RAISE EXCEPTION 'RECON-JUNCTIONS Phase A: unexpected equivalent paper_id index % on %', v_idx.idx_name, t.tbl;
      ELSIF NOT v_idx.indisunique AND v_idx.indnatts = 1 AND v_idx.keycols = ARRAY[t.col2] THEN
        RAISE EXCEPTION 'RECON-JUNCTIONS Phase A: unexpected equivalent % index % on %', t.col2, v_idx.idx_name, t.tbl;
      ELSIF (SELECT array_agg(x ORDER BY x) FROM unnest(v_idx.keycols) x)
            = (SELECT array_agg(x ORDER BY x) FROM unnest(ARRAY['paper_id', t.col2]) x) THEN
        -- Pair-equivalent index (unique or not, any name): permitted
        -- ONLY when it is exactly the backing index of the single pair
        -- UNIQUE constraint captured in A6 (matched by conindid OID,
        -- never inferred from key columns alone).
        IF v_state = 'surrogate' AND v_idx.indisunique
           AND v_idx.indexrelid = v_uq_indexrelid THEN
          CONTINUE;
        END IF;
        RAISE EXCEPTION 'RECON-JUNCTIONS Phase A: additional pair-equivalent index % on % (unique=%, not the UNIQUE-constraint backing index)',
          v_idx.idx_name, t.tbl, v_idx.indisunique;
      ELSE
        RAISE EXCEPTION 'RECON-JUNCTIONS Phase A: unexpected index % on % (keys=%)', v_idx.idx_name, t.tbl, v_idx.keycols;
      END IF;
    END LOOP;

    -- A10. Dependency inspection over id / created_at (surrogate only).
    IF v_state = 'surrogate' THEN
      FOREACH v_col IN ARRAY ARRAY['id', 'created_at'] LOOP
        SELECT attnum INTO v_attnum FROM pg_attribute
        WHERE attrelid = v_relid AND attname = v_col AND NOT attisdropped;

        -- external FKs referencing the column
        IF EXISTS (SELECT 1 FROM pg_constraint con, unnest(con.confkey) ck(attnum)
                   WHERE con.confrelid = v_relid AND con.contype = 'f' AND ck.attnum = v_attnum) THEN
          RAISE EXCEPTION 'RECON-JUNCTIONS Phase A: external FK references %.%', t.tbl, v_col;
        END IF;
        -- views / materialized views / rewrite rules
        IF EXISTS (SELECT 1 FROM pg_depend d
                   WHERE d.refobjid = v_relid AND d.refobjsubid = v_attnum
                     AND d.classid = 'pg_rewrite'::regclass) THEN
          RAISE EXCEPTION 'RECON-JUNCTIONS Phase A: a view/rule depends on %.%', t.tbl, v_col;
        END IF;
        -- policies
        IF EXISTS (SELECT 1 FROM pg_depend d
                   WHERE d.refobjid = v_relid AND d.refobjsubid = v_attnum
                     AND d.classid = 'pg_policy'::regclass) THEN
          RAISE EXCEPTION 'RECON-JUNCTIONS Phase A: a policy depends on %.%', t.tbl, v_col;
        END IF;
        -- triggers (column lists / WHEN clauses)
        IF EXISTS (SELECT 1 FROM pg_depend d
                   WHERE d.refobjid = v_relid AND d.refobjsubid = v_attnum
                     AND d.classid = 'pg_trigger'::regclass) THEN
          RAISE EXCEPTION 'RECON-JUNCTIONS Phase A: a trigger depends on %.%', t.tbl, v_col;
        END IF;
        -- defaults / generation expressions of OTHER columns
        IF EXISTS (SELECT 1 FROM pg_depend d
                   WHERE d.refobjid = v_relid AND d.refobjsubid = v_attnum
                     AND d.classid = 'pg_attrdef'::regclass
                     AND (SELECT adnum FROM pg_attrdef ad WHERE ad.oid = d.objid) <> v_attnum) THEN
          RAISE EXCEPTION 'RECON-JUNCTIONS Phase A: another column default depends on %.%', t.tbl, v_col;
        END IF;
        -- constraints touching the column beyond the classified PK
        IF EXISTS (SELECT 1 FROM pg_constraint con, unnest(con.conkey) ck(attnum)
                   WHERE con.conrelid = v_relid AND ck.attnum = v_attnum
                     AND con.contype <> 'p') THEN
          RAISE EXCEPTION 'RECON-JUNCTIONS Phase A: a non-PK constraint on % touches column %', t.tbl, v_col;
        END IF;
      END LOOP;
    END IF;

    -- A-record: stash the classification for Phase B.
    v_class := v_class || jsonb_build_object(t.tbl, jsonb_build_object(
      'state', v_state,
      'pk_name', v_pk_name,
      'uq_name', v_uq_name,
      'legacy_present', v_legacy_present,
      'rev_present', v_rev_present
    ));

    v_relid := NULL; v_pk_name := NULL; v_pk_cols := NULL; v_uq_name := NULL;
  END LOOP;

  -- ════════════════════ PHASE B — converge (first DDL) ═════════════════════
  -- Reached only after BOTH tables passed the complete Phase A
  -- validation above; no DDL of any kind has run before this point.
  FOR t IN
    SELECT * FROM (VALUES
      ('paper_tags',     'tag_id',     'idx_paper_tags_tag_id',         'idx_paper_tags_paper_id'),
      ('paper_projects', 'project_id', 'idx_paper_projects_project_id', 'idx_paper_projects_paper_id')
    ) AS v(tbl, col2, rev_idx, legacy_idx)
  LOOP
    IF v_class -> t.tbl ->> 'state' = 'surrogate' THEN
      EXECUTE format('ALTER TABLE public.%I DROP CONSTRAINT %I', t.tbl, v_class -> t.tbl ->> 'pk_name');
      EXECUTE format('ALTER TABLE public.%I DROP COLUMN id', t.tbl);           -- RESTRICT (default)
      EXECUTE format('ALTER TABLE public.%I DROP COLUMN created_at', t.tbl);   -- RESTRICT (default)
      EXECUTE format('ALTER TABLE public.%I ADD CONSTRAINT %I PRIMARY KEY (paper_id, %I)',
                     t.tbl, t.tbl || '_pkey', t.col2);
      EXECUTE format('ALTER TABLE public.%I DROP CONSTRAINT %I', t.tbl, v_class -> t.tbl ->> 'uq_name');
    END IF;

    IF (v_class -> t.tbl ->> 'legacy_present')::boolean THEN
      EXECUTE format('DROP INDEX public.%I', t.legacy_idx);  -- definition validated in A9
    END IF;

    IF NOT (v_class -> t.tbl ->> 'rev_present')::boolean THEN
      EXECUTE format('CREATE INDEX %I ON public.%I USING btree (%I)', t.rev_idx, t.tbl, t.col2);
    END IF;
  END LOOP;

  -- ════════════════════ PHASE C — exact end-state assertions ═══════════════
  FOR t IN
    SELECT * FROM (VALUES
      ('paper_tags',     'tag_id',     'idx_paper_tags_tag_id'),
      ('paper_projects', 'project_id', 'idx_paper_projects_project_id')
    ) AS v(tbl, col2, rev_idx)
  LOOP
    v_relid := ('public.' || quote_ident(t.tbl))::regclass;

    -- exactly the two live pair columns, uuid NOT NULL
    SELECT array_agg(attname::text ORDER BY attname) INTO v_cols
    FROM pg_attribute
    WHERE attrelid = v_relid AND attnum > 0 AND NOT attisdropped
      AND atttypid = 'uuid'::regtype AND attnotnull;
    IF v_cols <> (SELECT array_agg(x ORDER BY x) FROM unnest(ARRAY['paper_id', t.col2]) x)
       OR (SELECT count(*) FROM pg_attribute
           WHERE attrelid = v_relid AND attnum > 0 AND NOT attisdropped) <> 2 THEN
      RAISE EXCEPTION 'RECON-JUNCTIONS Phase C: % final column set is not canonical (%)', t.tbl, v_cols;
    END IF;

    -- exactly one PK, canonical name and ordered columns
    PERFORM 1 FROM pg_constraint con
    WHERE con.conrelid = v_relid AND con.contype = 'p'
      AND con.conname = t.tbl || '_pkey'
      AND (SELECT array_agg(att.attname::text ORDER BY ord.n)
           FROM unnest(con.conkey) WITH ORDINALITY ord(attnum, n)
           JOIN pg_attribute att ON att.attrelid = v_relid AND att.attnum = ord.attnum)
          = ARRAY['paper_id', t.col2];
    IF NOT FOUND OR (SELECT count(*) FROM pg_constraint WHERE conrelid = v_relid AND contype = 'p') <> 1 THEN
      RAISE EXCEPTION 'RECON-JUNCTIONS Phase C: % final primary key is not canonical', t.tbl;
    END IF;

    -- Exact final constraint inventory: exactly three constraints in
    -- total — one PK and two FKs; zero UNIQUE, zero CHECK, zero
    -- exclusion, zero constraints of any other type.
    IF (SELECT count(*) FROM pg_constraint WHERE conrelid = v_relid) <> 3
       OR (SELECT count(*) FROM pg_constraint WHERE conrelid = v_relid AND contype = 'p') <> 1
       OR (SELECT count(*) FROM pg_constraint WHERE conrelid = v_relid AND contype = 'f') <> 2
       OR (SELECT count(*) FROM pg_constraint WHERE conrelid = v_relid AND contype NOT IN ('p','f')) <> 0 THEN
      RAISE EXCEPTION 'RECON-JUNCTIONS Phase C: % final constraint inventory is not canonical (types: %)',
        t.tbl,
        (SELECT string_agg(contype::text || ':' || conname, ', ' ORDER BY conname)
         FROM pg_constraint WHERE conrelid = v_relid);
    END IF;

    -- exactly two indexes: the PK index and the canonical reverse index
    IF (SELECT count(*) FROM pg_index WHERE indrelid = v_relid) <> 2
       OR NOT EXISTS (SELECT 1 FROM pg_index i JOIN pg_class ic ON ic.oid = i.indexrelid
                      WHERE i.indrelid = v_relid AND ic.relname = t.rev_idx
                        AND NOT i.indisunique AND i.indisvalid AND i.indisready) THEN
      RAISE EXCEPTION 'RECON-JUNCTIONS Phase C: % final index inventory is not canonical', t.tbl;
    END IF;
  END LOOP;
END;
$$;

-- ── Canonical text form for the four assignment RPCs ────────────────
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
