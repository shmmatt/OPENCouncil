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
 * Keywords that indicate legal/liability/compliance context
 */
const LEGAL_SALIENCE_KEYWORDS = [
  "liability",
  "negligence",
  "lawsuit",
  "illegal",
  "RSA",
  "ADA",
  "compliance",
  "damages",
  "immunity",
  "permit",
  "building code",
  "DOJ",
  "Public Integrity",
  "Right to Know",
  "injunction",
  "federal",
  "civil action",
  "violation",
  "enforcement",
  "legal",
  "statute",
  "ordinance violation",
  "certificate of occupancy",
  "governmental immunity",
  "municipal liability",
];

/**
 * Patterns that indicate the user is asking for legal/liability context
 */
const LEGAL_SALIENCE_PATTERNS = [
  /\bcan\s+they\b/i,
  /\bis\s+this\s+allowed\b/i,
  /\bwhat\s+law\b/i,
  /\bwhat\s+happens\s+if\b/i,
  /\bis\s+it\s+legal\b/i,
  /\bis\s+this\s+legal\b/i,
  /\bare\s+they\s+liable\b/i,
  /\bam\s+i\s+liable\b/i,
  /\bwho\s+is\s+liable\b/i,
  /\bwhat\s+are\s+the\s+requirements\b/i,
  /\bwhat\s+does\s+the\s+law\s+say\b/i,
  /\bwhat\s+does\s+RSA\b/i,
  /\bunder\s+what\s+authority\b/i,
  /\bwhat\s+legal\b/i,
];

/**
 * Compute legal salience score for a text (0..1)
 * Higher scores indicate the question involves legal/liability/compliance topics
 */
export function computeLegalSalience(text: string): number {
  const lowerText = text.toLowerCase();
  
  // Count keyword matches
  let keywordMatches = 0;
  for (const keyword of LEGAL_SALIENCE_KEYWORDS) {
    if (lowerText.includes(keyword.toLowerCase())) {
      keywordMatches++;
    }
  }
  
  // Check pattern matches
  let patternMatches = 0;
  for (const pattern of LEGAL_SALIENCE_PATTERNS) {
    if (pattern.test(text)) {
      patternMatches++;
    }
  }
  
  // Compute salience score
  // - Each keyword match contributes 0.1, capped at 0.6
  // - Each pattern match contributes 0.15, capped at 0.45
  // - Combined max is 1.0
  const keywordScore = Math.min(keywordMatches * 0.1, 0.6);
  const patternScore = Math.min(patternMatches * 0.15, 0.45);
  
  return Math.min(keywordScore + patternScore, 1.0);
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
  legalSalience: number;
  debug: {
    localCount: number;
    stateCount: number;
    mergedCount: number;
    mergedLocalCount: number;
    mergedStateCount: number;
    topLocalDocs: string[];
    topStateDocs: string[];
    localQueryUsed: string;
    stateQueryUsed: string;
    secondPassLocalQuery?: string;
    secondPassStateQuery?: string;
    durationMs: number;
    escalationReason?: string;
    legalSalience?: number;
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
 * Deduplicate chunks by document name/title (stricter version)
 * Used for counting distinct documents before early exit decision
 */
function dedupeChunksByDocument(chunks: LaneChunk[]): LaneChunk[] {
  const seen = new Map<string, LaneChunk>();
  
  for (const chunk of chunks) {
    // Normalize title for comparison
    const normalizedTitle = chunk.title.toLowerCase().trim()
      .replace(/\s+/g, ' ')
      .replace(/[^\w\s]/g, '');
    
    const existing = seen.get(normalizedTitle);
    
    if (!existing || (chunk.score || 0) > (existing.score || 0)) {
      seen.set(normalizedTitle, chunk);
    }
  }
  
  return Array.from(seen.values());
}

/**
 * Detect authoritative state content by checking for RSA patterns and official sources
 */
function detectAuthoritativeStateContent(stateChunks: LaneChunk[]): boolean {
  const RSA_PATTERN = /\bRSA\s+\d+/i;
  const NHMA_PATTERN = /\b(NHMA|Municipal\s+Association)\b/i;
  const OFFICIAL_PATTERNS = [
    /\bDepartment\b/i,
    /\bDOJ\b/i,
    /\bNHDES\b/i,
    /\bNH\s+Secretary\s+of\s+State\b/i,
    /\bAttorney\s+General\b/i,
  ];

  for (const chunk of stateChunks) {
    const combinedText = (chunk.title + ' ' + chunk.content);
    
    if (RSA_PATTERN.test(combinedText)) {
      return true;
    }
    
    if (NHMA_PATTERN.test(combinedText)) {
      return true;
    }
    
    for (const pattern of OFFICIAL_PATTERNS) {
      if (pattern.test(chunk.title)) {
        return true;
      }
    }
  }
  
  return false;
}

/**
 * Quick computation of legal topic coverage for early exit decisions
 */
function computeQuickTopicCoverage(stateChunks: LaneChunk[], legalTopics: string[]): number {
  if (legalTopics.length === 0) return 1.0;
  if (stateChunks.length === 0) return 0;

  const chunkText = stateChunks.map(c => (c.title + ' ' + c.content).toLowerCase()).join(' ');
  let covered = 0;

  for (const topic of legalTopics) {
    if (chunkText.includes(topic.toLowerCase())) {
      covered++;
    }
  }

  return covered / legalTopics.length;
}

/**
 * Merge and rank chunks from both lanes with situation-aware re-ranking
 * and legal salience-based state chunk guarantees
 */
function mergeAndRankChunks(
  localChunks: LaneChunk[],
  stateChunks: LaneChunk[],
  questionHasRSAPattern: boolean,
  situationContext: SituationContext | null | undefined,
  legalSalience: number,
  dynamicStateCap: number
): LaneChunk[] {
  const localCap = chatConfig.LOCAL_CONTEXT_CAP || 10;
  const stateCap = dynamicStateCap;
  const mergedCap = chatConfig.MERGED_CONTEXT_CAP || 15;
  
  const cappedLocal = localChunks.slice(0, localCap);
  const cappedState = stateChunks.slice(0, stateCap);
  
  // Apply legal salience boost to state chunks
  const stateLaneBonus = legalSalience * 0.12;
  const boostedStateChunks = cappedState.map(chunk => ({
    ...chunk,
    score: (chunk.score || 0.5) + stateLaneBonus,
  }));
  
  // Initial merge order based on RSA pattern
  let merged: LaneChunk[];
  if (questionHasRSAPattern) {
    merged = [...boostedStateChunks, ...cappedLocal];
  } else {
    merged = [...cappedLocal, ...boostedStateChunks];
  }
  
  const deduped = dedupeChunks(merged);
  
  // Separate local and state candidates after deduplication
  const localCandidates = deduped.filter(c => c.lane === "local");
  const stateCandidates = deduped.filter(c => c.lane === "state");
  
  // Determine minimum state chunks to guarantee when legal salience is high
  // minState = 3 if salience >= 0.5 and at least 3 state chunks exist
  const minStateRequired = legalSalience >= 0.5 
    ? Math.min(3, stateCandidates.length) 
    : 0;
  
  // Apply situation anchoring scoring if enabled
  if (chatConfig.ENABLE_SITUATION_ANCHORING && situationContext) {
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
    
    // Bucketed selection with legal salience guarantee
    const scoredLocalCandidates = scoredChunks.filter(c => c.lane === "local");
    const scoredStateCandidates = scoredChunks.filter(c => c.lane === "state");
    
    // Guarantee minimum state chunks first
    const guaranteedState = scoredStateCandidates.slice(0, minStateRequired);
    let remainingSlots = mergedCap - guaranteedState.length;
    
    // Apply on-topic ratio to remaining slots
    const onTopicChunks = scoredChunks.filter(c => 
      (c.situationMatchScore || 0) > 0.2 && 
      !guaranteedState.some(gs => gs.docId === c.docId)
    );
    const offTopicChunks = scoredChunks.filter(c => 
      (c.situationMatchScore || 0) <= 0.2 &&
      !guaranteedState.some(gs => gs.docId === c.docId)
    );
    
    if (onTopicChunks.length > 0) {
      const minOnTopicCount = Math.ceil(remainingSlots * minOnTopicRatio);
      const guaranteedOnTopic = onTopicChunks.slice(0, Math.min(minOnTopicCount, onTopicChunks.length));
      remainingSlots = remainingSlots - guaranteedOnTopic.length;
      
      const remainingOnTopic = onTopicChunks.slice(guaranteedOnTopic.length);
      const remaining = [...remainingOnTopic, ...offTopicChunks]
        .sort((a, b) => (b.score || 0) - (a.score || 0))
        .slice(0, remainingSlots);
      
      const finalChunks = [...guaranteedState, ...guaranteedOnTopic, ...remaining];
      return finalChunks.map(({ situationMatchScore, ...chunk }) => chunk);
    } else {
      // No on-topic chunks, fill remaining slots by score
      const remaining = scoredChunks
        .filter(c => !guaranteedState.some(gs => gs.docId === c.docId))
        .slice(0, remainingSlots);
      
      const finalChunks = [...guaranteedState, ...remaining];
      return finalChunks.map(({ situationMatchScore, ...chunk }) => chunk);
    }
  }
  
  // No situation context - apply bucketed selection with legal salience guarantee
  if (minStateRequired > 0) {
    // Guarantee minimum state chunks
    const guaranteedState = stateCandidates
      .sort((a, b) => (b.score || 0) - (a.score || 0))
      .slice(0, minStateRequired);
    
    const remainingSlots = mergedCap - guaranteedState.length;
    
    // Fill remaining slots from all candidates by score
    const allSorted = deduped
      .filter(c => !guaranteedState.some(gs => gs.docId === c.docId))
      .sort((a, b) => (b.score || 0) - (a.score || 0))
      .slice(0, remainingSlots);
    
    return [...guaranteedState, ...allSorted];
  }
  
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
    legalSalience: 0,
    debug: {
      localCount: 0,
      stateCount: 0,
      mergedCount: 0,
      mergedLocalCount: 0,
      mergedStateCount: 0,
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
  
  // Compute legal salience from user question + situation title
  const salienceText = userQuestion + (situationContext?.title || "");
  const legalSalience = computeLegalSalience(salienceText);
  
  // Dynamic K/caps based on legal salience
  // When salience is high (>= 0.5), increase state lane retrieval
  const localK = chatConfig.LOCAL_LANE_K || 12;
  const baseStateK = chatConfig.STATE_LANE_K || 8;
  const stateK = legalSalience >= 0.5 ? Math.min(baseStateK + 4, 14) : baseStateK;
  
  const baseStateCap = chatConfig.STATE_CONTEXT_CAP || 5;
  const dynamicStateCap = legalSalience >= 0.5 ? Math.min(baseStateCap + 2, 8) : baseStateCap;
  
  logDebug("two_lane_start", {
    requestId: logContext?.requestId,
    sessionId: logContext?.sessionId,
    stage: "twoLaneRetrieve",
    localQuery: localQuery.slice(0, 200),
    stateQuery: stateQuery.slice(0, 200),
    scopeHint,
    townPreference,
    hasSessionSources: (sessionSources || []).length > 0,
    legalSalience,
    stateK,
    dynamicStateCap,
  });
  
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
    situationContext,
    legalSalience,
    dynamicStateCap
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
      situationContext,
      legalSalience,
      dynamicStateCap
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
  
  // Count merged chunks by lane
  const mergedLocalCount = mergedChunks.filter(c => c.lane === "local").length;
  const mergedStateCount = mergedChunks.filter(c => c.lane === "state").length;
  
  logDebug("two_lane_complete", {
    requestId: logContext?.requestId,
    sessionId: logContext?.sessionId,
    stage: "twoLaneRetrieve",
    localCount: localResult.chunks.length,
    stateCount: stateResult.chunks.length,
    mergedCount: mergedChunks.length,
    mergedLocalCount,
    mergedStateCount,
    durationMs,
    questionHasRSA,
    usedSecondPass,
    archiveChunksFound,
    retrievalConfidence: qualityScore.confidence,
    topicAlignment: qualityScore.topicAlignment,
    legalSalience,
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
    legalSalience,
    debug: {
      localCount: localResult.chunks.length,
      stateCount: stateResult.chunks.length,
      mergedCount: mergedChunks.length,
      mergedLocalCount,
      mergedStateCount,
      topLocalDocs: localResult.documentNames.slice(0, 5),
      topStateDocs: stateResult.documentNames.slice(0, 5),
      localQueryUsed: localQuery,
      stateQueryUsed: stateQuery,
      secondPassLocalQuery,
      secondPassStateQuery,
      durationMs,
      escalationReason: qualityScore.escalationReason || undefined,
      legalSalience,
    },
  };
}

// =====================================================
// V3 MULTI-QUERY RETRIEVAL
// =====================================================

import { chatConfigV3 } from "./chatConfigV3";
import type { RetrievalPlanV3, LabeledChunk, ChunkAuthority, IssueMap as IssueMapV3 } from "./types";

/**
 * V3 Multi-Query Retrieval Result
 */
export interface V3RetrievalResult {
  localChunks: LabeledChunk[];
  stateChunks: LabeledChunk[];
  allDocumentNames: string[];
  localCount: number;
  stateCount: number;
  situationAlignment: number;
  legalTopicCoverage: number;
  authoritativeStatePresent: boolean;
  distinctStateDocs: number;
  distinctLocalDocs: number;
  debug: {
    localQueriesUsed: string[];
    stateQueriesUsed: string[];
    localRetrievedTotal: number;
    stateRetrievedTotal: number;
    earlyExitTriggered: boolean;
    earlyExitReason?: string;
    durationMs: number;
    legalSalience?: number;
  };
}

/**
 * Execute multi-query retrieval using V3 plan
 * Runs multiple queries per lane in parallel with early-exit optimization
 */
export async function twoLaneRetrieveWithPlan(
  plan: RetrievalPlanV3,
  issueMap: IssueMapV3,
  options: {
    townPreference?: string | null;
    situationContext?: SituationContext | null;
    logContext?: PipelineLogContext;
  }
): Promise<V3RetrievalResult> {
  const { townPreference, situationContext, logContext } = options;
  const startTime = Date.now();

  const storeId = await getOrCreateFileSearchStoreId();

  let localQueriesUsed: string[] = [];
  let stateQueriesUsed: string[] = [];
  let localRetrievedTotal = 0;
  let stateRetrievedTotal = 0;
  let earlyExitTriggered = false;

  const allLocalChunks: LaneChunk[] = [];
  const allStateChunks: LaneChunk[] = [];

  const localQueries = plan.local.queries.slice(0, chatConfigV3.MAX_QUERIES_PER_LANE);
  const stateQueries = plan.state.queries.slice(0, chatConfigV3.MAX_QUERIES_PER_LANE);

  const executeLocalQuery = async (query: string, idx: number) => {
    const result = await executeLaneRetrieval({
      query,
      storeId,
      lane: "local",
      maxResults: plan.local.k,
      logContext,
    });
    return { query, idx, result };
  };

  const executeStateQuery = async (query: string, idx: number) => {
    const result = await executeLaneRetrieval({
      query,
      storeId,
      lane: "state",
      maxResults: plan.state.k,
      logContext,
    });
    return { query, idx, result };
  };

  const firstBatchLocal = localQueries.slice(0, 2);
  const firstBatchState = stateQueries.slice(0, 2);

  const firstBatchPromises = [
    ...firstBatchLocal.map((q, i) => executeLocalQuery(q, i)),
    ...firstBatchState.map((q, i) => executeStateQuery(q, i)),
  ];

  const firstBatchResults = await Promise.all(firstBatchPromises);

  for (const result of firstBatchResults) {
    if (result.result.chunks.length > 0) {
      if (result.result.chunks[0].lane === "local") {
        allLocalChunks.push(...result.result.chunks);
        localQueriesUsed.push(result.query);
        localRetrievedTotal += result.result.chunks.length;
      } else {
        allStateChunks.push(...result.result.chunks);
        stateQueriesUsed.push(result.query);
        stateRetrievedTotal += result.result.chunks.length;
      }
    }
  }

  // Dedupe by document name/title before counting
  const dedupedLocalFirst = dedupeChunksByDocument(allLocalChunks);
  const dedupedStateFirst = dedupeChunksByDocument(allStateChunks);
  
  // Count distinct documents for coverage assessment
  const distinctStateDocs = new Set(dedupedStateFirst.map(c => c.title.toLowerCase().trim())).size;
  const distinctLocalDocs = new Set(dedupedLocalFirst.map(c => c.title.toLowerCase().trim())).size;
  
  // Check for authoritative state content in first batch
  const authoritativeStatePresent = detectAuthoritativeStateContent(dedupedStateFirst);
  
  const totalGoodChunks = dedupedLocalFirst.length + dedupedStateFirst.length;
  
  // Compute legal salience from issue map
  const legalSalience = issueMap.legalSalience || 0;
  
  // NEW EARLY EXIT LOGIC: 
  // For legal questions (legalSalience >= 0.6), require better state coverage before exit
  const meetsBasicThreshold = totalGoodChunks >= chatConfigV3.EARLY_EXIT_MIN_CHUNKS;
  const minStateForLegal = 4;
  const minLegalTopicCoverage = 0.5;
  
  // Compute quick legal topic coverage for exit decision
  const quickLegalTopicCoverage = computeQuickTopicCoverage(dedupedStateFirst, issueMap.legalTopics);
  
  let canEarlyExit = false;
  let earlyExitReason = '';
  
  if (chatConfigV3.ENABLE_EARLY_EXIT && meetsBasicThreshold) {
    if (legalSalience >= 0.6) {
      // For legal questions, require state coverage + authority
      const hasStateCoverage = 
        (distinctStateDocs >= 2 || authoritativeStatePresent) &&
        dedupedStateFirst.length >= minStateForLegal &&
        quickLegalTopicCoverage >= minLegalTopicCoverage;
      
      if (hasStateCoverage) {
        canEarlyExit = true;
        earlyExitReason = `Legal question with good state coverage: ${distinctStateDocs} distinct docs, authority=${authoritativeStatePresent}`;
      } else {
        earlyExitReason = `Legal question needs more state coverage: ${distinctStateDocs} distinct docs, ${dedupedStateFirst.length} chunks, coverage=${quickLegalTopicCoverage.toFixed(2)}`;
      }
    } else {
      // For non-legal questions, basic chunk count is sufficient
      canEarlyExit = true;
      earlyExitReason = `Non-legal question with sufficient chunks: ${totalGoodChunks}`;
    }
  }
  
  if (canEarlyExit) {
    earlyExitTriggered = true;
    logDebug("v3_retrieval_early_exit", {
      requestId: logContext?.requestId,
      sessionId: logContext?.sessionId,
      stage: "v3_retrieval",
      reason: earlyExitReason,
      localCount: dedupedLocalFirst.length,
      stateCount: dedupedStateFirst.length,
      distinctStateDocs,
      authoritativeStatePresent,
      legalSalience,
    });
  } else {
    const remainingLocalQueries = localQueries.slice(2);
    const remainingStateQueries = stateQueries.slice(2);

    if (remainingLocalQueries.length > 0 || remainingStateQueries.length > 0) {
      const remainingPromises = [
        ...remainingLocalQueries.map((q, i) => executeLocalQuery(q, i + 2)),
        ...remainingStateQueries.map((q, i) => executeStateQuery(q, i + 2)),
      ];

      const remainingResults = await Promise.all(remainingPromises);

      for (const result of remainingResults) {
        if (result.result.chunks.length > 0) {
          if (result.result.chunks[0].lane === "local") {
            allLocalChunks.push(...result.result.chunks);
            localQueriesUsed.push(result.query);
            localRetrievedTotal += result.result.chunks.length;
          } else {
            allStateChunks.push(...result.result.chunks);
            stateQueriesUsed.push(result.query);
            stateRetrievedTotal += result.result.chunks.length;
          }
        }
      }
    }
  }

  // Use document-level deduplication for final selection
  const dedupedLocal = dedupeChunksByDocument(allLocalChunks);
  const dedupedState = dedupeChunksByDocument(allStateChunks);

  const rankedLocal = rankChunksWithSituationContext(dedupedLocal, situationContext);
  const rankedState = rankChunksWithSituationContext(dedupedState, situationContext);

  const minState = plan.mustInclude.minState || 0;
  const minLocalFacts = plan.mustInclude.minLocalFacts || 0;

  const selectedState = selectWithMinimum(rankedState, plan.state.cap, minState, issueMap.legalTopics);
  const selectedLocal = selectWithMinimum(rankedLocal, plan.local.cap, minLocalFacts, []);

  // Use robust authority classification that checks content
  const labeledLocalChunks: LabeledChunk[] = selectedLocal.map((chunk, idx) => ({
    label: `[L${idx + 1}]`,
    title: chunk.title,
    content: chunk.content,
    lane: "local" as const,
    authority: classifyAuthorityRobust(chunk.title, chunk.content, "local"),
  }));

  const labeledStateChunks: LabeledChunk[] = selectedState.map((chunk, idx) => ({
    label: `[S${idx + 1}]`,
    title: chunk.title,
    content: chunk.content,
    lane: "state" as const,
    authority: classifyAuthorityRobust(chunk.title, chunk.content, "state"),
  }));

  const situationAlignment = computeAverageSituationAlignment(
    [...selectedLocal, ...selectedState],
    situationContext
  );

  const legalTopicCoverageFinal = computeLegalTopicCoverageFromChunks(
    labeledStateChunks,
    issueMap.legalTopics
  );

  // Use robust authority detection that checks content
  const authoritativeStatePresentFinal = detectAuthoritativeStateContent(selectedState);

  // Count distinct documents in final selection
  const finalDistinctStateDocs = new Set(labeledStateChunks.map(c => c.title.toLowerCase().trim())).size;
  const finalDistinctLocalDocs = new Set(labeledLocalChunks.map(c => c.title.toLowerCase().trim())).size;

  const allDocumentNames = Array.from(new Set([
    ...selectedLocal.flatMap(c => c.documentNames),
    ...selectedState.flatMap(c => c.documentNames),
  ]));

  const durationMs = Date.now() - startTime;

  logDebug("v3_retrieval_complete", {
    requestId: logContext?.requestId,
    sessionId: logContext?.sessionId,
    stage: "v3_retrieval",
    localQueriesUsed: localQueriesUsed.length,
    stateQueriesUsed: stateQueriesUsed.length,
    localSelected: labeledLocalChunks.length,
    stateSelected: labeledStateChunks.length,
    distinctStateDocs: finalDistinctStateDocs,
    distinctLocalDocs: finalDistinctLocalDocs,
    situationAlignment,
    legalTopicCoverage: legalTopicCoverageFinal,
    authoritativeStatePresent: authoritativeStatePresentFinal,
    earlyExitTriggered,
    earlyExitReason,
    legalSalience,
    durationMs,
  });

  return {
    localChunks: labeledLocalChunks,
    stateChunks: labeledStateChunks,
    allDocumentNames,
    localCount: labeledLocalChunks.length,
    stateCount: labeledStateChunks.length,
    situationAlignment,
    legalTopicCoverage: legalTopicCoverageFinal,
    authoritativeStatePresent: authoritativeStatePresentFinal,
    distinctStateDocs: finalDistinctStateDocs,
    distinctLocalDocs: finalDistinctLocalDocs,
    debug: {
      localQueriesUsed,
      stateQueriesUsed,
      localRetrievedTotal,
      stateRetrievedTotal,
      earlyExitTriggered,
      earlyExitReason: earlyExitReason || undefined,
      durationMs,
      legalSalience,
    },
  };
}

function rankChunksWithSituationContext(
  chunks: LaneChunk[],
  situationContext: SituationContext | null | undefined
): LaneChunk[] {
  if (!situationContext) {
    return chunks.sort((a, b) => (b.score || 0) - (a.score || 0));
  }

  const scored = chunks.map(chunk => {
    const baseScore = chunk.score || 0.5;
    const situationMatch = computeSituationMatchScore(
      chunk.title + " " + chunk.content,
      situationContext
    );
    return {
      ...chunk,
      score: baseScore + (situationMatch * 0.3),
    };
  });

  return scored.sort((a, b) => (b.score || 0) - (a.score || 0));
}

function selectWithMinimum(
  rankedChunks: LaneChunk[],
  cap: number,
  minimum: number,
  relevanceKeywords: string[]
): LaneChunk[] {
  if (rankedChunks.length === 0) return [];

  if (minimum <= 0) {
    return rankedChunks.slice(0, cap);
  }

  const guaranteedCount = Math.min(minimum, rankedChunks.length);
  
  if (relevanceKeywords.length > 0) {
    const relevant = rankedChunks.filter(chunk => {
      const lowerContent = (chunk.title + " " + chunk.content).toLowerCase();
      return relevanceKeywords.some(kw => lowerContent.includes(kw.toLowerCase())) ||
             chatConfigV3.STATE_RELEVANCE_BAR_KEYWORDS.some(kw => lowerContent.includes(kw.toLowerCase()));
    });

    if (relevant.length >= guaranteedCount) {
      return relevant.slice(0, cap);
    }
  }

  return rankedChunks.slice(0, cap);
}

function classifyAuthority(title: string, lane: "local" | "state"): ChunkAuthority {
  const lowerTitle = title.toLowerCase();

  if (lane === "state") {
    if (lowerTitle.includes("rsa") || /\brsa\s+\d/.test(lowerTitle)) {
      return "rsa";
    }
    if (lowerTitle.includes("nhma") || lowerTitle.includes("municipal association")) {
      return "nhma";
    }
    return "official";
  }

  if (lowerTitle.includes("minutes") || lowerTitle.includes("meeting")) {
    return "minutes";
  }
  if (lowerTitle.includes("news") || lowerTitle.includes("article") || lowerTitle.includes("reporter")) {
    return "news";
  }
  return "official";
}

/**
 * Robust authority classification that checks both title AND content
 */
function classifyAuthorityRobust(title: string, content: string, lane: "local" | "state"): ChunkAuthority {
  const combinedText = (title + ' ' + content).toLowerCase();
  const lowerTitle = title.toLowerCase();

  if (lane === "state") {
    // Check for RSA in title or content
    if (/\brsa\s+\d+/i.test(combinedText)) {
      return "rsa";
    }
    // Check for NHMA
    if (/\bnhma\b/i.test(combinedText) || lowerTitle.includes("municipal association")) {
      return "nhma";
    }
    return "official";
  }

  // Local lane classification
  if (lowerTitle.includes("minutes") || lowerTitle.includes("meeting")) {
    return "minutes";
  }
  if (lowerTitle.includes("news") || lowerTitle.includes("article") || lowerTitle.includes("reporter")) {
    return "news";
  }
  return "official";
}

function computeAverageSituationAlignment(
  chunks: LaneChunk[],
  situationContext: SituationContext | null | undefined
): number {
  if (!situationContext || chunks.length === 0) return 0;

  let totalScore = 0;
  for (const chunk of chunks) {
    totalScore += computeSituationMatchScore(
      chunk.title + " " + chunk.content,
      situationContext
    );
  }

  return totalScore / chunks.length;
}

function computeLegalTopicCoverageFromChunks(
  stateChunks: LabeledChunk[],
  legalTopics: string[]
): number {
  if (legalTopics.length === 0) return 1.0;
  if (stateChunks.length === 0) return 0;

  const chunkText = stateChunks.map(c => c.content.toLowerCase()).join(' ');
  let covered = 0;

  for (const topic of legalTopics) {
    if (chunkText.includes(topic.toLowerCase())) {
      covered++;
    }
  }

  return covered / legalTopics.length;
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
