import { GoogleGenAI } from "@google/genai";
import { logLLMCall } from "../llm/callLLMWithLogging";
import { logInfo, logError, logWarn } from "../utils/logger";
import { pgvectorTwoLaneRetrieveWithPlan } from "./pgvectorRetrieveAdapter";
import { buildRetrievalPlanForQuery } from "./plannerV3";
import { searchWeb, isWebSearchConfigured } from "../services/webSearchTool";
import { mapFileSearchDocumentsToCitations } from "./sources";
import {
  createDeepDiveSession,
  updateDeepDiveSession,
  createDeepDiveStep,
} from "../storage/deepDive";
import type { PipelineLogContext, SourceCitation, ChatHistoryMessage } from "./types";
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

function extractWebCitationsFromGrounding(response: any): SourceCitation[] {
  const citations: SourceCitation[] = [];
  if (!response) return citations;

  try {
    const candidate = response.candidates?.[0];
    const metadata = candidate?.groundingMetadata;
    if (!metadata?.groundingChunks) return citations;

    const seenUrls = new Set<string>();
    for (const chunk of metadata.groundingChunks) {
      try {
        if (!chunk.web?.uri || seenUrls.has(chunk.web.uri)) continue;
        const uri = chunk.web.uri;
        const parsed = new URL(uri);
        if (parsed.protocol !== "http:" && parsed.protocol !== "https:") continue;
        seenUrls.add(uri);
        const domain = chunk.web.domain || parsed.hostname;
        citations.push({
          id: uri,
          title: chunk.web.title || domain,
          url: uri,
          isInternal: false,
        });
      } catch (chunkErr) {
        logWarn("grounding_citation_chunk_error", { error: chunkErr instanceof Error ? chunkErr.message : String(chunkErr) });
      }
    }
  } catch (err) {
    logWarn("grounding_citation_extraction_error", { error: err instanceof Error ? err.message : String(err) });
  }

  return citations;
}

async function callLLM(
  model: string,
  systemPrompt: string,
  userPrompt: string,
  tracker: StepTracker,
  logContext: PipelineLogContext,
  tools?: any[],
): Promise<{ text: string; tokensIn: number; tokensOut: number; costUsd: number; durationMs: number; rawResponse: any }> {
  const start = Date.now();
  const config: any = {
    systemInstruction: systemPrompt,
    temperature: 0.3,
  };
  if (tools && tools.length > 0) {
    config.tools = tools;
  }
  const response = await ai.models.generateContent({
    model,
    contents: [{ role: "user", parts: [{ text: userPrompt }] }],
    config,
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

  return { text, tokensIn, tokensOut, costUsd, durationMs, rawResponse: response };
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
  chatHistory?: ChatHistoryMessage[];
  logContext: PipelineLogContext;
  onStageChange: (stage: string, detail?: string) => void;
}): Promise<DeepDiveResult> {
  const { question, townPreference, sessionId, messageId, chatHistory, logContext, onStageChange } = options;
  const startTime = Date.now();

  const formattedChatHistory = (chatHistory && chatHistory.length > 0)
    ? chatHistory.map(m => `${m.role === "user" ? "User" : "Assistant"}: ${m.content.slice(0, 1500)}`).join("\n")
    : "(No prior conversation in this session)";

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
      `You are an expert municipal research analyst. Your job is to analyze the user's latest query within the context of the recent conversation history.

CRITICAL INSTRUCTION: Read the Chat History first. The user's latest question may contain pronouns ("it", "he", "the project", "the town"). You MUST resolve these pronouns using the history to formulate a complete, standalone coreQuestion and specific subQuestions.

Respond in JSON format:
{
  "coreQuestion": "Fully resolved, standalone research question",
  "subQuestions": ["Specific angle 1", "Specific angle 2"],
  "recommendedTools": ["document_search", "web_search"],
  "entities": { "towns": [], "boards": [], "people": [], "statutes": [] },
  "timePeriod": "Any specific years mentioned or implied",
  "reasoning": "Brief explanation of how you resolved the intent"
}`,
      `Town context: ${townPreference || "not specified"}\n\n--- Recent Chat History ---\n${formattedChatHistory}\n\n--- Latest User Question ---\n${question}`,
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

    const resolvedQuestion = intentData.coreQuestion || question;

    onStageChange("deep_dive_planning", "Creating research plan...");

    const planResult = await callLLM(
      FLASH_MODEL,
      `You are a research planner for municipal governance. Based on the Intent Analysis, create a targeted search plan.

RULES:
- ragQueries (2-4): Highly specific keyword and semantic searches for our internal municipal database (minutes, budgets, ordinances, town reports). Use exact entity names, board names, and town names.
- webQueries (0-2): Broad searches intended for the live web to catch state-level data or context. (Note: Google Search Grounding will automatically run in a dedicated web research phase to find recent local news, so these are supplementary.)

Respond in JSON:
{
  "ragQueries": ["query1", "query2", ...],
  "webQueries": ["query1", ...],
  "reasoning": "Why these queries will find what we need"
}`,
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
      plan = jsonMatch ? JSON.parse(jsonMatch[0]) : { ragQueries: [question], webQueries: [], reasoning: "" };
    } catch {
      plan = { ragQueries: [question], webQueries: [], reasoning: "" };
    }

    let allEvidence: string[] = [];
    let allDocumentNames: string[] = [];
    let iterationCount = 0;
    let qualityScore = 0;
    let completenessScore = 0;
    let finalAnswer = "";
    let lastSynthesisResponse: any = null;
    let lastWebResearchResponse: any = null;

    for (let iteration = 0; iteration < MAX_ITERATIONS; iteration++) {
      iterationCount = iteration + 1;
      onStageChange("deep_dive_researching", `Researching (Pass ${iterationCount} of ${MAX_ITERATIONS})...`);

      const iterationEvidence: string[] = [];

      // Execute RAG retrieval
      if (plan.ragQueries.length > 0) {
        const ragStart = Date.now();
        try {
          for (const query of plan.ragQueries.slice(0, 4)) {
            const { retrievalPlan, issueMap } = buildRetrievalPlanForQuery(query, townPreference || undefined);

            const result = await pgvectorTwoLaneRetrieveWithPlan(
              retrievalPlan,
              issueMap,
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

      // Phase 1: Dedicated web research call with minimal context to force Google Search
      onStageChange("deep_dive_web_research", `Searching for recent news and updates...`);

      const currentDate = new Date().toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });
      let webResearchText = "";
      let webResearchResponse: any = null;
      lastWebResearchResponse = null;

      try {
        const webResearchResult = await callLLM(
          FLASH_MODEL,
          `You are a web research assistant. Today's date is: ${currentDate}.
Your ONLY job is to search Google for the MOST RECENT information about the topic below.
You MUST search — do not answer from memory. Use the googleSearch tool to find current news articles, government press releases, project updates, and official announcements.
Search for multiple angles: recent news coverage, official project status, awards, controversies, and any developments in the last 1-2 years.
After searching, compile a factual summary of what you found, including exact URLs for every source. If you found nothing recent, state that clearly.`,
          `Search for the latest information about: ${resolvedQuestion}\nLocation context: ${townPreference || "New Hampshire"}`,
          tracker,
          logContext,
          [{ googleSearch: {} }],
        );
        webResearchText = webResearchResult.text;
        webResearchResponse = webResearchResult.rawResponse;
        lastWebResearchResponse = webResearchResponse;

        const webGm = webResearchResponse?.candidates?.[0]?.groundingMetadata;
        logInfo("deep_dive_web_research_grounding", {
          ...logContext,
          hasGroundingMetadata: !!webGm,
          groundingChunkCount: webGm?.groundingChunks?.length || 0,
        });
      } catch (err) {
        logWarn("deep_dive_web_research_error", { ...logContext, error: err instanceof Error ? err.message : String(err) });
      }

      // Phase 2: Synthesis combining RAG evidence + web research results
      onStageChange("deep_dive_synthesizing", `Writing analysis (Pass ${iterationCount})...`);

      const evidenceBlock = allEvidence.map((e, i) => `--- Evidence ${i + 1} ---\n${e}`).join("\n\n");

      let webResearchSection = "";
      if (webResearchText) {
        webResearchSection = `\n\n--- Recent Web Research (from Google Search, conducted ${currentDate}) ---\n${webResearchText}`;
      }

      const synthesisResult = await callLLM(
        PRO_MODEL,
        `You are an expert municipal governance journalist writing a comprehensive research report for OPENCouncil.

Today's date is: ${currentDate}

NARRATIVE & STYLE RULES (CRITICAL):
- Do NOT write a disconnected, chronological list of meeting minutes or a "trivia dump."
- Synthesize the evidence into a cohesive, highly readable narrative. Group facts logically by theme (e.g., Funding Challenges, Project Milestones, Community Response, Regulatory Context) using descriptive ### headers.
- Start with a clear ## title that captures the core topic.
- Follow immediately with a ### Executive Summary (2-3 punchy sentences that answer the user's question upfront).
- Write in Smart Brevity style: punchy, factual, and easy to scan. Use bullet points only for actionable lists or distinct data sets, not as a substitute for narrative prose.
- Use **bold** for key terms, proper nouns, dollar amounts, dates, and vote counts.
- Do NOT use memo/letter formatting (no "To:", "From:", "Date:", "Subject:" headers).
- Do NOT roleplay a persona or sign off with a name/title.
- Write 500-1000 words.

INTEGRATING WEB RESEARCH:
- The evidence below includes BOTH municipal documents AND recent web research results gathered via Google Search.
- The "Recent Web Research" section at the end contains the latest publicly available information. Integrate these findings into your report where relevant.
- When municipal documents and web research conflict, note both and indicate which is more recent.

CITATION RULES (STRICT):
- Do NOT use any inline citations, footnotes, or bracketed references in the text (e.g., do not write [minutes-117.pdf] or [1]).
- Do NOT insert markdown links for the web sources in the body of the text.
- Write the narrative smoothly and seamlessly as a clean article. The user interface will automatically provide a separate list of all sources at the bottom of the screen.

ENDING:
- Conclude with a ### What You Can Do section containing 2-3 highly specific, actionable next steps for the citizen.
- Be concrete — include actual URLs, board names, meeting schedules, or contact pages when available from the evidence.
- Instead of "check the town website," say "Review the [Ossipee Select Board agenda page](url)" if a URL was found.
- If no specific URL is available, give the most specific direction possible (e.g., "Contact the Planning Board clerk at Town Hall").

Town context: ${townPreference || "New Hampshire (general)"}

CRITICAL CONSTRAINT — TONE AND TEMPORAL HONESTY:
- Use a neutral, factual, professional tone throughout.
- NEVER use dramatic, editorial, or speculative language. Specifically BANNED phrases include: "has gone cold", "remains shrouded", "a mystery", "only time will tell", "the clock is ticking", "behind closed doors", "raises questions", "silence is deafening", "unanswered questions", and similar editorial language.
- Today's date is ${currentDate}. If the most recent evidence is from months or years ago, state this with dry neutrality: "The most recent official municipal record provided regarding this topic is dated [Month Year]."
- Do NOT speculate on why records stopped or editorialize about the gap.
- Never present old information as if it is current.`,
        `Research question: ${resolvedQuestion}\n\nGathered Evidence:\n${evidenceBlock.slice(0, 30000)}${webResearchSection}`,
        tracker,
        logContext,
      );

      finalAnswer = synthesisResult.text;
      lastSynthesisResponse = synthesisResult.rawResponse;

      const gm = webResearchResponse?.candidates?.[0]?.groundingMetadata;
      logInfo("deep_dive_grounding_metadata", {
        ...logContext,
        hasGroundingMetadata: !!gm,
        groundingChunkCount: gm?.groundingChunks?.length || 0,
      });

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
        `You are a senior editorial editor grading a municipal research report. Score it strictly on two dimensions:

1. Quality (1-10): Does this read like a cohesive, journalistic narrative? Is it grouped by logical themes rather than a boring chronological list of facts? Does it use proper markdown formatting (## title, ### sections, **bold**)? Is the text free of inline citations, bracketed references, or raw filenames (those are shown separately in the UI)? Does it avoid dramatic "true-crime" phrasing ("gone cold", "remains a mystery", etc.)? Is the Executive Summary punchy and does it answer the question upfront?
2. Completeness (1-10): Did it fully answer the core question? Did web research successfully find recent news to bridge gaps in older municipal records? Are the "What You Can Do" action items specific (with board names, URLs, or contacts)?

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
        `Original question: ${resolvedQuestion}\n\nAnalysis to assess:\n${finalAnswer}\n\nEvidence count: ${allEvidence.length}\nIteration: ${iterationCount} of ${MAX_ITERATIONS}`,
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

Note: Current local news is handled automatically via a dedicated Google Search web research phase. Focus on document retrieval and web queries.

Respond in JSON:
{
  "ragQueries": ["new query 1", ...],
  "webQueries": ["new query", ...],
  "reasoning": "Why these new approaches should find what was missing"
}`,
          `Original question: ${resolvedQuestion}
Town: ${townPreference || "not specified"}

Previous assessment:
- Quality: ${qualityScore}/10, Completeness: ${completenessScore}/10
- Reasoning: ${assessment.reasoning}
- Missing aspects: ${assessment.missingAspects.join(", ")}
- Failed approaches: ${assessment.failedApproaches.join(", ")}
- Suggested new angles: ${assessment.suggestedNewAngles.join(", ")}

Previous queries used:
- RAG: ${plan.ragQueries.join(", ")}
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
    const sources: SourceCitation[] = await mapFileSearchDocumentsToCitations(uniqueDocNames);

    const webCitations = extractWebCitationsFromGrounding(lastWebResearchResponse);
    if (webCitations.length > 0) {
      const beforeCount = sources.length;
      const existingUrls = new Set(sources.filter(s => s.url).map(s => s.url));
      for (const wc of webCitations) {
        if (!existingUrls.has(wc.url)) {
          existingUrls.add(wc.url);
          sources.push(wc);
        }
      }
      logInfo("deep_dive_web_citations", {
        ...logContext,
        webCitationCount: webCitations.length,
        addedCount: sources.length - beforeCount,
      });
    }

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
