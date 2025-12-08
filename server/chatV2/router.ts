import { GoogleGenAI } from "@google/genai";
import type { RouterOutput, ChatHistoryMessage, PipelineLogContext, ScopeHint } from "./types";
import { logLlmRequest, logLlmResponse, logLlmError } from "../utils/llmLogging";
import { isQuotaError, GeminiQuotaExceededError } from "../utils/geminiErrors";

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

5. SCOPE HINT: Determine the scope of the question:
   - "local": Question specifically about a town/municipality (e.g., "What is Ossipee's budget?")
   - "statewide": Question about NH law, RSAs, or state-level requirements without referencing a specific town
   - "mixed": Question mentions both a specific town AND state law/RSAs
   - null: Cannot determine scope

You MUST respond with valid JSON only, no other text. Use this exact format:
{
  "complexity": "simple" | "complex",
  "domains": ["array", "of", "relevant", "categories"],
  "requiresClarification": true | false,
  "clarificationQuestions": ["question1", "question2"] (empty array if no clarification needed),
  "rerankedQuestion": "cleaned up question text",
  "scopeHint": "local" | "statewide" | "mixed" | null
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
  };
}
