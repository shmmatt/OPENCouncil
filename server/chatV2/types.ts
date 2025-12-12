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

/**
 * Raw citation extracted from Gemini grounding metadata.
 * geminiDocId is the canonical key (extracted from URI).
 */
export interface ExtractedCitation {
  rawTitle?: string;      // retrievedContext.title (for debug only, not for identity)
  rawUri?: string;        // retrievedContext.uri (full path)
  geminiDocId?: string;   // parsed from /documents/<docId> - this is the canonical key
}

/**
 * Resolved source ready for UI display.
 */
export interface ResolvedSource {
  docVersionId: string | null;
  label: string;
  href: string | null;
  debug?: {
    geminiDocId?: string;
    rawUri?: string;
    rawTitle?: string;
  };
}

export interface ChatV2Request {
  content: string;
  metadata?: {
    town?: string;
    board?: string;
  };
}

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
