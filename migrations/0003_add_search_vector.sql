-- Add tsvector column for full-text search on document_chunks
-- Uses a regular column with a trigger to keep it in sync

-- Step 1: Add the column (nullable, no default to avoid full rewrite)
ALTER TABLE document_chunks ADD COLUMN IF NOT EXISTS search_vector tsvector;

-- Step 2: Create GIN index for fast full-text search
CREATE INDEX IF NOT EXISTS idx_document_chunks_search_vector
  ON document_chunks USING GIN (search_vector);

-- Step 3: Create trigger function to auto-populate on INSERT/UPDATE
CREATE OR REPLACE FUNCTION document_chunks_search_vector_update() RETURNS trigger AS $$
BEGIN
  NEW.search_vector := to_tsvector('english', coalesce(NEW.content, ''));
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Step 4: Create trigger
DROP TRIGGER IF EXISTS trg_document_chunks_search_vector ON document_chunks;
CREATE TRIGGER trg_document_chunks_search_vector
  BEFORE INSERT OR UPDATE OF content ON document_chunks
  FOR EACH ROW
  EXECUTE FUNCTION document_chunks_search_vector_update();

-- Step 5: Backfill existing rows in batches (run separately if needed for large tables)
-- UPDATE document_chunks SET search_vector = to_tsvector('english', coalesce(content, '')) WHERE search_vector IS NULL;
