-- Create a table for user keyword pools
CREATE TABLE public.keyword_pool (
    id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
    user_id UUID NOT NULL,
    keyword TEXT NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
    UNIQUE(user_id, keyword)
);

-- Enable Row Level Security
ALTER TABLE public.keyword_pool ENABLE ROW LEVEL SECURITY;

-- Create policies for user access
CREATE POLICY "Users can view their own keywords" 
ON public.keyword_pool 
FOR SELECT 
USING (auth.uid() = user_id);

CREATE POLICY "Users can create their own keywords" 
ON public.keyword_pool 
FOR INSERT 
WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can delete their own keywords" 
ON public.keyword_pool 
FOR DELETE 
USING (auth.uid() = user_id);