/**
 * Embedding Generation Service
 * 
 * Handles text embedding generation using Google's Gemini REST API.
 * Uses text-embedding-004 model which produces 768-dimensional embeddings.
 */

import { logDebug, logError } from "../utils/logger";

const EMBEDDING_MODEL = "gemini-embedding-001";  // Correct Gemini embedding model name
const EMBEDDING_DIMENSIONS = 768;
const MAX_BATCH_SIZE = 100;

function getApiKey(): string {
  const apiKey = process.env.GEM_API_KEY;
  if (!apiKey) {
    throw new Error("GEM_API_KEY not found in environment");
  }
  return apiKey;
}

/**
 * Generate embedding for a single text chunk using REST API
 */
export async function generateEmbedding(text: string): Promise<number[]> {
  try {
    const apiKey = getApiKey();
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${EMBEDDING_MODEL}:embedContent?key=${apiKey}`;
    
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        content: {
          parts: [{ text }]
        },
        taskType: "RETRIEVAL_DOCUMENT",
        outputDimensionality: EMBEDDING_DIMENSIONS,
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Gemini API error: ${response.status} - ${error}`);
    }

    const result = await response.json();
    
    if (!result.embedding?.values) {
      throw new Error("No embedding values returned from Gemini");
    }

    logDebug("[embeddingService]", `Generated embedding: ${result.embedding.values.length} dims`);
    return result.embedding.values;
  } catch (error) {
    logError("[embeddingService]", "Failed to generate embedding", error);
    throw error;
  }
}

/**
 * Generate embeddings for multiple texts in batch
 * Uses REST API batch endpoint
 */
export async function generateEmbeddingBatch(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) {
    return [];
  }

  const apiKey = getApiKey();
  const results: number[][] = [];

  // Process in batches if needed
  for (let i = 0; i < texts.length; i += MAX_BATCH_SIZE) {
    const batch = texts.slice(i, i + MAX_BATCH_SIZE);
    
    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${EMBEDDING_MODEL}:batchEmbedContents?key=${apiKey}`;
      
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          requests: batch.map(text => ({
            model: `models/${EMBEDDING_MODEL}`,
            content: { parts: [{ text }] },
            taskType: "RETRIEVAL_DOCUMENT",
            outputDimensionality: EMBEDDING_DIMENSIONS,
          })),
        }),
      });

      if (!response.ok) {
        const error = await response.text();
        throw new Error(`Gemini API error: ${response.status} - ${error}`);
      }

      const result = await response.json();
      
      if (!result.embeddings) {
        throw new Error("No embeddings in batch response");
      }

      for (const embedding of result.embeddings) {
        if (!embedding.values) {
          throw new Error("No embedding values in batch result");
        }
        results.push(embedding.values);
      }

      logDebug("[embeddingService]", `Generated batch: ${batch.length} embeddings`);
    } catch (error) {
      logError("[embeddingService]", `Failed to generate batch embeddings`, error);
      throw error;
    }
  }

  return results;
}

/**
 * Generate embedding for a query (uses RETRIEVAL_QUERY task type)
 */
export async function generateQueryEmbedding(query: string): Promise<number[]> {
  try {
    const apiKey = getApiKey();
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${EMBEDDING_MODEL}:embedContent?key=${apiKey}`;
    
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        content: {
          parts: [{ text: query }]
        },
        taskType: "RETRIEVAL_QUERY",
        outputDimensionality: EMBEDDING_DIMENSIONS,
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Gemini API error: ${response.status} - ${error}`);
    }

    const result = await response.json();
    
    if (!result.embedding?.values) {
      throw new Error("No embedding values returned from Gemini");
    }

    logDebug("[embeddingService]", `Generated query embedding: ${result.embedding.values.length} dims`);
    return result.embedding.values;
  } catch (error) {
    logError("[embeddingService]", "Failed to generate query embedding", error);
    throw error;
  }
}

/**
 * Split text into chunks suitable for embedding
 * Uses simple character-based chunking with overlap
 */
export function chunkText(text: string, chunkSize = 1000, overlap = 200): string[] {
  const chunks: string[] = [];
  let start = 0;

  while (start < text.length) {
    const end = Math.min(start + chunkSize, text.length);
    const chunk = text.slice(start, end).trim();
    
    if (chunk.length > 0) {
      chunks.push(chunk);
    }

    start = end - overlap;
    if (start >= text.length) break;
  }

  return chunks;
}
