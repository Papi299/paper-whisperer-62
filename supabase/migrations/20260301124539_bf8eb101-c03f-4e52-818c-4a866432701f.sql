
-- Create paper_projects junction table
CREATE TABLE public.paper_projects (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  paper_id uuid NOT NULL REFERENCES public.papers(id) ON DELETE CASCADE,
  project_id uuid NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  UNIQUE (paper_id, project_id)
);

-- Enable RLS
ALTER TABLE public.paper_projects ENABLE ROW LEVEL SECURITY;

-- RLS policies (same pattern as paper_tags - check ownership via papers table)
CREATE POLICY "Users can view their paper-project links"
ON public.paper_projects FOR SELECT
USING (EXISTS (
  SELECT 1 FROM public.papers WHERE papers.id = paper_projects.paper_id AND papers.user_id = auth.uid()
));

CREATE POLICY "Users can add projects to their papers"
ON public.paper_projects FOR INSERT
WITH CHECK (EXISTS (
  SELECT 1 FROM public.papers WHERE papers.id = paper_projects.paper_id AND papers.user_id = auth.uid()
));

CREATE POLICY "Users can remove projects from their papers"
ON public.paper_projects FOR DELETE
USING (EXISTS (
  SELECT 1 FROM public.papers WHERE papers.id = paper_projects.paper_id AND papers.user_id = auth.uid()
));

-- Migrate existing data: copy paper.project_id relationships to junction table
INSERT INTO public.paper_projects (paper_id, project_id)
SELECT id, project_id FROM public.papers WHERE project_id IS NOT NULL;

-- Drop the foreign key constraint and column
ALTER TABLE public.papers DROP CONSTRAINT IF EXISTS papers_project_id_fkey;
ALTER TABLE public.papers DROP COLUMN project_id;
