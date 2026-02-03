-- Create keyword exclusion pool table
CREATE TABLE public.keyword_exclusion_pool (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL,
  keyword TEXT NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  UNIQUE(user_id, keyword)
);

-- Enable RLS
ALTER TABLE public.keyword_exclusion_pool ENABLE ROW LEVEL SECURITY;

-- Create policies
CREATE POLICY "Users can view their own excluded keywords" 
ON public.keyword_exclusion_pool 
FOR SELECT 
USING (auth.uid() = user_id);

CREATE POLICY "Users can create their own excluded keywords" 
ON public.keyword_exclusion_pool 
FOR INSERT 
WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can delete their own excluded keywords" 
ON public.keyword_exclusion_pool 
FOR DELETE 
USING (auth.uid() = user_id);

-- Create study type exclusion pool table
CREATE TABLE public.study_type_exclusion_pool (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL,
  study_type TEXT NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  UNIQUE(user_id, study_type)
);

-- Enable RLS
ALTER TABLE public.study_type_exclusion_pool ENABLE ROW LEVEL SECURITY;

-- Create policies
CREATE POLICY "Users can view their own excluded study types" 
ON public.study_type_exclusion_pool 
FOR SELECT 
USING (auth.uid() = user_id);

CREATE POLICY "Users can create their own excluded study types" 
ON public.study_type_exclusion_pool 
FOR INSERT 
WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can delete their own excluded study types" 
ON public.study_type_exclusion_pool 
FOR DELETE 
USING (auth.uid() = user_id);