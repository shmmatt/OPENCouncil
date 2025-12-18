import { GoogleGenAI } from "@google/genai";
import type { RouterOutput, ChatHistoryMessage, PipelineLogContext, ScopeHint } from "./types";
import { logLlmRequest, logLlmResponse, logLlmError } from "../utils/llmLogging";
import { isQuotaError, GeminiQuotaExceededError } from "../utils/geminiErrors";
import { logLLMCall, extractTokenCounts } from "../llm/callLLMWithLogging";

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY || "" });

const NH_TOWNS = [
  "Ossipee", "Conway", "Bartlett", "Madison", "Tamworth", "Freedom", "Effingham",
  "Moultonborough", "Sandwich", "Wolfeboro", "Wakefield", "Milton", "Farmington",
  "Rochester", "Dover", "Portsmouth", "Exeter", "Hampton", "Concord", "Manchester",
  "Nashua", "Keene", "Laconia", "Berlin", "Littleton", "Plymouth", "Hanover",
  "Lebanon", "Claremont", "Franklin", "Tilton", "Meredith", "Ashland", "Holderness",
  "Campton", "Thornton", "Lincoln", "Woodstock", "Franconia", "Sugar Hill", "Lisbon",
  "Bethlehem", "Whitefield", "Lancaster", "Gorham", "Jackson", "Albany", "Eaton",
  "Chatham", "Brookfield"
];

const RSA_PATTERNS = [
  /\bRSA\b/i,
  /\bRevised Statutes\b/i,
  /\bNew Hampshire law\b/i,
  /\bNH law\b/i,
  /\bstate law\b/i,
  /\bstate statute\b/i,
  /\bstate requirements?\b/i
];

function detectScopeHint(question: string, userHints?: { town?: string }): ScopeHint {
  const lowerQuestion = question.toLowerCase();
  
  const hasTownReference = userHints?.town || 
    NH_TOWNS.some(town => lowerQuestion.includes(town.toLowerCase()));
  
  const hasRSAReference = RSA_PATTERNS.some(pattern => pattern.test(question));
  
  if (hasTownReference && hasRSAReference) {
    return "mixed";
  } else if (hasRSAReference && !hasTownReference) {
    return "statewide";
  } else if (hasTownReference) {
    return "local";
  }
  
  return null;
}

export function isRSAQuestion(question: string): boolean {
  return RSA_PATTERNS.some(pattern => pattern.test(question));
}

function combineScopeHints(detected: ScopeHint, llm: ScopeHint): ScopeHint {
  if (detected === "mixed" || llm === "mixed") {
    return "mixed";
  }
  
  if (detected === "local" && llm === "statewide") {
    return "mixed";
  }
  if (detected === "statewide" && llm === "local") {
    return "mixed";
  }
  
  if (detected === "statewide" || llm === "statewide") {
    return "statewide";
  }
  
  if (detected === "local" || llm === "local") {
    return "local";
  }
  
  return llm || detected || null;
}

const ROUTER_SYSTEM_PROMPT = `You are the routing and classification agent for OpenCouncil, a municipal governance Q&A system.

Your job is to analyze the user's question and return a JSON object that determines how the system should handle it.

You must determine:

1. complexity: "simple" or "complex"
2. detectedDomains: an array of relevant document domains (e.g., budget, meeting_minutes, zoning, policy, elections, misc_other)
3. requiresClarification: true or false
4. clarificationQuestions: optional array of short questions if clarification is required
5. rerankedQuestion: a cleaned, retrieval-optimized version of the user's question
6. scopeHint: "local", "statewide", "mixed", or null
7. requiresComposedAnswer: true or false

IMPORTANT GUIDELINES:

• Complexity
  - Use "simple" only for narrow factual lookups.
  - Use "complex" for questions involving causes, explanations, comparisons, processes, or multiple contributing factors.

• requiresComposedAnswer
  Set this to true when the user is asking:
  - why something changed
  - how something is calculated or determined
  - for a breakdown of components
  - to explain or interpret a document, bill, notice, or outcome
  These questions require a complete, multi-part answer in a single response.

• Scope
  - Use "local" ONLY when the question is explicitly about a town-specific fact or event.
  - Use "statewide" ONLY when the question is explicitly about NH law or general practice.
  - Use "mixed" when:
    - the question references a specific town AND
    - understanding requires statewide process, law, or multi-entity context.
  When in doubt between "local" and "mixed", choose "mixed".

• Do NOT assume that a town name means the answer should be purely local.
• Do NOT collapse multi-factor questions into a single domain.
• Do NOT answer the question; only classify and prepare it.

You MUST respond with valid JSON only, no other text. Use this exact format:
{
  "complexity": "simple" | "complex",
  "domains": ["array", "of", "relevant", "categories"],
  "requiresClarification": true | false,
  "clarificationQuestions": ["question1", "question2"] (empty array if no clarification needed),
  "rerankedQuestion": "cleaned up question text",
  "scopeHint": "local" | "statewide" | "mixed" | null,
  "requiresComposedAnswer": true | false
}`;

const MODEL_NAME = "gemini-3-flash-preview";

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

    // Log usage for cost tracking
    if (logContext?.actor) {
      const tokens = extractTokenCounts(response);
      await logLLMCall(
        {
          actor: logContext.actor,
          sessionId: logContext.sessionId,
          requestId: logContext.requestId,
          stage: "router",
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
      const detectedScopeHint = detectScopeHint(question, userHints);
      const llmScopeHint = parsed.scopeHint as ScopeHint;
      
      const finalScopeHint = combineScopeHints(detectedScopeHint, llmScopeHint);
      
      return {
        complexity: parsed.complexity === "complex" ? "complex" : "simple",
        domains: Array.isArray(parsed.domains) ? parsed.domains : ["misc_other"],
        requiresClarification: Boolean(parsed.requiresClarification),
        clarificationQuestions: Array.isArray(parsed.clarificationQuestions)
          ? parsed.clarificationQuestions
          : [],
        rerankedQuestion: parsed.rerankedQuestion || question,
        scopeHint: finalScopeHint,
        requiresComposedAnswer: Boolean(parsed.requiresComposedAnswer),
      };
    } catch (parseError) {
      logLlmError({
        requestId: logContext?.requestId,
        sessionId: logContext?.sessionId,
        stage: "router_parse",
        model: MODEL_NAME,
        error: parseError instanceof Error ? parseError : new Error(String(parseError)),
      });
      return getDefaultRouterOutput(question, userHints);
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
    
    return getDefaultRouterOutput(question, userHints);
  }
}

function getDefaultRouterOutput(question: string, userHints?: { town?: string }): RouterOutput {
  return {
    complexity: "simple",
    domains: ["misc_other"],
    requiresClarification: false,
    clarificationQuestions: [],
    rerankedQuestion: question,
    scopeHint: detectScopeHint(question, userHints),
    requiresComposedAnswer: false,
  };
}
