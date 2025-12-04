import { GoogleGenAI } from "@google/genai";
import type { RouterOutput, ChatHistoryMessage } from "./types";

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

3. CLARIFICATION: Does the question need clarification before answering?
   - Only require clarification if the question is genuinely ambiguous about WHICH town or topic
   - Do NOT ask for clarification on common governance terms

4. RERANKED QUESTION: Clean up the user's question for better retrieval (fix typos, expand abbreviations, etc.)

You MUST respond with valid JSON only, no other text. Use this exact format:
{
  "complexity": "simple" | "complex",
  "domains": ["array", "of", "relevant", "categories"],
  "requiresClarification": true | false,
  "clarificationQuestions": ["question1", "question2"] (empty array if no clarification needed),
  "rerankedQuestion": "cleaned up question text"
}`;

export async function routeQuestion(
  question: string,
  recentHistory: ChatHistoryMessage[],
  userHints?: { town?: string; board?: string }
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

  try {
    const response = await ai.models.generateContent({
      model: "gemini-2.5-flash",
      contents: [{ role: "user", parts: [{ text: userPrompt }] }],
      config: {
        systemInstruction: ROUTER_SYSTEM_PROMPT,
        temperature: 0.2,
      },
    });

    const responseText = response.text || "";
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
      console.error("Failed to parse router response:", cleanedText);
      return getDefaultRouterOutput(question);
    }
  } catch (error) {
    console.error("Router error:", error);
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
