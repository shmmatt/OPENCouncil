export type ComplexityLevel = "simple" | "complex";

export interface RouterOutput {
  complexity: ComplexityLevel;
  domains: string[];
  requiresClarification: boolean;
  clarificationQuestions: string[];
  rerankedQuestion: string;
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
