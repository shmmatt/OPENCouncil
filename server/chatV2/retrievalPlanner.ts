import { GoogleGenAI } from "@google/genai";
import type { RouterOutput, RetrievalPlan, PipelineLogContext } from "./types";
import { logLlmRequest, logLlmResponse, logLlmError } from "../utils/llmLogging";
import { isQuotaError, GeminiQuotaExceededError } from "../utils/geminiErrors";
import { logLLMCall, extractTokenCounts } from "../llm/callLLMWithLogging";

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY || "" });

const PLANNER_SYSTEM_PROMPT = `You are the retrieval planning agent for OpenCouncil.

Your job is to design a document retrieval plan that provides sufficient evidence to answer the user's question accurately and completely.

Inputs include:
- user question
- detected domains
- scopeHint ("local", "statewide", "mixed")
- requiresComposedAnswer (boolean)

You must output a JSON retrieval plan specifying:
- townPreference (string or null)
- allowStatewideFallback (boolean)
- categories (array)
- boards (array or null)
- rsaChapters (array or null)
- preferRecent (boolean)
- infoNeeds (array of information goals)

CRITICAL RULES:

• MEETING MINUTES AND BUDGET GUIDANCE (MANDATORY):
  - If the user asks about what happened at a meeting, board decisions, votes, discussions, or actions taken:
    - ALWAYS include "meeting_minutes" in categories
  - If the user asks about costs, spending, budgets, or financial matters:
    - ALWAYS include "budget" and/or "town_report" in categories
  - For meeting-related questions with a specific town, prioritize town-specific minutes

• If requiresComposedAnswer is true:
  - Plan for MULTIPLE contributing facets when the question has multiple causes
  - Include diverse categories when the question involves multi-factor explanations
  - Still ensure meeting_minutes/budget are included when relevant

• Scope handling:
  - If scopeHint is "mixed":
    - set townPreference to the relevant town
    - set allowStatewideFallback = true
  - If scopeHint is "local":
    - set allowStatewideFallback = false (prefer local documents)
    - Only set allowStatewideFallback = true if requiresComposedAnswer AND the question clearly requires statewide process context
  - If scopeHint is "statewide":
    - set townPreference = null
    - set allowStatewideFallback = true

• RECENCY PREFERENCE:
  When the user's question includes "currently", "now", "this year", "recent", "latest", or a specific year:
  - Set "preferRecent": true
  - Focus on recent meeting_minutes and current-year budgets
  - In infoNeeds, be explicit about wanting "most recent" or "current-year" data

• Information goals:
  - Include at least one infoNeed describing local decisions, changes, or data
  - When requiresComposedAnswer is true, also include process/mechanism context if relevant

• Do NOT assume municipal budgets alone explain outcomes that involve schools, counties, or state processes.

You MUST respond with valid JSON only:
{
  "filters": {
    "townPreference": "Town Name or null",
    "allowStatewideFallback": true | false,
    "categories": ["array of relevant categories"],
    "boards": ["Planning Board", "Select Board", etc.],
    "rsaChapters": ["RSA chapter numbers if relevant, e.g., '91-A', '673', '32']
  },
  "infoNeeds": ["plain-language description of what info to look for"],
  "preferRecent": true | false
}`;

const MODEL_NAME = "gemini-3-flash-preview";

interface PlanRetrievalOptions {
  question: string;
  routerOutput: RouterOutput;
  userHints?: { town?: string; board?: string };
  logContext?: PipelineLogContext;
}

export async function planRetrieval(
  options: PlanRetrievalOptions
): Promise<RetrievalPlan> {
  const { question, routerOutput, userHints, logContext } = options;

  const scopeContext = routerOutput.scopeHint 
    ? `Scope hint: ${routerOutput.scopeHint}` 
    : "Scope hint: not determined";

  const requiresComposedAnswer = routerOutput.requiresComposedAnswer ?? false;

  const userPrompt = `Create a retrieval plan for this question:

Question: "${routerOutput.rerankedQuestion || question}"

Detected domains: ${routerOutput.domains.join(", ")}
${scopeContext}
requiresComposedAnswer: ${requiresComposedAnswer}
${userHints?.town ? `Town hint: ${userHints.town}` : "No town specified"}
${userHints?.board ? `Board hint: ${userHints.board}` : "No board specified"}

Respond with valid JSON only.`;

  logLlmRequest({
    requestId: logContext?.requestId,
    sessionId: logContext?.sessionId,
    stage: "retrievalPlanner",
    model: MODEL_NAME,
    systemPrompt: PLANNER_SYSTEM_PROMPT,
    userPrompt,
    temperature: 0.2,
    extra: {
      detectedDomains: routerOutput.domains,
      townHint: userHints?.town,
      boardHint: userHints?.board,
      scopeHint: routerOutput.scopeHint,
    },
  });

  const startTime = Date.now();

  try {
    const response = await ai.models.generateContent({
      model: MODEL_NAME,
      contents: [{ role: "user", parts: [{ text: userPrompt }] }],
      config: {
        systemInstruction: PLANNER_SYSTEM_PROMPT,
        temperature: 0.2,
      },
    });

    const responseText = response.text || "";
    const durationMs = Date.now() - startTime;

    logLlmResponse({
      requestId: logContext?.requestId,
      sessionId: logContext?.sessionId,
      stage: "retrievalPlanner",
      model: MODEL_NAME,
      responseText,
      durationMs,
    });

    // Log usage for cost tracking
    if (logContext?.actor) {
      const tokens = extractTokenCounts(response);
      await logLLMCall(
        {
          actor: logContext.actor,
          sessionId: logContext.sessionId,
          requestId: logContext.requestId,
          stage: "retrievalPlanner",
          model: MODEL_NAME,
        },
        { text: responseText, tokensIn: tokens.tokensIn, tokensOut: tokens.tokensOut }
      );
    }

    const cleanedText = responseText
      .replace(/```json\n?/g, "")
      .replace(/```\n?/g, "")
      .trim();

    try {
      const parsed = JSON.parse(cleanedText);
      const preferRecent = parsed.preferRecent === true || detectRecencyIntent(question);
      
      let townPreference = parsed.filters?.townPreference || userHints?.town || undefined;
      let allowStatewideFallback = parsed.filters?.allowStatewideFallback !== false;
      let categories = Array.isArray(parsed.filters?.categories)
        ? parsed.filters.categories
        : routerOutput.domains;
      
      if (routerOutput.scopeHint === "local") {
        // For local questions, prefer local documents unless LLM specifically allowed fallback
        allowStatewideFallback = parsed.filters?.allowStatewideFallback === true;
      } else if (routerOutput.scopeHint === "statewide") {
        townPreference = undefined;
        allowStatewideFallback = true;
      } else if (routerOutput.scopeHint === "mixed") {
        allowStatewideFallback = true;
      }
      
      return {
        filters: {
          townPreference,
          allowStatewideFallback,
          categories,
          boards: Array.isArray(parsed.filters?.boards)
            ? parsed.filters.boards
            : userHints?.board
              ? [userHints.board]
              : [],
          rsaChapters: Array.isArray(parsed.filters?.rsaChapters)
            ? parsed.filters.rsaChapters
            : [],
        },
        infoNeeds: Array.isArray(parsed.infoNeeds)
          ? parsed.infoNeeds
          : ["General information about the topic"],
        preferRecent,
      };
    } catch (parseError) {
      logLlmError({
        requestId: logContext?.requestId,
        sessionId: logContext?.sessionId,
        stage: "retrievalPlanner_parse",
        model: MODEL_NAME,
        error: parseError instanceof Error ? parseError : new Error(String(parseError)),
      });
      return getDefaultRetrievalPlan(routerOutput, userHints);
    }
  } catch (error) {
    if (isQuotaError(error)) {
      const errMessage = error instanceof Error ? error.message : String(error);
      logLlmError({
        requestId: logContext?.requestId,
        sessionId: logContext?.sessionId,
        stage: "retrievalPlanner",
        model: MODEL_NAME,
        error: error instanceof Error ? error : new Error(String(error)),
      });
      throw new GeminiQuotaExceededError(errMessage || "Gemini quota exceeded in retrievalPlanner");
    }
    
    logLlmError({
      requestId: logContext?.requestId,
      sessionId: logContext?.sessionId,
      stage: "retrievalPlanner",
      model: MODEL_NAME,
      error: error instanceof Error ? error : new Error(String(error)),
    });
    
    return getDefaultRetrievalPlan(routerOutput, userHints);
  }
}

function getDefaultRetrievalPlan(
  routerOutput: RouterOutput,
  userHints?: { town?: string; board?: string }
): RetrievalPlan {
  return {
    filters: {
      townPreference: userHints?.town,
      allowStatewideFallback: true,
      categories: routerOutput.domains.length > 0 ? routerOutput.domains : ["misc_other"],
      boards: userHints?.board ? [userHints.board] : [],
      rsaChapters: [],
    },
    infoNeeds: ["General information about the topic"],
    preferRecent: false,
  };
}

const RECENCY_KEYWORDS = [
  "currently",
  "now",
  "this year",
  "recent",
  "recently",
  "latest",
  "today",
  "right now",
  "at the moment",
  "present",
  "presently",
  "2024",
  "2025",
];

function detectRecencyIntent(question: string): boolean {
  const lowerQuestion = question.toLowerCase();
  return RECENCY_KEYWORDS.some((keyword) => lowerQuestion.includes(keyword));
}
