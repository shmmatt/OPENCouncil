/**
 * File Search Logging Utilities
 * 
 * Provides structured logging for all File Search (Gemini grounding) operations.
 * Logs queries, filters, and retrieved document chunks.
 * 
 * SAFETY CONSTRAINTS:
 * - Query text is truncated
 * - Document snippets are truncated
 * - Full document content is never logged
 * - No sensitive metadata (user tokens, etc.) is logged
 */

import { logDebug, truncate, sanitizeUserContent, type LogContext } from "./logger";

/**
 * Log a File Search request before making the API call
 */
export function logFileSearchRequest(params: {
  requestId?: string;
  sessionId?: string;
  stage: string;
  storeId?: string;
  queryText?: string;
  filters?: Record<string, any>;
}): void {
  const { requestId, sessionId, stage, storeId, queryText, filters } = params;
  
  logDebug("file_search_request", {
    requestId,
    sessionId,
    stage,
    storeId: storeId ? truncate(storeId, 100) : undefined,
    queryText: sanitizeUserContent(queryText, 200),
    filters,
  });
}

export interface FileSearchResult {
  documentName?: string;
  uri?: string;
  score?: number;
  snippet?: string;
}

/**
 * Log a File Search response with retrieved chunks
 * Captures document names, scores, and truncated snippets
 */
export function logFileSearchResponse(params: {
  requestId?: string;
  sessionId?: string;
  stage: string;
  results: FileSearchResult[];
  responseText?: string;
  durationMs?: number;
}): void {
  const { requestId, sessionId, stage, results, responseText, durationMs } = params;
  
  const summarizedResults = results.map(r => ({
    documentName: r.documentName,
    uri: r.uri ? truncate(r.uri, 100) : undefined,
    score: r.score,
    snippetPreview: r.snippet ? truncate(r.snippet, 200) : undefined,
  }));

  logDebug("file_search_response", {
    requestId,
    sessionId,
    stage,
    resultCount: results.length,
    results: summarizedResults,
    responseLength: responseText?.length,
    responseSnippet: responseText ? truncate(responseText, 500) : undefined,
    durationMs,
  });
}

/**
 * Extract retrieval document count from File Search response.
 * This is the AUTHORITATIVE source for determining if documents were found.
 * 
 * ARCHITECTURAL NOTE:
 * In the Gemini API, File Search is a tool that runs as part of the model call.
 * Results are returned in the response's groundingMetadata structure - there is
 * NO separate File Search API call that returns results independently.
 * 
 * This function serves as the SINGLE SOURCE OF TRUTH for:
 * 1. Determining if documents were found (for scope/no-doc notice logic)
 * 2. Providing document names for classification
 * 
 * CRITICAL: All scope/no-doc notice logic MUST use the output of this function.
 * The extractGroundingInfoForLogging function is for LOGGING ONLY and must NOT
 * be used to drive user-visible behavior.
 */
export function extractRetrievalDocCount(response: any): { count: number; documentNames: string[] } {
  const documentNames: string[] = [];
  const seenDocs = new Set<string>();
  
  try {
    if (response.candidates?.[0]?.groundingMetadata?.groundingChunks) {
      const chunks = response.candidates[0].groundingMetadata.groundingChunks;
      
      for (const chunk of chunks) {
        // Check retrievedContext.uri
        const uri = chunk.retrievedContext?.uri;
        if (uri && !seenDocs.has(uri)) {
          documentNames.push(uri);
          seenDocs.add(uri);
        }
        
        // Check retrievedContext.title
        const title = chunk.retrievedContext?.title;
        if (title && !seenDocs.has(title)) {
          documentNames.push(title);
          seenDocs.add(title);
        }
        
        // Check web.title (for web grounding fallback)
        const webTitle = chunk.web?.title;
        if (webTitle && !seenDocs.has(webTitle)) {
          documentNames.push(webTitle);
          seenDocs.add(webTitle);
        }
        
        // Check web.uri
        const webUri = chunk.web?.uri;
        if (webUri && !seenDocs.has(webUri)) {
          documentNames.push(webUri);
          seenDocs.add(webUri);
        }
      }
    }
  } catch (e) {
    // Silently fail - return empty if extraction fails
  }
  
  return {
    count: documentNames.length,
    documentNames,
  };
}

/**
 * Extract grounding metadata from a Gemini response for logging ONLY.
 * 
 * WARNING: This data is for LOGGING PURPOSES ONLY.
 * It MUST NOT be used to determine scope notices or "No docs found" logic.
 * Use extractRetrievalDocCount() for that purpose.
 */
export function extractGroundingInfoForLogging(response: any): FileSearchResult[] {
  const results: FileSearchResult[] = [];
  
  try {
    if (response.candidates?.[0]?.groundingMetadata?.groundingChunks) {
      const chunks = response.candidates[0].groundingMetadata.groundingChunks;
      
      for (const chunk of chunks) {
        const result: FileSearchResult = {};
        
        if (chunk.retrievedContext?.uri) {
          result.uri = chunk.retrievedContext.uri;
        }
        if (chunk.retrievedContext?.title) {
          result.documentName = chunk.retrievedContext.title;
        }
        if (chunk.web?.title) {
          result.documentName = result.documentName || chunk.web.title;
        }
        if (chunk.web?.uri) {
          result.uri = result.uri || chunk.web.uri;
        }
        if (chunk.text) {
          result.snippet = chunk.text;
        }
        
        if (result.documentName || result.uri) {
          results.push(result);
        }
      }
    }
    
    if (response.candidates?.[0]?.groundingMetadata?.retrievalMetadata) {
      const metadata = response.candidates[0].groundingMetadata.retrievalMetadata;
      if (metadata.googleSearchDynamicRetrievalScore !== undefined) {
        results.push({
          documentName: "[Web Search Used]",
          score: metadata.googleSearchDynamicRetrievalScore,
        });
      }
    }
  } catch (e) {
  }
  
  return results;
}
