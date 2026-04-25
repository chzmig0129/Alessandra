-- Migration: 006_knowledge_search
-- Description: Function to do cosine-similarity semantic search on
--   public.knowledge using its pgvector embedding column.
--   Used by the new knowledge_buscar Mastra tool.
--
-- Apply: psql $SUPABASE_DB_URL -f migrations/sql/006_knowledge_search.sql

CREATE OR REPLACE FUNCTION public.match_knowledge(
  query_embedding vector(1536),
  match_threshold float DEFAULT 0.5,
  match_count int DEFAULT 5,
  filter_category text DEFAULT NULL
)
RETURNS TABLE (
  id bigint,
  category text,
  subcategory text,
  title text,
  summary text,
  content_type text,
  content jsonb,
  tags text[],
  filename text,
  similarity float
)
LANGUAGE sql
STABLE
AS $$
  SELECT
    k.id,
    k.category,
    k.subcategory,
    k.title,
    k.summary,
    k.content_type,
    k.content,
    k.tags,
    k.filename,
    1 - (k.embedding <=> query_embedding) AS similarity
  FROM public.knowledge k
  WHERE k.embedding IS NOT NULL
    AND (filter_category IS NULL OR k.category = filter_category)
    AND 1 - (k.embedding <=> query_embedding) >= match_threshold
  ORDER BY k.embedding <=> query_embedding
  LIMIT LEAST(match_count, 20);
$$;

-- Grant execute to anon and authenticated so the service-role admin client
-- can call it via supabase.rpc(). The function reads only knowledge — already
-- public information.
GRANT EXECUTE ON FUNCTION public.match_knowledge(vector(1536), float, int, text)
  TO anon, authenticated, service_role;
