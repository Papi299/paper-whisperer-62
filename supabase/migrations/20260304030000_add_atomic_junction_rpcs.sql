-- Atomic tag assignment for a single paper (DELETE + INSERT in one transaction).
CREATE OR REPLACE FUNCTION public.set_paper_tags(
  p_paper_id uuid,
  p_tag_ids uuid[]
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
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

-- Atomic project assignment for a single paper.
CREATE OR REPLACE FUNCTION public.set_paper_projects(
  p_paper_id uuid,
  p_project_ids uuid[]
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
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

-- Bulk atomic tag assignment for multiple papers.
CREATE OR REPLACE FUNCTION public.bulk_set_paper_tags(
  p_paper_ids uuid[],
  p_tag_ids uuid[]
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
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

-- Bulk atomic project assignment for multiple papers.
CREATE OR REPLACE FUNCTION public.bulk_set_paper_projects(
  p_paper_ids uuid[],
  p_project_ids uuid[]
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
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
