export type ComplexityLevel = "simple" | "complex";

export type ScopeHint = "local" | "statewide" | "mixed" | null;

/**
 * Answer mode controls response length and detail level.
 * - "standard": Default mode with shorter, more concise answers
 * - "deep": Extended mode with longer, more detailed answers (premium feature)
 */
export type AnswerMode = "standard" | "deep";

/**
 * Explicit document source tracking for scope note selection.
 * This ensures the scope note accurately reflects which documents were used.
 */
export type DocSourceType = "none" | "local" | "statewide" | "mixed";

/**
 * Context about document sources used in the answer.
 */
export interface DocSourceContext {
  docSourceType: DocSourceType;
  townUsed: string | null;
}

export interface RouterOutput {
  complexity: ComplexityLevel;
  domains: string[];
  requiresClarification: boolean;
  clarificationQuestions: string[];
  rerankedQuestion: string;
  scopeHint: ScopeHint;
  requiresComposedAnswer?: boolean;
}

export interface RetrievalPlan {
  filters: {
    townPreference?: string;
    allowStatewideFallback: boolean;
    categories: string[];
    boards: string[];
    rsaChapters: string[];
  };
  infoNeeds: string[];
  preferRecent?: boolean;
  /**
   * When true, always run parallel state lane retrieval regardless of scopeHint.
   * Default true - state lane is cheap and often useful.
   */
  forceParallelStateRetrieval?: boolean;
  /**
   * Optional anchors for state lane queries (can be customized by planner).
   */
  stateLaneAnchors?: string[];
}

/**
 * Synthesis output from the combined Discriminator + Synthesis prompt.
 * Used by complex path for structured answer generation.
 */
export interface SynthesisOutput {
  answer_markdown: string;
  used_statewide: boolean;
  statewide_reason: string | null;
  applicability_check: string | null;
  assumptions: string[];
  limitations: string[];
  suggested_followups: string[];
}

export interface CriticScore {
  relevance: number;
  completeness: number;
  clarity: number;
  riskOfMisleading: number;
}

export interface FinalAnswerMeta {
  complexity: ComplexityLevel;
  requiresClarification: boolean;
  criticScore: CriticScore;
  limitationsNote?: string;
}

export interface SourceCitation {
  id: string;
  title: string;
  town?: string;
  year?: string;
  category?: string;
  url?: string;
  meetingDate?: string;
  board?: string;
}

export interface ChatV2Request {
  content: string;
  metadata?: {
    town?: string;
    board?: string;
  };
  attachment?: {
    filename: string;
    mimeType: string;
    extractedText: string;
  };
  /**
   * Answer mode: "standard" (default) or "deep" (longer, more detailed responses)
   */
  answerMode?: AnswerMode;
}

import type { ChatNotice } from "@shared/chatNotices";

export interface ChatV2Response {
  message: {
    id: string;
    sessionId: string;
    role: string;
    content: string;
    createdAt: string;
  };
  answerMeta: FinalAnswerMeta;
  sources: SourceCitation[];
  suggestedFollowUps: string[];
  notices?: ChatNotice[];
}

export interface ChatHistoryMessage {
  role: "user" | "assistant";
  content: string;
}

import type { ActorContext } from "../auth/types";

/**
 * Logging context passed through the pipeline for request correlation
 */
export interface PipelineLogContext {
  requestId: string;
  sessionId: string;
  actor?: ActorContext;
}

// =====================================================
// CHAT V3 PIPELINE TYPES
// =====================================================

/**
 * IssueMap: Structured extraction of the user's question/situation
 * Used by Stage 1 (Planner) to guide retrieval and synthesis
 */
export interface IssueMap {
  town?: string;
  situationTitle?: string;
  entities: string[];
  actions: string[];
  legalTopics: string[];
  boards: string[];
  timeHints: string[];
  requestedOutput?: "explain" | "steps" | "cite_laws" | "risk" | "process";
  legalSalience: number; // 0..1
  plannerConfidence: number; // 0..1
}

/**
 * Lane-specific retrieval plan for multi-query retrieval
 */
export interface LanePlan {
  queries: string[];
  k: number;
  cap: number;
}

/**
 * V3 Retrieval Plan with multi-query support per lane
 */
export interface RetrievalPlanV3 {
  local: LanePlan;
  state: LanePlan;
  mustInclude: {
    minState?: number;
    minLocalFacts?: number;
  };
  priority: "law-first" | "facts-first" | "process-first";
  reason: string; // for debug
}

/**
 * Record strength tier system for synthesis confidence control
 * - Tier A: Rich sources, cite specifics, direct framing
 * - Tier B: Some sources, add "gaps/depends" language
 * - Tier C: Weak sources, general framework only, no statute numbers
 */
export interface RecordStrength {
  tier: "A" | "B" | "C";
  localCount: number;
  stateCount: number;
  situationAlignment: number; // 0..1
  legalTopicCoverage: number; // 0..1
  authoritativeStatePresent: boolean;
  distinctStateDocs?: number; // Unique state documents by title
  distinctLocalDocs?: number; // Unique local documents by title
}

/**
 * Authority classification for chunk sources
 */
export type ChunkAuthority = "rsa" | "nhma" | "official" | "minutes" | "news" | "other";

/**
 * Enhanced chunk metadata for v3 pipeline
 */
export interface ChunkMetadataV3 {
  lane: "local" | "state";
  authority: ChunkAuthority;
  topicTags: string[];
  situationMatchScore?: number;
  sourceId: string;
  sourceTitle: string;
}

/**
 * V3 Pipeline planner output combining IssueMap and RetrievalPlan
 */
export interface PlannerOutput {
  issueMap: IssueMap;
  retrievalPlan: RetrievalPlanV3;
  validationWarnings: string[];
}

/**
 * Audit result from post-generation checking
 */
export interface AuditResult {
  passed: boolean;
  violations: AuditViolation[];
  shouldRepair: boolean;
  repairHint?: string;
  formatValidation?: {
    wordCount: number;
    headingsInOrder: boolean;
    stateCitationCount: number;
    lawSectionHasStateCitations: boolean;
    llmTailsFound: string[];
  };
}

export interface AuditViolation {
  type: 
    | "uncited_rsa" 
    | "uncited_procedure" 
    | "absolute_legal_claim" 
    | "off_topic_drift"
    | "format_violation"
    | "missing_state_citation"
    | "llm_tail";
  evidence: string;
  severity: "warning" | "error";
}

/**
 * V3 Synthesis input combining all sources
 */
export interface SynthesisInputV3 {
  userMessage: string;
  issueMap: IssueMap;
  sessionSourceText?: string;
  localChunks: LabeledChunk[];
  stateChunks: LabeledChunk[];
  recordStrength: RecordStrength;
  history: ChatHistoryMessage[];
}

/**
 * Labeled chunk for citation tracking in synthesis
 */
export interface LabeledChunk {
  label: string; // e.g., "[L1]" or "[S2]"
  title: string;
  content: string;
  lane: "local" | "state";
  authority: ChunkAuthority;
}

/**
 * V3 Orchestrator debug output for observability
 */
export interface V3DebugInfo {
  issueMapSummary: {
    entities: string[];
    legalTopics: string[];
    legalSalience: number;
    plannerConfidence: number;
  };
  planQueries: {
    local: string[];
    state: string[];
  };
  retrievalCounts: {
    localRetrieved: number;
    localSelected: number;
    stateRetrieved: number;
    stateSelected: number;
  };
  recordStrengthTier: "A" | "B" | "C";
  auditFlags: string[];
  repairRan: boolean;
  durationMs: number;
}

/**
 * V3 Pipeline result
 */
export interface V3PipelineResult {
  answerText: string;
  sourceDocumentNames: string[];
  docSourceType: DocSourceType;
  docSourceTown: string | null;
  retrievedChunkCount: number;
  recordStrength: RecordStrength;
  debug: V3DebugInfo;
  durationMs: number;
}
