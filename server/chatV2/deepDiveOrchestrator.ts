import { GoogleGenAI } from "@google/genai";
import { logLLMCall, extractTokenCounts } from "../llm/callLLMWithLogging";
import { logInfo, logError, logWarn } from "../utils/logger";
import { pgvectorTwoLaneRetrieveWithPlan } from "./pgvectorRetrieveAdapter";
import { searchNewsForTopic } from "../services/newsCrawler";
import { searchWeb, isWebSearchConfigured } from "../services/webSearchTool";
import { mapFileSearchDocumentsToCitations } from "./sources";
import {
  createDeepDiveSession,
  updateDeepDiveSession,
  createDeepDiveStep,
} from "../storage/deepDive";
import type { PipelineLogContext } from "./types";
import type { DeepDiveSession, DeepDiveStep, DeepDiveStepType } from "@shared/schema";

const ai = new GoogleGenAI({ apiKey: process.env.GEM_API_KEY || "" });

const FLASH_MODEL = "gemini-2.5-flash";
const PRO_MODEL = "gemini-2.5-pro";
const MAX_ITERATIONS = 3;
const QUALITY_THRESHOLD = 7;

export interface DeepDiveResult {
  sessionId: string;
  deepDiveId: string;
  answerText: string;
  qualityScore: number;
  completenessScore: number;
  iterationCount: number;
  sources: any[];
  totalCostUsd: number;
  totalDurationMs: number;
}

interface StepTracker {
  stepNumber: number;
  totalTokensIn: number;
  totalTokensOut: number;
  totalCostUsd: number;
}

interface ResearchPlan {
  ragQueries: string[];
  newsTopics: string[];
  webQueries: string[];
  reasoning: string;
}

interface QualityAssessment {
  qualityScore: number;
  completenessScore: number;
  reasoning: string;
  missingAspects: string[];
  failedApproaches: string[];
  suggestedNewAngles: string[];
}

function estimateCost(model: string, tokensIn: number, tokensOut: number): number {
  if (model.includes("pro")) {
    return (tokensIn * 1.25 + tokensOut * 10) / 1_000_000;
  }
  return (tokensIn * 0.15 + tokensOut * 0.6) / 1_000_000;
}

async function callLLM(
  model: string,
  systemPrompt: string,
  userPrompt: string,
  tracker: StepTracker,
  logContext: PipelineLogContext,
): Promise<{ text: string; tokensIn: number; tokensOut: number; costUsd: number; durationMs: number }> {
  const start = Date.now();
  const response = await ai.models.generateContent({
    model,
    contents: [{ role: "user", parts: [{ text: userPrompt }] }],
    config: {
      systemInstruction: systemPrompt,
      temperature: 0.3,
    },
  });

  const text = response.text || "";
  const usage = response.usageMetadata;
  const tokensIn = usage?.promptTokenCount || 0;
  const tokensOut = usage?.candidatesTokenCount || 0;
  const costUsd = estimateCost(model, tokensIn, tokensOut);
  const durationMs = Date.now() - start;

  tracker.totalTokensIn += tokensIn;
  tracker.totalTokensOut += tokensOut;
  tracker.totalCostUsd += costUsd;

  await logLLMCall(
    { actor: logContext.actor, sessionId: logContext.sessionId, requestId: logContext.requestId, stage: "deepDive", model },
    { tokensIn, tokensOut }
  ).catch(() => {});

  return { text, tokensIn, tokensOut, costUsd, durationMs };
}

async function recordStep(
  deepDiveId: string,
  tracker: StepTracker,
  stepType: DeepDiveStepType,
  input: string,
  output: string,
  opts: { reasoning?: string; toolUsed?: string; modelUsed?: string; tokensIn?: number; tokensOut?: number; costUsd?: number; durationMs?: number }
): Promise<DeepDiveStep> {
  tracker.stepNumber++;
  return createDeepDiveStep({
    deepDiveId,
    stepNumber: tracker.stepNumber,
    stepType,
    input: input.slice(0, 10000),
    output: output.slice(0, 50000),
    reasoning: opts.reasoning?.slice(0, 5000) || null,
    toolUsed: opts.toolUsed || null,
    modelUsed: opts.modelUsed || null,
    tokensIn: opts.tokensIn || null,
    tokensOut: opts.tokensOut || null,
    costUsd: opts.costUsd?.toFixed(6) || null,
    durationMs: opts.durationMs || null,
  });
}

export async function runDeepDive(options: {
  question: string;
  townPreference?: string | null;
  sessionId: string;
  messageId: string;
  logContext: PipelineLogContext;
  onStageChange: (stage: string, detail?: string) => void;
}): Promise<DeepDiveResult> {
  const { question, townPreference, sessionId, messageId, logContext, onStageChange } = options;
  const startTime = Date.now();

  const deepDiveSession = await createDeepDiveSession({
    chatSessionId: sessionId,
    messageId,
    question,
    town: townPreference || null,
    status: "running",
    finalAnswer: null,
    qualityScore: null,
    completenessScore: null,
    iterationCount: 0,
    totalCostUsd: null,
    totalDurationMs: null,
    completedAt: null,
  });

  const tracker: StepTracker = { stepNumber: 0, totalTokensIn: 0, totalTokensOut: 0, totalCostUsd: 0 };

  try {
    onStageChange("deep_dive_intent", "Analyzing your question...");

    const intentResult = await callLLM(
      FLASH_MODEL,
      `You are a municipal governance research analyst for New Hampshire. Analyze the user's question to extract:
1. The core research question
2. Sub-questions that need answering
3. Which tools would be most useful (document_search, news_search, web_search)
4. Key entities (towns, boards, people, statutes)
5. Time period of interest

Respond in JSON format:
{
  "coreQuestion": "...",
  "subQuestions": ["..."],
  "recommendedTools": ["document_search", "news_search", "web_search"],
  "entities": { "towns": [], "boards": [], "people": [], "statutes": [] },
  "timePeriod": "...",
  "reasoning": "..."
}`,
      `User question: ${question}\nTown context: ${townPreference || "not specified"}`,
      tracker,
      logContext,
    );

    await recordStep(deepDiveSession.id, tracker, "intent_analysis", question, intentResult.text, {
      modelUsed: FLASH_MODEL,
      tokensIn: intentResult.tokensIn,
      tokensOut: intentResult.tokensOut,
      costUsd: intentResult.costUsd,
      durationMs: intentResult.durationMs,
    });

    let intentData: any;
    try {
      const jsonMatch = intentResult.text.match(/\{[\s\S]*\}/);
      intentData = jsonMatch ? JSON.parse(jsonMatch[0]) : { coreQuestion: question, subQuestions: [question], recommendedTools: ["document_search"] };
    } catch {
      intentData = { coreQuestion: question, subQuestions: [question], recommendedTools: ["document_search"] };
    }

    onStageChange("deep_dive_planning", "Creating research plan...");

    const planResult = await callLLM(
      FLASH_MODEL,
      `You are a research planner for NH municipal governance. Given the intent analysis, create a concrete research plan.

Respond in JSON:
{
  "ragQueries": ["query1", "query2", ...],
  "newsTopics": ["topic1", ...],
  "webQueries": ["query1", ...],
  "reasoning": "Why these queries will find what we need"
}

Rules:
- ragQueries: 2-4 specific queries for searching municipal documents (minutes, ordinances, budgets)
- newsTopics: 0-2 topics for local news search (only if current events are relevant)
- webQueries: 0-2 web search queries (only if broader context or NH state-level info is needed)
- Be specific with town names and board names when known`,
      `Intent analysis:\n${intentResult.text}\n\nTown: ${townPreference || "not specified"}`,
      tracker,
      logContext,
    );

    await recordStep(deepDiveSession.id, tracker, "research_plan", intentResult.text, planResult.text, {
      modelUsed: FLASH_MODEL,
      tokensIn: planResult.tokensIn,
      tokensOut: planResult.tokensOut,
      costUsd: planResult.costUsd,
      durationMs: planResult.durationMs,
    });

    let plan: ResearchPlan;
    try {
      const jsonMatch = planResult.text.match(/\{[\s\S]*\}/);
      plan = jsonMatch ? JSON.parse(jsonMatch[0]) : { ragQueries: [question], newsTopics: [], webQueries: [], reasoning: "" };
    } catch {
      plan = { ragQueries: [question], newsTopics: [], webQueries: [], reasoning: "" };
    }

    let allEvidence: string[] = [];
    let allDocumentNames: string[] = [];
    let iterationCount = 0;
    let qualityScore = 0;
    let completenessScore = 0;
    let finalAnswer = "";

    for (let iteration = 0; iteration < MAX_ITERATIONS; iteration++) {
      iterationCount = iteration + 1;
      onStageChange("deep_dive_researching", `Researching (Pass ${iterationCount} of ${MAX_ITERATIONS})...`);

      const iterationEvidence: string[] = [];

      // Execute RAG retrieval
      if (plan.ragQueries.length > 0) {
        const ragStart = Date.now();
        try {
          for (const query of plan.ragQueries.slice(0, 4)) {
            const retrievalPlan = {
              localLane: {
                queries: [{ text: query, weight: 1.0 }],
                keywordFilters: [],
                temporalTarget: null,
                queryFocus: "general" as const,
              },
              stateLane: {
                queries: [{ text: query, weight: 1.0 }],
                keywordFilters: [],
                temporalTarget: null,
                queryFocus: "general" as const,
              },
              sauLane: null,
            };

            const result = await pgvectorTwoLaneRetrieveWithPlan(
              retrievalPlan,
              { topics: [question], entities: [], legalTopics: [], boardsDiscussed: [], legalSalience: 0, keySignals: [], temporalSignals: [], queryFocus: "general" },
              { townPreference, logContext }
            );

            const chunks = [...result.localChunks, ...result.stateChunks, ...result.sauChunks];
            for (const chunk of chunks.slice(0, 5)) {
              iterationEvidence.push(`[Document: ${chunk.title}]\n${chunk.content}`);
            }
            allDocumentNames.push(...result.allDocumentNames);
          }

          await recordStep(deepDiveSession.id, tracker, "rag_retrieval",
            JSON.stringify(plan.ragQueries),
            `Found ${iterationEvidence.length} document chunks`,
            { toolUsed: "rag_pipeline", durationMs: Date.now() - ragStart }
          );
        } catch (err) {
          logError("deep_dive_rag_error", { error: err instanceof Error ? err.message : String(err), ...logContext });
          await recordStep(deepDiveSession.id, tracker, "rag_retrieval",
            JSON.stringify(plan.ragQueries),
            `Error: ${err instanceof Error ? err.message : String(err)}`,
            { toolUsed: "rag_pipeline", durationMs: Date.now() - ragStart }
          );
        }
      }

      // Execute news search
      if (plan.newsTopics.length > 0) {
        const newsStart = Date.now();
        try {
          for (const topic of plan.newsTopics.slice(0, 2)) {
            const articles = await searchNewsForTopic(topic);
            for (const article of articles.slice(0, 3)) {
              iterationEvidence.push(`[News: ${article.title} - ${article.source}]\n${article.snippet}`);
            }
          }
          await recordStep(deepDiveSession.id, tracker, "news_search",
            JSON.stringify(plan.newsTopics),
            `Found ${iterationEvidence.length} news results`,
            { toolUsed: "news_crawler", durationMs: Date.now() - newsStart }
          );
        } catch (err) {
          logWarn("deep_dive_news_error", { error: err instanceof Error ? err.message : String(err) });
          await recordStep(deepDiveSession.id, tracker, "news_search",
            JSON.stringify(plan.newsTopics),
            `Error: ${err instanceof Error ? err.message : String(err)}`,
            { toolUsed: "news_crawler", durationMs: Date.now() - newsStart }
          );
        }
      }

      // Execute web search
      if (plan.webQueries.length > 0 && isWebSearchConfigured()) {
        const webStart = Date.now();
        try {
          for (const query of plan.webQueries.slice(0, 2)) {
            const results = await searchWeb(query, 3);
            for (const result of results) {
              const text = result.fullText || result.snippet;
              iterationEvidence.push(`[Web: ${result.title}]\nURL: ${result.url}\n${text}`);
            }
          }
          await recordStep(deepDiveSession.id, tracker, "web_search",
            JSON.stringify(plan.webQueries),
            `Found web results`,
            { toolUsed: "web_search", durationMs: Date.now() - webStart }
          );
        } catch (err) {
          logWarn("deep_dive_web_error", { error: err instanceof Error ? err.message : String(err) });
          await recordStep(deepDiveSession.id, tracker, "web_search",
            JSON.stringify(plan.webQueries),
            `Error: ${err instanceof Error ? err.message : String(err)}`,
            { toolUsed: "web_search", durationMs: Date.now() - webStart }
          );
        }
      }

      allEvidence.push(...iterationEvidence);

      // Synthesis
      onStageChange("deep_dive_synthesizing", `Writing analysis (Pass ${iterationCount})...`);

      const evidenceBlock = allEvidence.map((e, i) => `--- Evidence ${i + 1} ---\n${e}`).join("\n\n");

      const synthesisResult = await callLLM(
        PRO_MODEL,
        `You are an expert municipal governance analyst for New Hampshire. Write a comprehensive, well-structured analysis based on the provided evidence.

Requirements:
- Write 500-1000 words
- Use clear headings and structure (markdown)
- Cite specific sources using [Document: ...] or [News: ...] references
- Be factual and specific — reference dates, dollar amounts, vote counts when available
- Identify areas of uncertainty or missing information
- Provide actionable insights for residents
- If evidence is limited, acknowledge this honestly rather than speculating

Town context: ${townPreference || "New Hampshire (general)"}`,
        `Research question: ${question}\n\nGathered Evidence:\n${evidenceBlock.slice(0, 30000)}`,
        tracker,
        logContext,
      );

      finalAnswer = synthesisResult.text;

      await recordStep(deepDiveSession.id, tracker, "synthesis",
        `Question: ${question}\nEvidence items: ${allEvidence.length}`,
        finalAnswer,
        {
          modelUsed: PRO_MODEL,
          tokensIn: synthesisResult.tokensIn,
          tokensOut: synthesisResult.tokensOut,
          costUsd: synthesisResult.costUsd,
          durationMs: synthesisResult.durationMs,
        }
      );

      // Quality assessment
      onStageChange("deep_dive_quality", `Evaluating quality (Pass ${iterationCount})...`);

      const assessmentResult = await callLLM(
        FLASH_MODEL,
        `You are a quality assessor for municipal governance research reports. Score the analysis on two dimensions:

1. Quality (1-10): Is the analysis well-written, accurate, properly cited, and insightful?
2. Completeness (1-10): Does the analysis fully address the user's question and sub-questions?

Also identify:
- What aspects are missing or incomplete
- Which search approaches failed to produce useful results
- What new angles or queries might fill the gaps

Respond in JSON:
{
  "qualityScore": 8,
  "completenessScore": 7,
  "reasoning": "...",
  "missingAspects": ["..."],
  "failedApproaches": ["..."],
  "suggestedNewAngles": ["..."]
}`,
        `Original question: ${question}\n\nAnalysis to assess:\n${finalAnswer}\n\nEvidence count: ${allEvidence.length}\nIteration: ${iterationCount} of ${MAX_ITERATIONS}`,
        tracker,
        logContext,
      );

      await recordStep(deepDiveSession.id, tracker, "quality_check",
        finalAnswer.slice(0, 2000),
        assessmentResult.text,
        {
          modelUsed: FLASH_MODEL,
          tokensIn: assessmentResult.tokensIn,
          tokensOut: assessmentResult.tokensOut,
          costUsd: assessmentResult.costUsd,
          durationMs: assessmentResult.durationMs,
        }
      );

      let assessment: QualityAssessment;
      try {
        const jsonMatch = assessmentResult.text.match(/\{[\s\S]*\}/);
        assessment = jsonMatch ? JSON.parse(jsonMatch[0]) : { qualityScore: 7, completenessScore: 7, reasoning: "", missingAspects: [], failedApproaches: [], suggestedNewAngles: [] };
      } catch {
        assessment = { qualityScore: 7, completenessScore: 7, reasoning: "", missingAspects: [], failedApproaches: [], suggestedNewAngles: [] };
      }

      qualityScore = assessment.qualityScore;
      completenessScore = assessment.completenessScore;

      logInfo("deep_dive_quality_check", {
        ...logContext,
        iteration: iterationCount,
        qualityScore,
        completenessScore,
        missingAspects: assessment.missingAspects,
      });

      if (qualityScore >= QUALITY_THRESHOLD && completenessScore >= QUALITY_THRESHOLD) {
        break;
      }

      if (iteration < MAX_ITERATIONS - 1) {
        onStageChange("deep_dive_replanning", `Refining research plan (Pass ${iterationCount + 1})...`);

        const supplementalResult = await callLLM(
          FLASH_MODEL,
          `You are a research planner improving a previous research attempt. The previous attempt scored below threshold.

IMPORTANT: Do NOT repeat queries that already failed. Try completely different approaches:
- Different search terms and phrasings
- Different document types or time periods
- Different tools than what was tried before

Respond in JSON:
{
  "ragQueries": ["new query 1", ...],
  "newsTopics": ["new topic", ...],
  "webQueries": ["new query", ...],
  "reasoning": "Why these new approaches should find what was missing"
}`,
          `Original question: ${question}
Town: ${townPreference || "not specified"}

Previous assessment:
- Quality: ${qualityScore}/10, Completeness: ${completenessScore}/10
- Reasoning: ${assessment.reasoning}
- Missing aspects: ${assessment.missingAspects.join(", ")}
- Failed approaches: ${assessment.failedApproaches.join(", ")}
- Suggested new angles: ${assessment.suggestedNewAngles.join(", ")}

Previous queries used:
- RAG: ${plan.ragQueries.join(", ")}
- News: ${plan.newsTopics.join(", ")}
- Web: ${plan.webQueries.join(", ")}`,
          tracker,
          logContext,
        );

        await recordStep(deepDiveSession.id, tracker, "supplemental_plan",
          `Previous scores: Q=${qualityScore} C=${completenessScore}. Missing: ${assessment.missingAspects.join(", ")}`,
          supplementalResult.text,
          {
            modelUsed: FLASH_MODEL,
            reasoning: assessment.reasoning,
            tokensIn: supplementalResult.tokensIn,
            tokensOut: supplementalResult.tokensOut,
            costUsd: supplementalResult.costUsd,
            durationMs: supplementalResult.durationMs,
          }
        );

        try {
          const jsonMatch = supplementalResult.text.match(/\{[\s\S]*\}/);
          const supplemental = jsonMatch ? JSON.parse(jsonMatch[0]) : null;
          if (supplemental) {
            plan = {
              ragQueries: supplemental.ragQueries || [],
              newsTopics: supplemental.newsTopics || [],
              webQueries: supplemental.webQueries || [],
              reasoning: supplemental.reasoning || "",
            };
          }
        } catch {
          break;
        }
      }
    }

    const totalDurationMs = Date.now() - startTime;

    const uniqueDocNames = [...new Set(allDocumentNames)];
    const sources = await mapFileSearchDocumentsToCitations(uniqueDocNames);

    await updateDeepDiveSession(deepDiveSession.id, {
      status: "completed",
      finalAnswer,
      qualityScore,
      completenessScore,
      iterationCount,
      totalCostUsd: tracker.totalCostUsd.toFixed(6),
      totalDurationMs,
      completedAt: new Date(),
    });

    logInfo("deep_dive_completed", {
      ...logContext,
      deepDiveId: deepDiveSession.id,
      iterations: iterationCount,
      qualityScore,
      completenessScore,
      totalCostUsd: tracker.totalCostUsd,
      totalDurationMs,
    });

    return {
      sessionId,
      deepDiveId: deepDiveSession.id,
      answerText: finalAnswer,
      qualityScore,
      completenessScore,
      iterationCount,
      sources,
      totalCostUsd: tracker.totalCostUsd,
      totalDurationMs,
    };
  } catch (error) {
    const totalDurationMs = Date.now() - startTime;
    await updateDeepDiveSession(deepDiveSession.id, {
      status: "failed",
      iterationCount: 0,
      totalCostUsd: tracker.totalCostUsd.toFixed(6),
      totalDurationMs,
      completedAt: new Date(),
    });

    logError("deep_dive_failed", {
      ...logContext,
      deepDiveId: deepDiveSession.id,
      error: error instanceof Error ? error.message : String(error),
      totalCostUsd: tracker.totalCostUsd,
      totalDurationMs,
    });

    throw error;
  }
}
