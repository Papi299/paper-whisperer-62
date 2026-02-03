-- Create synonym_pool table for storing synonym groups
CREATE TABLE public.synonym_pool (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL,
  canonical_term TEXT NOT NULL,
  synonyms TEXT[] NOT NULL DEFAULT '{}',
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Enable Row Level Security
ALTER TABLE public.synonym_pool ENABLE ROW LEVEL SECURITY;

-- Create policies for user access
CREATE POLICY "Users can view their own synonym groups"
ON public.synonym_pool
FOR SELECT
USING (auth.uid() = user_id);

CREATE POLICY "Users can create their own synonym groups"
ON public.synonym_pool
FOR INSERT
WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update their own synonym groups"
ON public.synonym_pool
FOR UPDATE
USING (auth.uid() = user_id);

CREATE POLICY "Users can delete their own synonym groups"
ON public.synonym_pool
FOR DELETE
USING (auth.uid() = user_id);

-- Create index for faster lookups
CREATE INDEX idx_synonym_pool_user_id ON public.synonym_pool(user_id);