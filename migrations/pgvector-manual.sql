-- Enable pgvector extension
CREATE EXTENSION IF NOT EXISTS vector;

-- Create document_chunks table
CREATE TABLE IF NOT EXISTS document_chunks (
  id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
  document_version_id VARCHAR NOT NULL REFERENCES document_versions(id) ON DELETE CASCADE,
  chunk_index INTEGER NOT NULL,
  content TEXT NOT NULL,
  embedding vector(768) NOT NULL,
  town TEXT NOT NULL,
  category TEXT NOT NULL,
  board TEXT,
  year TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

-- Create embedding_jobs table
CREATE TABLE IF NOT EXISTS embedding_jobs (
  id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
  document_version_id VARCHAR NOT NULL UNIQUE REFERENCES document_versions(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending',
  chunk_count INTEGER,
  error_message TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMP
);

-- Create HNSW index for fast similarity search (cosine distance)
CREATE INDEX IF NOT EXISTS document_chunks_embedding_idx 
ON document_chunks 
USING hnsw (embedding vector_cosine_ops);

-- Create indexes on filter columns for better query performance
CREATE INDEX IF NOT EXISTS document_chunks_town_idx 
ON document_chunks (town);

CREATE INDEX IF NOT EXISTS document_chunks_category_idx 
ON document_chunks (category);

CREATE INDEX IF NOT EXISTS document_chunks_document_version_idx 
ON document_chunks (document_version_id);

CREATE INDEX IF NOT EXISTS embedding_jobs_status_idx 
ON embedding_jobs (status);

CREATE INDEX IF NOT EXISTS embedding_jobs_document_version_idx 
ON embedding_jobs (document_version_id);
