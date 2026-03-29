-- TSV Trigger Upgrade: include filename, board, documentType from chunk JSONB metadata
-- This makes keyword search find documents by their filename (e.g. "031026townresults.pdf"
-- adds the stems "town" and "result" to the index even if those words are absent from content).
--
-- The trigger is updated via CREATE OR REPLACE at server startup (idempotent).
-- This file documents the change for audit purposes.
--
-- After updating the trigger function, rebuild ALL existing search_vectors with:
--
--   UPDATE document_chunks
--   SET search_vector = to_tsvector('english',
--     coalesce(content, '') || ' ' ||
--     coalesce(metadata->>'filename', '') || ' ' ||
--     coalesce(metadata->>'board', '') || ' ' ||
--     coalesce(metadata->>'documentType', '')
--   );
--
-- This can be triggered via POST /api/admin/embeddings/rebuild-tsv (admin endpoint).

CREATE OR REPLACE FUNCTION public.document_chunks_search_vector_update()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.search_vector := to_tsvector('english',
    coalesce(NEW.content, '') || ' ' ||
    coalesce(NEW.metadata->>'filename', '') || ' ' ||
    coalesce(NEW.metadata->>'board', '') || ' ' ||
    coalesce(NEW.metadata->>'documentType', '')
  );
  RETURN NEW;
END;
$$;
