/**
 * Unified Chat Pipeline
 * 
 * Simplified pipeline that:
 * 1. Runs parallel local + statewide retrieval
 * 2. Merges chunks
 * 3. Synthesizes one answer
 * 
 * No router, no evidence gate, no simple vs complex branching.
 */

import { GoogleGenAI } from "@google/genai";
import { getOrCreateFileSearchStoreId } from "../gemini-store";
import { logDebug, logError } from "../utils/logger";
import { logLlmRequest, logLlmResponse, logLlmError } from "../utils/llmLogging";
import { isQuotaError, GeminiQuotaExceededError } from "../utils/geminiErrors";
import { getModelForStage } from "../llm/modelRegistry";
import { logLLMCall, extractTokenCounts } from "../llm/callLLMWithLogging";
import { chatConfig } from "./chatConfig";
import type { PipelineLogContext, ChatHistoryMessage, DocSourceType } from "./types";
import type { SituationContext } from "@shared/schema";
import { twoLaneRetrieve, extractTwoLaneDocNames, buildTwoLaneSnippetText, classifyTwoLaneDocSource, type LaneChunk, type TwoLaneRetrievalResult } from "./twoLaneRetrieve";

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY || "" });

export interface UnifiedPipelineOptions {
  question: string;
  sessionHistory: ChatHistoryMessage[];
  townPreference?: string | null;
  situationContext?: SituationContext | null;
  logContext?: PipelineLogContext;
}

export interface UnifiedPipelineResult {
  answerText: string;
  sourceDocumentNames: string[];
  docSourceType: DocSourceType;
  docSourceTown: string | null;
  retrievedChunkCount: number;
  durationMs: number;
}

/**
 * Main unified pipeline - two lanes + one synthesis
 */
export async function runUnifiedChatPipeline(
  options: UnifiedPipelineOptions
): Promise<UnifiedPipelineResult> {
  const { question, sessionHistory, townPreference, situationContext, logContext } = options;
  const startTime = Date.now();

  logDebug("unified_pipeline_start", {
    requestId: logContext?.requestId,
    sessionId: logContext?.sessionId,
    stage: "unified_pipeline",
    questionLength: question.length,
    townPreference,
    historyLength: sessionHistory.length,
    hasSituationContext: !!situationContext,
    situationTitle: situationContext?.title,
  });

  // Step 1: Two-lane parallel retrieval with situation context
  const retrievalResult = await twoLaneRetrieve({
    userQuestion: question,
    rerankedQuestion: question,
    townPreference,
    situationContext,
    logContext,
  });

  const mergedChunks = retrievalResult.mergedTopChunks;
  const sourceDocumentNames = extractTwoLaneDocNames(retrievalResult);

  logDebug("unified_pipeline_retrieval_complete", {
    requestId: logContext?.requestId,
    sessionId: logContext?.sessionId,
    stage: "unified_pipeline",
    localChunkCount: retrievalResult.debug.localCount,
    stateChunkCount: retrievalResult.debug.stateCount,
    mergedChunkCount: mergedChunks.length,
    retrievalDurationMs: retrievalResult.debug.durationMs,
  });

  // Step 2: Synthesize answer from merged chunks with situation anchoring
  const answerText = await synthesizeUnifiedAnswer(
    question,
    retrievalResult,
    sessionHistory,
    townPreference,
    situationContext,
    logContext
  );

  // Classify document source type
  const { type: docSourceType, town: docSourceTown } = classifyTwoLaneDocSource(
    retrievalResult,
    townPreference || undefined
  );

  const durationMs = Date.now() - startTime;

  logDebug("unified_pipeline_complete", {
    requestId: logContext?.requestId,
    sessionId: logContext?.sessionId,
    stage: "unified_pipeline",
    answerLength: answerText.length,
    sourceDocCount: sourceDocumentNames.length,
    totalDurationMs: durationMs,
  });

  return {
    answerText,
    sourceDocumentNames,
    docSourceType,
    docSourceTown,
    retrievedChunkCount: mergedChunks.length,
    durationMs,
  };
}

/**
 * Build situation anchoring instructions for the system prompt
 */
function buildSituationAnchoringInstructions(situationContext: SituationContext | null | undefined): string {
  if (!chatConfig.ENABLE_SITUATION_ANCHORING || !situationContext) {
    return "";
  }
  
  const entitiesList = situationContext.entities.slice(0, 6).join(", ");
  
  return `

=== STRICT TOPIC CONTINUITY RULES ===
CURRENT SITUATION: "${situationContext.title}"
KEY ENTITIES: ${entitiesList}

You MUST follow these topic continuity rules:

1. ANCHORING REQUIREMENT: Your answer MUST be about "${situationContext.title}". Start your response by explicitly referring to the current situation.

2. NO TOPIC SUBSTITUTION: Even if you find documents about other cases, properties, or matters that seem relevant, do NOT use them as your primary answer. The user is asking about "${situationContext.title}" - not other matters.

3. ANALOGY RULE: You may ONLY reference other cases/properties/matters if you:
   a) Have already answered within the current situation context, AND
   b) Explicitly label the reference as separate (e.g., "As a separate example, in an unrelated matter involving [X]...")
   
4. CONTEXTUAL REFUSAL: If the retrieved documents don't contain information about "${situationContext.title}", acknowledge this gap directly. Say something like: "The available documents don't contain specific information about [topic] in relation to ${situationContext.title}."

5. ENTITY PRIORITY: Prioritize information containing these entities: ${entitiesList}

VIOLATION EXAMPLE (DO NOT DO THIS):
- User asks about ADA compliance for Constitution Park boardwalk
- Documents contain info about Brown property enforcement
- BAD: "The Brown property case shows that..." (substituted unrelated case)
- GOOD: "Regarding the Constitution Park boardwalk ADA requirements, the documents show..." (anchored to situation)`;
}

/**
 * Simple synthesis prompt - direct and concise with situation anchoring
 */
async function synthesizeUnifiedAnswer(
  question: string,
  retrievalResult: TwoLaneRetrievalResult,
  history: ChatHistoryMessage[],
  townPreference: string | null | undefined,
  situationContext: SituationContext | null | undefined,
  logContext?: PipelineLogContext
): Promise<string> {
  const { model: synthesisModel } = getModelForStage('complexSynthesis');

  const totalChunks = retrievalResult.mergedTopChunks.length;
  if (totalChunks === 0) {
    return "No relevant documents were found in the OpenCouncil archive for this question. You may wish to consult municipal records or counsel for more specific guidance.";
  }

  // Build snippet text from full retrieval result
  const snippetText = buildTwoLaneSnippetText(retrievalResult);

  // Build conversation context
  const historyContext = history.length > 0
    ? `\nRecent conversation:\n${history
        .slice(-4)
        .map((m) => `${m.role}: ${m.content.slice(0, 200)}`)
        .join("\n")}\n`
    : "";

  const townName = townPreference || "the municipality";
  
  // Build situation anchoring instructions
  const situationInstructions = buildSituationAnchoringInstructions(situationContext);

  const systemPrompt = `You are an assistant for New Hampshire municipal officials. Answer questions using the provided document excerpts.

Guidelines:
- Provide clear, direct answers based on the documents
- Cite specific document sources when making claims
- Be accurate and helpful
- If the documents don't fully answer the question, acknowledge limitations
- Keep answers focused and practical
- Target around 800-1500 characters for most answers${situationInstructions}`;

  const userPrompt = `${historyContext}
QUESTION: ${question}

RETRIEVED DOCUMENTS (for ${townName}):
${snippetText}

Please provide a helpful answer based on these documents. Cite your sources.`;

  logLlmRequest({
    requestId: logContext?.requestId,
    sessionId: logContext?.sessionId,
    stage: "unified_synthesis" as any,
    model: synthesisModel,
    systemPrompt: systemPrompt.slice(0, 500),
    userPrompt: userPrompt.slice(0, 500),
    temperature: 0.3,
    extra: {
      chunkCount: totalChunks,
      historyLength: history.length,
      townPreference,
    },
  });

  const startTime = Date.now();

  try {
    const response = await ai.models.generateContent({
      model: synthesisModel,
      contents: [{ role: "user", parts: [{ text: userPrompt }] }],
      config: {
        systemInstruction: systemPrompt,
        temperature: 0.3,
        maxOutputTokens: 3000,
      },
    });

    const responseText = response.text || "Unable to synthesize an answer from the retrieved documents.";
    const durationMs = Date.now() - startTime;

    logLlmResponse({
      requestId: logContext?.requestId,
      sessionId: logContext?.sessionId,
      stage: "unified_synthesis",
      model: synthesisModel,
      responseText: responseText.slice(0, 500),
      durationMs,
    });

    // Log for cost tracking
    if (logContext?.actor) {
      const tokens = extractTokenCounts(response);
      await logLLMCall(
        {
          actor: logContext.actor,
          sessionId: logContext.sessionId,
          requestId: logContext.requestId,
          stage: "unified_synthesis" as any,
          model: synthesisModel,
        },
        { text: responseText, tokensIn: tokens.tokensIn, tokensOut: tokens.tokensOut }
      );
    }

    return responseText;
  } catch (error) {
    if (isQuotaError(error)) {
      const errMessage = error instanceof Error ? error.message : String(error);
      logLlmError({
        requestId: logContext?.requestId,
        sessionId: logContext?.sessionId,
        stage: "unified_synthesis",
        model: synthesisModel,
        error: error instanceof Error ? error : new Error(String(error)),
      });
      throw new GeminiQuotaExceededError(errMessage || "Gemini quota exceeded during synthesis");
    }

    logLlmError({
      requestId: logContext?.requestId,
      sessionId: logContext?.sessionId,
      stage: "unified_synthesis",
      model: synthesisModel,
      error: error instanceof Error ? error : new Error(String(error)),
    });

    return "An error occurred while processing the retrieved documents. Please try again in a moment.";
  }
}
