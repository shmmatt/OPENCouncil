import { GoogleGenAI } from "@google/genai";
import { logLlmRequest, logLlmResponse, logLlmError } from "../utils/llmLogging";
import { isQuotaError } from "../utils/geminiErrors";
import { logLLMCall, extractTokenCounts } from "../llm/callLLMWithLogging";
import type { PipelineLogContext } from "./types";

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY || "" });

const MODEL_NAME = "gemini-3-flash-preview";

const FOLLOWUP_SYSTEM_PROMPT = `You are generating follow-up questions for OpenCouncil.

Your task is to suggest 2–4 short follow-up questions that help the user explore the topic more deeply.

RULES:

• Questions must build on the answer, not correct it.
• If the original question involved a specific town:
  - At least one follow-up must address statewide law, process, or authority.
• Others may explore:
  - historical trends
  - related boards or entities
  - timelines
  - comparisons across years or towns

• Each question must be under 100 characters.
• Avoid redundancy with information already explained.

Do not generate follow-ups that exist only because the initial answer was incomplete.

Output format:
Return a JSON array of strings, like:
["Question 1...", "Question 2...", "Question 3..."]`;

interface GenerateFollowupsParams {
  userQuestion: string;
  answerText: string;
  townPreference?: string | null;
  detectedDomains?: string[];
  logContext?: PipelineLogContext;
}

export async function generateFollowups(
  params: GenerateFollowupsParams
): Promise<string[]> {
  const { userQuestion, answerText, townPreference, detectedDomains, logContext } = params;

  const townContext = townPreference
    ? `The question is about a specific town: ${townPreference}`
    : "No specific town was mentioned - this appears to be a general New Hampshire question.";

  const domainContext = detectedDomains && detectedDomains.length > 0
    ? `Relevant document categories: ${detectedDomains.join(", ")}`
    : "";

  const userPrompt = `Generate 2-4 follow-up questions based on this conversation.

USER QUESTION: "${userQuestion}"

ASSISTANT'S ANSWER (summary):
${answerText.slice(0, 800)}${answerText.length > 800 ? "..." : ""}

CONTEXT:
${townContext}
${domainContext}

Remember:
- If a specific town is mentioned, include at least one follow-up that asks about general NH/RSA context.
- Keep questions short (under 100 characters) and practical.
- Respond with a JSON array of strings only.`;

  logLlmRequest({
    requestId: logContext?.requestId,
    sessionId: logContext?.sessionId,
    stage: "generateFollowups",
    model: MODEL_NAME,
    systemPrompt: FOLLOWUP_SYSTEM_PROMPT,
    userPrompt,
    temperature: 0.4,
    extra: {
      townPreference,
      detectedDomains,
      answerLength: answerText.length,
    },
  });

  const startTime = Date.now();

  try {
    const response = await ai.models.generateContent({
      model: MODEL_NAME,
      contents: [{ role: "user", parts: [{ text: userPrompt }] }],
      config: {
        systemInstruction: FOLLOWUP_SYSTEM_PROMPT,
        temperature: 0.4,
      },
    });

    const responseText = response.text || "";
    const durationMs = Date.now() - startTime;

    logLlmResponse({
      requestId: logContext?.requestId,
      sessionId: logContext?.sessionId,
      stage: "generateFollowups",
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
          stage: "followups",
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
      if (Array.isArray(parsed)) {
        return parsed
          .filter((q): q is string => typeof q === "string" && q.length > 0)
          .slice(0, 4);
      }
      return [];
    } catch (parseError) {
      logLlmError({
        requestId: logContext?.requestId,
        sessionId: logContext?.sessionId,
        stage: "generateFollowups_parse",
        model: MODEL_NAME,
        error: parseError instanceof Error ? parseError : new Error(String(parseError)),
      });
      return [];
    }
  } catch (error) {
    if (isQuotaError(error)) {
      logLlmError({
        requestId: logContext?.requestId,
        sessionId: logContext?.sessionId,
        stage: "generateFollowups",
        model: MODEL_NAME,
        error: error instanceof Error ? error : new Error(String(error)),
      });
      return [];
    }

    logLlmError({
      requestId: logContext?.requestId,
      sessionId: logContext?.sessionId,
      stage: "generateFollowups",
      model: MODEL_NAME,
      error: error instanceof Error ? error : new Error(String(error)),
    });

    return [];
  }
}
