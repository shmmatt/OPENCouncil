import { GoogleGenAI } from "@google/genai";
import { getOrCreateFileSearchStoreId } from "../gemini-store";
import type { RetrievalPlan, ChatHistoryMessage, PipelineLogContext, DocSourceType, SynthesisOutput } from "./types";
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
}

interface ComplexDraftResult {
  draftAnswerText: string;
  sourceDocumentNames: string[];
  docSourceType: import("./types").DocSourceType;
  docSourceTown: string | null;
  notices: ChatNotice[];
  retrievedChunks: RetrievedChunk[];
  composedAnswerApplied?: boolean;
}

export interface RetrievedChunk {
  source: string;
  content: string;
  documentNames: string[];
}

export async function generateComplexDraftAnswer(
  options: ComplexAnswerOptions
): Promise<ComplexDraftResult> {
  const { question, retrievalPlan, sessionHistory, logContext, additionalChunks = [], composedAnswerFlags } = options;
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

  // ===== TWO-LANE RETRIEVAL INTEGRATION =====
  // If enabled, run parallel local + state retrieval first
  if (chatConfig.ENABLE_PARALLEL_STATE_LANE && (retrievalPlan.forceParallelStateRetrieval !== false)) {
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
            documentNames: laneChunk.documentName ? [laneChunk.documentName] : [],
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

  // Fall back to sequential retrieval if two-lane didn't produce results
  if (!usedTwoLane) {
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
  } // End !usedTwoLane block

  // Merge additional chunks from evidence gate expansion passes
  for (const chunk of additionalChunks) {
    retrievedChunks.push(chunk);
    allRetrievalDocNames.push(...chunk.documentNames);
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
  });

  const snippetsForSynthesis = retrievedChunks.map(c => ({
    source: c.source,
    content: c.content,
  }));

  const { text: draftAnswerText, composedAnswerApplied } = await synthesizeDraftAnswer(
    question,
    snippetsForSynthesis,
    sessionHistory,
    retrievalPlan,
    logContext,
    composedAnswerFlags
  );

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
  composedAnswerFlags?: ComposedAnswerFlags
): Promise<{ text: string; composedAnswerApplied: boolean }> {
  const { model: synthesisModel } = getModelForStage('complexSynthesis');
  
  if (snippets.length === 0) {
    return {
      text: "No directly relevant material was found in the OpenCouncil archive for this question. The available documents for this municipality do not address this question directly. You may wish to consult municipal records or counsel for more specific guidance.",
      composedAnswerApplied: false,
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

  const synthesisPrompt = `Based on the following document excerpts, provide a comprehensive answer to the question.
${historyContext}
Question: ${question}

Document Excerpts:
${snippetText}

Instructions:
Use this EXACT structure for your answer:

### At a glance
- 2-4 bullet points summarizing the main answer in plain language

### Key numbers (${townName})
- A short bullet list of important figures (dollar amounts, percentages, contract values, budget line items)
- If no specific numbers are available, omit this section

### Details from recent meetings
- 1-3 short paragraphs that reference specific meetings or documents
- When mentioning a meeting or document, use phrases like "According to the ${townName} BOS minutes from [date]..." or "In the 2025 ${townName} budget document..."

Additional rules:
- Keep the entire answer roughly 400-600 words unless the question clearly requires more detailed statutory analysis
- Explicitly distinguish between what the documents say (facts) and what is unknown or not covered
- If information is missing, advise consulting town counsel or NHMA
- ${plan.filters.townPreference ? `Focus on ${plan.filters.townPreference} when specific local information is available` : "Provide statewide guidance when no specific town is mentioned"}

Provide your answer:`;

  const baseSynthesisSystemPrompt = `You are synthesizing a comprehensive answer for OpenCouncil using multiple retrieved sources.

Your goal is to produce a complete, trustworthy explanation that feels sufficient on first read.

Target length: 400–600 words.

STRUCTURE:

### At a glance
- 3–5 bullets summarizing the outcome and major contributing factors based on retrieved documents.
- Only include general process context if retrieved documents support it.

### How this works (context)
- ONLY include this section if you have retrieved statewide/handbook documents that explain the mechanism.
- If no statewide documents are retrieved, SKIP this section entirely.
- Do NOT invent or assume general process context without document evidence.
- When included, cite the specific handbook or statewide document.

### Key numbers and facts
- Present quantitative details from retrieved documents.
- Clearly label what entity each number relates to (town, school, county, state).

### Local details and recent actions
- Describe what local boards, voters, or officials approved or discussed.
- Cite specific documents and meeting dates.
- This is the primary section when only local documents are retrieved.

### What is not shown in the available documents
- Explicitly list relevant components that were not found in the retrieved materials, if any.
- This prevents misleading completeness.
- If statewide process context was not retrieved, note that here.

STYLE RULES:

• EVIDENCE-FIRST: Only describe mechanisms/processes that are documented in retrieved sources.
• Maintain a neutral, civic tone.
• Do not speculate or invent context.
• Do not attribute causation without evidence.
• When statewide context is used, cite the specific document.
• This information is informational only and not legal advice.`;

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

    return { text: responseText, composedAnswerApplied };
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

    return { text: "An error occurred while processing the retrieved documents. Please try again in a moment.", composedAnswerApplied: false };
  }
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
