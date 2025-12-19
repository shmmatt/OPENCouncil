import { GoogleGenAI } from "@google/genai";
import type { RouterOutput, RetrievalPlan, CriticScore, PipelineLogContext } from "./types";
import { logLlmRequest, logLlmResponse, logLlmError } from "../utils/llmLogging";
import { isQuotaError, GeminiQuotaExceededError } from "../utils/geminiErrors";
import { logLLMCall, extractTokenCounts } from "../llm/callLLMWithLogging";
import { infoOnlyNotice } from "./scopeUtils";
import type { ChatNotice } from "@shared/chatNotices";
import { getModelForStage } from "../llm/modelRegistry";

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY || "" });

const CRITIC_SYSTEM_PROMPT = `You are reviewing a draft OpenCouncil answer for quality and accuracy.

Evaluate the answer on:
- relevance
- completeness
- clarity
- risk of misleading the reader

CHECKS YOU MUST PERFORM:

• If the question asks "why", "how", or for a breakdown:
  - Does the answer explain the general mechanism?
  - Does it identify all major contributing components?
  - If some components are missing, are they explicitly acknowledged?

• If the answer relies heavily on one category of documents:
  - Ensure it does not imply those documents explain the entire outcome unless justified.

• Remove speculation and unsupported causal claims.
• Tighten structure but do not add new facts.
• Add clarifying caveats where evidence is partial.
• Suggest follow-up questions that deepen understanding, not repair gaps.

Return an improved version of the answer, preserving tone and structure.

You MUST respond with valid JSON only:
{
  "criticScore": {
    "relevance": 0.0-1.0,
    "completeness": 0.0-1.0,
    "clarity": 0.0-1.0,
    "riskOfMisleading": 0.0-1.0
  },
  "improvedAnswerText": "the improved answer text",
  "limitationsNote": "brief note about limitations or null",
  "suggestedFollowUps": ["question1", "question2", "question3"]
}`;

interface CritiqueOptions {
  question: string;
  draftAnswerText: string;
  routerOutput: RouterOutput;
  retrievalPlan?: RetrievalPlan;
  logContext?: PipelineLogContext;
}

interface CritiqueResult {
  improvedAnswerText: string;
  criticScore: CriticScore;
  limitationsNote?: string;
  suggestedFollowUps: string[];
  notices: ChatNotice[];
}

export async function critiqueAndImproveAnswer(
  options: CritiqueOptions
): Promise<CritiqueResult> {
  const { question, draftAnswerText, routerOutput, retrievalPlan, logContext } = options;
  const { model: modelName } = getModelForStage('critic');

  const contextInfo = buildContextInfo(routerOutput, retrievalPlan);

  const userPrompt = `Evaluate and improve this draft answer.

QUESTION: "${question}"

DRAFT ANSWER:
${draftAnswerText}

CONTEXT:
- Complexity: ${routerOutput.complexity}
- Domains: ${routerOutput.domains.join(", ")}
${contextInfo}

Remember:
- This is for municipal officials in New Hampshire
- Accuracy and appropriate caution are critical
- If uncertain, say so rather than speculate
- Include the standard disclaimer about seeking professional legal advice when appropriate

Respond with valid JSON only.`;

  logLlmRequest({
    requestId: logContext?.requestId,
    sessionId: logContext?.sessionId,
    stage: "critic",
    model: modelName,
    systemPrompt: CRITIC_SYSTEM_PROMPT,
    userPrompt,
    temperature: 0.3,
    extra: {
      complexity: routerOutput.complexity,
      domains: routerOutput.domains,
      draftAnswerLength: draftAnswerText.length,
      hasTownPreference: !!retrievalPlan?.filters.townPreference,
    },
  });

  const startTime = Date.now();

  try {
    const response = await ai.models.generateContent({
      model: modelName,
      contents: [{ role: "user", parts: [{ text: userPrompt }] }],
      config: {
        systemInstruction: CRITIC_SYSTEM_PROMPT,
        temperature: 0.3,
      },
    });

    const responseText = response.text || "";
    const durationMs = Date.now() - startTime;

    logLlmResponse({
      requestId: logContext?.requestId,
      sessionId: logContext?.sessionId,
      stage: "critic",
      model: modelName,
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
          stage: "critic",
          model: modelName,
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

      const criticScore: CriticScore = {
        relevance: parseScore(parsed.criticScore?.relevance, 0.8),
        completeness: parseScore(parsed.criticScore?.completeness, 0.7),
        clarity: parseScore(parsed.criticScore?.clarity, 0.8),
        riskOfMisleading: parseScore(parsed.criticScore?.riskOfMisleading, 0.2),
      };

      return {
        improvedAnswerText: parsed.improvedAnswerText || draftAnswerText,
        criticScore,
        limitationsNote: parsed.limitationsNote || undefined,
        suggestedFollowUps: Array.isArray(parsed.suggestedFollowUps)
          ? parsed.suggestedFollowUps.slice(0, 3)
          : [],
        notices: [infoOnlyNotice()],
      };
    } catch (parseError) {
      logLlmError({
        requestId: logContext?.requestId,
        sessionId: logContext?.sessionId,
        stage: "critic_parse",
        model: modelName,
        error: parseError instanceof Error ? parseError : new Error(String(parseError)),
      });
      return getDefaultCritiqueResult(draftAnswerText);
    }
  } catch (error) {
    if (isQuotaError(error)) {
      const errMessage = error instanceof Error ? error.message : String(error);
      logLlmError({
        requestId: logContext?.requestId,
        sessionId: logContext?.sessionId,
        stage: "critic",
        model: modelName,
        error: error instanceof Error ? error : new Error(String(error)),
      });
      throw new GeminiQuotaExceededError(errMessage || "Gemini quota exceeded in critic");
    }
    
    logLlmError({
      requestId: logContext?.requestId,
      sessionId: logContext?.sessionId,
      stage: "critic",
      model: modelName,
      error: error instanceof Error ? error : new Error(String(error)),
    });
    
    return getDefaultCritiqueResult(draftAnswerText);
  }
}

function buildContextInfo(
  routerOutput: RouterOutput,
  retrievalPlan?: RetrievalPlan
): string {
  const parts: string[] = [];

  if (retrievalPlan) {
    if (retrievalPlan.filters.townPreference) {
      parts.push(`- Town focus: ${retrievalPlan.filters.townPreference}`);
    }
    if (retrievalPlan.filters.categories.length > 0) {
      parts.push(`- Document categories: ${retrievalPlan.filters.categories.join(", ")}`);
    }
    if (retrievalPlan.infoNeeds.length > 0) {
      parts.push(`- Information needs: ${retrievalPlan.infoNeeds.join("; ")}`);
    }
  }

  return parts.join("\n");
}

function parseScore(value: any, defaultValue: number): number {
  if (typeof value === "number" && value >= 0 && value <= 1) {
    return value;
  }
  if (typeof value === "string") {
    const parsed = parseFloat(value);
    if (!isNaN(parsed) && parsed >= 0 && parsed <= 1) {
      return parsed;
    }
  }
  return defaultValue;
}

function getDefaultCritiqueResult(draftAnswerText: string): CritiqueResult {
  return {
    improvedAnswerText: draftAnswerText,
    criticScore: {
      relevance: 0.7,
      completeness: 0.7,
      clarity: 0.7,
      riskOfMisleading: 0.3,
    },
    limitationsNote: "Unable to perform full quality review. Please verify information with official sources.",
    suggestedFollowUps: [],
    notices: [infoOnlyNotice()],
  };
}
