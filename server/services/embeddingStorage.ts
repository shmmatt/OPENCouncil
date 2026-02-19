/**
 * Embedding Storage Service
 * 
 * Handles database operations for document embeddings using pgvector.
 * Provides semantic search over embedded document chunks.
 * 
 * The document_chunks table stores metadata (town, board, year, etc.) in a JSONB column.
 * Filters use SQL JSONB operators to query against metadata fields.
 */

import { db, schema, eq, and, sql } from "../storage/db";
import type {
  DocumentChunk,
  InsertDocumentChunk,
  EmbeddingJob,
  InsertEmbeddingJob,
} from "@shared/schema";
import { logDebug, logError } from "../utils/logger";

// ============================================================
// EMBEDDING JOBS
// ============================================================

export async function createEmbeddingJob(job: InsertEmbeddingJob): Promise<EmbeddingJob> {
  const [result] = await db.insert(schema.embeddingJobs).values(job).returning();
  return result;
}

export async function getEmbeddingJobByDocumentId(documentId: string): Promise<EmbeddingJob | undefined> {
  const [result] = await db
    .select()
    .from(schema.embeddingJobs)
    .where(eq(schema.embeddingJobs.documentId, documentId));
  return result;
}

export async function updateEmbeddingJob(id: number, data: Partial<InsertEmbeddingJob>): Promise<void> {
  await db
    .update(schema.embeddingJobs)
    .set(data)
    .where(eq(schema.embeddingJobs.id, id));
}

export async function getPendingEmbeddingJobs(limit = 10): Promise<EmbeddingJob[]> {
  return await db
    .select()
    .from(schema.embeddingJobs)
    .where(eq(schema.embeddingJobs.status, "pending"))
    .limit(limit);
}

// ============================================================
// DOCUMENT CHUNKS
// ============================================================

export async function insertDocumentChunk(chunk: InsertDocumentChunk): Promise<DocumentChunk> {
  const [result] = await db.insert(schema.documentChunks).values([chunk] as any).returning();
  return result;
}

export async function insertDocumentChunkBatch(chunks: InsertDocumentChunk[]): Promise<void> {
  if (chunks.length === 0) return;
  
  await db.insert(schema.documentChunks).values(chunks as any);
  logDebug(`Inserted ${chunks.length} chunks`, { stage: "embeddingStorage" });
}

export async function getChunksByDocumentId(documentId: string): Promise<DocumentChunk[]> {
  return await db
    .select()
    .from(schema.documentChunks)
    .where(eq(schema.documentChunks.documentId, documentId))
    .orderBy(schema.documentChunks.chunkIndex);
}

export async function deleteChunksByDocumentId(documentId: string): Promise<void> {
  await db
    .delete(schema.documentChunks)
    .where(eq(schema.documentChunks.documentId, documentId));
}

// ============================================================
// SEMANTIC SEARCH
// ============================================================

export interface SearchOptions {
  town?: string;
  towns?: string[];
  category?: string;
  board?: string;
  year?: string;
  limit?: number;
  similarityThreshold?: number;
}

export interface SearchResult {
  chunk: DocumentChunk;
  similarity: number;
  documentId: string | null;
}

/**
 * Perform semantic search over document chunks using cosine similarity.
 * Filters use JSONB metadata fields (town, board, year, category).
 */
export async function semanticSearch(
  queryEmbedding: number[],
  options: SearchOptions = {}
): Promise<SearchResult[]> {
  const {
    town,
    towns,
    category,
    board,
    year,
    limit = 20,
    similarityThreshold = 0.5,
  } = options;

  const conditions = [];

  if (town) {
    conditions.push(sql`lower(metadata->>'town') = ${town.toLowerCase()}`);
  } else if (towns && towns.length > 0) {
    const townList = towns.map(t => `'${t.replace(/'/g, "''").toLowerCase()}'`).join(",");
    conditions.push(sql.raw(`lower(metadata->>'town') IN (${townList})`));
  }

  if (category) {
    conditions.push(sql`metadata->>'documentType' = ${category}`);
  }

  if (board) {
    conditions.push(sql`metadata->>'board' = ${board}`);
  }

  if (year) {
    conditions.push(sql`metadata->>'year' = ${year}`);
  }

  const embeddingStr = `[${queryEmbedding.join(",")}]`;

  try {
    const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

    const results = await db
      .select({
        chunk: schema.documentChunks,
        similarity: sql<number>`1 - (embedding <=> ${embeddingStr}::vector)`,
      })
      .from(schema.documentChunks)
      .where(whereClause)
      .orderBy(sql`embedding <=> ${embeddingStr}::vector`)
      .limit(limit);

    const filtered = results
      .filter(r => r.similarity >= similarityThreshold)
      .map(r => ({
        chunk: r.chunk,
        similarity: r.similarity,
        documentId: r.chunk.documentId,
      }));

    logDebug(
      `Semantic search: ${filtered.length} results (threshold: ${similarityThreshold})`,
      { stage: "embeddingStorage" }
    );

    return filtered;
  } catch (error) {
    logError("Semantic search failed", { stage: "embeddingStorage" });
    throw error;
  }
}

async function semanticSearchStatewideOnly(
  queryEmbedding: number[],
  options: SearchOptions = {}
): Promise<SearchResult[]> {
  const {
    category,
    board,
    year,
    limit = 6,
    similarityThreshold = 0.5,
  } = options;

  const conditions = [];
  conditions.push(sql`lower(metadata->>'town') = 'statewide'`);

  if (category) {
    conditions.push(sql`metadata->>'documentType' = ${category}`);
  }
  if (board) {
    conditions.push(sql`metadata->>'board' = ${board}`);
  }
  if (year) {
    conditions.push(sql`metadata->>'year' = ${year}`);
  }

  const embeddingStr = `[${queryEmbedding.join(",")}]`;

  try {
    const results = await db
      .select({
        chunk: schema.documentChunks,
        similarity: sql<number>`1 - (embedding <=> ${embeddingStr}::vector)`,
      })
      .from(schema.documentChunks)
      .where(and(...conditions))
      .orderBy(sql`embedding <=> ${embeddingStr}::vector`)
      .limit(limit);

    return results
      .filter(r => r.similarity >= similarityThreshold)
      .map(r => ({
        chunk: r.chunk,
        similarity: r.similarity,
        documentId: r.chunk.documentId,
      }));
  } catch (error) {
    logError("Statewide semantic search failed", { stage: "embeddingStorage" });
    throw error;
  }
}

/**
 * Search with automatic two-lane splitting (local + statewide)
 */
export async function twoLaneSemanticSearch(
  queryEmbedding: number[],
  options: SearchOptions & { localTown: string }
): Promise<{ local: SearchResult[]; statewide: SearchResult[] }> {
  const { localTown, ...baseOptions } = options;
  
  const localLimit = options.limit ? Math.ceil(options.limit * 0.7) : 14;
  const statewideLimit = options.limit ? Math.floor(options.limit * 0.3) : 6;

  const [local, statewide] = await Promise.all([
    semanticSearch(queryEmbedding, {
      ...baseOptions,
      town: localTown,
      limit: localLimit,
    }),
    semanticSearchStatewideOnly(queryEmbedding, {
      ...baseOptions,
      limit: statewideLimit,
    }),
  ]);

  logDebug(
    `Two-lane search: ${local.length} local, ${statewide.length} statewide`,
    { stage: "embeddingStorage" }
  );

  return { local, statewide };
}

// ============================================================
// UTILITY FUNCTIONS
// ============================================================

/**
 * Get count of embedded documents by town
 */
export async function getEmbeddingStats(): Promise<{
  totalChunks: number;
  totalDocuments: number;
  byTown: Record<string, number>;
}> {
  const chunks = await db
    .select({
      town: sql<string>`metadata->>'town'`,
      count: sql<number>`count(*)::int`,
    })
    .from(schema.documentChunks)
    .groupBy(sql`metadata->>'town'`);

  const totalChunks = chunks.reduce((sum, row) => sum + row.count, 0);
  const byTown = Object.fromEntries(
    chunks.filter(row => row.town).map(row => [row.town, row.count])
  );

  const documents = await db
    .select({ count: sql<number>`count(distinct document_id)::int` })
    .from(schema.documentChunks);

  return {
    totalChunks,
    totalDocuments: documents[0]?.count || 0,
    byTown,
  };
}
