/**
 * Embedding Storage Service
 * 
 * Handles database operations for document embeddings using pgvector.
 * Provides semantic search over embedded document chunks.
 */

import { db, schema, eq, and, inArray, sql } from "../storage/db";
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

export async function getEmbeddingJobByDocumentVersion(documentVersionId: string): Promise<EmbeddingJob | undefined> {
  const [result] = await db
    .select()
    .from(schema.embeddingJobs)
    .where(eq(schema.embeddingJobs.documentVersionId, documentVersionId));
  return result;
}

export async function updateEmbeddingJob(id: string, data: Partial<InsertEmbeddingJob>): Promise<void> {
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
  const [result] = await db.insert(schema.documentChunks).values(chunk).returning();
  return result;
}

export async function insertDocumentChunkBatch(chunks: InsertDocumentChunk[]): Promise<void> {
  if (chunks.length === 0) return;
  
  await db.insert(schema.documentChunks).values(chunks);
  logDebug("[embeddingStorage]", `Inserted ${chunks.length} chunks`);
}

export async function getChunksByDocumentVersion(documentVersionId: string): Promise<DocumentChunk[]> {
  return await db
    .select()
    .from(schema.documentChunks)
    .where(eq(schema.documentChunks.documentVersionId, documentVersionId))
    .orderBy(schema.documentChunks.chunkIndex);
}

export async function deleteChunksByDocumentVersion(documentVersionId: string): Promise<void> {
  await db
    .delete(schema.documentChunks)
    .where(eq(schema.documentChunks.documentVersionId, documentVersionId));
}

// ============================================================
// SEMANTIC SEARCH
// ============================================================

export interface SearchOptions {
  town?: string;
  towns?: string[]; // For multi-town queries
  category?: string;
  board?: string;
  year?: string;
  limit?: number;
  similarityThreshold?: number;
}

export interface SearchResult {
  chunk: DocumentChunk;
  similarity: number;
  documentVersionId: string;
}

/**
 * Perform semantic search over document chunks using cosine similarity
 * Returns chunks ordered by similarity score (highest first)
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

  // Build filter conditions
  const conditions = [];
  
  if (town) {
    conditions.push(eq(schema.documentChunks.town, town));
  } else if (towns && towns.length > 0) {
    conditions.push(inArray(schema.documentChunks.town, towns));
  }
  
  if (category) {
    conditions.push(eq(schema.documentChunks.category, category));
  }
  
  if (board) {
    conditions.push(eq(schema.documentChunks.board, board));
  }
  
  if (year) {
    conditions.push(eq(schema.documentChunks.year, year));
  }

  // Convert embedding array to pgvector format
  const embeddingStr = `[${queryEmbedding.join(",")}]`;

  try {
    // Perform vector similarity search using cosine distance
    // 1 - (embedding <=> query) gives us similarity score (0 to 1)
    const results = await db
      .select({
        chunk: schema.documentChunks,
        similarity: sql<number>`1 - (embedding <=> ${embeddingStr}::vector)`,
      })
      .from(schema.documentChunks)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(sql`embedding <=> ${embeddingStr}::vector`)
      .limit(limit);

    // Filter by similarity threshold
    const filtered = results
      .filter(r => r.similarity >= similarityThreshold)
      .map(r => ({
        chunk: r.chunk,
        similarity: r.similarity,
        documentVersionId: r.chunk.documentVersionId,
      }));

    logDebug(
      "[embeddingStorage]",
      `Semantic search: ${filtered.length} results (threshold: ${similarityThreshold})`
    );

    return filtered;
  } catch (error) {
    logError("[embeddingStorage]", "Semantic search failed", error);
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

  // Execute both searches in parallel
  const [local, statewide] = await Promise.all([
    semanticSearch(queryEmbedding, {
      ...baseOptions,
      town: localTown,
      limit: localLimit,
    }),
    semanticSearch(queryEmbedding, {
      ...baseOptions,
      town: "statewide",
      limit: statewideLimit,
    }),
  ]);

  logDebug(
    "[embeddingStorage]",
    `Two-lane search: ${local.length} local, ${statewide.length} statewide`
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
      town: schema.documentChunks.town,
      count: sql<number>`count(*)::int`,
    })
    .from(schema.documentChunks)
    .groupBy(schema.documentChunks.town);

  const totalChunks = chunks.reduce((sum, row) => sum + row.count, 0);
  const byTown = Object.fromEntries(chunks.map(row => [row.town, row.count]));

  const documents = await db
    .select({ count: sql<number>`count(distinct document_version_id)::int` })
    .from(schema.documentChunks);

  return {
    totalChunks,
    totalDocuments: documents[0]?.count || 0,
    byTown,
  };
}
