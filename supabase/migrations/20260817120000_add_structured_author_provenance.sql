-- AUTHOR-IDENTITY-PROVENANCE-001B
--
-- Adds persistent structured authorship provenance and teaches the two RPCs
-- that own paper provenance to carry it.
--
-- What this column is, and what it is deliberately not
-- ───────────────────────────────────────────────────
-- papers.authors is a string array: one author *mention* as some source wrote
-- it. It stays exactly as it is — the display, search and Analytics
-- representation, unchanged by this migration.
--
-- What it cannot carry is what the source actually *said* about each mention:
-- whether authorship was personal or collective, which part was the given name
-- and which the family name, the affiliations, the author-associated
-- identifiers, an ORCID. PubMed states all of that discretely; flattening it to
-- "Ricardo Soto-Rifo" throws it away, and no later parse of that string can
-- recover it — splitting a name on its spaces is exactly the fabrication this
-- column exists to avoid.
--
-- So author_provenance records the source's own statement, ordered one-to-one
-- with authors: author_provenance[i] describes authors[i].
--
-- It is NOT an identity model. It does not say that two mentions are the same
-- researcher, and a matching ORCID in two rows does not say so either — that is
-- a value two sources supplied, not a resolution this application has made.
-- There is deliberately no author table, no person table, no alias table, no
-- link table, and no global uniqueness on any identifier. Resolving mentions to
-- people is a separate, later product decision, and this migration is careful
-- to leave that decision open rather than pre-empt it.
--
-- No historical backfill
-- ──────────────────────
-- Existing rows get SQL NULL from the ADD COLUMN itself; no UPDATE runs. A
-- stored authors value of ["S M Phillips"] genuinely does not record whether
-- the source said "personal author, family Phillips, initials S M" or anything
-- else — the semantics were never persisted. Deriving given_name = "S" and
-- family_name = "Phillips" from the string would invent provenance rather than
-- recover it, and would then look identical to provenance a source really
-- stated. NULL says the truth: nothing trustworthy was persisted for this row.
-- Every read path treats NULL as "work from authors", which is exactly what
-- those rows do today, so nothing regresses.
--
-- Storage shape follows the table's existing convention: authors, keywords,
-- raw_keywords, mesh_terms, substances and raw_publication_types are all jsonb.
--
-- Signatures, SECURITY DEFINER posture, bounded search_path, ownership guards,
-- return shapes and EXECUTE surfaces of both functions are preserved exactly.
-- No overload is added and no privilege is widened.

-- ══ 1. The column ══════════════════════════════════════════════════════════
ALTER TABLE public.papers
  ADD COLUMN author_provenance jsonb;

COMMENT ON COLUMN public.papers.author_provenance IS
  'Structured authorship provenance from the source, ordered one-to-one with '
  'papers.authors: element i describes the mention stored at authors[i]. NULL '
  'means no trustworthy structured provenance was persisted for this row — '
  'read authors instead. Records what a source stated; it is NOT a person '
  'identity, and a matching ORCID across rows does not link two mentions.';

-- Fail closed on malformed provenance. Everything the application can write is
-- accepted; nothing else is.
--
-- The rules, and why each is here:
--   * SQL NULL is valid — the single representation of "no provenance".
--   * A non-null value is a non-empty JSON array of objects. An empty array is
--     rejected because it conveys nothing NULL does not, keeping one
--     representation of absence.
--   * Its length must equal jsonb_array_length(authors). This is the load-
--     bearing rule: once the indexes stop lining up, every entry describes the
--     WRONG mention, and an ORCID attached to the wrong name is a false claim
--     about a person. A partial array is worse than none, so it is refused
--     rather than stored and trusted.
--   * source and source_name must be present, string, and non-blank; kind must
--     be present, a string, and exactly one of the three known values.
--   * The optional name components are null-or-string. Absent is allowed and
--     means the same as null.
--   * affiliations is an array of strings; identifiers is an array of objects
--     each carrying non-blank string scheme AND value — half an identifier
--     cannot be represented honestly.
--   * orcid is null or canonical `0000-0000-0000-000X` text. The DB does not
--     re-run the checksum (that is the writer's job, and a CHECK cannot express
--     ISO 7064 legibly), but it does refuse every non-canonical spelling: a URL
--     form, an unhyphenated run of digits, or a lowercase x never reaches
--     storage, so one canonical form is the only thing readers ever see.
--   * orcid_authenticated is null or boolean, never a string.
--
-- Written as jsonb_path_exists probes that search for VIOLATIONS, so every
-- required field is guarded by BOTH exists(@.key) AND @.key.type(). Both halves
-- are load bearing, for two different reasons, and a violation probe that omits
-- either one fails OPEN — it reports "no violation found" and the CHECK admits
-- the malformed value:
--
--   * SQL/JSON filters are three-valued. Comparing values of different types
--     yields *unknown*, not false, and a filter only selects an item when its
--     predicate is TRUE. So `!(@.kind == "personal" || ...)` is unknown — never
--     true — when kind is a number, a boolean, or an object, and the probe
--     silently finds nothing. The `.type() == "string"` guard is what converts
--     that unknown into a definite violation.
--   * Lax mode auto-unwraps arrays before a comparison. Without the type guard
--     `@.kind == "personal"` is TRUE for `{"kind": ["personal"]}` and even for
--     `{"kind": ["personal", "bogus"]}`, so an array spelling of a legal value
--     is accepted as if it were the scalar. `.type()` is applied to the item
--     itself and does not unwrap, so it rejects the array outright.
--
-- exists() alone covers the third case: a key that is absent entirely. (Against
-- a missing key the comparison yields false rather than unknown, so negation
-- does catch it — but relying on that is subtle and leaves the two cases above
-- open, which is why every required field carries the full guard.)
--
-- Each probe is IMMUTABLE and subquery-free, so the whole rule is one
-- deterministic column-level CHECK. It validates against NULL fine, so the rows
-- this migration leaves NULL all satisfy it and the constraint is added
-- validated in place.
ALTER TABLE public.papers
  ADD CONSTRAINT papers_author_provenance_shape_check
  CHECK (
    author_provenance IS NULL
    OR (
      jsonb_typeof(author_provenance) = 'array'
      AND jsonb_array_length(author_provenance) > 0
      AND jsonb_typeof(authors) = 'array'
      AND jsonb_array_length(author_provenance) = jsonb_array_length(authors)
      AND NOT jsonb_path_exists(author_provenance, '$[*] ? (@.type() != "object")')
      AND NOT jsonb_path_exists(author_provenance, '$[*] ? (!(exists(@.source) && @.source.type() == "string" && !(@.source like_regex "^\\s*$")))')
      AND NOT jsonb_path_exists(author_provenance, '$[*] ? (!(exists(@.source_name) && @.source_name.type() == "string" && !(@.source_name like_regex "^\\s*$")))')
      AND NOT jsonb_path_exists(author_provenance, '$[*] ? (!(exists(@.kind) && @.kind.type() == "string" && (@.kind == "personal" || @.kind == "collective" || @.kind == "unknown")))')
      AND NOT jsonb_path_exists(author_provenance, '$[*].source_field    ? (@.type() != "string" && @.type() != "null")')
      AND NOT jsonb_path_exists(author_provenance, '$[*].given_name      ? (@.type() != "string" && @.type() != "null")')
      AND NOT jsonb_path_exists(author_provenance, '$[*].family_name     ? (@.type() != "string" && @.type() != "null")')
      AND NOT jsonb_path_exists(author_provenance, '$[*].initials        ? (@.type() != "string" && @.type() != "null")')
      AND NOT jsonb_path_exists(author_provenance, '$[*].suffix          ? (@.type() != "string" && @.type() != "null")')
      AND NOT jsonb_path_exists(author_provenance, '$[*].collective_name ? (@.type() != "string" && @.type() != "null")')
      AND NOT jsonb_path_exists(author_provenance, '$[*] ? (!(exists(@.affiliations) && @.affiliations.type() == "array"))')
      AND NOT jsonb_path_exists(author_provenance, '$[*].affiliations[*] ? (@.type() != "string")')
      AND NOT jsonb_path_exists(author_provenance, '$[*] ? (!(exists(@.identifiers) && @.identifiers.type() == "array"))')
      AND NOT jsonb_path_exists(author_provenance, '$[*].identifiers[*] ? (@.type() != "object")')
      AND NOT jsonb_path_exists(author_provenance, '$[*].identifiers[*] ? (!(exists(@.scheme) && @.scheme.type() == "string" && !(@.scheme like_regex "^\\s*$")))')
      AND NOT jsonb_path_exists(author_provenance, '$[*].identifiers[*] ? (!(exists(@.value) && @.value.type() == "string" && !(@.value like_regex "^\\s*$")))')
      AND NOT jsonb_path_exists(author_provenance, '$[*].orcid ? (@.type() != "null" && !(@.type() == "string" && @ like_regex "^[0-9]{4}-[0-9]{4}-[0-9]{4}-[0-9]{3}[0-9X]$"))')
      AND NOT jsonb_path_exists(author_provenance, '$[*].orcid_authenticated ? (@.type() != "boolean" && @.type() != "null")')
    )
  );

-- ══ 2. safe_bulk_insert_papers ═════════════════════════════════════════════
-- Identical to the definition installed by
-- 20260809051802_add_structured_publication_type_provenance.sql except for the
-- new author_provenance input handling. The full NULL-auth + caller-mismatch
-- guard, the statistical_methods canonicalization, the raw_publication_types
-- canonicalization, the per-row BEGIN/EXCEPTION model and the result shape are
-- reproduced unchanged.
--
-- Normalization runs inside the per-paper block, so a malformed value produces
-- a per-row 'error' result — the batch continues and no row is stored with
-- corrupted provenance. Structural validation is left to the column CHECK
-- rather than restated here: one authority for the shape cannot drift from
-- itself, and a direct write gets exactly the same verdict as an RPC write.
-- A payload that omits the key simply stores NULL; older callers that never
-- send it keep working untouched.
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

-- ══ 3. merge_exact_duplicates ══════════════════════════════════════════════
-- Identical to the definition installed by
-- 20260809051802_add_structured_publication_type_provenance.sql except that the
-- authors value and its provenance are now chosen as a coherent PAIR.
--
-- authors and author_provenance are two representations of the SAME source's
-- statement about the same people, positionally bound to each other. Taking
-- them from different rows would pair one record's names with another record's
-- ORCIDs — provenance no source ever stated, and the one failure mode that
-- turns this column into misinformation. Both are therefore read from one
-- source row, chosen by the function's existing authors rule:
--
--   1. the keep paper, when it has a non-empty authors array;
--   2. otherwise the earliest discard by the existing (created_at, id)
--      ordering that has one, contributing BOTH of its values;
--   3. otherwise the keep paper's own values (both effectively absent).
--
-- Rules 1 and 2 reproduce the previous authors CASE exactly, so no existing
-- merge choice changes. When the winning row's author_provenance is NULL the
-- result stays NULL: a row never borrows structured provenance from an
-- unrelated duplicate just to become non-null. Provenance arrays are never
-- unioned across duplicates and ORCIDs are never merged — this is one source's
-- statement about one byline, not a collection.
CREATE OR REPLACE FUNCTION public.merge_exact_duplicates(
  p_keep_id uuid,
  p_discard_ids uuid[]
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id uuid := auth.uid();
  v_owned   integer;
  v_merged  record;
BEGIN
  -- ══ 1. Validation ════════════════════════════════════════════════════════
  -- Every check runs before the first persistent mutation, so a rejected call
  -- is provably side-effect free. The function is SECURITY DEFINER and its owner
  -- (postgres) holds BYPASSRLS, so these explicit auth.uid() predicates — not
  -- row-level security — are the authorization boundary.

  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

  IF p_keep_id IS NULL THEN
    RAISE EXCEPTION 'Keep paper id is required';
  END IF;

  IF p_discard_ids IS NULL OR cardinality(p_discard_ids) = 0 THEN
    RAISE EXCEPTION 'At least one discard paper id is required';
  END IF;

  IF EXISTS (SELECT 1 FROM unnest(p_discard_ids) AS d WHERE d IS NULL) THEN
    RAISE EXCEPTION 'Discard paper ids must not contain NULL';
  END IF;

  -- The keep paper must never be reachable through its own discard list.
  IF p_keep_id = ANY(p_discard_ids) THEN
    RAISE EXCEPTION 'Keep paper cannot also be listed as a discard paper';
  END IF;

  -- Repeated discard ids are malformed input, not a merge instruction: reject
  -- rather than silently normalising, so the caller learns its request was wrong.
  IF cardinality(p_discard_ids) <>
     (SELECT count(DISTINCT d)::integer FROM unnest(p_discard_ids) AS d) THEN
    RAISE EXCEPTION 'Discard paper ids must be unique';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM papers WHERE id = p_keep_id AND user_id = v_user_id
  ) THEN
    RAISE EXCEPTION 'Keep paper not found or access denied';
  END IF;

  -- All-or-nothing: every discard id must resolve to an existing caller-owned
  -- paper. Counting owned rows rejects unknown and foreign ids alike.
  SELECT count(*)::integer INTO v_owned
  FROM papers
  WHERE id = ANY(p_discard_ids) AND user_id = v_user_id;

  IF v_owned <> cardinality(p_discard_ids) THEN
    RAISE EXCEPTION 'One or more discard papers not found or access denied';
  END IF;

  -- ══ 2. Capture the merged metadata before anything is deleted ════════════
  WITH keep AS (
    SELECT * FROM papers WHERE id = p_keep_id
  ),
  discard AS (
    SELECT * FROM papers WHERE id = ANY(p_discard_ids)
  ),
  -- Deterministic source order for list metadata: the keep paper first, then
  -- the discards by (created_at, id).
  ordered AS (
    SELECT s.keywords, s.raw_keywords, s.mesh_terms, s.substances,
           row_number() OVER (ORDER BY s.grp, s.created_at, s.id) AS rn
    FROM (
      SELECT 0 AS grp, k.created_at, k.id,
             k.keywords, k.raw_keywords, k.mesh_terms, k.substances
      FROM keep k
      UNION ALL
      SELECT 1, d.created_at, d.id,
             d.keywords, d.raw_keywords, d.mesh_terms, d.substances
      FROM discard d
    ) s
  ),
  -- Unpivot the four list columns, keeping each element's source row (rn) and
  -- its position inside its own JSON array (ord). Anything that is not a JSON
  -- array — including SQL NULL — contributes nothing.
  elems AS (
    SELECT f.field, e.val, o.rn, e.ord
    FROM ordered o
    CROSS JOIN LATERAL (VALUES
      ('keywords'::text,     o.keywords),
      ('raw_keywords'::text, o.raw_keywords),
      ('mesh_terms'::text,   o.mesh_terms),
      ('substances'::text,   o.substances)
    ) AS f(field, arr)
    CROSS JOIN LATERAL jsonb_array_elements_text(
      CASE WHEN jsonb_typeof(f.arr) = 'array' THEN f.arr ELSE '[]'::jsonb END
    ) WITH ORDINALITY AS e(val, ord)
  ),
  -- Exact-value deduplication that retains the first occurrence only.
  firsts AS (
    SELECT DISTINCT ON (field, val) field, val, rn, ord
    FROM elems
    ORDER BY field, val, rn, ord
  ),
  lists AS (
    SELECT
      COALESCE((SELECT jsonb_agg(val ORDER BY rn, ord) FROM firsts WHERE field = 'keywords'),     '[]'::jsonb) AS keywords,
      COALESCE((SELECT jsonb_agg(val ORDER BY rn, ord) FROM firsts WHERE field = 'raw_keywords'), '[]'::jsonb) AS raw_keywords,
      COALESCE((SELECT jsonb_agg(val ORDER BY rn, ord) FROM firsts WHERE field = 'mesh_terms'),   '[]'::jsonb) AS mesh_terms,
      COALESCE((SELECT jsonb_agg(val ORDER BY rn, ord) FROM firsts WHERE field = 'substances'),   '[]'::jsonb) AS substances
  ),
  -- The single source row that supplies BOTH raw study-type representations:
  -- the keep paper first (grp 0), then the discards by (created_at, id). Rows
  -- with no raw_study_type cannot establish the pair and are not candidates.
  provenance AS (
    SELECT s.raw_study_type, s.raw_publication_types
    FROM (
      SELECT 0 AS grp, k.created_at, k.id, k.raw_study_type, k.raw_publication_types
      FROM keep k
      UNION ALL
      SELECT 1, d.created_at, d.id, d.raw_study_type, d.raw_publication_types
      FROM discard d
    ) s
    WHERE s.raw_study_type IS NOT NULL
    ORDER BY s.grp, s.created_at, s.id
    LIMIT 1
  ),
  -- The single source row that supplies BOTH the authors array and the
  -- structured provenance describing it, under the function's pre-existing
  -- authors rule: the keep paper first (grp 0), then the discards by
  -- (created_at, id), considering only rows with a non-empty authors array.
  -- Selecting the ROW rather than each column independently is what keeps the
  -- names and the structure describing them from coming out of different
  -- records.
  author_source AS (
    SELECT s.authors, s.author_provenance
    FROM (
      SELECT 0 AS grp, k.created_at, k.id, k.authors, k.author_provenance
      FROM keep k
      UNION ALL
      SELECT 1, d.created_at, d.id, d.authors, d.author_provenance
      FROM discard d
    ) s
    WHERE jsonb_typeof(s.authors) = 'array' AND jsonb_array_length(s.authors) > 0
    ORDER BY s.grp, s.created_at, s.id
    LIMIT 1
  )
  SELECT
    -- Scalar metadata: the keep value wins; a NULL keep value is filled from the
    -- earliest discard that has one, ordered by (created_at, id).
    COALESCE(k.abstract,            (SELECT d.abstract            FROM discard d WHERE d.abstract            IS NOT NULL ORDER BY d.created_at, d.id LIMIT 1)) AS abstract,
    COALESCE(k.journal,             (SELECT d.journal             FROM discard d WHERE d.journal             IS NOT NULL ORDER BY d.created_at, d.id LIMIT 1)) AS journal,
    COALESCE(k.year,                (SELECT d.year                FROM discard d WHERE d.year                IS NOT NULL ORDER BY d.created_at, d.id LIMIT 1)) AS year,
    COALESCE(k.pmid,                (SELECT d.pmid                FROM discard d WHERE d.pmid                IS NOT NULL ORDER BY d.created_at, d.id LIMIT 1)) AS pmid,
    COALESCE(k.doi,                 (SELECT d.doi                 FROM discard d WHERE d.doi                 IS NOT NULL ORDER BY d.created_at, d.id LIMIT 1)) AS doi,
    COALESCE(k.study_type,          (SELECT d.study_type          FROM discard d WHERE d.study_type          IS NOT NULL ORDER BY d.created_at, d.id LIMIT 1)) AS study_type,
    COALESCE(k.statistical_methods, (SELECT d.statistical_methods FROM discard d WHERE d.statistical_methods IS NOT NULL ORDER BY d.created_at, d.id LIMIT 1)) AS statistical_methods,
    COALESCE(k.pubmed_url,          (SELECT d.pubmed_url          FROM discard d WHERE d.pubmed_url          IS NOT NULL ORDER BY d.created_at, d.id LIMIT 1)) AS pubmed_url,
    COALESCE(k.journal_url,         (SELECT d.journal_url         FROM discard d WHERE d.journal_url         IS NOT NULL ORDER BY d.created_at, d.id LIMIT 1)) AS journal_url,
    COALESCE(k.drive_url,           (SELECT d.drive_url           FROM discard d WHERE d.drive_url           IS NOT NULL ORDER BY d.created_at, d.id LIMIT 1)) AS drive_url,
    COALESCE(k.tldr,                (SELECT d.tldr                FROM discard d WHERE d.tldr                IS NOT NULL ORDER BY d.created_at, d.id LIMIT 1)) AS tldr,
    COALESCE(k.notes,               (SELECT d.notes               FROM discard d WHERE d.notes               IS NOT NULL ORDER BY d.created_at, d.id LIMIT 1)) AS notes,
    -- Raw study-type provenance, taken whole from one source row so the joined
    -- string and its boundaries always describe the same source statement.
    -- Falling back to the keep row when no row qualifies leaves a legacy keep
    -- paper exactly as it was rather than borrowing a foreign array.
    COALESCE((SELECT p.raw_study_type FROM provenance p), k.raw_study_type) AS raw_study_type,
    CASE
      WHEN EXISTS (SELECT 1 FROM provenance)
        THEN (SELECT p.raw_publication_types FROM provenance p)
      ELSE k.raw_publication_types
    END AS raw_publication_types,
    -- Authors are a whole-value choice, never a union: a non-empty keep author
    -- list is preserved exactly, otherwise the earliest non-empty discard list
    -- is adopted. Identical selection to the previous CASE expression, now
    -- routed through author_source so its provenance travels with it.
    COALESCE((SELECT a.authors FROM author_source a), k.authors) AS authors,
    -- ...and the provenance from that SAME row. NULL there stays NULL here.
    CASE
      WHEN EXISTS (SELECT 1 FROM author_source)
        THEN (SELECT a.author_provenance FROM author_source a)
      ELSE k.author_provenance
    END AS author_provenance,
    l.keywords, l.raw_keywords, l.mesh_terms, l.substances
  INTO v_merged
  FROM keep k CROSS JOIN lists l;

  -- ══ 3. Preserve relationships before the discards disappear ══════════════
  -- Junction rows cascade on delete, so union them onto the keep paper first.
  -- DISTINCT collapses the same assignment held by several discards; ON CONFLICT
  -- collapses an assignment the keep paper already holds.
  INSERT INTO paper_tags (paper_id, tag_id)
  SELECT DISTINCT p_keep_id, pt.tag_id
  FROM paper_tags pt
  WHERE pt.paper_id = ANY(p_discard_ids)
  ON CONFLICT (paper_id, tag_id) DO NOTHING;

  INSERT INTO paper_projects (paper_id, project_id)
  SELECT DISTINCT p_keep_id, pp.project_id
  FROM paper_projects pp
  WHERE pp.paper_id = ANY(p_discard_ids)
  ON CONFLICT (paper_id, project_id) DO NOTHING;

  -- ══ 4. Re-parent attachments so the cascade cannot destroy them ══════════
  -- Only paper_id changes. id, user_id, file_path, file_name, file_type,
  -- size_bytes and created_at are all left untouched, the Storage object is not
  -- addressed at all, and no quota trigger fires.
  UPDATE paper_attachments
  SET paper_id = p_keep_id
  WHERE paper_id = ANY(p_discard_ids);

  -- ══ 5. Delete the discards, releasing their unique identifier values ═════
  DELETE FROM papers
  WHERE id = ANY(p_discard_ids)
    AND user_id = v_user_id;

  -- ══ 6. Apply the captured metadata to the keep paper ═════════════════════
  -- Runs last so an identifier transferred from a discard cannot collide with
  -- the still-live discard row. id, user_id, title, created_at and insert_order
  -- are never assigned; has_abstract and search_vector are generated columns and
  -- update themselves from their sources.
  UPDATE papers SET
    abstract              = v_merged.abstract,
    journal               = v_merged.journal,
    year                  = v_merged.year,
    pmid                  = v_merged.pmid,
    doi                   = v_merged.doi,
    study_type            = v_merged.study_type,
    statistical_methods   = v_merged.statistical_methods,
    pubmed_url            = v_merged.pubmed_url,
    journal_url           = v_merged.journal_url,
    drive_url             = v_merged.drive_url,
    raw_study_type        = v_merged.raw_study_type,
    raw_publication_types = v_merged.raw_publication_types,
    tldr                  = v_merged.tldr,
    notes                 = v_merged.notes,
    authors               = v_merged.authors,
    author_provenance     = v_merged.author_provenance,
    keywords              = v_merged.keywords,
    raw_keywords          = v_merged.raw_keywords,
    mesh_terms            = v_merged.mesh_terms,
    substances            = v_merged.substances,
    updated_at            = now()
  WHERE id = p_keep_id
    AND user_id = v_user_id;
END;
$$;

-- ══ 4. Least-privilege surface re-asserted, not assumed ════════════════════
-- CREATE OR REPLACE preserves the existing ACL; these reproduce exactly the
-- grants made by 20260802025704_harden_rpc_and_relational_ownership.sql so a
-- replacement can never silently widen the surface.
REVOKE ALL ON FUNCTION public.safe_bulk_insert_papers(uuid, jsonb) FROM PUBLIC, anon, service_role;
GRANT  EXECUTE ON FUNCTION public.safe_bulk_insert_papers(uuid, jsonb) TO authenticated;

REVOKE ALL ON FUNCTION public.merge_exact_duplicates(uuid, uuid[]) FROM PUBLIC, anon, service_role;
GRANT  EXECUTE ON FUNCTION public.merge_exact_duplicates(uuid, uuid[]) TO authenticated;

-- ══ 5. Fail-closed self-check ══════════════════════════════════════════════
-- The additive change must not have altered the column shape, created any
-- identity table, or weakened either function's security contract.
DO $verify$
DECLARE
  v_count integer;
  v_row   record;
  v_col   record;
BEGIN
  -- ── Column ──
  SELECT c.data_type, c.is_nullable, c.column_default
  INTO v_col
  FROM information_schema.columns c
  WHERE c.table_schema = 'public'
    AND c.table_name = 'papers'
    AND c.column_name = 'author_provenance';

  IF NOT FOUND THEN
    RAISE EXCEPTION 'author_provenance: papers.author_provenance was not created';
  END IF;
  IF v_col.data_type <> 'jsonb' THEN
    RAISE EXCEPTION 'author_provenance: unexpected column type %', v_col.data_type;
  END IF;
  IF v_col.is_nullable <> 'YES' THEN
    RAISE EXCEPTION 'author_provenance: column must stay nullable';
  END IF;
  IF v_col.column_default IS NOT NULL THEN
    RAISE EXCEPTION 'author_provenance: unexpected column default %', v_col.column_default;
  END IF;

  -- No historical row may have been given a value by this migration.
  IF EXISTS (SELECT 1 FROM public.papers WHERE author_provenance IS NOT NULL) THEN
    RAISE EXCEPTION 'author_provenance: existing rows must not be backfilled';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.papers'::regclass
      AND conname = 'papers_author_provenance_shape_check'
      AND contype = 'c'
      AND convalidated
  ) THEN
    RAISE EXCEPTION 'author_provenance: validated CHECK constraint missing';
  END IF;

  -- ── No identity model was introduced ──
  -- 001B stores provenance and nothing else. A table representing people, or a
  -- global uniqueness rule on an identifier, would pre-empt an identity design
  -- that has not been made yet — so their absence is asserted, not assumed.
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_name IN ('authors', 'people', 'person', 'author_identities',
                         'author_aliases', 'author_identity_links')
  ) THEN
    RAISE EXCEPTION 'author_provenance: an author/person identity table exists; 001B must not create one';
  END IF;

  -- ── safe_bulk_insert_papers ──
  SELECT count(*)::integer INTO v_count
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'safe_bulk_insert_papers';
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'author_provenance: expected exactly 1 safe_bulk_insert_papers overload, found %', v_count;
  END IF;

  SELECT p.prosecdef, p.proconfig, pg_get_userbyid(p.proowner) AS owner,
         pg_get_function_result(p.oid) AS ret,
         pg_get_function_identity_arguments(p.oid) AS args
  INTO v_row
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'safe_bulk_insert_papers';

  IF NOT v_row.prosecdef THEN
    RAISE EXCEPTION 'author_provenance: safe_bulk_insert_papers lost SECURITY DEFINER';
  END IF;
  IF v_row.proconfig IS DISTINCT FROM ARRAY['search_path=public'] THEN
    RAISE EXCEPTION 'author_provenance: safe_bulk_insert_papers search_path is %', v_row.proconfig;
  END IF;
  IF v_row.owner <> 'postgres' THEN
    RAISE EXCEPTION 'author_provenance: safe_bulk_insert_papers owner is %', v_row.owner;
  END IF;
  IF v_row.ret <> 'jsonb' THEN
    RAISE EXCEPTION 'author_provenance: safe_bulk_insert_papers returns %', v_row.ret;
  END IF;
  IF v_row.args <> 'p_user_id uuid, p_papers jsonb' THEN
    RAISE EXCEPTION 'author_provenance: safe_bulk_insert_papers signature is %', v_row.args;
  END IF;
  IF has_function_privilege('anon', 'public.safe_bulk_insert_papers(uuid,jsonb)', 'EXECUTE')
     OR has_function_privilege('service_role', 'public.safe_bulk_insert_papers(uuid,jsonb)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.safe_bulk_insert_papers(uuid,jsonb)', 'EXECUTE') THEN
    RAISE EXCEPTION 'author_provenance: unexpected safe_bulk_insert_papers EXECUTE surface';
  END IF;

  -- ── merge_exact_duplicates ──
  SELECT count(*)::integer INTO v_count
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'merge_exact_duplicates';
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'author_provenance: expected exactly 1 merge_exact_duplicates overload, found %', v_count;
  END IF;

  SELECT p.prosecdef, p.proconfig, pg_get_userbyid(p.proowner) AS owner,
         pg_get_function_result(p.oid) AS ret,
         pg_get_function_identity_arguments(p.oid) AS args
  INTO v_row
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'merge_exact_duplicates';

  IF NOT v_row.prosecdef THEN
    RAISE EXCEPTION 'author_provenance: merge_exact_duplicates lost SECURITY DEFINER';
  END IF;
  IF v_row.proconfig IS DISTINCT FROM ARRAY['search_path=public'] THEN
    RAISE EXCEPTION 'author_provenance: merge_exact_duplicates search_path is %', v_row.proconfig;
  END IF;
  IF v_row.owner <> 'postgres' THEN
    RAISE EXCEPTION 'author_provenance: merge_exact_duplicates owner is %', v_row.owner;
  END IF;
  IF v_row.ret <> 'void' THEN
    RAISE EXCEPTION 'author_provenance: merge_exact_duplicates returns %', v_row.ret;
  END IF;
  IF v_row.args <> 'p_keep_id uuid, p_discard_ids uuid[]' THEN
    RAISE EXCEPTION 'author_provenance: merge_exact_duplicates signature is %', v_row.args;
  END IF;
  IF has_function_privilege('anon', 'public.merge_exact_duplicates(uuid,uuid[])', 'EXECUTE')
     OR has_function_privilege('service_role', 'public.merge_exact_duplicates(uuid,uuid[])', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.merge_exact_duplicates(uuid,uuid[])', 'EXECUTE') THEN
    RAISE EXCEPTION 'author_provenance: unexpected merge_exact_duplicates EXECUTE surface';
  END IF;
END;
$verify$;
