/**
 * pgvector Retrieval Service
 * 
 * Integrates pgvector semantic search into the chat pipeline.
 * Converts search results to the format expected by the existing pipeline.
 */

import { generateQueryEmbedding } from "./embeddingService";
import { semanticSearch, twoLaneSemanticSearch, type SearchResult } from "./embeddingStorage";
import { getLogicalDocumentById } from "../storage/documents";
import { logDebug, logError, logInfo } from "../utils/logger";

export interface PgvectorChunk {
  content: string;
  similarity: number;
  metadata: {
    documentId: string | null;
    chunkIndex: number;
    town?: string;
    category?: string;
    board?: string;
    year?: string;
    canonicalTitle?: string;
    filename?: string;
  };
}

export interface PgvectorRetrievalResult {
  localChunks: PgvectorChunk[];
  statewideChunks: PgvectorChunk[];
  totalChunks: number;
  queryTimeMs: number;
  avgSimilarity: number;
}

async function enrichSearchResult(result: SearchResult): Promise<PgvectorChunk> {
  const chunk = result.chunk;
  const meta = chunk.metadata || {};
  
  let canonicalTitle: string | undefined;
  
  try {
    if (chunk.documentId) {
      const logicalDoc = await getLogicalDocumentById(chunk.documentId);
      if (logicalDoc) {
        canonicalTitle = logicalDoc.canonicalTitle;
      }
    }
  } catch (error) {
    logError("Failed to enrich metadata", { stage: "pgvectorRetrieval" });
  }

  return {
    content: chunk.content,
    similarity: result.similarity,
    metadata: {
      documentId: chunk.documentId,
      chunkIndex: chunk.chunkIndex,
      town: meta.town,
      category: meta.documentType,
      board: meta.board || undefined,
      year: meta.year != null ? String(meta.year) : undefined,
      canonicalTitle,
      filename: meta.filename,
    },
  };
}

export async function pgvectorTwoLaneRetrieve(
  query: string,
  town: string,
  options: {
    localLimit?: number;
    statewideLimit?: number;
    similarityThreshold?: number;
  } = {}
): Promise<PgvectorRetrievalResult> {
  const startTime = Date.now();
  const {
    localLimit = 14,
    statewideLimit = 6,
    similarityThreshold = 0.4,
  } = options;

  try {
    const queryEmbedding = await generateQueryEmbedding(query);

    const { local, statewide } = await twoLaneSemanticSearch(queryEmbedding, {
      localTown: town,
      limit: localLimit + statewideLimit,
      similarityThreshold,
    });

    const [localChunks, statewideChunks] = await Promise.all([
      Promise.all(local.map(enrichSearchResult)),
      Promise.all(statewide.map(enrichSearchResult)),
    ]);

    const allChunks = [...localChunks, ...statewideChunks];
    const avgSimilarity = allChunks.length > 0
      ? allChunks.reduce((sum, c) => sum + c.similarity, 0) / allChunks.length
      : 0;

    const result: PgvectorRetrievalResult = {
      localChunks,
      statewideChunks,
      totalChunks: allChunks.length,
      queryTimeMs: Date.now() - startTime,
      avgSimilarity,
    };

    logInfo(`pgvector retrieval: ${localChunks.length} local + ${statewideChunks.length} statewide chunks (${result.queryTimeMs}ms)`, {
      stage: "pgvectorRetrieval",
    });

    return result;
  } catch (error) {
    logError("pgvector retrieval failed", { stage: "pgvectorRetrieval" });
    throw error;
  }
}

export async function pgvectorSingleQuery(
  query: string,
  options: {
    town?: string;
    limit?: number;
    similarityThreshold?: number;
  } = {}
): Promise<PgvectorChunk[]> {
  const { town, limit = 20, similarityThreshold = 0.4 } = options;

  try {
    const queryEmbedding = await generateQueryEmbedding(query);
    const results = await semanticSearch(queryEmbedding, {
      town,
      limit,
      similarityThreshold,
    });

    return await Promise.all(results.map(enrichSearchResult));
  } catch (error) {
    logError("pgvector single query failed", { stage: "pgvectorRetrieval" });
    throw error;
  }
}
