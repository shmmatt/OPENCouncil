import { GoogleGenAI } from "@google/genai";
import { drizzle } from "drizzle-orm/neon-serverless";
import { Pool, neonConfig } from "@neondatabase/serverless";
import ws from "ws";
import { storage } from "../storage";
import { eq, desc, asc, sql } from "drizzle-orm";
import * as schema from "@shared/schema";
import type { ChatAnalytics, ChatReviewRun } from "@shared/schema";
import { createChatReviewRun, getChatReviewRuns, getChatReviewRunById } from "../storage/analytics";
import { getArchitectureContext } from "./architectureContext";

neonConfig.webSocketConstructor = ws;

let _db: ReturnType<typeof drizzle> | null = null;
function getDb() {
  if (!_db) {
    const pool = new Pool({ connectionString: process.env.DATABASE_URL });
    _db = drizzle({ client: pool, schema });
  }
  return _db;
}

const REVIEW_MODEL = "gemini-3.1-pro-preview";

const ai = new GoogleGenAI({ apiKey: process.env.GEM_API_KEY || "" });

const ANALYSIS_RESPONSE_SCHEMA = {
  type: "object" as const,
  properties: {
    userIntent: {
      type: "string" as const,
      description: "Clear statement of what the user was trying to learn or accomplish.",
    },
    summary: {
      type: "string" as const,
      description: "Brief summary: what did the user ask for, and did they get it?",
    },
    critique: {
      type: "string" as const,
      description: "Harsh, specific critique of the AI response quality. Call out every failure.",
    },
    missingDocsSuggestions: {
      type: "string" as const,
      description: "Specific documents needed: town name + document type + year. Be precise.",
    },
    documentQualityScore: {
      type: "integer" as const,
      description: "1-10 score for citation and source document usage quality.",
    },
    answerQualityScore: {
      type: "integer" as const,
      description: "1-10 score for whether the user got what they actually needed.",
    },
    gapCategory: {
      type: "string" as const,
      enum: ["prompting", "system_prompt", "algorithm", "missing_docs", "embedding_quality", "other"],
      description: "Primary improvement category to close the gap between what the user wanted and what they got.",
    },
    pipelineStage: {
      type: "string" as const,
      nullable: true,
      description: "Which V3 pipeline stage is the root cause. Examples: situation_gate, planner_entity_extraction, planner_query_generation, retrieval_local_lane, retrieval_state_lane, retrieval_sau_lane, synthesizer_tier_assignment, synthesizer_prose_rules, synthesizer_citation, audit_drift, audit_format, second_hop, model_selection",
    },
    criticalDomainError: {
      type: "boolean" as const,
      description: "True if the AI made a factual error about NH governance (tax cycle, board authority, RSA fabrication, SAU vs town confusion, etc.). This is separate from quality scores — it flags immediate triage needs.",
    },
    promptingSuggestions: {
      type: "string" as const,
      nullable: true,
      description: "Specific changes to system prompts or prompt engineering that would improve this response. Reference exact prompt sections when possible.",
    },
    pipelineSuggestions: {
      type: "string" as const,
      nullable: true,
      description: "Specific algorithm or pipeline changes that would improve this response. Reference exact pipeline stages and mechanisms.",
    },
  },
  required: [
    "userIntent", "summary", "critique", "missingDocsSuggestions",
    "documentQualityScore", "answerQualityScore", "gapCategory",
    "pipelineStage", "criticalDomainError", "promptingSuggestions", "pipelineSuggestions",
  ],
};

const ROLLUP_RESPONSE_SCHEMA = {
  type: "object" as const,
  properties: {
    executiveSummary: {
      type: "string" as const,
      description: "High-level markdown summary of batch performance, patterns, and priorities.",
    },
    patternAnalysis: {
      type: "string" as const,
      description: "Common failure modes grouped by gapCategory and pipelineStage. Identify systemic issues vs one-offs.",
    },
    criticalDomainErrors: {
      type: "string" as const,
      description: "List of sessions with critical domain errors, what went wrong, and why it matters. Empty string if none.",
    },
    promptDiffs: {
      type: "string" as const,
      description: "Suggested system prompt changes formatted as diffs. Use format: LOCATION: [file/section] | OLD: [exact current text] | NEW: [exact replacement text] | REASON: [why]. Multiple diffs separated by ---.",
    },
    pipelineImprovements: {
      type: "string" as const,
      description: "Specific algorithm changes with expected impact, referencing exact pipeline stages. Prioritize by impact.",
    },
    missingDocsPriority: {
      type: "string" as const,
      description: "Deduplicated, ranked list of missing documents. Format: priority rank, town, document type, year, number of sessions affected.",
    },
    quickWins: {
      type: "string" as const,
      description: "Changes that can be implemented quickly (prompt tweaks, config changes) with high expected impact.",
    },
    deepChanges: {
      type: "string" as const,
      description: "Changes requiring significant development effort (algorithm redesign, new pipeline stages, infrastructure changes).",
    },
  },
  required: [
    "executiveSummary", "patternAnalysis", "criticalDomainErrors", "promptDiffs",
    "pipelineImprovements", "missingDocsPriority", "quickWins", "deepChanges",
  ],
};

export interface ChatAnalyticsListItem {
  sessionId: string;
  title: string;
  userId: string | null;
  anonId: string | null;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  totalCost: number;
  costPerMessage: number;
  isAnalyzed: boolean;
  summary: string | null;
  critique: string | null;
  missingDocsSuggestions: string | null;
  documentQualityScore: number | null;
  answerQualityScore: number | null;
  analyzedAt: string | null;
  thumbsUpCount: number;
  thumbsDownCount: number;
  gapCategory: string | null;
  pipelineStage: string | null;
  criticalDomainError: boolean;
  userIntent: string | null;
  promptingSuggestions: string | null;
  pipelineSuggestions: string | null;
}

export interface ChatAnalyticsListResult {
  items: ChatAnalyticsListItem[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

interface ListParams {
  page: number;
  pageSize: number;
  sortField: string;
  sortOrder: "asc" | "desc";
  search: string;
  filterAnalyzed?: boolean;
  filterNegativeFeedback?: boolean;
  filterMinDocScore: number;
  filterMaxDocScore: number;
  filterMinAnswerScore: number;
  filterMaxAnswerScore: number;
  filterGapCategory?: string;
  filterCriticalDomainError?: boolean;
}

export async function getChatAnalyticsList(params: ListParams): Promise<ChatAnalyticsListResult> {
  const {
    page,
    pageSize,
    sortField,
    sortOrder,
    search,
    filterAnalyzed,
    filterNegativeFeedback,
    filterMinDocScore,
    filterMaxDocScore,
    filterMinAnswerScore,
    filterMaxAnswerScore,
    filterGapCategory,
    filterCriticalDomainError,
  } = params;

  const offset = (page - 1) * pageSize;

  const db = getDb();
  
  const sessionsWithStats = await db
    .select({
      session: schema.chatSessions,
      messageCount: sql<number>`(SELECT COUNT(*) FROM chat_messages WHERE session_id = ${schema.chatSessions.id})`.as('message_count'),
      totalCost: sql<number>`COALESCE((SELECT SUM(CAST(cost_usd AS FLOAT)) FROM llm_cost_logs WHERE session_id = ${schema.chatSessions.id}), 0)`.as('total_cost'),
      thumbsUpCount: sql<number>`(SELECT COUNT(*) FROM chat_messages WHERE session_id = ${schema.chatSessions.id} AND feedback = 'up')`.as('thumbs_up_count'),
      thumbsDownCount: sql<number>`(SELECT COUNT(*) FROM chat_messages WHERE session_id = ${schema.chatSessions.id} AND feedback = 'down')`.as('thumbs_down_count'),
    })
    .from(schema.chatSessions)
    .orderBy(sortOrder === "desc" ? desc(schema.chatSessions.updatedAt) : asc(schema.chatSessions.updatedAt))
    .execute();

  const allAnalytics = await db
    .select()
    .from(schema.chatAnalytics)
    .execute();

  const analyticsMap = new Map<string, typeof allAnalytics[0]>();
  for (const a of allAnalytics) {
    analyticsMap.set(a.sessionId, a);
  }

  let items: ChatAnalyticsListItem[] = sessionsWithStats.map(row => {
    const analytics = analyticsMap.get(row.session.id);
    const messageCount = Number(row.messageCount) || 0;
    const totalCost = Number(row.totalCost) || 0;
    return {
      sessionId: row.session.id,
      title: row.session.title,
      userId: row.session.userId,
      anonId: row.session.anonId,
      createdAt: row.session.createdAt.toISOString(),
      updatedAt: row.session.updatedAt.toISOString(),
      messageCount,
      totalCost,
      costPerMessage: messageCount > 0 ? totalCost / messageCount : 0,
      isAnalyzed: !!analytics,
      summary: analytics?.summary || null,
      critique: analytics?.critique || null,
      missingDocsSuggestions: analytics?.missingDocsSuggestions || null,
      documentQualityScore: analytics?.documentQualityScore || null,
      answerQualityScore: analytics?.answerQualityScore || null,
      analyzedAt: analytics?.analyzedAt?.toISOString() || null,
      thumbsUpCount: Number(row.thumbsUpCount) || 0,
      thumbsDownCount: Number(row.thumbsDownCount) || 0,
      gapCategory: analytics?.gapCategory || null,
      pipelineStage: analytics?.pipelineStage || null,
      criticalDomainError: analytics?.criticalDomainError || false,
      userIntent: analytics?.userIntent || null,
      promptingSuggestions: analytics?.promptingSuggestions || null,
      pipelineSuggestions: analytics?.pipelineSuggestions || null,
    };
  });

  if (search) {
    const lowerSearch = search.toLowerCase();
    items = items.filter(item =>
      item.title.toLowerCase().includes(lowerSearch) ||
      (item.summary && item.summary.toLowerCase().includes(lowerSearch)) ||
      (item.critique && item.critique.toLowerCase().includes(lowerSearch))
    );
  }

  if (filterAnalyzed !== undefined) {
    items = items.filter(item => item.isAnalyzed === filterAnalyzed);
  }

  if (filterNegativeFeedback) {
    items = items.filter(item => item.thumbsDownCount > 0);
  }

  if (filterGapCategory) {
    items = items.filter(item => item.gapCategory === filterGapCategory);
  }

  if (filterCriticalDomainError) {
    items = items.filter(item => item.criticalDomainError === true);
  }

  items = items.filter(item => {
    if (item.documentQualityScore !== null) {
      if (item.documentQualityScore < filterMinDocScore || item.documentQualityScore > filterMaxDocScore) {
        return false;
      }
    }
    if (item.answerQualityScore !== null) {
      if (item.answerQualityScore < filterMinAnswerScore || item.answerQualityScore > filterMaxAnswerScore) {
        return false;
      }
    }
    return true;
  });

  const sortFn = (a: ChatAnalyticsListItem, b: ChatAnalyticsListItem) => {
    let aVal: any, bVal: any;
    switch (sortField) {
      case "date":
        aVal = new Date(a.updatedAt).getTime();
        bVal = new Date(b.updatedAt).getTime();
        break;
      case "cost":
        aVal = a.totalCost;
        bVal = b.totalCost;
        break;
      case "messages":
        aVal = a.messageCount;
        bVal = b.messageCount;
        break;
      case "docScore":
        aVal = a.documentQualityScore ?? -1;
        bVal = b.documentQualityScore ?? -1;
        break;
      case "answerScore":
        aVal = a.answerQualityScore ?? -1;
        bVal = b.answerQualityScore ?? -1;
        break;
      default:
        aVal = new Date(a.updatedAt).getTime();
        bVal = new Date(b.updatedAt).getTime();
    }
    if (sortOrder === "desc") {
      return bVal - aVal;
    }
    return aVal - bVal;
  };

  items.sort(sortFn);

  const total = items.length;
  const paginatedItems = items.slice(offset, offset + pageSize);

  return {
    items: paginatedItems,
    total,
    page,
    pageSize,
    totalPages: Math.ceil(total / pageSize),
  };
}

export async function analyzeChatSession(sessionId: string): Promise<ChatAnalytics> {
  const session = await storage.getChatSessionById(sessionId);
  if (!session) {
    throw new Error("Session not found");
  }

  const messages = await storage.getMessagesBySessionId(sessionId);
  if (messages.length === 0) {
    throw new Error("No messages in session");
  }

  const feedbackSummary = messages
    .filter(m => m.feedback)
    .map(m => `Message "${m.content.slice(0, 80)}..." received ${m.feedback === 'up' ? 'THUMBS UP' : 'THUMBS DOWN'} from the user`)
    .join("\n");

  const transcript = messages
    .map(m => {
      let line = `[${m.role.toUpperCase()}]: ${m.content}`;
      if (m.feedback) {
        line += `\n  [USER FEEDBACK: ${m.feedback === 'up' ? 'THUMBS UP' : 'THUMBS DOWN'}]`;
      }
      return line;
    })
    .join("\n\n");

  const architectureContext = getArchitectureContext();

  const systemInstruction = `You are a senior QA engineer and domain expert reviewing chat sessions from OPENCouncil. You have deep knowledge of both the technical architecture and New Hampshire municipal governance.

${architectureContext}

Your job is to perform a rigorous gap analysis on each chat session. For every session, you must answer three questions:

1. WHAT DID THE USER WANT? Extract their true intent, expected outcome, and specificity level.
2. WHAT DID THEY GET? Evaluate the answer quality, citation completeness, factual accuracy, tone compliance, and format adherence.
3. HOW DO WE CLOSE THE GAP? Provide specific, actionable recommendations categorized by type.

SCORING GUIDELINES — BE STRICT:
- Score 1-3: FAILURE — AI couldn't answer, gave wrong info, no citations, or said "I don't have that document"
- Score 4-5: POOR — Generic advice without specific citations, vague responses, missing key details
- Score 6-7: ACCEPTABLE — Answered with some citations but incomplete or could be better
- Score 8-9: GOOD — Solid answer with proper citations and specific information
- Score 10: EXCEPTIONAL — Perfect response with comprehensive citations (rare)

AUTOMATIC LOW SCORES:
- AI said "I don't have access to" or "I couldn't find" → documentQualityScore max 3
- Generic legal advice without citing specific NH RSAs or town ordinances → answerQualityScore max 4
- Failed to answer the user's actual question → answerQualityScore max 2
- Response lacks ANY citations → documentQualityScore max 4
- User asked for specific town info and AI gave general info → answerQualityScore max 4

CRITICAL DOMAIN ERROR DETECTION:
Set criticalDomainError to true if ANY of these occur:
- Incorrect tax cycle information (e.g., wrong billing schedule, wrong entity setting rates)
- Confusing SAU/school district authority with town government authority
- Fabricating RSA numbers not present in citations
- Misattributing board authority (e.g., saying Planning Board can grant variances)
- Stating vote outcomes without evidence
- Confusing SB2 vs traditional Town Meeting procedures
- Wrong information about default budget mechanics

GAP CATEGORY ASSIGNMENT:
- "prompting": The system prompt instructions are insufficient or misleading for this type of question
- "system_prompt": Specific system prompt text needs to be added, removed, or changed
- "algorithm": The pipeline logic (retrieval strategy, tier assignment, second-hop, audit) needs adjustment
- "missing_docs": The answer failed because the required documents aren't in the database
- "embedding_quality": Documents exist but weren't retrieved (embedding/chunking issue)
- "other": Issues outside the above categories

PIPELINE STAGE ATTRIBUTION:
When identifying the root cause, attribute it to the most specific stage possible:
- situation_gate: Sticky context leaked or was incorrectly cleared
- planner_entity_extraction: Wrong entities extracted from the question
- planner_query_generation: Retrieval queries were too broad, narrow, or off-target
- retrieval_local_lane: Local document retrieval failed or returned irrelevant chunks
- retrieval_state_lane: State/RSA retrieval failed
- retrieval_sau_lane: SAU lane not triggered or returned wrong results
- synthesizer_tier_assignment: RecordStrength tier was wrong for the evidence quality
- synthesizer_prose_rules: Answer violated prose-first rules (headings, bullets, length)
- synthesizer_citation: Citations missing, wrong format, or fabricated
- audit_drift: Drift detection missed a hallucination
- audit_format: Format violations weren't caught
- second_hop: Second-hop should have triggered but didn't, or triggered unnecessarily
- model_selection: Wrong model used for the task complexity`;

  const userPrompt = `Analyze this chat session.

${feedbackSummary ? `USER FEEDBACK SIGNALS:\n${feedbackSummary}\n\nPay special attention to messages that received THUMBS DOWN.\n\n` : ''}TRANSCRIPT:
${transcript}`;

  try {
    const response = await ai.models.generateContent({
      model: REVIEW_MODEL,
      contents: [{ role: "user", parts: [{ text: userPrompt }] }],
      config: {
        systemInstruction,
        responseMimeType: "application/json",
        responseSchema: ANALYSIS_RESPONSE_SCHEMA,
        temperature: 0.2,
      },
    });

    const text = response.text || "";
    const parsed = JSON.parse(text);

    const analytics = await storage.upsertChatAnalytics({
      sessionId,
      summary: parsed.summary || "",
      critique: parsed.critique || "",
      missingDocsSuggestions: parsed.missingDocsSuggestions || null,
      documentQualityScore: Math.min(10, Math.max(1, Math.round(parsed.documentQualityScore || 1))),
      answerQualityScore: Math.min(10, Math.max(1, Math.round(parsed.answerQualityScore || 1))),
      gapCategory: parsed.gapCategory || null,
      pipelineStage: parsed.pipelineStage || null,
      criticalDomainError: parsed.criticalDomainError === true,
      userIntent: parsed.userIntent || null,
      promptingSuggestions: parsed.promptingSuggestions || null,
      pipelineSuggestions: parsed.pipelineSuggestions || null,
    });

    return analytics;
  } catch (error) {
    console.error("Error analyzing chat session:", error);
    throw error;
  }
}

export type ProgressCallback = (current: number, total: number, phase: string, sessionId?: string) => void;

export async function batchAnalyzeSessions(
  sessionIds: string[],
  onProgress?: ProgressCallback,
): Promise<{ sessionId: string; success: boolean; error?: string }[]> {
  const results: { sessionId: string; success: boolean; error?: string }[] = [];
  const total = sessionIds.length;

  for (let i = 0; i < sessionIds.length; i++) {
    const sessionId = sessionIds[i];
    try {
      await analyzeChatSession(sessionId);
      results.push({ sessionId, success: true });
    } catch (error) {
      results.push({
        sessionId,
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      });
    }
    onProgress?.(i + 1, total, "analyzing", sessionId);
  }

  return results;
}

async function generateRollupFromAnalyses(
  sessionIds: string[],
  analyses: ChatAnalytics[],
  successCount: number,
): Promise<{ executiveSummary: string; allMissingDocs: string; totalThumbsUp: number; totalThumbsDown: number; avgDocScore: string | null; avgAnswerScore: string | null }> {
  let totalThumbsUp = 0;
  let totalThumbsDown = 0;
  for (const sessionId of sessionIds) {
    const messages = await storage.getMessagesBySessionId(sessionId);
    for (const m of messages) {
      if (m.feedback === "up") totalThumbsUp++;
      if (m.feedback === "down") totalThumbsDown++;
    }
  }

  const docScores = analyses.filter(a => a.documentQualityScore != null).map(a => a.documentQualityScore!);
  const answerScores = analyses.filter(a => a.answerQualityScore != null).map(a => a.answerQualityScore!);
  const avgDocScore = docScores.length > 0 ? (docScores.reduce((a, b) => a + b, 0) / docScores.length).toFixed(1) : null;
  const avgAnswerScore = answerScores.length > 0 ? (answerScores.reduce((a, b) => a + b, 0) / answerScores.length).toFixed(1) : null;

  const criticalCount = analyses.filter(a => a.criticalDomainError).length;

  const gapCategoryCounts: Record<string, number> = {};
  const pipelineStageCounts: Record<string, number> = {};
  for (const a of analyses) {
    if (a.gapCategory) {
      gapCategoryCounts[a.gapCategory] = (gapCategoryCounts[a.gapCategory] || 0) + 1;
    }
    if (a.pipelineStage) {
      pipelineStageCounts[a.pipelineStage] = (pipelineStageCounts[a.pipelineStage] || 0) + 1;
    }
  }

  const sessionDetails = analyses.map(a => {
    const parts = [
      `Session: ${a.sessionId}`,
      `Doc Score: ${a.documentQualityScore}/10 | Answer Score: ${a.answerQualityScore}/10`,
      `Gap Category: ${a.gapCategory || "N/A"} | Pipeline Stage: ${a.pipelineStage || "N/A"}`,
      `Critical Domain Error: ${a.criticalDomainError ? "YES" : "no"}`,
      `User Intent: ${a.userIntent || "N/A"}`,
      `Critique: ${a.critique}`,
      `Missing Docs: ${a.missingDocsSuggestions || "None"}`,
      `Prompting Suggestions: ${a.promptingSuggestions || "None"}`,
      `Pipeline Suggestions: ${a.pipelineSuggestions || "None"}`,
    ];
    return parts.join("\n");
  }).join("\n\n---\n\n");

  const allMissingDocs = analyses
    .map(a => a.missingDocsSuggestions)
    .filter(Boolean)
    .join("\n---\n");

  const architectureContext = getArchitectureContext();

  let executiveSummary = "";
  try {
    const systemInstruction = `You are a senior engineering lead reviewing a batch of chat session analyses for OPENCouncil. You have deep knowledge of the system architecture and NH municipal governance.

${architectureContext}

Your job is to synthesize individual session analyses into an actionable improvement roadmap. Focus on systemic patterns, not individual session quirks. When suggesting prompt changes, provide EXACT replacement text that can be dropped directly into the codebase.`;

    const userPrompt = `Analyze this batch of ${sessionIds.length} chat session reviews and produce a prioritized improvement roadmap.

BATCH STATISTICS:
- Total sessions analyzed: ${sessionIds.length}
- Successful analyses: ${successCount}
- Average Document Quality Score: ${avgDocScore || "N/A"}/10
- Average Answer Quality Score: ${avgAnswerScore || "N/A"}/10
- User Thumbs Up: ${totalThumbsUp} | Thumbs Down: ${totalThumbsDown}
- Critical Domain Errors: ${criticalCount}
- Gap Category Distribution: ${JSON.stringify(gapCategoryCounts)}
- Pipeline Stage Distribution: ${JSON.stringify(pipelineStageCounts)}

INDIVIDUAL SESSION ANALYSES:
${sessionDetails}`;

    const response = await ai.models.generateContent({
      model: REVIEW_MODEL,
      contents: [{ role: "user", parts: [{ text: userPrompt }] }],
      config: {
        systemInstruction,
        responseMimeType: "application/json",
        responseSchema: ROLLUP_RESPONSE_SCHEMA,
        temperature: 0.2,
      },
    });

    const text = response.text || "";
    const parsed = JSON.parse(text);

    const summaryParts = [
      `# Batch Review Summary\n`,
      `## Overview`,
      parsed.executiveSummary,
      `\n## Pattern Analysis`,
      parsed.patternAnalysis,
    ];

    if (parsed.criticalDomainErrors && parsed.criticalDomainErrors.trim()) {
      summaryParts.push(`\n## Critical Domain Errors`);
      summaryParts.push(parsed.criticalDomainErrors);
    }

    if (parsed.promptDiffs && parsed.promptDiffs.trim()) {
      summaryParts.push(`\n## Suggested Prompt Changes`);
      summaryParts.push(parsed.promptDiffs);
    }

    if (parsed.pipelineImprovements && parsed.pipelineImprovements.trim()) {
      summaryParts.push(`\n## Pipeline Improvements`);
      summaryParts.push(parsed.pipelineImprovements);
    }

    if (parsed.missingDocsPriority && parsed.missingDocsPriority.trim()) {
      summaryParts.push(`\n## Missing Documents (Priority Order)`);
      summaryParts.push(parsed.missingDocsPriority);
    }

    summaryParts.push(`\n## Quick Wins`);
    summaryParts.push(parsed.quickWins || "None identified");

    summaryParts.push(`\n## Deep Changes`);
    summaryParts.push(parsed.deepChanges || "None identified");

    executiveSummary = summaryParts.join("\n");

  } catch (error) {
    console.error("Error generating executive summary:", error);
    executiveSummary = `Batch analysis completed. ${successCount}/${sessionIds.length} sessions analyzed. Avg Doc: ${avgDocScore}/10, Avg Answer: ${avgAnswerScore}/10. ${totalThumbsUp} thumbs up, ${totalThumbsDown} thumbs down. ${criticalCount} critical domain errors.`;
  }

  return { executiveSummary, allMissingDocs, totalThumbsUp, totalThumbsDown, avgDocScore, avgAnswerScore };
}

export async function batchAnalyzeWithSummary(
  sessionIds: string[],
  onProgress?: ProgressCallback,
): Promise<ChatReviewRun> {
  const analysisResults = await batchAnalyzeSessions(sessionIds, onProgress);
  const successCount = analysisResults.filter(r => r.success).length;

  const analyses: ChatAnalytics[] = [];
  for (const sessionId of sessionIds) {
    const a = await storage.getChatAnalyticsBySessionId(sessionId);
    if (a) analyses.push(a);
  }

  onProgress?.(sessionIds.length, sessionIds.length, "rollup");

  const { executiveSummary, allMissingDocs, totalThumbsUp, totalThumbsDown, avgDocScore, avgAnswerScore } =
    await generateRollupFromAnalyses(sessionIds, analyses, successCount);

  const run = await createChatReviewRun({
    sessionIds,
    totalSessions: sessionIds.length,
    successfulAnalyses: successCount,
    avgDocScore,
    avgAnswerScore,
    thumbsUpCount: totalThumbsUp,
    thumbsDownCount: totalThumbsDown,
    topMissingDocs: allMissingDocs.slice(0, 5000),
    executiveSummary,
  });

  return run;
}

export async function generateRollupSummaryOnly(
  sessionIds: string[],
  onProgress?: ProgressCallback,
): Promise<ChatReviewRun> {
  const analyses: ChatAnalytics[] = [];
  const missingAnalysis: string[] = [];

  for (const sessionId of sessionIds) {
    const a = await storage.getChatAnalyticsBySessionId(sessionId);
    if (a) {
      analyses.push(a);
    } else {
      missingAnalysis.push(sessionId);
    }
  }

  if (missingAnalysis.length > 0) {
    throw new Error(`The following sessions have not been analyzed yet: ${missingAnalysis.join(", ")}`);
  }

  onProgress?.(0, 1, "rollup");

  const { executiveSummary, allMissingDocs, totalThumbsUp, totalThumbsDown, avgDocScore, avgAnswerScore } =
    await generateRollupFromAnalyses(sessionIds, analyses, analyses.length);

  const run = await createChatReviewRun({
    sessionIds,
    totalSessions: sessionIds.length,
    successfulAnalyses: analyses.length,
    avgDocScore,
    avgAnswerScore,
    thumbsUpCount: totalThumbsUp,
    thumbsDownCount: totalThumbsDown,
    topMissingDocs: allMissingDocs.slice(0, 5000),
    executiveSummary,
  });

  return run;
}

export { getChatReviewRuns, getChatReviewRunById };
