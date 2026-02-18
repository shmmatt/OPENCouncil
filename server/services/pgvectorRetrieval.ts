/**
 * pgvector Retrieval Service
 * 
 * Integrates pgvector semantic search into the chat pipeline.
 * Converts search results to the format expected by the existing pipeline.
 */

import { generateQueryEmbedding } from "./embeddingService";
import { semanticSearch, twoLaneSemanticSearch, type SearchResult } from "./embeddingStorage";
import { getDocumentVersionById, getLogicalDocumentById } from "../storage/documents";
import { getFileBlobById } from "../storage/fileBlobs";
import { logDebug, logError, logInfo } from "../utils/logger";
import type { ScopeHint } from "../chatV2/types";

export interface PgvectorChunk {
  content: string;
  similarity: number;
  metadata: {
    documentVersionId: string;
    chunkIndex: number;
    town: string;
    category: string;
    board?: string;
    year?: string;
    // Extended metadata from document
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

/**
 * Convert storage SearchResult to PgvectorChunk with enriched metadata
 */
async function enrichSearchResult(result: SearchResult): Promise<PgvectorChunk> {
  const chunk = result.chunk;
  
  // Try to get document metadata
  let canonicalTitle: string | undefined;
  let filename: string | undefined;
  
  try {
    const docVersion = await getDocumentVersionById(chunk.documentVersionId);
    if (docVersion) {
      const logicalDoc = await getLogicalDocumentById(docVersion.documentId);
      if (logicalDoc) {
        canonicalTitle = logicalDoc.canonicalTitle;
      }
      
      const fileBlob = await getFileBlobById(docVersion.fileBlobId);
      if (fileBlob) {
        filename = fileBlob.originalFilename;
      }
    }
  } catch (error) {
    logError("[pgvectorRetrieval]", "Failed to enrich metadata", error);
  }

  return {
    content: chunk.content,
    similarity: result.similarity,
    metadata: {
      documentVersionId: chunk.documentVersionId,
      chunkIndex: chunk.chunkIndex,
      town: chunk.town,
      category: chunk.category,
      board: chunk.board || undefined,
      year: chunk.year || undefined,
      canonicalTitle,
      filename,
    },
  };
}

/**
 * Perform two-lane retrieval using pgvector
 */
export async function twoLaneRetrieve(
  query: string,
  scopeHint: ScopeHint,
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
    similarityThreshold = 0.5,
  } = options;

  try {
    logInfo("[pgvectorRetrieval]", `Two-lane query: "${query}" (town: ${scopeHint.town})`);

    // Generate query embedding
    const queryEmbedding = await generateQueryEmbedding(query);
    
    // Perform two-lane search
    const { local, statewide } = await twoLaneSemanticSearch(queryEmbedding, {
      localTown: scopeHint.town,
      limit: localLimit + statewideLimit,
      similarityThreshold,
    });

    // Enrich results with metadata
    const [localChunks, statewideChunks] = await Promise.all([
      Promise.all(local.map(enrichSearchResult)),
      Promise.all(statewide.map(enrichSearchResult)),
    ]);

    const queryTimeMs = Date.now() - startTime;
    const allSimilarities = [...local, ...statewide].map(r => r.similarity);
    const avgSimilarity = allSimilarities.length > 0
      ? allSimilarities.reduce((sum, s) => sum + s, 0) / allSimilarities.length
      : 0;

    logInfo(
      "[pgvectorRetrieval]",
      `Retrieved ${localChunks.length} local + ${statewideChunks.length} statewide chunks ` +
      `(avg similarity: ${avgSimilarity.toFixed(3)}, ${queryTimeMs}ms)`
    );

    return {
      localChunks,
      statewideChunks,
      totalChunks: localChunks.length + statewideChunks.length,
      queryTimeMs,
      avgSimilarity,
    };
  } catch (error) {
    logError("[pgvectorRetrieval]", "Two-lane retrieval failed", error);
    throw error;
  }
}

/**
 * Perform single-lane retrieval (for specific town or statewide only)
 */
export async function singleLaneRetrieve(
  query: string,
  options: {
    town?: string;
    category?: string;
    board?: string;
    limit?: number;
    similarityThreshold?: number;
  } = {}
): Promise<PgvectorChunk[]> {
  const startTime = Date.now();
  
  try {
    logInfo("[pgvectorRetrieval]", `Single-lane query: "${query}"`);

    // Generate query embedding
    const queryEmbedding = await generateQueryEmbedding(query);
    
    // Perform search
    const results = await semanticSearch(queryEmbedding, {
      ...options,
      limit: options.limit || 20,
      similarityThreshold: options.similarityThreshold || 0.5,
    });

    // Enrich results with metadata
    const chunks = await Promise.all(results.map(enrichSearchResult));

    const queryTimeMs = Date.now() - startTime;
    const avgSimilarity = results.length > 0
      ? results.reduce((sum, r) => sum + r.similarity, 0) / results.length
      : 0;

    logInfo(
      "[pgvectorRetrieval]",
      `Retrieved ${chunks.length} chunks (avg similarity: ${avgSimilarity.toFixed(3)}, ${queryTimeMs}ms)`
    );

    return chunks;
  } catch (error) {
    logError("[pgvectorRetrieval]", "Single-lane retrieval failed", error);
    throw error;
  }
}
