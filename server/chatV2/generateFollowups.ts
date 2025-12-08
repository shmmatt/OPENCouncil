import { GoogleGenAI } from "@google/genai";
import { logLlmRequest, logLlmResponse, logLlmError } from "../utils/llmLogging";
import { isQuotaError } from "../utils/geminiErrors";
import type { PipelineLogContext } from "./types";

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY || "" });

const MODEL_NAME = "gemini-2.5-flash";

const FOLLOWUP_SYSTEM_PROMPT = `You are a follow-up question generator for a municipal governance Q&A assistant in New Hampshire.

Your job:
- Suggest 2-4 short follow-up questions the user might want to ask next.
- Questions must be directly related to the user's original question and the assistant's answer.
- They should help the user go deeper in useful directions, not random trivia.

IMPORTANT LOGIC:

1. If the question clearly targets a specific town (e.g. Ossipee, Conway, Bartlett):
   - At least ONE follow-up must ask about GENERAL New Hampshire / RSA-level context, for example:
     - "How are intermunicipal ambulance agreements typically established under New Hampshire law?"
     - "What does RSA 53-A say about intermunicipal agreements?"
     - "What are the state requirements for [topic] in New Hampshire?"

2. The other follow-ups should stay hyper-local, for example:
   - Asking about historical trends in that town's budget
   - Asking about related boards, warrants, or policies in that same town
   - Asking for clarification about actions taken at specific meetings
   - Asking about timeline or next steps for that town

3. Keep each follow-up:
   - Under 100 characters
   - Written in plain language a town official or resident would actually click.

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
