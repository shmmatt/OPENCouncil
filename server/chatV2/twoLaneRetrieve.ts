/**
 * Two-Lane Retrieval System
 * 
 * Implements parallel "local lane" + "statewide lane" retrieval using
 * the same Gemini File Search store. This reduces latency while ensuring
 * both town-specific and RSA/statewide context are retrieved upfront.
 * 
 * Key features:
 * - Parallel execution using Promise.all
 * - Query rewriting with domain-specific anchors
 * - Deduplication and merging of results
 * - Configurable chunk caps per lane
 */

import { GoogleGenAI } from "@google/genai";
import { getOrCreateFileSearchStoreId } from "../gemini-store";
import { logDebug, logError } from "../utils/logger";
import { logFileSearchRequest, logFileSearchResponse, extractGroundingInfoForLogging, extractRetrievalDocCount } from "../utils/fileSearchLogging";
import { logLlmRequest, logLlmResponse, logLlmError } from "../utils/llmLogging";
import { isQuotaError, GeminiQuotaExceededError } from "../utils/geminiErrors";
import { getModelForStage } from "../llm/modelRegistry";
import { chatConfig } from "./chatConfig";
import type { PipelineLogContext, ScopeHint } from "./types";

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY || "" });

/**
 * A retrieved chunk with lane labeling for citation purposes
 */
export interface LaneChunk {
  docId: string;
  title: string;
  content: string;
  lane: "local" | "state";
  score?: number;
  documentNames: string[];
}

/**
 * Input options for two-lane retrieval
 */
export interface TwoLaneRetrieveOptions {
  userQuestion: string;
  rerankedQuestion: string;
  townPreference?: string | null;
  domains?: string[];
  categories?: string[];
  preferRecent?: boolean;
  boards?: string[];
  scopeHint?: ScopeHint;
  logContext?: PipelineLogContext;
}

/**
 * Output from two-lane retrieval
 */
export interface TwoLaneRetrievalResult {
  localChunks: LaneChunk[];
  stateChunks: LaneChunk[];
  mergedTopChunks: LaneChunk[];
  debug: {
    localCount: number;
    stateCount: number;
    mergedCount: number;
    topLocalDocs: string[];
    topStateDocs: string[];
    localQueryUsed: string;
    stateQueryUsed: string;
    durationMs: number;
  };
}

/**
 * Anchors to add to statewide queries for better RSA/handbook retrieval
 */
const STATE_LANE_ANCHORS = [
  "New Hampshire RSA",
  "NH law",
  "administrative rules",
  "Right-to-Know",
  "NHMA",
  "AG guidance",
  "statewide handbook",
  "municipal law",
];

/**
 * Document type hints for local queries
 */
const LOCAL_DOC_TYPE_HINTS = [
  "minutes",
  "warrant",
  "ordinance",
  "town report",
  "budget",
  "selectboard",
  "planning board",
];

/**
 * Build the local lane query with town-biased context
 */
function buildLocalLaneQuery(
  question: string,
  townPreference?: string | null,
  boards?: string[],
  categories?: string[]
): string {
  let query = question;
  
  if (townPreference) {
    query = `${question} (Town of ${townPreference})`;
  }
  
  if (boards && boards.length > 0) {
    query += ` [Boards: ${boards.join(", ")}]`;
  }
  
  if (categories && categories.length > 0) {
    const catHints = categories.filter(c => 
      LOCAL_DOC_TYPE_HINTS.some(hint => c.toLowerCase().includes(hint.toLowerCase()))
    );
    if (catHints.length > 0) {
      query += ` [Document types: ${catHints.join(", ")}]`;
    }
  }
  
  return query;
}

/**
 * Build the state lane query with RSA/statewide anchors
 */
function buildStateLaneQuery(question: string): string {
  const anchors = STATE_LANE_ANCHORS.slice(0, 4).join(", ");
  return `${question} [Context: ${anchors}]. Focus on New Hampshire statewide laws, RSA statutes, NHMA guidance, and administrative rules. Ignore town-specific documents unless they explain statewide process.`;
}

/**
 * Execute a single lane retrieval using Gemini File Search
 */
async function executeLaneRetrieval(options: {
  query: string;
  storeId: string;
  lane: "local" | "state";
  maxResults: number;
  logContext?: PipelineLogContext;
}): Promise<{
  chunks: LaneChunk[];
  documentNames: string[];
  rawContent: string;
}> {
  const { query, storeId, lane, maxResults, logContext } = options;
  const { model: retrievalModel } = getModelForStage('complexSummary');
  
  const systemPrompt = lane === "local"
    ? `You are a document retrieval assistant. Extract relevant information from municipal documents. Focus on town-specific facts, decisions, votes, dates, amounts, and board actions. Be thorough and include specific details.`
    : `You are a document retrieval assistant. Extract relevant information about New Hampshire state laws, RSA statutes, administrative rules, and statewide municipal guidance. Focus on legal authority, definitions, processes, and mechanisms.`;
  
  const startTime = Date.now();
  
  logFileSearchRequest({
    requestId: logContext?.requestId,
    sessionId: logContext?.sessionId,
    stage: `twoLane_${lane}`,
    storeId,
    queryText: query,
    filters: { lane },
  });
  
  try {
    const response = await ai.models.generateContent({
      model: retrievalModel,
      contents: [{ role: "user", parts: [{ text: query }] }],
      config: {
        systemInstruction: systemPrompt,
        tools: [
          {
            fileSearch: {
              fileSearchStoreNames: [storeId],
            },
          } as any,
        ],
      },
    });
    
    const rawContent = response.text || "";
    const durationMs = Date.now() - startTime;
    const retrievalResult = extractRetrievalDocCount(response);
    const groundingInfo = extractGroundingInfoForLogging(response);
    
    logFileSearchResponse({
      requestId: logContext?.requestId,
      sessionId: logContext?.sessionId,
      stage: `twoLane_${lane}`,
      results: groundingInfo,
      responseText: rawContent.slice(0, 500),
      durationMs,
    });
    
    const chunks: LaneChunk[] = retrievalResult.documentNames.slice(0, maxResults).map((docName, idx) => ({
      docId: `${lane}_${idx}_${docName.slice(0, 20)}`,
      title: docName,
      content: rawContent,
      lane,
      score: 1 - (idx * 0.05),
      documentNames: [docName],
    }));
    
    return {
      chunks,
      documentNames: retrievalResult.documentNames,
      rawContent,
    };
  } catch (error) {
    if (isQuotaError(error)) {
      throw new GeminiQuotaExceededError(
        error instanceof Error ? error.message : "Gemini quota exceeded in two-lane retrieval"
      );
    }
    
    logLlmError({
      requestId: logContext?.requestId,
      sessionId: logContext?.sessionId,
      stage: `twoLane_${lane}`,
      model: retrievalModel,
      error: error instanceof Error ? error : new Error(String(error)),
    });
    
    return { chunks: [], documentNames: [], rawContent: "" };
  }
}

/**
 * Deduplicate chunks by document name, preferring higher-scored chunks
 */
function dedupeChunks(chunks: LaneChunk[]): LaneChunk[] {
  const seen = new Map<string, LaneChunk>();
  
  for (const chunk of chunks) {
    const key = chunk.title.toLowerCase().trim();
    const existing = seen.get(key);
    
    if (!existing || (chunk.score || 0) > (existing.score || 0)) {
      seen.set(key, chunk);
    }
  }
  
  return Array.from(seen.values());
}

/**
 * Merge and rank chunks from both lanes
 */
function mergeAndRankChunks(
  localChunks: LaneChunk[],
  stateChunks: LaneChunk[],
  questionHasRSAPattern: boolean
): LaneChunk[] {
  const localCap = chatConfig.LOCAL_CONTEXT_CAP || 10;
  const stateCap = chatConfig.STATE_CONTEXT_CAP || 5;
  const mergedCap = chatConfig.MERGED_CONTEXT_CAP || 15;
  
  const cappedLocal = localChunks.slice(0, localCap);
  const cappedState = stateChunks.slice(0, stateCap);
  
  let merged: LaneChunk[];
  
  if (questionHasRSAPattern) {
    merged = [...cappedState, ...cappedLocal];
  } else {
    merged = [...cappedLocal, ...cappedState];
  }
  
  const deduped = dedupeChunks(merged);
  
  return deduped.slice(0, mergedCap);
}

/**
 * Check if question has RSA/statewide pattern
 */
function hasRSAPattern(question: string): boolean {
  const patterns = [
    /\bRSA\b/i,
    /\bstatute\b/i,
    /\bstate\s+law\b/i,
    /\bNH\s+law\b/i,
    /\badministrative\s+rule\b/i,
    /\bRight[\s-]to[\s-]Know\b/i,
    /\bdefault\s+budget\b/i,
    /\bhow\s+is\s+.+\s+calculated\b/i,
    /\bwho\s+decides\b/i,
    /\bwhat\s+governs\b/i,
    /\blegal\s+requirement\b/i,
  ];
  
  return patterns.some(p => p.test(question));
}

/**
 * Main two-lane retrieval function
 * 
 * Executes local and statewide retrieval in parallel, then merges and dedupes results.
 * For most queries, this provides both town-specific facts and statewide context upfront.
 */
export async function twoLaneRetrieve(
  options: TwoLaneRetrieveOptions
): Promise<TwoLaneRetrievalResult> {
  const {
    userQuestion,
    rerankedQuestion,
    townPreference,
    domains,
    categories,
    preferRecent,
    boards,
    scopeHint,
    logContext,
  } = options;
  
  const startTime = Date.now();
  
  if (!chatConfig.ENABLE_PARALLEL_STATE_LANE) {
    logDebug("two_lane_disabled", {
      requestId: logContext?.requestId,
      sessionId: logContext?.sessionId,
      stage: "twoLaneRetrieve",
      reason: "ENABLE_PARALLEL_STATE_LANE is false",
    });
    
    return {
      localChunks: [],
      stateChunks: [],
      mergedTopChunks: [],
      debug: {
        localCount: 0,
        stateCount: 0,
        mergedCount: 0,
        topLocalDocs: [],
        topStateDocs: [],
        localQueryUsed: "",
        stateQueryUsed: "",
        durationMs: 0,
      },
    };
  }
  
  const storeId = await getOrCreateFileSearchStoreId();
  
  if (!storeId) {
    logError("two_lane_no_store", {
      requestId: logContext?.requestId,
      sessionId: logContext?.sessionId,
      stage: "twoLaneRetrieve",
      reason: "No file search store available",
    });
    
    return {
      localChunks: [],
      stateChunks: [],
      mergedTopChunks: [],
      debug: {
        localCount: 0,
        stateCount: 0,
        mergedCount: 0,
        topLocalDocs: [],
        topStateDocs: [],
        localQueryUsed: "",
        stateQueryUsed: "",
        durationMs: Date.now() - startTime,
      },
    };
  }
  
  const localQuery = buildLocalLaneQuery(rerankedQuestion, townPreference, boards, categories);
  const stateQuery = buildStateLaneQuery(rerankedQuestion);
  
  logDebug("two_lane_start", {
    requestId: logContext?.requestId,
    sessionId: logContext?.sessionId,
    stage: "twoLaneRetrieve",
    localQuery: localQuery.slice(0, 200),
    stateQuery: stateQuery.slice(0, 200),
    scopeHint,
    townPreference,
  });
  
  const localK = chatConfig.LOCAL_LANE_K || 12;
  const stateK = chatConfig.STATE_LANE_K || 8;
  
  const [localResult, stateResult] = await Promise.all([
    executeLaneRetrieval({
      query: localQuery,
      storeId,
      lane: "local",
      maxResults: localK,
      logContext,
    }),
    executeLaneRetrieval({
      query: stateQuery,
      storeId,
      lane: "state",
      maxResults: stateK,
      logContext,
    }),
  ]);
  
  const questionHasRSA = hasRSAPattern(userQuestion);
  const mergedChunks = mergeAndRankChunks(
    localResult.chunks,
    stateResult.chunks,
    questionHasRSA
  );
  
  const durationMs = Date.now() - startTime;
  
  logDebug("two_lane_complete", {
    requestId: logContext?.requestId,
    sessionId: logContext?.sessionId,
    stage: "twoLaneRetrieve",
    localCount: localResult.chunks.length,
    stateCount: stateResult.chunks.length,
    mergedCount: mergedChunks.length,
    durationMs,
    questionHasRSA,
  });
  
  return {
    localChunks: localResult.chunks,
    stateChunks: stateResult.chunks,
    mergedTopChunks: mergedChunks,
    debug: {
      localCount: localResult.chunks.length,
      stateCount: stateResult.chunks.length,
      mergedCount: mergedChunks.length,
      topLocalDocs: localResult.documentNames.slice(0, 5),
      topStateDocs: stateResult.documentNames.slice(0, 5),
      localQueryUsed: localQuery,
      stateQueryUsed: stateQuery,
      durationMs,
    },
  };
}

/**
 * Extract combined document names from two-lane result
 */
export function extractTwoLaneDocNames(result: TwoLaneRetrievalResult): string[] {
  const allNames: string[] = [];
  
  for (const chunk of result.localChunks) {
    allNames.push(...chunk.documentNames);
  }
  
  for (const chunk of result.stateChunks) {
    allNames.push(...chunk.documentNames);
  }
  
  return Array.from(new Set(allNames));
}

/**
 * Build combined snippet text from two-lane result for synthesis
 */
export function buildTwoLaneSnippetText(result: TwoLaneRetrievalResult): string {
  const sections: string[] = [];
  
  if (result.localChunks.length > 0 && result.localChunks[0].content) {
    sections.push(`=== LOCAL LANE (Town Documents) ===\n${result.localChunks[0].content}`);
  }
  
  if (result.stateChunks.length > 0 && result.stateChunks[0].content) {
    sections.push(`=== STATE LANE (NH RSA / Statewide Guidance) ===\n${result.stateChunks[0].content}`);
  }
  
  return sections.join("\n\n");
}

/**
 * Determine doc source type from two-lane results
 */
export function classifyTwoLaneDocSource(
  result: TwoLaneRetrievalResult,
  townHint?: string
): { type: "none" | "local" | "statewide" | "mixed"; town: string | null } {
  const hasLocal = result.localChunks.length > 0;
  const hasState = result.stateChunks.length > 0;
  
  if (!hasLocal && !hasState) {
    return { type: "none", town: null };
  }
  
  if (hasLocal && hasState) {
    return { type: "mixed", town: townHint || null };
  }
  
  if (hasLocal) {
    return { type: "local", town: townHint || null };
  }
  
  return { type: "statewide", town: null };
}
