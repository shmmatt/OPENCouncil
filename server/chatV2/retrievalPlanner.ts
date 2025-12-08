import { GoogleGenAI } from "@google/genai";
import type { RouterOutput, RetrievalPlan, PipelineLogContext } from "./types";
import { logLlmRequest, logLlmResponse, logLlmError } from "../utils/llmLogging";
import { isQuotaError, GeminiQuotaExceededError } from "../utils/geminiErrors";

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY || "" });

const PLANNER_SYSTEM_PROMPT = `You are a retrieval planner for a municipal governance Q&A assistant in New Hampshire.

Given a complex municipal governance question and routing information, decide which document types to search and what information is needed.

Document categories available:
- budget: Town budgets, financial reports
- zoning: Zoning ordinances, maps, regulations
- meeting_minutes: Board/committee meeting minutes (IMPORTANT: Use this category when user asks about what happened at a meeting, meeting discussions, board decisions, votes, or actions taken at meetings)
- town_report: Annual town reports
- warrant_article: Town meeting warrant articles
- ordinance: Local ordinances and bylaws
- policy: Policies and procedures
- planning_board_docs: Planning board materials, site plans
- zba_docs: Zoning Board of Adjustment materials, variances
- licensing_permits: Licenses and permit information
- cip: Capital Improvement Plans
- elections: Election materials
- misc_other: Other documents

SPECIAL GUIDANCE FOR MEETING MINUTES:
When a user's question mentions any of these, prioritize "meeting_minutes" category:
- "minutes", "meeting", "last night's meeting", "meeting on [date]"
- "what did the [board] decide", "what was discussed", "what happened at"
- "vote on", "approved by", "actions taken", "motion to"
- Questions about specific board discussions or decisions on dates
For meeting-related questions, ONLY include "meeting_minutes" in categories to focus the search.

RECENCY PREFERENCE:
When the user's question includes words like "currently", "now", "this year", "recent", "latest", or a specific year (e.g. "2025"), you must:
- Set "preferRecent": true
- Prefer recent meeting_minutes and current or specified year budgets for the town
- Set categories to focus on ["meeting_minutes", "budget"] first; include "town_report", "policy", or "ordinance" only if clearly relevant
- In infoNeeds, be explicit that you want "most recent" or "current-year" data, not historical information

HYPER-LOCAL PREFERENCE (IMPORTANT):
- If the user question names a specific town (e.g. "Ossipee", "Conway", "Bartlett"):
  - Set filters.townPreference to that exact town name.
  - Set filters.allowStatewideFallback to false UNLESS the user explicitly asks about "New Hampshire" or state law in general.
- If the user explicitly asks about state-wide law or "New Hampshire" generally, you may set filters.townPreference to null and allowStatewideFallback to true.

MEETING-MINUTES AND BUDGET GUIDANCE:
- If the user is asking what happened at a meeting, about board decisions, or about how something was decided:
  - Always include "meeting_minutes" in filters.categories.
- If the user is asking about costs, spending, or budgets:
  - Always include "budget" and/or "town_report" in filters.categories.

RSA / STATUTE GUIDANCE:
- Do NOT set rsaChapters in filters.rsaChapters unless the user explicitly asks about state law, statutes, or "RSA".
- Default to local documents (meeting_minutes, budget, ordinance) over RSA references.

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

const MODEL_NAME = "gemini-2.5-flash";

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

  const userPrompt = `Create a retrieval plan for this complex question:

Question: "${routerOutput.rerankedQuestion || question}"

Detected domains: ${routerOutput.domains.join(", ")}
${scopeContext}
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
        allowStatewideFallback = false;
      } else if (routerOutput.scopeHint === "statewide") {
        townPreference = undefined;
        allowStatewideFallback = true;
        if (!categories.some((c: string) => ["policy", "ordinance", "misc_other"].includes(c))) {
          categories = [...categories, "policy", "ordinance", "misc_other"];
        }
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
