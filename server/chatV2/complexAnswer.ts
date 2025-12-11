import { GoogleGenAI } from "@google/genai";
import { getOrCreateFileSearchStoreId } from "../gemini-store";
import type { RetrievalPlan, ChatHistoryMessage, PipelineLogContext, DocSourceType } from "./types";
import { logLlmRequest, logLlmResponse, logLlmError } from "../utils/llmLogging";
import { logFileSearchRequest, logFileSearchResponse, extractGroundingInfoForLogging } from "../utils/fileSearchLogging";
import { logDebug } from "../utils/logger";
import { chatConfig } from "./chatConfig";
import { buildMergedRetrievalQuery } from "./pipelineUtils";
import { isQuotaError, GeminiQuotaExceededError } from "../utils/geminiErrors";
import { logLLMCall, extractTokenCounts } from "../llm/callLLMWithLogging";

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY || "" });

const MODEL_NAME = "gemini-2.5-flash";

interface ComplexAnswerOptions {
  question: string;
  retrievalPlan: RetrievalPlan;
  sessionHistory: ChatHistoryMessage[];
  logContext?: PipelineLogContext;
}

interface ComplexDraftResult {
  draftAnswerText: string;
  sourceDocumentNames: string[];
  docSourceType: import("./types").DocSourceType;
  docSourceTown: string | null;
}

export async function generateComplexDraftAnswer(
  options: ComplexAnswerOptions
): Promise<ComplexDraftResult> {
  const { question, retrievalPlan, sessionHistory, logContext } = options;

  const storeId = await getOrCreateFileSearchStoreId();

  if (!storeId) {
    return {
      draftAnswerText:
        "The OpenCouncil archive is not yet configured. Please contact your administrator to set up document indexing.",
      sourceDocumentNames: [],
      docSourceType: "none" as DocSourceType,
      docSourceTown: null
    };
  }

  const allSourceDocumentNames: string[] = [];

  const retrievalPrompts = buildRetrievalPrompts(question, retrievalPlan);

  logDebug("complex_answer_retrieval_prompts", {
    requestId: logContext?.requestId,
    sessionId: logContext?.sessionId,
    stage: "complexAnswer_prompts",
    promptCount: retrievalPrompts.length,
    prompts: retrievalPrompts.map(p => ({ label: p.sourceLabel, queryLength: p.query.length })),
  });

  const retrievedSnippets: { source: string; content: string }[] = [];

  for (let i = 0; i < retrievalPrompts.length; i++) {
    const prompt = retrievalPrompts[i];
    const retrievalStage = `complexAnswer_retrieval_${i + 1}`;
    const retrievalSystemPrompt = `You are a document retrieval assistant. Extract relevant information from municipal documents to answer the query. Be thorough and include specific details, quotes, and section references when available. Format as structured excerpts.`;

    logLlmRequest({
      requestId: logContext?.requestId,
      sessionId: logContext?.sessionId,
      stage: retrievalStage,
      model: MODEL_NAME,
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
        model: MODEL_NAME,
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
        model: MODEL_NAME,
        responseText: snippetContent,
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
            stage: "other",
            model: MODEL_NAME,
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

      if (snippetContent.length > 50) {
        retrievedSnippets.push({
          source: prompt.sourceLabel,
          content: snippetContent,
        });
      }

      const docNames = extractSourceDocumentNames(response);
      allSourceDocumentNames.push(...docNames);
    } catch (error) {
      if (isQuotaError(error)) {
        const errMessage = error instanceof Error ? error.message : String(error);
        logLlmError({
          requestId: logContext?.requestId,
          sessionId: logContext?.sessionId,
          stage: retrievalStage,
          model: MODEL_NAME,
          error: error instanceof Error ? error : new Error(String(error)),
        });
        throw new GeminiQuotaExceededError(errMessage || "Gemini quota exceeded in complexAnswer retrieval");
      }
      
      logLlmError({
        requestId: logContext?.requestId,
        sessionId: logContext?.sessionId,
        stage: retrievalStage,
        model: MODEL_NAME,
        error: error instanceof Error ? error : new Error(String(error)),
      });
    }
  }

  logDebug("complex_answer_synthesis_start", {
    requestId: logContext?.requestId,
    sessionId: logContext?.sessionId,
    stage: "complexAnswer_synthesis",
    retrievedSnippetCount: retrievedSnippets.length,
    totalSourceDocs: allSourceDocumentNames.length,
  });

  const draftAnswerText = await synthesizeDraftAnswer(
    question,
    retrievedSnippets,
    sessionHistory,
    retrievalPlan,
    logContext
  );

  const uniqueDocNames = Array.from(new Set(allSourceDocumentNames));

  // Determine docSourceType based on actual retrieved documents
  const townPref = retrievalPlan.filters.townPreference;
  const docClassification = classifyDocumentSources(uniqueDocNames, townPref);
  const docSourceType: DocSourceType = docClassification.type;
  const docSourceTown: string | null = docClassification.town;

  logDebug("complex_answer_doc_source_tracking", {
    requestId: logContext?.requestId,
    sessionId: logContext?.sessionId,
    stage: "complexAnswer_docSource",
    docSourceType,
    docSourceTown,
    snippetCount: retrievedSnippets.length,
    sourceDocCount: uniqueDocNames.length,
    townPreference: townPref,
  });

  return {
    draftAnswerText,
    sourceDocumentNames: uniqueDocNames,
    docSourceType,
    docSourceTown
  };
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
  logContext?: PipelineLogContext
): Promise<string> {
  if (snippets.length === 0) {
    return "No directly relevant material was found in the OpenCouncil archive for this question. The available documents for this municipality do not address this question directly. You may wish to consult municipal records or counsel for more specific guidance.";
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

  const synthesisSystemPrompt = `You are an expert municipal governance assistant for New Hampshire. Synthesize information from multiple document sources to provide accurate, practical answers. Always distinguish between legal requirements and best practices.

For complex answers, use this structure exactly:
1. "### At a glance" - 2-4 bullet summary
2. "### Key numbers (Town)" - bullet list of dollars/percentages (omit if no numbers available)
3. "### Details from recent meetings" - compact narrative referencing specific meetings/documents

Keep total length around 400-600 words unless the question explicitly demands more.
When you use information from a document, mention it explicitly, e.g. "According to the Ossipee Board of Selectmen minutes from March 4, 2024..." or "As noted in the 2025 Ossipee budget...".

HYPER-LOCAL FOCUS (IMPORTANT):
- If a specific town is identified in the question or the retrieval filters (e.g. Ossipee, Conway), base your primary answer ONLY on documents for that town.
- Do NOT generalize to statewide RSA procedures or "how it usually works in NH" unless the user explicitly asks for statewide context.
- If the documents do not clearly explain the legal or procedural basis for how something was established or approved, say that explicitly instead of guessing.
- You may mention that state law or RSAs might apply, but do not describe their content in detail unless the user asked for that.
- Focus on specific meeting minutes, budget line items, and local decisions rather than theoretical RSA frameworks.`;

  logLlmRequest({
    requestId: logContext?.requestId,
    sessionId: logContext?.sessionId,
    stage: "complexAnswer_synthesis",
    model: MODEL_NAME,
    systemPrompt: synthesisSystemPrompt,
    userPrompt: synthesisPrompt,
    temperature: 0.3,
    extra: {
      snippetCount: snippets.length,
      historyLength: history.length,
      townPreference: plan.filters.townPreference,
    },
  });

  const startTime = Date.now();

  try {
    const response = await ai.models.generateContent({
      model: MODEL_NAME,
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
          stage: "synthesis",
          model: MODEL_NAME,
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
        stage: "complexAnswer_synthesis",
        model: MODEL_NAME,
        error: error instanceof Error ? error : new Error(String(error)),
      });
      throw new GeminiQuotaExceededError(errMessage || "Gemini quota exceeded in complexAnswer synthesis");
    }

    logLlmError({
      requestId: logContext?.requestId,
      sessionId: logContext?.sessionId,
      stage: "complexAnswer_synthesis",
      model: MODEL_NAME,
      error: error instanceof Error ? error : new Error(String(error)),
    });

    return "An error occurred while processing the retrieved documents. Please try again in a moment.";
  }
}

function extractSourceDocumentNames(response: any): string[] {
  const documentNames: string[] = [];

  if (response.candidates?.[0]?.groundingMetadata?.groundingChunks) {
    const chunks = response.candidates[0].groundingMetadata.groundingChunks;
    const seenDocs = new Set<string>();

    chunks.forEach((chunk: any) => {
      const uri = chunk.retrievedContext?.uri;
      if (uri && !seenDocs.has(uri)) {
        documentNames.push(uri);
        seenDocs.add(uri);
      }
      const title = chunk.web?.title;
      if (title && !seenDocs.has(title)) {
        documentNames.push(title);
        seenDocs.add(title);
      }
    });
  }

  return documentNames;
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
