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
import { logDebug, logError, logInfo } from "../utils/logger";

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

    logInfo(
      `Semantic search: ${filtered.length}/${results.length} results passed threshold ${similarityThreshold}`,
      { stage: "embeddingStorage" }
    );

    for (const r of filtered) {
      const meta = r.chunk.metadata || {};
      const preview = r.chunk.content.slice(0, 150).replace(/\n/g, " ");
      logInfo(
        `  [${r.similarity.toFixed(3)}] town=${meta.town || "?"} type=${meta.documentType || "?"} board=${meta.board || "-"} year=${meta.year || "-"} | "${preview}..."`,
        { stage: "embeddingStorage" }
      );
    }

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
// KEYWORD SEARCH (Full-Text via GIN-indexed tsvector)
// ============================================================

export interface KeywordSearchResult {
  chunk: DocumentChunk;
  rank: number;
  documentId: string | null;
}

function sanitizeKeywordTerms(terms: string[]): string {
  return terms
    .map(term => term
      .replace(/[^\w\s$.,'-]/g, ' ')
      .replace(/\$/g, '')
      .trim()
    )
    .filter(t => t.length > 1)
    .map(t => t.split(/\s+/).filter(w => w.length > 1).join(' & '))
    .filter(t => t.length > 0)
    .join(' | ');
}

export async function keywordSearch(
  terms: string[],
  options: SearchOptions = {}
): Promise<KeywordSearchResult[]> {
  const {
    town,
    towns,
    category,
    board,
    year,
    limit = 20,
  } = options;

  const tsQuery = sanitizeKeywordTerms(terms);
  if (!tsQuery) return [];

  const conditions = [];

  conditions.push(sql`search_vector @@ to_tsquery('english', ${tsQuery})`);

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

  try {
    const results = await db
      .select({
        chunk: schema.documentChunks,
        rank: sql<number>`ts_rank(search_vector, to_tsquery('english', ${tsQuery}))`,
      })
      .from(schema.documentChunks)
      .where(and(...conditions))
      .orderBy(sql`ts_rank(search_vector, to_tsquery('english', ${tsQuery})) DESC`)
      .limit(limit);

    const mapped = results.map(r => ({
      chunk: r.chunk,
      rank: r.rank,
      documentId: r.chunk.documentId,
    }));

    logInfo(
      `Keyword search: ${mapped.length} results for terms: ${terms.join(', ')}`,
      { stage: "embeddingStorage" }
    );

    return mapped;
  } catch (error) {
    logError("Keyword search failed", { stage: "embeddingStorage", error: String(error) });
    return [];
  }
}

// ============================================================
// HYBRID SEARCH (Semantic + Keyword via Reciprocal Rank Fusion)
// ============================================================

import type { TemporalTarget, QueryFocus } from "../chatV2/types";

export interface HybridSearchOptions extends SearchOptions {
  keywordTerms?: string[];
  temporalFilter?: TemporalTarget;
  queryFocus?: QueryFocus;
  docTypeWeights?: Record<string, number>;
}

export interface HybridSearchResult {
  chunk: DocumentChunk;
  score: number;
  documentId: string | null;
  semanticRank?: number;
  keywordRank?: number;
}

const RRF_K = 60;

export async function hybridSearch(
  queryEmbedding: number[],
  options: HybridSearchOptions = {}
): Promise<HybridSearchResult[]> {
  const {
    keywordTerms,
    temporalFilter,
    queryFocus,
    docTypeWeights,
    limit = 20,
    ...baseOptions
  } = options;

  const fetchLimit = Math.max(limit, 15);

  const hasKeywords = keywordTerms && keywordTerms.length > 0;

  const [semanticResults, keywordResults] = await Promise.all([
    semanticSearch(queryEmbedding, { ...baseOptions, limit: fetchLimit }),
    hasKeywords
      ? keywordSearch(keywordTerms, { ...baseOptions, limit: fetchLimit })
      : Promise.resolve([]),
  ]);

  const chunkMap = new Map<number, {
    chunk: DocumentChunk;
    documentId: string | null;
    semanticRank?: number;
    keywordRank?: number;
  }>();

  for (let i = 0; i < semanticResults.length; i++) {
    const r = semanticResults[i];
    chunkMap.set(r.chunk.id, {
      chunk: r.chunk,
      documentId: r.documentId,
      semanticRank: i + 1,
    });
  }

  for (let i = 0; i < keywordResults.length; i++) {
    const r = keywordResults[i];
    const existing = chunkMap.get(r.chunk.id);
    if (existing) {
      existing.keywordRank = i + 1;
    } else {
      chunkMap.set(r.chunk.id, {
        chunk: r.chunk,
        documentId: r.documentId,
        keywordRank: i + 1,
      });
    }
  }

  const scored: HybridSearchResult[] = [];

  for (const entry of Array.from(chunkMap.values())) {
    let rrfScore = 0;
    if (entry.semanticRank != null) {
      rrfScore += 1 / (RRF_K + entry.semanticRank);
    }
    if (entry.keywordRank != null) {
      rrfScore += 1 / (RRF_K + entry.keywordRank);
    }

    if (temporalFilter && temporalFilter.strategy !== "none") {
      rrfScore = applyTemporalBoost(rrfScore, entry.chunk, temporalFilter);
    }

    if (docTypeWeights && Object.keys(docTypeWeights).length > 0) {
      rrfScore = applyDocTypeWeight(rrfScore, entry.chunk, docTypeWeights);
    }

    scored.push({
      chunk: entry.chunk,
      score: rrfScore,
      documentId: entry.documentId,
      semanticRank: entry.semanticRank,
      keywordRank: entry.keywordRank,
    });
  }

  scored.sort((a, b) => b.score - a.score);

  const topResults = scored.slice(0, limit);

  logInfo(
    `Hybrid search: ${topResults.length} results (${semanticResults.length} semantic, ${keywordResults.length} keyword, ${chunkMap.size} unique)`,
    { stage: "embeddingStorage" }
  );

  return topResults;
}

function applyTemporalBoost(
  score: number,
  chunk: DocumentChunk,
  temporalFilter: TemporalTarget
): number {
  const meta = chunk.metadata;
  if (!meta?.year) return score * 0.85;

  const docYear = typeof meta.year === 'number' ? meta.year : parseInt(String(meta.year), 10);
  if (isNaN(docYear)) return score * 0.85;

  const yearDiff = Math.abs(temporalFilter.year - docYear);

  if (temporalFilter.strategy === "hard_filter") {
    if (yearDiff === 0) return score * 1.4;
    if (yearDiff === 1) return score * 1.0;
    if (yearDiff <= 3) return score * 0.6;
    return score * 0.3;
  }

  if (temporalFilter.strategy === "boost") {
    if (yearDiff === 0) return score * 1.3;
    if (yearDiff === 1) return score * 1.1;
    if (yearDiff <= 3) return score * 0.9;
    return score * 0.7;
  }

  return score;
}

function applyDocTypeWeight(
  score: number,
  chunk: DocumentChunk,
  weights: Record<string, number>
): number {
  const meta = chunk.metadata;
  const docType = (meta?.documentType || "").toLowerCase();

  const exactWeight = weights[docType];
  if (exactWeight != null) {
    return score * exactWeight;
  }

  for (const [type, weight] of Object.entries(weights)) {
    const typeLower = type.toLowerCase();
    if (docType.includes(typeLower) || typeLower.includes(docType)) {
      return score * weight;
    }
  }

  return score;
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
