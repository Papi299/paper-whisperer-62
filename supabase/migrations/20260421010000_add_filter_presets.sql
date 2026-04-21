-- Saved Searches / Filter Presets — MVP
--
-- Per-user named snapshots of the dashboard filter state. A row stores an
-- opaque JSONB `payload` that captures the 8 filter fields (searchQuery,
-- yearFrom, yearTo, studyType, notesPresence, selectedKeywords,
-- selectedProjectId, selectedTagId) plus a `version` sentinel. The table
-- shape mirrors the projects/tags pattern exactly: one FK to auth.users
-- with ON DELETE CASCADE, four per-user RLS policies, case-insensitive
-- per-user unique name, and an updated_at trigger reusing the existing
-- public.update_updated_at_column() function.
--
-- JSONB was chosen over individual columns because the payload is only
-- ever round-tripped as a whole — we never query by its internal keys.
-- Adding/removing a filter field in the future requires zero schema
-- change; client-side Zod validation at the read boundary protects
-- against stale/malformed rows.

CREATE TABLE public.filter_presets (
    id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    payload JSONB NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Per-user case-insensitive uniqueness on name. Matches the projects/tags
-- idiom from migration 20260412020000.
CREATE UNIQUE INDEX idx_filter_presets_user_name
    ON public.filter_presets (user_id, lower(name));

-- Non-unique index for the common list query (WHERE user_id = :uid).
CREATE INDEX idx_filter_presets_user_id
    ON public.filter_presets (user_id);

-- Enable + force RLS. FORCE prevents table owners from bypassing the
-- policies; matches the canonical pattern restored in migration
-- 20260412030000_fix_rls_all_tables.sql.
ALTER TABLE public.filter_presets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.filter_presets FORCE ROW LEVEL SECURITY;

-- Four per-user policies (SELECT/INSERT/UPDATE/DELETE), identical to the
-- projects/tags template. Every row check is `auth.uid() = user_id`.
CREATE POLICY "Users can view their own filter presets"
    ON public.filter_presets FOR SELECT
    USING (auth.uid() = user_id);

CREATE POLICY "Users can create their own filter presets"
    ON public.filter_presets FOR INSERT
    WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update their own filter presets"
    ON public.filter_presets FOR UPDATE
    USING (auth.uid() = user_id);

CREATE POLICY "Users can delete their own filter presets"
    ON public.filter_presets FOR DELETE
    USING (auth.uid() = user_id);

-- updated_at auto-refresh trigger, reusing the existing function defined
-- in migration 20260203072053.
CREATE TRIGGER update_filter_presets_updated_at
    BEFORE UPDATE ON public.filter_presets
    FOR EACH ROW
    EXECUTE FUNCTION public.update_updated_at_column();
