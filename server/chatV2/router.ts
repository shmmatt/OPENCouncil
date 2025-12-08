import { GoogleGenAI } from "@google/genai";
import type { RouterOutput, ChatHistoryMessage, PipelineLogContext } from "./types";
import { logLlmRequest, logLlmResponse, logLlmError } from "../utils/llmLogging";
import { isQuotaError, GeminiQuotaExceededError } from "../utils/geminiErrors";

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY || "" });

const ROUTER_SYSTEM_PROMPT = `You are a router for a municipal governance Q&A assistant that helps small-town elected officials and public workers in New Hampshire.

Your job is to analyze each user question and determine:
1. COMPLEXITY: Is this a "simple" or "complex" question?
   - Simple: Straightforward, single-topic questions with clear answers (e.g., "What is the quorum for a planning board?")
   - Complex: Multi-part questions, comparative analysis, procedural questions requiring multiple sources (e.g., "How does the site plan review process differ between Conway and Bartlett?")

2. DOMAINS: What document categories are relevant? Choose from:
   - budget, zoning, meeting_minutes, town_report, warrant_article
   - ordinance, policy, planning_board_docs, zba_docs, licensing_permits
   - cip, elections, misc_other

IMPORTANT FOR MEETING MINUTES:
If the user asks about:
- "minutes", "meeting minutes", "last night's meeting"
- What a board "decided", "discussed", "voted on"
- What happened at a specific meeting or date
- Actions, motions, or decisions made by a board
Then the primary domain should be "meeting_minutes".

3. CLARIFICATION: Does the question need clarification before answering?
   - Only require clarification if the question is genuinely ambiguous about WHICH town or topic
   - Do NOT ask for clarification on common governance terms

4. RERANKED QUESTION: Clean up the user's question for better retrieval (fix typos, expand abbreviations, etc.)
   IMPORTANT: If the user names a specific town (e.g., "Ossipee", "Conway", "Bartlett"), you MUST preserve that town name in rerankedQuestion.
   The town name is critical for downstream retrieval - never strip it out or generalize it.

You MUST respond with valid JSON only, no other text. Use this exact format:
{
  "complexity": "simple" | "complex",
  "domains": ["array", "of", "relevant", "categories"],
  "requiresClarification": true | false,
  "clarificationQuestions": ["question1", "question2"] (empty array if no clarification needed),
  "rerankedQuestion": "cleaned up question text"
}`;

const MODEL_NAME = "gemini-2.5-flash";

export async function routeQuestion(
  question: string,
  recentHistory: ChatHistoryMessage[],
  userHints?: { town?: string; board?: string },
  logContext?: PipelineLogContext
): Promise<RouterOutput> {
  const historyContext = recentHistory.length > 0
    ? `\nRecent conversation context:\n${recentHistory.slice(-4).map(m => `${m.role}: ${m.content}`).join("\n")}`
    : "";

  const hintsContext = userHints
    ? `\nUser hints: ${userHints.town ? `Town: ${userHints.town}` : ""}${userHints.board ? ` Board: ${userHints.board}` : ""}`
    : "";

  const userPrompt = `Analyze this question and respond with JSON only:

Question: "${question}"${historyContext}${hintsContext}

Remember: Respond with valid JSON only, no other text.`;

  logLlmRequest({
    requestId: logContext?.requestId,
    sessionId: logContext?.sessionId,
    stage: "router",
    model: MODEL_NAME,
    systemPrompt: ROUTER_SYSTEM_PROMPT,
    userPrompt,
    temperature: 0.2,
    extra: {
      historyLength: recentHistory.length,
      hasUserHints: !!userHints,
    },
  });

  const startTime = Date.now();

  try {
    const response = await ai.models.generateContent({
      model: MODEL_NAME,
      contents: [{ role: "user", parts: [{ text: userPrompt }] }],
      config: {
        systemInstruction: ROUTER_SYSTEM_PROMPT,
        temperature: 0.2,
      },
    });

    const responseText = response.text || "";
    const durationMs = Date.now() - startTime;

    logLlmResponse({
      requestId: logContext?.requestId,
      sessionId: logContext?.sessionId,
      stage: "router",
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
      return {
        complexity: parsed.complexity === "complex" ? "complex" : "simple",
        domains: Array.isArray(parsed.domains) ? parsed.domains : ["misc_other"],
        requiresClarification: Boolean(parsed.requiresClarification),
        clarificationQuestions: Array.isArray(parsed.clarificationQuestions)
          ? parsed.clarificationQuestions
          : [],
        rerankedQuestion: parsed.rerankedQuestion || question,
      };
    } catch (parseError) {
      logLlmError({
        requestId: logContext?.requestId,
        sessionId: logContext?.sessionId,
        stage: "router_parse",
        model: MODEL_NAME,
        error: parseError instanceof Error ? parseError : new Error(String(parseError)),
      });
      return getDefaultRouterOutput(question);
    }
  } catch (error) {
    if (isQuotaError(error)) {
      const errMessage = error instanceof Error ? error.message : String(error);
      logLlmError({
        requestId: logContext?.requestId,
        sessionId: logContext?.sessionId,
        stage: "router",
        model: MODEL_NAME,
        error: error instanceof Error ? error : new Error(String(error)),
      });
      throw new GeminiQuotaExceededError(errMessage || "Gemini quota exceeded in router");
    }
    
    logLlmError({
      requestId: logContext?.requestId,
      sessionId: logContext?.sessionId,
      stage: "router",
      model: MODEL_NAME,
      error: error instanceof Error ? error : new Error(String(error)),
    });
    
    return getDefaultRouterOutput(question);
  }
}

function getDefaultRouterOutput(question: string): RouterOutput {
  return {
    complexity: "simple",
    domains: ["misc_other"],
    requiresClarification: false,
    clarificationQuestions: [],
    rerankedQuestion: question,
  };
}
