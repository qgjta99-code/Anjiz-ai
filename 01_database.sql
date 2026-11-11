-- Run once in Supabase SQL Editor before deploying the new function.
ALTER TABLE public.service_requests
ADD COLUMN IF NOT EXISTS file_path text;
