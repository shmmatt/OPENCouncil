/**
 * Multi-Store Query Service
 * 
 * Searches multiple Gemini File Search stores based on town context.
 * 
 * Architecture:
 * - Legacy store: Contains statewide docs (RSAs, regs) + existing Ossipee/GWRSD
 * - Per-town stores: New town-specific documents
 * 
 * Query logic:
 * - Always search statewide/legacy store (RSAs apply to all towns)
 * - Also search town-specific store if available
 * - Merge and rank results
 */

import { GoogleGenAI } from "@google/genai";

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY || "" });

// ============================================================
// STORE REGISTRY
// ============================================================

export interface StoreInfo {
  id: string;
  name: string;
  type: "legacy" | "statewide" | "town";
  town?: string;
}

// This would typically be stored in a database
// For now, using in-memory registry
const storeRegistry: Map<string, StoreInfo> = new Map();

export function registerStore(info: StoreInfo): void {
  storeRegistry.set(info.id, info);
  console.log(`[MultiStore] Registered store: ${info.name} (${info.type})`);
}

export function getStoresForTown(town: string): StoreInfo[] {
  const stores: StoreInfo[] = [];
  
  for (const store of storeRegistry.values()) {
    // Always include statewide/legacy stores
    if (store.type === "statewide" || store.type === "legacy") {
      stores.push(store);
    }
    // Include town-specific store if it matches
    else if (store.type === "town" && store.town?.toLowerCase() === town.toLowerCase()) {
      stores.push(store);
    }
  }
  
  return stores;
}

export function getAllStores(): StoreInfo[] {
  return Array.from(storeRegistry.values());
}

// ============================================================
// SEARCH INTERFACE
// ============================================================

export interface SearchOptions {
  town: string;
  query: string;
  maxResults?: number;
  filters?: {
    category?: string;
    board?: string;
    year?: string;
    isMinutes?: boolean;
  };
}

export interface SearchResult {
  storeId: string;
  storeName: string;
  documentId: string;
  documentName: string;
  snippet: string;
  score: number;
  metadata: Record<string, string>;
}

export interface SearchResponse {
  results: SearchResult[];
  storesSearched: string[];
  totalResults: number;
}

/**
 * Search across relevant stores for a given town.
 * 
 * This uses Gemini's file search grounding to find relevant documents.
 */
export async function searchMultiStore(options: SearchOptions): Promise<SearchResponse> {
  const { town, query, maxResults = 10, filters } = options;
  
  // Get relevant stores for this town
  const stores = getStoresForTown(town);
  
  if (stores.length === 0) {
    console.warn(`[MultiStore] No stores found for town: ${town}`);
    return { results: [], storesSearched: [], totalResults: 0 };
  }
  
  console.log(`[MultiStore] Searching ${stores.length} stores for "${query}" (town: ${town})`);
  
  const allResults: SearchResult[] = [];
  const storesSearched: string[] = [];
  
  // Search each store
  for (const store of stores) {
    try {
      const storeResults = await searchSingleStore(store.id, query, maxResults, filters);
      
      for (const result of storeResults) {
        allResults.push({
          ...result,
          storeId: store.id,
          storeName: store.name,
        });
      }
      
      storesSearched.push(store.name);
    } catch (error) {
      console.error(`[MultiStore] Error searching store ${store.name}:`, error);
    }
  }
  
  // Sort by score and limit results
  allResults.sort((a, b) => b.score - a.score);
  const limitedResults = allResults.slice(0, maxResults);
  
  return {
    results: limitedResults,
    storesSearched,
    totalResults: allResults.length,
  };
}

/**
 * Search a single store using Gemini file search.
 */
async function searchSingleStore(
  storeId: string,
  query: string,
  maxResults: number,
  filters?: SearchOptions["filters"]
): Promise<Omit<SearchResult, "storeId" | "storeName">[]> {
  // Build filter string if provided
  let filterString = "";
  if (filters) {
    const filterParts: string[] = [];
    if (filters.category) filterParts.push(`category=${filters.category}`);
    if (filters.board) filterParts.push(`board=${filters.board}`);
    if (filters.year) filterParts.push(`year=${filters.year}`);
    if (filters.isMinutes !== undefined) filterParts.push(`isMinutes=${filters.isMinutes}`);
    if (filterParts.length > 0) {
      filterString = ` [Filter: ${filterParts.join(", ")}]`;
    }
  }
  
  // Use Gemini model with file search grounding
  const model = ai.getGenerativeModel({
    model: "gemini-2.0-flash",
    tools: [{
      fileSearch: {
        fileSearchStoreId: storeId,
      },
    }],
  });
  
  // Generate a search-oriented prompt
  const searchPrompt = `Find relevant documents about: ${query}${filterString}

Return the most relevant passages and their sources. Focus on factual information.`;
  
  try {
    const result = await model.generateContent(searchPrompt);
    const response = result.response;
    
    // Extract grounding metadata (document references)
    const groundingMetadata = (response as any).groundingMetadata;
    const searchResults: Omit<SearchResult, "storeId" | "storeName">[] = [];
    
    if (groundingMetadata?.groundingChunks) {
      for (const chunk of groundingMetadata.groundingChunks) {
        if (chunk.retrievedContext) {
          searchResults.push({
            documentId: chunk.retrievedContext.uri || "",
            documentName: chunk.retrievedContext.title || "Unknown",
            snippet: chunk.retrievedContext.text || "",
            score: chunk.retrievedContext.score || 0.5,
            metadata: chunk.retrievedContext.metadata || {},
          });
        }
      }
    }
    
    return searchResults.slice(0, maxResults);
  } catch (error) {
    console.error(`[MultiStore] Search error for store ${storeId}:`, error);
    return [];
  }
}

// ============================================================
// CONTEXT BUILDER
// ============================================================

/**
 * Build RAG context from search results.
 * Used by the chat pipeline to provide relevant document context.
 */
export function buildContextFromResults(results: SearchResult[]): string {
  if (results.length === 0) {
    return "";
  }
  
  const contextParts: string[] = [];
  
  for (const result of results) {
    const source = result.metadata.meetingDate 
      ? `${result.documentName} (${result.metadata.meetingDate})`
      : result.documentName;
    
    contextParts.push(`--- Source: ${source} ---\n${result.snippet}\n`);
  }
  
  return contextParts.join("\n");
}

// ============================================================
// INITIALIZATION
// ============================================================

/**
 * Initialize the multi-store system.
 * Call this on server startup to register known stores.
 */
export async function initializeMultiStore(legacyStoreId?: string): Promise<void> {
  console.log("[MultiStore] Initializing...");
  
  // Register legacy store if provided
  if (legacyStoreId) {
    registerStore({
      id: legacyStoreId,
      name: "Statewide + Legacy",
      type: "legacy",
    });
  }
  
  // TODO: Load town stores from database
  // For now, stores are registered dynamically when created by s3Sync
  
  console.log(`[MultiStore] Initialized with ${storeRegistry.size} stores`);
}

export { storeRegistry };
