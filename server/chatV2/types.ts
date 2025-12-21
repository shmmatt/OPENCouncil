export type ComplexityLevel = "simple" | "complex";

export type ScopeHint = "local" | "statewide" | "mixed" | null;

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
