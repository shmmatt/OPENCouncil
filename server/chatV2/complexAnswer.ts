import { GoogleGenAI } from "@google/genai";
import { getOrCreateFileSearchStoreId } from "../gemini-store";
import type { RetrievalPlan, ChatHistoryMessage, PipelineLogContext, DocSourceType, SynthesisOutput, AnswerMode } from "./types";
import { getAnswerPolicy, getPolicyPromptInstructions, type AnswerPolicy, type AnswerPolicyMetrics } from "./answerPolicy";
import { logLlmRequest, logLlmResponse, logLlmError } from "../utils/llmLogging";
import { logFileSearchRequest, logFileSearchResponse, extractGroundingInfoForLogging, extractRetrievalDocCount } from "../utils/fileSearchLogging";
import { logDebug } from "../utils/logger";
import { chatConfig } from "./chatConfig";
import { buildMergedRetrievalQuery } from "./pipelineUtils";
import { isQuotaError, GeminiQuotaExceededError } from "../utils/geminiErrors";
import { logLLMCall, extractTokenCounts } from "../llm/callLLMWithLogging";
import { 
  archiveNotConfiguredNotice, 
  processingErrorNotice,
} from "./scopeUtils";
import type { ChatNotice } from "@shared/chatNotices";
import { augmentSystemPromptWithComposedAnswer, type ComposedAnswerFlags } from "./composedFirstAnswer";
import { getModelForStage } from "../llm/modelRegistry";
import { 
  twoLaneRetrieve,
  extractTwoLaneDocNames,
  buildTwoLaneSnippetText,
  classifyTwoLaneDocSource,
} from "./twoLaneRetrieve";

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY || "" });

interface ComplexAnswerOptions {
  question: string;
  retrievalPlan: RetrievalPlan;
  sessionHistory: ChatHistoryMessage[];
  logContext?: PipelineLogContext;
  additionalChunks?: RetrievedChunk[];
  composedAnswerFlags?: ComposedAnswerFlags;
  /**
   * Original chunks from initial retrieval pass.
   * When provided along with additionalChunks, this triggers "resynthesis mode":
   * - Skip fresh two-lane retrieval
   * - Merge originalChunks + additionalChunks
   * - Deduplicate and synthesize from merged evidence
   */
  originalChunks?: RetrievedChunk[];
  /**
   * Answer mode: "standard" (default) or "deep" (longer, more detailed responses)
   */
  answerMode?: AnswerMode;
}

interface ComplexDraftResult {
  draftAnswerText: string;
  sourceDocumentNames: string[];
  docSourceType: import("./types").DocSourceType;
  docSourceTown: string | null;
  notices: ChatNotice[];
  retrievedChunks: RetrievedChunk[];
  composedAnswerApplied?: boolean;
  /** Policy metrics for observability logging */
  policyMetrics?: Partial<AnswerPolicyMetrics>;
}

export interface RetrievedChunk {
  source: string;
  content: string;
  documentNames: string[];
}

export async function generateComplexDraftAnswer(
  options: ComplexAnswerOptions
): Promise<ComplexDraftResult> {
  const { question, retrievalPlan, sessionHistory, logContext, additionalChunks = [], composedAnswerFlags, originalChunks, answerMode = "standard" } = options;
  const { model: summaryModel } = getModelForStage('complexSummary');

  const storeId = await getOrCreateFileSearchStoreId();

  if (!storeId) {
    return {
      draftAnswerText:
        "The OpenCouncil archive is not yet configured. Please contact your administrator to set up document indexing.",
      sourceDocumentNames: [],
      docSourceType: "none" as DocSourceType,
      docSourceTown: null,
      notices: [archiveNotConfiguredNotice()],
      retrievedChunks: [],
    };
  }

  let allRetrievalDocNames: string[] = [];
  let retrievedChunks: RetrievedChunk[] = [];
  let usedTwoLane = false;

  // ===== RESYNTHESIS MODE =====
  // When originalChunks are provided, skip fresh retrieval and use merged evidence
  const isResynthesisMode = originalChunks && originalChunks.length > 0;

  if (isResynthesisMode) {
    // Merge original + additional chunks with deduplication
    const mergedChunks = mergeAndDeduplicateChunks(originalChunks, additionalChunks);
    retrievedChunks = mergedChunks;
    
    // Extract all document names from merged chunks
    for (const chunk of mergedChunks) {
      allRetrievalDocNames.push(...chunk.documentNames);
    }

    logDebug("complexAnswer_resynthesis_mode", {
      requestId: logContext?.requestId,
      sessionId: logContext?.sessionId,
      stage: "complexAnswer_resynthesis",
      originalChunkCount: originalChunks.length,
      additionalChunkCount: additionalChunks.length,
      mergedChunkCount: mergedChunks.length,
      totalDocNames: allRetrievalDocNames.length,
      expansionEvidenceIncluded: additionalChunks.length > 0,
    });
  }
  // ===== TWO-LANE RETRIEVAL INTEGRATION =====
  // If enabled and NOT in resynthesis mode, run parallel local + state retrieval first
  else if (chatConfig.ENABLE_PARALLEL_STATE_LANE && (retrievalPlan.forceParallelStateRetrieval !== false)) {
    try {
      const twoLaneResult = await twoLaneRetrieve({
        userQuestion: question,
        rerankedQuestion: question,
        townPreference: retrievalPlan.filters.townPreference,
        domains: retrievalPlan.filters.categories,
        scopeHint: retrievalPlan.filters.townPreference ? "mixed" : "statewide",
        logContext,
      });
      
      if (twoLaneResult.mergedTopChunks.length > 0) {
        usedTwoLane = true;
        allRetrievalDocNames = extractTwoLaneDocNames(twoLaneResult);
        
        // Convert two-lane chunks to RetrievedChunk format
        for (const laneChunk of twoLaneResult.mergedTopChunks) {
          retrievedChunks.push({
            source: laneChunk.lane === "local" ? "Local Municipal Documents" : "NH State & NHMA Resources",
            content: laneChunk.content,
            documentNames: laneChunk.documentNames || [],
          });
        }
        
        logDebug("complexAnswer_twoLane_result", {
          requestId: logContext?.requestId,
          sessionId: logContext?.sessionId,
          stage: "complexAnswer_twoLane",
          localCount: twoLaneResult.debug.localCount,
          stateCount: twoLaneResult.debug.stateCount,
          mergedCount: twoLaneResult.debug.mergedCount,
          durationMs: twoLaneResult.debug.durationMs,
        });
      }
    } catch (twoLaneError) {
      logDebug("complexAnswer_twoLane_error", {
        requestId: logContext?.requestId,
        sessionId: logContext?.sessionId,
        stage: "complexAnswer_twoLane",
        error: twoLaneError instanceof Error ? twoLaneError.message : String(twoLaneError),
      });
      // Fall back to sequential retrieval
    }
  }

  // Fall back to sequential retrieval if two-lane didn't produce results and not in resynthesis mode
  if (!usedTwoLane && !isResynthesisMode) {
    const retrievalPrompts = buildRetrievalPrompts(question, retrievalPlan);

    logDebug("complex_answer_retrieval_prompts", {
      requestId: logContext?.requestId,
      sessionId: logContext?.sessionId,
      stage: "complexAnswer_prompts",
      promptCount: retrievalPrompts.length,
      prompts: retrievalPrompts.map(p => ({ label: p.sourceLabel, queryLength: p.query.length })),
      additionalChunksCount: additionalChunks.length,
    });

    for (let i = 0; i < retrievalPrompts.length; i++) {
    const prompt = retrievalPrompts[i];
    const retrievalStage = `complexAnswer_retrieval_${i + 1}`;
    const retrievalSystemPrompt = `You are a document retrieval assistant. Extract relevant information from municipal documents to answer the query. Be thorough and include specific details, quotes, and section references when available. Format as structured excerpts.`;

    logLlmRequest({
      requestId: logContext?.requestId,
      sessionId: logContext?.sessionId,
      stage: retrievalStage,
      model: summaryModel,
      systemPrompt: retrievalSystemPrompt,
      userPrompt: prompt.query,
      extra: {
        sourceLabel: prompt.sourceLabel,
        retrievalIndex: i + 1,
        totalRetrievals: retrievalPrompts.length,
      },
    });

    logFileSearchRequest({
      requestId: logContext?.requestId,
      sessionId: logContext?.sessionId,
      stage: `${retrievalStage}_fileSearch`,
      storeId,
      queryText: prompt.query,
      filters: {
        sourceLabel: prompt.sourceLabel,
        categories: retrievalPlan.filters.categories,
        town: retrievalPlan.filters.townPreference,
      },
    });

    const startTime = Date.now();

    try {
      const response = await ai.models.generateContent({
        model: summaryModel,
        contents: [{ role: "user", parts: [{ text: prompt.query }] }],
        config: {
          systemInstruction: retrievalSystemPrompt,
          tools: [
            {
              fileSearch: {
                fileSearchStoreNames: [storeId],
              },
            } as any,
          ],
        },
      });

      const snippetContent = response.text || "";
      const durationMs = Date.now() - startTime;
      const groundingInfo = extractGroundingInfoForLogging(response);

      logLlmResponse({
        requestId: logContext?.requestId,
        sessionId: logContext?.sessionId,
        stage: retrievalStage,
        model: summaryModel,
        responseText: snippetContent,
        durationMs,
      });

      if (logContext?.actor) {
        const tokens = extractTokenCounts(response);
        await logLLMCall(
          {
            actor: logContext.actor,
            sessionId: logContext.sessionId,
            requestId: logContext.requestId,
            stage: "other",
            model: summaryModel,
            metadata: { subStage: retrievalStage },
          },
          { text: snippetContent, tokensIn: tokens.tokensIn, tokensOut: tokens.tokensOut }
        );
      }

      logFileSearchResponse({
        requestId: logContext?.requestId,
        sessionId: logContext?.sessionId,
        stage: `${retrievalStage}_fileSearch`,
        results: groundingInfo,
        responseText: snippetContent,
        durationMs,
      });

      const retrievalResult = extractRetrievalDocCount(response);
      allRetrievalDocNames.push(...retrievalResult.documentNames);

      if (snippetContent.length > 50) {
        retrievedChunks.push({
          source: prompt.sourceLabel,
          content: snippetContent,
          documentNames: retrievalResult.documentNames,
        });
      }
    } catch (error) {
      if (isQuotaError(error)) {
        const errMessage = error instanceof Error ? error.message : String(error);
        logLlmError({
          requestId: logContext?.requestId,
          sessionId: logContext?.sessionId,
          stage: retrievalStage,
          model: summaryModel,
          error: error instanceof Error ? error : new Error(String(error)),
        });
        throw new GeminiQuotaExceededError(errMessage || "Gemini quota exceeded in complexAnswer retrieval");
      }
      
      logLlmError({
        requestId: logContext?.requestId,
        sessionId: logContext?.sessionId,
        stage: retrievalStage,
        model: summaryModel,
        error: error instanceof Error ? error : new Error(String(error)),
      });
    }
    }
  } // End !usedTwoLane && !isResynthesisMode block

  // In non-resynthesis mode, still merge any additional chunks (legacy compatibility)
  // In resynthesis mode, chunks were already merged above with deduplication
  if (!isResynthesisMode && additionalChunks.length > 0) {
    for (const chunk of additionalChunks) {
      retrievedChunks.push(chunk);
      allRetrievalDocNames.push(...chunk.documentNames);
    }
  }

  const uniqueRetrievalDocNames = Array.from(new Set(allRetrievalDocNames));
  const retrievalDocCount = uniqueRetrievalDocNames.length;

  // Verification logging: prove that retrievalDocCount is derived from file_search_response
  logDebug("scope_notice_inputs", {
    requestId: logContext?.requestId,
    sessionId: logContext?.sessionId,
    stage: "complexAnswer",
    retrievalDocCount,
    note: "retrievalDocCount is derived ONLY from file_search_response",
  });

  logDebug("complex_answer_synthesis_start", {
    requestId: logContext?.requestId,
    sessionId: logContext?.sessionId,
    stage: "complexAnswer_synthesis",
    retrievedChunkCount: retrievedChunks.length,
    retrievalDocCount,
    hadAdditionalChunks: additionalChunks.length > 0,
    usedTwoLaneRetrieval: usedTwoLane,
    isResynthesisMode: !!isResynthesisMode,
    expansionEvidenceIncluded: isResynthesisMode && additionalChunks.length > 0,
  });

  const snippetsForSynthesis = retrievedChunks.map(c => ({
    source: c.source,
    content: c.content,
  }));

  const { text: draftAnswerText, composedAnswerApplied, policy } = await synthesizeDraftAnswer(
    question,
    snippetsForSynthesis,
    sessionHistory,
    retrievalPlan,
    logContext,
    composedAnswerFlags,
    answerMode
  );

  // Build policy metrics for observability logging
  const policyMetrics: Partial<AnswerPolicyMetrics> = {
    policyName: policy.policyName,
    charTargetMin: policy.charTargetMin,
    charTargetMax: policy.charTargetMax,
    charCap: policy.charCap,
    maxOutputTokensUsed: policy.maxOutputTokens,
    generationLengthChars: draftAnswerText.length,
    finalAnswerLengthChars: draftAnswerText.length, // Will be updated after any truncation
    wasRewrittenForLength: false,
    wasTruncated: false,
  };

  logDebug("complex_answer_policy_metrics", {
    requestId: logContext?.requestId,
    sessionId: logContext?.sessionId,
    stage: "complexAnswer_policy",
    ...policyMetrics,
  });

  // Determine docSourceType based on actual retrieved documents (from File Search)
  const townPref = retrievalPlan.filters.townPreference;
  const docClassification = classifyDocumentSources(uniqueRetrievalDocNames, townPref);
  const docSourceType: DocSourceType = docClassification.type;
  const docSourceTown: string | null = docClassification.town;

  logDebug("complex_answer_doc_source_tracking", {
    requestId: logContext?.requestId,
    sessionId: logContext?.sessionId,
    stage: "complexAnswer_docSource",
    docSourceType,
    docSourceTown,
    snippetCount: snippetsForSynthesis.length,
    retrievalDocCount,
    townPreference: townPref,
  });

  // Scope badges disabled - classification was unreliable
  // TODO: Re-enable when badge logic analyzes answer content, not just document names

  return {
    draftAnswerText,
    sourceDocumentNames: uniqueRetrievalDocNames,
    docSourceType,
    docSourceTown,
    notices: [],
    retrievedChunks,
    composedAnswerApplied,
    policyMetrics,
  };
}

export async function performExpansionRetrieval(options: {
  queries: string[];
  storeId: string;
  logContext?: PipelineLogContext;
  passNumber: number;
}): Promise<RetrievedChunk[]> {
  const { queries, storeId, logContext, passNumber } = options;
  const { model: summaryModel } = getModelForStage('complexSummary');
  const chunks: RetrievedChunk[] = [];

  for (let i = 0; i < queries.length; i++) {
    const query = queries[i];
    const retrievalStage = `evidenceGate_expansion_pass${passNumber}_${i + 1}`;
    const retrievalSystemPrompt = `You are a document retrieval assistant. Extract relevant information from municipal documents to answer the query. Be thorough and include specific details, quotes, and section references when available.`;

    logDebug("expansion_retrieval_start", {
      requestId: logContext?.requestId,
      sessionId: logContext?.sessionId,
      stage: retrievalStage,
      passNumber,
      queryIndex: i + 1,
      queryLength: query.length,
    });

    const startTime = Date.now();

    try {
      const response = await ai.models.generateContent({
        model: summaryModel,
        contents: [{ role: "user", parts: [{ text: query }] }],
        config: {
          systemInstruction: retrievalSystemPrompt,
          tools: [
            {
              fileSearch: {
                fileSearchStoreNames: [storeId],
              },
            } as any,
          ],
        },
      });

      const snippetContent = response.text || "";
      const durationMs = Date.now() - startTime;
      const retrievalResult = extractRetrievalDocCount(response);

      logDebug("expansion_retrieval_result", {
        requestId: logContext?.requestId,
        sessionId: logContext?.sessionId,
        stage: retrievalStage,
        passNumber,
        queryIndex: i + 1,
        snippetLength: snippetContent.length,
        docCount: retrievalResult.documentNames.length,
        durationMs,
      });

      if (snippetContent.length > 50) {
        chunks.push({
          source: `Expansion Pass ${passNumber} - Query ${i + 1}`,
          content: snippetContent,
          documentNames: retrievalResult.documentNames,
        });
      }
    } catch (error) {
      if (isQuotaError(error)) {
        throw new GeminiQuotaExceededError(
          error instanceof Error ? error.message : "Gemini quota exceeded in expansion retrieval"
        );
      }
      
      logLlmError({
        requestId: logContext?.requestId,
        sessionId: logContext?.sessionId,
        stage: retrievalStage,
        model: summaryModel,
        error: error instanceof Error ? error : new Error(String(error)),
      });
    }
  }

  return chunks;
}

interface RetrievalPrompt {
  query: string;
  sourceLabel: string;
}

function buildRetrievalPrompts(
  question: string,
  plan: RetrievalPlan
): RetrievalPrompt[] {
  const maxPasses = chatConfig.MAX_RETRIEVAL_PASSES;
  
  if (maxPasses === 1) {
    const mergedQuery = buildMergedRetrievalQuery(question, plan);
    return [{
      query: mergedQuery,
      sourceLabel: "Comprehensive Document Search",
    }];
  }
  
  const prompts: RetrievalPrompt[] = [];

  if (plan.filters.allowStatewideFallback) {
    const statewideQuery = buildQueryWithContext(
      question,
      plan.infoNeeds,
      "statewide",
      plan.filters.categories
    );
    prompts.push({
      query: statewideQuery,
      sourceLabel: "Statewide Handbooks & Guides",
    });
  }

  if (plan.filters.townPreference) {
    const localQuery = buildQueryWithContext(
      question,
      plan.infoNeeds,
      plan.filters.townPreference,
      plan.filters.categories
    );
    prompts.push({
      query: localQuery,
      sourceLabel: `${plan.filters.townPreference} Local Documents`,
    });
  }

  const needsMinutes =
    plan.infoNeeds.some(
      (need) =>
        need.toLowerCase().includes("example") ||
        need.toLowerCase().includes("precedent") ||
        need.toLowerCase().includes("case")
    ) ||
    plan.filters.categories.includes("meeting_minutes");

  if (needsMinutes) {
    const minutesQuery = `Find examples in meeting minutes related to: ${question}. Look for similar cases, precedents, or past decisions.`;
    prompts.push({
      query: minutesQuery,
      sourceLabel: "Meeting Minutes & Examples",
    });
  }

  if (prompts.length === 0) {
    prompts.push({
      query: question,
      sourceLabel: "General Documents",
    });
  }

  return prompts.slice(0, maxPasses);
}

function buildQueryWithContext(
  question: string,
  infoNeeds: string[],
  townContext: string,
  categories: string[]
): string {
  const categoryStr = categories.length > 0 ? categories.join(", ") : "all";
  const needsStr =
    infoNeeds.length > 0
      ? `\n\nSpecifically looking for: ${infoNeeds.join("; ")}`
      : "";

  return `Context: ${townContext} municipal governance documents (categories: ${categoryStr})

Question: ${question}${needsStr}

Provide detailed relevant excerpts from the documents.`;
}

async function synthesizeDraftAnswer(
  question: string,
  snippets: { source: string; content: string }[],
  history: ChatHistoryMessage[],
  plan: RetrievalPlan,
  logContext?: PipelineLogContext,
  composedAnswerFlags?: ComposedAnswerFlags,
  answerMode: AnswerMode = "standard"
): Promise<{ text: string; composedAnswerApplied: boolean; policy: AnswerPolicy }> {
  const { model: synthesisModel } = getModelForStage('complexSynthesis');
  const policy = getAnswerPolicy("complex", answerMode);
  
  if (snippets.length === 0) {
    return {
      text: "No directly relevant material was found in the OpenCouncil archive for this question. The available documents for this municipality do not address this question directly. You may wish to consult municipal records or counsel for more specific guidance.",
      composedAnswerApplied: false,
      policy,
    };
  }

  const snippetText = snippets
    .map((s) => `=== ${s.source} ===\n${s.content}`)
    .join("\n\n");

  const historyContext =
    history.length > 0
      ? `\nRecent conversation:\n${history
          .slice(-4)
          .map((m) => `${m.role}: ${m.content.slice(0, 200)}...`)
          .join("\n")}\n`
      : "";

  const townName = plan.filters.townPreference || "the town";
  const policyInstructions = getPolicyPromptInstructions(policy);

  // Different prompts based on answer mode
  const synthesisPrompt = answerMode === "standard" 
    ? buildStandardSynthesisPrompt(question, snippetText, historyContext, townName, policyInstructions)
    : buildDeepSynthesisPrompt(question, snippetText, historyContext, townName, policyInstructions, plan);

  const baseSynthesisSystemPrompt = answerMode === "standard"
    ? buildStandardSystemPrompt(policyInstructions)
    : buildDeepSystemPrompt(policyInstructions);

  const { prompt: synthesisSystemPrompt, composedAnswerApplied } = composedAnswerFlags
    ? augmentSystemPromptWithComposedAnswer(baseSynthesisSystemPrompt, composedAnswerFlags, plan.filters.townPreference)
    : { prompt: baseSynthesisSystemPrompt, composedAnswerApplied: false };

  logLlmRequest({
    requestId: logContext?.requestId,
    sessionId: logContext?.sessionId,
    stage: "complexAnswer_synthesis",
    model: synthesisModel,
    systemPrompt: synthesisSystemPrompt,
    userPrompt: synthesisPrompt,
    temperature: 0.3,
    extra: {
      snippetCount: snippets.length,
      historyLength: history.length,
      townPreference: plan.filters.townPreference,
      composedAnswerApplied,
    },
  });

  const startTime = Date.now();

  try {
    const response = await ai.models.generateContent({
      model: synthesisModel,
      contents: [{ role: "user", parts: [{ text: synthesisPrompt }] }],
      config: {
        systemInstruction: synthesisSystemPrompt,
        temperature: 0.3,
        maxOutputTokens: policy.maxOutputTokens,
      },
    });

    const responseText = response.text || "Unable to synthesize an answer from the retrieved documents.";
    const durationMs = Date.now() - startTime;

    logLlmResponse({
      requestId: logContext?.requestId,
      sessionId: logContext?.sessionId,
      stage: "complexAnswer_synthesis",
      model: synthesisModel,
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
          stage: "synthesis",
          model: synthesisModel,
        },
        { text: responseText, tokensIn: tokens.tokensIn, tokensOut: tokens.tokensOut }
      );
    }

    return { text: responseText, composedAnswerApplied, policy };
  } catch (error) {
    if (isQuotaError(error)) {
      const errMessage = error instanceof Error ? error.message : String(error);
      logLlmError({
        requestId: logContext?.requestId,
        sessionId: logContext?.sessionId,
        stage: "complexAnswer_synthesis",
        model: synthesisModel,
        error: error instanceof Error ? error : new Error(String(error)),
      });
      throw new GeminiQuotaExceededError(errMessage || "Gemini quota exceeded in complexAnswer synthesis");
    }

    logLlmError({
      requestId: logContext?.requestId,
      sessionId: logContext?.sessionId,
      stage: "complexAnswer_synthesis",
      model: synthesisModel,
      error: error instanceof Error ? error : new Error(String(error)),
    });

    return { text: "An error occurred while processing the retrieved documents. Please try again in a moment.", composedAnswerApplied: false, policy };
  }
}

/**
 * Build the synthesis prompt for STANDARD mode (complex questions).
 * Enforces the Key points + Sources structure.
 */
function buildStandardSynthesisPrompt(
  question: string,
  snippetText: string,
  historyContext: string,
  townName: string,
  policyInstructions: string
): string {
  return `Based on the following document excerpts, answer the question concisely.
${historyContext}
Question: ${question}

Document Excerpts:
${snippetText}

${policyInstructions}

REQUIRED FORMAT:
1. Start with 1-2 sentences directly answering the question (no preamble)
2. **Key points**
   - Maximum 6 bullets, each under 160 characters
   - Focus on the most important facts from the documents
3. **Sources**
   - List the document names used

${townName !== "the town" ? `Focus on ${townName} when local information is available.` : ""}
If information is missing from documents, include max 2 "Unknown/Not found" bullets in Key points.

Provide your answer:`;
}

/**
 * Build the synthesis prompt for DEEP mode (complex questions).
 * Allows richer structure with multiple sections.
 */
function buildDeepSynthesisPrompt(
  question: string,
  snippetText: string,
  historyContext: string,
  townName: string,
  policyInstructions: string,
  plan: RetrievalPlan
): string {
  return `Based on the following document excerpts, provide a comprehensive answer to the question.
${historyContext}
Question: ${question}

Document Excerpts:
${snippetText}

${policyInstructions}

Use these sections as appropriate:
- **At a glance** - 3-5 bullet summary of the main answer
- **Key numbers** - Important figures (amounts, percentages, dates)
- **Details from documents** - Specific findings with citations
- **What's not covered** - Information gaps (if relevant)
- **Sources** - Document citations

${plan.filters.townPreference ? `Focus on ${plan.filters.townPreference} when local information is available.` : "Provide statewide guidance when no specific town is mentioned."}
If information is missing, advise consulting town counsel or NHMA.

Provide your answer:`;
}

/**
 * Build the system prompt for STANDARD mode.
 * Emphasizes brevity and the Key points structure.
 */
function buildStandardSystemPrompt(policyInstructions: string): string {
  return `You are synthesizing a concise answer for OpenCouncil.

${policyInstructions}

CRITICAL RULES:
1. Start with a direct answer - NO preambles like "Based on the documents..." or "Let me explain..."
2. Use ONLY "Key points" and "Sources" sections
3. Each bullet must be factual and cite the source document
4. If evidence is missing, state it briefly (max 2 bullets for unknowns)
5. Stay within character limits - be concise
6. NEVER mention answer modes, toggles, or length limits in your response
7. This is informational only, not legal advice`;
}

/**
 * Build the system prompt for DEEP mode.
 * Allows richer explanation with multiple sections.
 */
function buildDeepSystemPrompt(policyInstructions: string): string {
  return `You are synthesizing a comprehensive answer for OpenCouncil using multiple retrieved sources.

${policyInstructions}

Your goal is to produce a complete, trustworthy explanation.

STYLE RULES:
• EVIDENCE-FIRST: Only describe what is documented in retrieved sources
• Maintain a neutral, civic tone
• Do not speculate or invent context
• When statewide context is used, cite the specific document
• NEVER mention answer modes, toggles, or length limits in your response
• This is informational only and not legal advice`;
}

/**
 * Patterns indicating statewide/RSA documents vs local municipal documents.
 */
const STATEWIDE_PATTERNS = [
  /\bRSA\b/i,
  /\bNHMA\b/i,
  /\bhandbook\b/i,
  /\bstatewide\b/i,
  /\bNew Hampshire (Municipal|Town|City)/i,
  /\bgencourt\.state\.nh/i,
  /\bstate law\b/i,
];

/**
 * Classify document sources based on their names/URIs.
 * Returns the doc source type and detected town.
 */
function classifyDocumentSources(
  docNames: string[],
  townHint?: string
): { type: DocSourceType; town: string | null } {
  if (docNames.length === 0) {
    return { type: "none", town: null };
  }

  let hasLocal = false;
  let hasStatewide = false;
  let detectedTown: string | null = null;

  for (const docName of docNames) {
    const isStatewideDoc = STATEWIDE_PATTERNS.some(pattern => pattern.test(docName));
    
    if (isStatewideDoc) {
      hasStatewide = true;
    } else {
      // If not matching statewide patterns, assume local
      hasLocal = true;
      // Try to detect town from document name if not already set
      if (!detectedTown && townHint) {
        if (docName.toLowerCase().includes(townHint.toLowerCase())) {
          detectedTown = townHint;
        }
      }
    }
  }

  // If we have a town hint and local docs, use it even if not detected in doc names
  if (hasLocal && !detectedTown && townHint) {
    detectedTown = townHint;
  }

  if (hasLocal && hasStatewide) {
    return { type: "mixed", town: detectedTown };
  } else if (hasLocal) {
    return { type: "local", town: detectedTown };
  } else if (hasStatewide) {
    return { type: "statewide", town: null };
  }

  // Default - if we have docs but couldn't classify, assume local
  return { type: "local", town: detectedTown };
}

/**
 * Merge and deduplicate chunks from original retrieval and expansion passes.
 * Deduplication strategy:
 * 1. By document name + content hash (preferred for structured chunks)
 * 2. By normalized content hash (fallback for unstructured chunks)
 */
function mergeAndDeduplicateChunks(
  originalChunks: RetrievedChunk[],
  additionalChunks: RetrievedChunk[]
): RetrievedChunk[] {
  const seen = new Set<string>();
  const merged: RetrievedChunk[] = [];

  const getChunkKey = (chunk: RetrievedChunk): string => {
    // Primary key: document name + content hash
    if (chunk.documentNames.length > 0) {
      const docKey = chunk.documentNames.slice().sort().join("|");
      const contentHash = hashContent(chunk.content);
      return `doc:${docKey}:${contentHash}`;
    }
    // Fallback: content hash only
    return `content:${hashContent(chunk.content)}`;
  };

  // Add original chunks first (they take precedence)
  for (const chunk of originalChunks) {
    const key = getChunkKey(chunk);
    if (!seen.has(key)) {
      seen.add(key);
      merged.push(chunk);
    }
  }

  // Add additional chunks, skipping duplicates
  for (const chunk of additionalChunks) {
    const key = getChunkKey(chunk);
    if (!seen.has(key)) {
      seen.add(key);
      merged.push(chunk);
    }
  }

  return merged;
}

/**
 * Create a stable hash of content for deduplication.
 * Normalizes whitespace to avoid false negatives.
 */
function hashContent(content: string): string {
  // Normalize whitespace and take first 500 chars for efficiency
  const normalized = content.replace(/\s+/g, " ").trim().slice(0, 500);
  // Simple hash - sum of char codes mod a large prime
  let hash = 0;
  for (let i = 0; i < normalized.length; i++) {
    hash = ((hash << 5) - hash + normalized.charCodeAt(i)) | 0;
  }
  return hash.toString(36);
}
