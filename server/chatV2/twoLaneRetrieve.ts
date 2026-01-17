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
import { computeSituationMatchScore } from "./situationExtractor";
import type { PipelineLogContext, ScopeHint } from "./types";
import type { SituationContext, SessionSource } from "@shared/schema";

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY || "" });

/**
 * Issue map extracted from query + situation + session sources
 * Used for topic alignment scoring and query expansion
 */
export interface IssueMap {
  entities: string[];
  actions: string[];
  legalTopics: string[];
  boards: string[];
  propertyRef?: string;
  dateRefs: string[];
}

/**
 * Result from confidence/alignment scoring
 */
export interface RetrievalQualityScore {
  confidence: number;
  topicAlignment: number;
  driftDetected: boolean;
  driftedToEntities: string[];
  needsEscalation: boolean;
  escalationReason: string | null;
}

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
  situationContext?: SituationContext | null;
  sessionSources?: SessionSource[];
  logContext?: PipelineLogContext;
}

/**
 * Output from two-lane retrieval
 */
export interface TwoLaneRetrievalResult {
  localChunks: LaneChunk[];
  stateChunks: LaneChunk[];
  mergedTopChunks: LaneChunk[];
  archiveChunksFound: boolean;
  usedSecondPass: boolean;
  retrievalConfidence: number;
  topicAlignment: number;
  driftDetected: boolean;
  issueMap: IssueMap | null;
  debug: {
    localCount: number;
    stateCount: number;
    mergedCount: number;
    topLocalDocs: string[];
    topStateDocs: string[];
    localQueryUsed: string;
    stateQueryUsed: string;
    secondPassLocalQuery?: string;
    secondPassStateQuery?: string;
    durationMs: number;
    escalationReason?: string;
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
 * Board name patterns for extraction
 */
const BOARD_PATTERNS = [
  /\b(selectboard|selectmen|board\s+of\s+selectmen)\b/i,
  /\b(planning\s+board)\b/i,
  /\b(zoning\s+board|ZBA)\b/i,
  /\b(conservation\s+commission)\b/i,
  /\b(budget\s+committee)\b/i,
  /\b(school\s+board)\b/i,
  /\b(library\s+trustees?)\b/i,
  /\b(town\s+meeting)\b/i,
];

/**
 * Legal topic patterns for RSA/law extraction
 */
const LEGAL_TOPIC_PATTERNS = [
  { pattern: /\bRSA\s+\d+[:\-]\d+/gi, topic: "RSA statute" },
  { pattern: /\bRight[\s-]to[\s-]Know/gi, topic: "Right-to-Know law" },
  { pattern: /\bpublic\s+hearing/gi, topic: "public hearing requirements" },
  { pattern: /\bdefault\s+budget/gi, topic: "default budget" },
  { pattern: /\bwarrant\s+article/gi, topic: "warrant articles" },
  { pattern: /\bnotice\s+requirement/gi, topic: "notice requirements" },
  { pattern: /\bopen\s+meeting/gi, topic: "open meeting law" },
  { pattern: /\brecusal/gi, topic: "recusal/conflict of interest" },
  { pattern: /\bvote|voting/gi, topic: "voting procedures" },
  { pattern: /\bsit\s*-?\s*lien/gi, topic: "sit-lien" },
  { pattern: /\bvariance/gi, topic: "zoning variance" },
  { pattern: /\bsubdivision/gi, topic: "subdivision" },
  { pattern: /\bexemption/gi, topic: "tax exemption" },
];

/**
 * Extract issue map from question + situation + session sources
 * This identifies key entities, actions, legal topics, and boards
 */
export function extractIssueMap(
  question: string,
  situationContext?: SituationContext | null,
  sessionSources?: SessionSource[]
): IssueMap {
  const combinedText = [
    question,
    situationContext?.title || "",
    ...(situationContext?.entities || []),
    ...(sessionSources || []).map(s => s.text.slice(0, 2000)),
  ].join(" ");

  const entities: string[] = [];
  const actions: string[] = [];
  const legalTopics: string[] = [];
  const boards: string[] = [];
  const dateRefs: string[] = [];
  let propertyRef: string | undefined;

  if (situationContext?.entities) {
    entities.push(...situationContext.entities);
  }

  const propertyPatterns = [
    /\b(\d+)\s+([\w\s]+(?:road|street|lane|drive|avenue|way|place|court|circle|boulevard))\b/gi,
    /\bmap\s+\d+\s+lot\s+\d+/gi,
    /\btax\s+map\s+\d+/gi,
  ];
  for (const pattern of propertyPatterns) {
    const match = combinedText.match(pattern);
    if (match && !propertyRef) {
      propertyRef = match[0];
    }
  }

  for (const bp of BOARD_PATTERNS) {
    const match = combinedText.match(bp);
    if (match) {
      boards.push(match[0].toLowerCase());
    }
  }

  for (const lt of LEGAL_TOPIC_PATTERNS) {
    if (lt.pattern.test(combinedText)) {
      legalTopics.push(lt.topic);
    }
  }

  const actionPatterns = [
    /\b(approved|denied|tabled|continued|voted|granted|rejected)\b/gi,
    /\b(appeal|amend|reconsider|rehearing)\b/gi,
    /\b(apply|submit|request)\b/gi,
  ];
  for (const ap of actionPatterns) {
    const matches = combinedText.match(ap);
    if (matches) {
      actions.push(...matches.map(m => m.toLowerCase()));
    }
  }

  const datePatterns = [
    /\b(january|february|march|april|may|june|july|august|september|october|november|december)\s+\d{1,2},?\s*\d{4}\b/gi,
    /\b\d{1,2}\/\d{1,2}\/\d{2,4}\b/g,
  ];
  for (const dp of datePatterns) {
    const matches = combinedText.match(dp);
    if (matches) {
      dateRefs.push(...matches.slice(0, 3));
    }
  }

  return {
    entities: Array.from(new Set(entities)).slice(0, 10),
    actions: Array.from(new Set(actions)).slice(0, 5),
    legalTopics: Array.from(new Set(legalTopics)).slice(0, 5),
    boards: Array.from(new Set(boards)).slice(0, 4),
    propertyRef,
    dateRefs: Array.from(new Set(dateRefs)).slice(0, 3),
  };
}

/**
 * Compute retrieval confidence based on chunk scores and count
 * Returns 0-1 where 1 = high confidence
 */
export function computeRetrievalConfidence(
  chunks: LaneChunk[],
  issueMap: IssueMap
): number {
  if (chunks.length === 0) return 0;

  const avgScore = chunks.reduce((sum, c) => sum + (c.score || 0.3), 0) / chunks.length;
  
  const countFactor = Math.min(chunks.length / 5, 1.0);
  
  const hasKeyEntity = issueMap.entities.length > 0 
    ? chunks.some(c => 
        issueMap.entities.some(e => 
          c.content.toLowerCase().includes(e.toLowerCase()) ||
          c.title.toLowerCase().includes(e.toLowerCase())
        )
      )
    : true;
  
  const entityBonus = hasKeyEntity ? 0.1 : 0;
  
  return Math.min(1.0, (avgScore * 0.6) + (countFactor * 0.3) + entityBonus);
}

/**
 * Compute topic alignment between chunks and the issue map
 * Returns 0-1 where 1 = highly aligned
 */
export function computeTopicAlignment(
  chunks: LaneChunk[],
  issueMap: IssueMap
): number {
  if (chunks.length === 0) return 0;
  if (issueMap.entities.length === 0 && issueMap.legalTopics.length === 0) return 1.0;

  const alignmentScores = chunks.map(chunk => {
    const text = (chunk.title + " " + chunk.content).toLowerCase();
    
    let entityHits = 0;
    for (const entity of issueMap.entities) {
      if (text.includes(entity.toLowerCase())) {
        entityHits++;
      }
    }
    const entityScore = issueMap.entities.length > 0 
      ? entityHits / issueMap.entities.length 
      : 0.5;

    let topicHits = 0;
    for (const topic of issueMap.legalTopics) {
      if (text.includes(topic.toLowerCase())) {
        topicHits++;
      }
    }
    const topicScore = issueMap.legalTopics.length > 0 
      ? topicHits / issueMap.legalTopics.length 
      : 0.5;

    let boardHits = 0;
    for (const board of issueMap.boards) {
      if (text.includes(board.toLowerCase())) {
        boardHits++;
      }
    }
    const boardScore = issueMap.boards.length > 0 
      ? boardHits / issueMap.boards.length 
      : 0.5;

    return (entityScore * 0.5) + (topicScore * 0.3) + (boardScore * 0.2);
  });

  return alignmentScores.reduce((sum, s) => sum + s, 0) / alignmentScores.length;
}

/**
 * Detect drift in retrieved chunks (chunks about wrong entity/case)
 */
export function detectDriftInRetrieval(
  chunks: LaneChunk[],
  issueMap: IssueMap
): { hasDrift: boolean; driftedToEntities: string[] } {
  if (chunks.length === 0 || issueMap.entities.length === 0) {
    return { hasDrift: false, driftedToEntities: [] };
  }

  const expectedEntities = new Set(issueMap.entities.map(e => e.toLowerCase()));
  const foreignEntityCounts = new Map<string, number>();

  const genericEntityPattern = /\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)\s+(?:property|case|appeal|application|variance|subdivision)\b/g;

  for (const chunk of chunks) {
    const text = chunk.title + " " + chunk.content;
    let match;
    while ((match = genericEntityPattern.exec(text)) !== null) {
      const entity = match[1].toLowerCase();
      if (!expectedEntities.has(entity) && entity.length > 3) {
        foreignEntityCounts.set(entity, (foreignEntityCounts.get(entity) || 0) + 1);
      }
    }
  }

  const driftedEntities = Array.from(foreignEntityCounts.entries())
    .filter(([_, count]) => count >= 2)
    .map(([entity]) => entity);

  const hasDrift = driftedEntities.length > 0 && 
    driftedEntities.some(de => {
      const deCount = foreignEntityCounts.get(de) || 0;
      return deCount >= Math.ceil(chunks.length * 0.3);
    });

  return {
    hasDrift,
    driftedToEntities: driftedEntities,
  };
}

/**
 * Check if any high-stakes keywords are present in the question
 */
function hasHighStakesKeywords(question: string): boolean {
  return chatConfig.HIGH_STAKES_LEGAL_KEYWORDS.some((kw: string) => 
    question.toLowerCase().includes(kw.toLowerCase())
  );
}

/**
 * Evaluate whether retrieval quality requires escalation (second pass)
 */
export function evaluateRetrievalQuality(
  chunks: LaneChunk[],
  issueMap: IssueMap,
  question: string
): RetrievalQualityScore {
  const confidence = computeRetrievalConfidence(chunks, issueMap);
  const topicAlignment = computeTopicAlignment(chunks, issueMap);
  const driftResult = detectDriftInRetrieval(chunks, issueMap);

  const belowConfidenceThreshold = confidence < chatConfig.RETRIEVAL_CONFIDENCE_THRESHOLD;
  const belowAlignmentThreshold = topicAlignment < chatConfig.TOPIC_ALIGNMENT_THRESHOLD;
  const isHighStakes = hasHighStakesKeywords(question);

  let needsEscalation = false;
  let escalationReason: string | null = null;

  if (belowConfidenceThreshold) {
    needsEscalation = true;
    escalationReason = `Low confidence: ${confidence.toFixed(2)} < ${chatConfig.RETRIEVAL_CONFIDENCE_THRESHOLD}`;
  } else if (belowAlignmentThreshold) {
    needsEscalation = true;
    escalationReason = `Low topic alignment: ${topicAlignment.toFixed(2)} < ${chatConfig.TOPIC_ALIGNMENT_THRESHOLD}`;
  } else if (driftResult.hasDrift) {
    needsEscalation = true;
    escalationReason = `Drift detected to: ${driftResult.driftedToEntities.join(", ")}`;
  } else if (isHighStakes && confidence < 0.5) {
    needsEscalation = true;
    escalationReason = `High-stakes question with moderate confidence: ${confidence.toFixed(2)}`;
  }

  return {
    confidence,
    topicAlignment,
    driftDetected: driftResult.hasDrift,
    driftedToEntities: driftResult.driftedToEntities,
    needsEscalation,
    escalationReason,
  };
}

/**
 * Generate expanded queries for second-pass retrieval
 */
export function generateExpandedQueries(
  originalQuestion: string,
  issueMap: IssueMap,
  lane: "local" | "state",
  townPreference?: string | null
): string {
  const entityStr = issueMap.entities.slice(0, 3).join(", ");
  const boardStr = issueMap.boards.slice(0, 2).join(", ");
  const topicStr = issueMap.legalTopics.slice(0, 2).join(", ");

  if (lane === "local") {
    let query = originalQuestion;
    if (entityStr) {
      query += ` MUST include: ${entityStr}`;
    }
    if (boardStr) {
      query += ` Board: ${boardStr}`;
    }
    if (issueMap.propertyRef) {
      query += ` Property: ${issueMap.propertyRef}`;
    }
    if (townPreference) {
      query += ` (Town of ${townPreference})`;
    }
    if (issueMap.dateRefs.length > 0) {
      query += ` Date: ${issueMap.dateRefs[0]}`;
    }
    return query;
  } else {
    let query = originalQuestion;
    if (topicStr) {
      query += ` Legal topics: ${topicStr}`;
    }
    query += ` [Context: NH RSA, municipal law, NHMA guidance]`;
    if (issueMap.legalTopics.includes("Right-to-Know law")) {
      query += ` RSA 91-A`;
    }
    return query;
  }
}

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
 * Merge and rank chunks from both lanes with situation-aware re-ranking
 */
function mergeAndRankChunks(
  localChunks: LaneChunk[],
  stateChunks: LaneChunk[],
  questionHasRSAPattern: boolean,
  situationContext?: SituationContext | null
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
  
  if (!chatConfig.ENABLE_SITUATION_ANCHORING || !situationContext) {
    return deduped.slice(0, mergedCap);
  }
  
  const situationWeight = chatConfig.SITUATION_MATCH_WEIGHT || 0.3;
  const minOnTopicRatio = chatConfig.MIN_ON_TOPIC_CHUNK_RATIO || 0.4;
  
  const scoredChunks = deduped.map(chunk => {
    const baseScore = chunk.score || 0.5;
    const situationMatchScore = computeSituationMatchScore(
      chunk.title + " " + chunk.content,
      situationContext
    );
    const finalScore = baseScore + (situationWeight * situationMatchScore);
    
    return {
      ...chunk,
      score: finalScore,
      situationMatchScore,
    };
  });
  
  scoredChunks.sort((a, b) => (b.score || 0) - (a.score || 0));
  
  const onTopicChunks = scoredChunks.filter(c => (c.situationMatchScore || 0) > 0.2);
  const offTopicChunks = scoredChunks.filter(c => (c.situationMatchScore || 0) <= 0.2);
  
  if (onTopicChunks.length === 0) {
    return scoredChunks.slice(0, mergedCap);
  }
  
  const minOnTopicCount = Math.ceil(mergedCap * minOnTopicRatio);
  const guaranteedOnTopic = onTopicChunks.slice(0, Math.min(minOnTopicCount, onTopicChunks.length));
  const remainingSlots = mergedCap - guaranteedOnTopic.length;
  
  const remainingOnTopic = onTopicChunks.slice(guaranteedOnTopic.length);
  const remaining = [...remainingOnTopic, ...offTopicChunks]
    .sort((a, b) => (b.score || 0) - (a.score || 0))
    .slice(0, remainingSlots);
  
  const finalChunks = [...guaranteedOnTopic, ...remaining];
  
  return finalChunks.map(({ situationMatchScore, ...chunk }) => chunk);
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
 * 
 * Adaptive multi-hop retrieval: If first pass has low confidence/alignment or drift,
 * automatically generates expanded queries and runs a second pass.
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
    situationContext,
    sessionSources,
    logContext,
  } = options;
  
  const startTime = Date.now();
  
  const emptyResult: TwoLaneRetrievalResult = {
    localChunks: [],
    stateChunks: [],
    mergedTopChunks: [],
    archiveChunksFound: false,
    usedSecondPass: false,
    retrievalConfidence: 0,
    topicAlignment: 0,
    driftDetected: false,
    issueMap: null,
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
  
  if (!chatConfig.ENABLE_PARALLEL_STATE_LANE) {
    logDebug("two_lane_disabled", {
      requestId: logContext?.requestId,
      sessionId: logContext?.sessionId,
      stage: "twoLaneRetrieve",
      reason: "ENABLE_PARALLEL_STATE_LANE is false",
    });
    
    return emptyResult;
  }
  
  const storeId = await getOrCreateFileSearchStoreId();
  
  if (!storeId) {
    logError("two_lane_no_store", {
      requestId: logContext?.requestId,
      sessionId: logContext?.sessionId,
      stage: "twoLaneRetrieve",
      reason: "No file search store available",
    });
    
    return { ...emptyResult, debug: { ...emptyResult.debug, durationMs: Date.now() - startTime } };
  }
  
  const issueMap = extractIssueMap(userQuestion, situationContext, sessionSources);
  
  logDebug("two_lane_issue_map_extracted", {
    requestId: logContext?.requestId,
    sessionId: logContext?.sessionId,
    stage: "twoLaneRetrieve",
    entityCount: issueMap.entities.length,
    legalTopicCount: issueMap.legalTopics.length,
    boardCount: issueMap.boards.length,
    propertyRef: issueMap.propertyRef,
  });
  
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
    hasSessionSources: (sessionSources || []).length > 0,
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
  let mergedChunks = mergeAndRankChunks(
    localResult.chunks,
    stateResult.chunks,
    questionHasRSA,
    situationContext
  );
  
  const qualityScore = evaluateRetrievalQuality(mergedChunks, issueMap, userQuestion);
  
  logDebug("two_lane_quality_evaluation", {
    requestId: logContext?.requestId,
    sessionId: logContext?.sessionId,
    stage: "twoLaneRetrieve",
    confidence: qualityScore.confidence,
    topicAlignment: qualityScore.topicAlignment,
    driftDetected: qualityScore.driftDetected,
    driftedToEntities: qualityScore.driftedToEntities,
    needsEscalation: qualityScore.needsEscalation,
    escalationReason: qualityScore.escalationReason,
  });
  
  let usedSecondPass = false;
  let secondPassLocalQuery: string | undefined;
  let secondPassStateQuery: string | undefined;
  
  if (qualityScore.needsEscalation && chatConfig.ENABLE_SECOND_PASS_RETRIEVAL) {
    logDebug("two_lane_second_pass_triggered", {
      requestId: logContext?.requestId,
      sessionId: logContext?.sessionId,
      stage: "twoLaneRetrieve",
      reason: qualityScore.escalationReason,
    });
    
    secondPassLocalQuery = generateExpandedQueries(userQuestion, issueMap, "local", townPreference);
    secondPassStateQuery = generateExpandedQueries(userQuestion, issueMap, "state", townPreference);
    
    const secondPassLocalK = chatConfig.SECOND_PASS_LOCAL_LANE_K || 8;
    const secondPassStateK = chatConfig.SECOND_PASS_STATE_LANE_K || 6;
    
    const [secondLocalResult, secondStateResult] = await Promise.all([
      executeLaneRetrieval({
        query: secondPassLocalQuery,
        storeId,
        lane: "local",
        maxResults: secondPassLocalK,
        logContext,
      }),
      executeLaneRetrieval({
        query: secondPassStateQuery,
        storeId,
        lane: "state",
        maxResults: secondPassStateK,
        logContext,
      }),
    ]);
    
    const combinedLocal = [...localResult.chunks, ...secondLocalResult.chunks];
    const combinedState = [...stateResult.chunks, ...secondStateResult.chunks];
    
    mergedChunks = mergeAndRankChunks(
      combinedLocal,
      combinedState,
      questionHasRSA,
      situationContext
    );
    
    usedSecondPass = true;
    
    logDebug("two_lane_second_pass_complete", {
      requestId: logContext?.requestId,
      sessionId: logContext?.sessionId,
      stage: "twoLaneRetrieve",
      originalMergedCount: localResult.chunks.length + stateResult.chunks.length,
      newMergedCount: mergedChunks.length,
      secondPassLocalCount: secondLocalResult.chunks.length,
      secondPassStateCount: secondStateResult.chunks.length,
    });
  }
  
  if (situationContext && chatConfig.ENABLE_SITUATION_ANCHORING) {
    logDebug("two_lane_situation_applied", {
      requestId: logContext?.requestId,
      sessionId: logContext?.sessionId,
      stage: "twoLaneRetrieve",
      situationTitle: situationContext.title,
      entityCount: situationContext.entities.length,
    });
  }
  
  const durationMs = Date.now() - startTime;
  const archiveChunksFound = localResult.chunks.length > 0 || stateResult.chunks.length > 0;
  
  logDebug("two_lane_complete", {
    requestId: logContext?.requestId,
    sessionId: logContext?.sessionId,
    stage: "twoLaneRetrieve",
    localCount: localResult.chunks.length,
    stateCount: stateResult.chunks.length,
    mergedCount: mergedChunks.length,
    durationMs,
    questionHasRSA,
    usedSecondPass,
    archiveChunksFound,
    retrievalConfidence: qualityScore.confidence,
    topicAlignment: qualityScore.topicAlignment,
  });
  
  return {
    localChunks: localResult.chunks,
    stateChunks: stateResult.chunks,
    mergedTopChunks: mergedChunks,
    archiveChunksFound,
    usedSecondPass,
    retrievalConfidence: qualityScore.confidence,
    topicAlignment: qualityScore.topicAlignment,
    driftDetected: qualityScore.driftDetected,
    issueMap,
    debug: {
      localCount: localResult.chunks.length,
      stateCount: stateResult.chunks.length,
      mergedCount: mergedChunks.length,
      topLocalDocs: localResult.documentNames.slice(0, 5),
      topStateDocs: stateResult.documentNames.slice(0, 5),
      localQueryUsed: localQuery,
      stateQueryUsed: stateQuery,
      secondPassLocalQuery,
      secondPassStateQuery,
      durationMs,
      escalationReason: qualityScore.escalationReason || undefined,
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
