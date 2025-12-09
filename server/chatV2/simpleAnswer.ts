import { GoogleGenAI } from "@google/genai";
import { getOrCreateFileSearchStoreId } from "../gemini-store";
import type { RouterOutput, ChatHistoryMessage, PipelineLogContext, DocSourceType } from "./types";
import { logLlmRequest, logLlmResponse, logLlmError } from "../utils/llmLogging";
import { logDebug } from "../utils/logger";
import { logFileSearchRequest, logFileSearchResponse, extractGroundingInfoForLogging } from "../utils/fileSearchLogging";
import { isQuotaError, GeminiQuotaExceededError } from "../utils/geminiErrors";
import { isRSAQuestion } from "./router";
import { 
  generateStatewideDisclaimer, 
  generateNoDocsFoundMessage, 
  selectScopeNote,
  LOCAL_SCOPE_NOTE,
  STATEWIDE_SCOPE_NOTE,
  NO_DOC_SCOPE_NOTE
} from "./scopeUtils";

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY || "" });

const MODEL_NAME = "gemini-2.5-flash";

const RSA_GENERAL_KNOWLEDGE_SYSTEM_PROMPT = `You are an assistant for New Hampshire municipal officials. The user is asking about New Hampshire Revised Statutes (RSA).

Provide a concise, plain-language summary based on general knowledge. When appropriate, mention that this is not based on OpenCouncil-indexed municipal documents, and recommend consulting the official RSA text or municipal counsel for precise legal language.

Guidelines:
- Provide a 2-6 sentence answer summarizing the RSA or concept
- Be accurate and conservative - don't speculate beyond what is well-established
- Use professional but accessible language
- If you're unsure about specifics, acknowledge that and recommend official sources

IMPORTANT: This is informational only, not legal advice. Users should consult the official RSA text or municipal counsel for formal legal opinions.`;

interface SimpleAnswerOptions {
  question: string;
  routerOutput: RouterOutput;
  sessionHistory: ChatHistoryMessage[];
  userHints?: { town?: string; board?: string };
  logContext?: PipelineLogContext;
}

interface SimpleAnswerResult {
  answerText: string;
  sourceDocumentNames: string[];
  docSourceType: import("./types").DocSourceType;
  docSourceTown: string | null;
}

export async function generateSimpleAnswer(
  options: SimpleAnswerOptions
): Promise<SimpleAnswerResult> {
  const { question, routerOutput, sessionHistory, userHints, logContext } = options;

  const storeId = await getOrCreateFileSearchStoreId();

  if (!storeId) {
    return {
      answerText:
        "The OpenCouncil archive is not yet configured. Please contact your administrator to set up document indexing.",
      sourceDocumentNames: [],
      docSourceType: "none" as DocSourceType,
      docSourceTown: null
    };
  }

  const contents: Array<{ role: string; parts: Array<{ text: string }> }> = [];

  sessionHistory.slice(-6).forEach((msg) => {
    contents.push({
      role: msg.role === "user" ? "user" : "model",
      parts: [{ text: msg.content }],
    });
  });

  const enhancedQuestion = buildEnhancedQuestion(
    routerOutput.rerankedQuestion || question,
    routerOutput.domains,
    userHints
  );

  contents.push({
    role: "user",
    parts: [{ text: enhancedQuestion }],
  });

  const systemInstruction = buildSimpleAnswerSystemPrompt(userHints);

  logLlmRequest({
    requestId: logContext?.requestId,
    sessionId: logContext?.sessionId,
    stage: "simpleAnswer",
    model: MODEL_NAME,
    systemPrompt: systemInstruction,
    userPrompt: enhancedQuestion,
    extra: {
      domains: routerOutput.domains,
      historyLength: sessionHistory.length,
      hasUserHints: !!userHints,
    },
  });

  logFileSearchRequest({
    requestId: logContext?.requestId,
    sessionId: logContext?.sessionId,
    stage: "simpleAnswer_fileSearch",
    storeId,
    queryText: enhancedQuestion,
    filters: {
      domains: routerOutput.domains,
      town: userHints?.town,
    },
  });

  const startTime = Date.now();

  try {
    const response = await ai.models.generateContent({
      model: MODEL_NAME,
      contents: contents,
      config: {
        systemInstruction: systemInstruction,
        tools: [
          {
            fileSearch: {
              fileSearchStoreNames: [storeId],
            },
          } as any,
        ],
      },
    });

    const rawAnswerText = response.text || "";
    const durationMs = Date.now() - startTime;

    const sourceDocumentNames = extractSourceDocumentNames(response);
    const groundingInfo = extractGroundingInfoForLogging(response);
    const hasDocResults = sourceDocumentNames.length > 0;
    const userQuestion = routerOutput.rerankedQuestion || question;
    const isRSA = isRSAQuestion(userQuestion);

    logDebug("simpleAnswer_scope_check", {
      requestId: logContext?.requestId,
      sessionId: logContext?.sessionId,
      stage: "simpleAnswer",
      isRSAQuestion: isRSA,
      scopeHint: routerOutput.scopeHint,
      hasDocResults,
      sourceCount: sourceDocumentNames.length,
    });

    logLlmResponse({
      requestId: logContext?.requestId,
      sessionId: logContext?.sessionId,
      stage: "simpleAnswer",
      model: MODEL_NAME,
      responseText: rawAnswerText,
      durationMs,
    });

    logFileSearchResponse({
      requestId: logContext?.requestId,
      sessionId: logContext?.sessionId,
      stage: "simpleAnswer_fileSearch",
      results: groundingInfo,
      responseText: rawAnswerText,
      durationMs,
    });

    if (!hasDocResults && isRSA) {
      const rsaAnswer = await generateRSAGeneralKnowledgeAnswer(userQuestion, logContext);
      return { 
        answerText: rsaAnswer + generateStatewideDisclaimer(), 
        sourceDocumentNames: [],
        docSourceType: "statewide" as DocSourceType,
        docSourceTown: null
      };
    }

    if (!rawAnswerText || rawAnswerText.toLowerCase().includes("i couldn't generate a response")) {
      if (isRSA) {
        const rsaAnswer = await generateRSAGeneralKnowledgeAnswer(userQuestion, logContext);
        return { 
          answerText: rsaAnswer + generateStatewideDisclaimer(), 
          sourceDocumentNames: [],
          docSourceType: "statewide" as DocSourceType,
          docSourceTown: null
        };
      }
      return {
        answerText: generateNoDocsFoundMessage(false),
        sourceDocumentNames: [],
        docSourceType: "none" as DocSourceType,
        docSourceTown: null
      };
    }

    // Determine docSourceType based on actual retrieved documents
    const docClassification = classifyDocumentSources(sourceDocumentNames, userHints?.town);
    let docSourceType: DocSourceType = docClassification.type;
    let docSourceTown: string | null = docClassification.town;

    // If no docs found but RSA question, mark as statewide
    if (!hasDocResults && isRSA) {
      docSourceType = "statewide";
    }

    const scopeNote = selectScopeNote({ docSourceType, docSourceTown });
    
    return { 
      answerText: rawAnswerText + scopeNote, 
      sourceDocumentNames,
      docSourceType,
      docSourceTown
    };
  } catch (error) {
    if (isQuotaError(error)) {
      const errMessage = error instanceof Error ? error.message : String(error);
      logLlmError({
        requestId: logContext?.requestId,
        sessionId: logContext?.sessionId,
        stage: "simpleAnswer",
        model: MODEL_NAME,
        error: error instanceof Error ? error : new Error(String(error)),
      });
      throw new GeminiQuotaExceededError(errMessage || "Gemini quota exceeded in simpleAnswer");
    }

    logLlmError({
      requestId: logContext?.requestId,
      sessionId: logContext?.sessionId,
      stage: "simpleAnswer",
      model: MODEL_NAME,
      error: error instanceof Error ? error : new Error(String(error)),
    });

    return {
      answerText:
        "The OpenCouncil archive is temporarily unavailable. Please try again in a moment.",
      sourceDocumentNames: [],
      docSourceType: "none" as DocSourceType,
      docSourceTown: null
    };
  }
}

function buildEnhancedQuestion(
  question: string,
  domains: string[],
  userHints?: { town?: string; board?: string }
): string {
  let enhanced = question;

  if (userHints?.town && !question.toLowerCase().includes(userHints.town.toLowerCase())) {
    enhanced += ` (Context: ${userHints.town} town)`;
  }

  if (userHints?.board && !question.toLowerCase().includes(userHints.board.toLowerCase())) {
    enhanced += ` (Relevant board: ${userHints.board})`;
  }

  return enhanced;
}

function buildSimpleAnswerSystemPrompt(
  userHints?: { town?: string; board?: string }
): string {
  let townContext = "";
  if (userHints?.town) {
    townContext = `The user is asking about ${userHints.town}. Prioritize ${userHints.town}-specific documents when available, but you may reference statewide guidance if local information is not available.`;
  }

  return `You are an assistant helping small-town elected officials and public workers in New Hampshire.

${townContext}

Your role:
- Answer questions based on documents indexed in the OpenCouncil archive (municipal budgets, minutes, town reports, ordinances, etc.)
- Provide concise, practical answers (2-4 sentences unless the question clearly needs more)
- Reference specific document titles or sections when answering
- When a clear, document-based answer is not possible, explain that no directly relevant material was found in the OpenCouncil archive, and provide carefully labeled general guidance based on New Hampshire practice or law

Guidelines:
- Be conservative and accurate - don't speculate
- Use professional but accessible language
- Prioritize actionable guidance
- When citing, mention the document name clearly
- Never use phrases like "your documents" or imply the user personally provided documents

IMPORTANT: All information is informational only and is not legal advice. Users should consult town counsel or NHMA for formal legal opinions.`;
}

async function generateRSAGeneralKnowledgeAnswer(
  question: string,
  logContext?: PipelineLogContext
): Promise<string> {
  logLlmRequest({
    requestId: logContext?.requestId,
    sessionId: logContext?.sessionId,
    stage: "simpleAnswer_rsaFallback",
    model: MODEL_NAME,
    systemPrompt: RSA_GENERAL_KNOWLEDGE_SYSTEM_PROMPT,
    userPrompt: question,
    temperature: 0.3,
  });

  const startTime = Date.now();

  try {
    const response = await ai.models.generateContent({
      model: MODEL_NAME,
      contents: [{ role: "user", parts: [{ text: question }] }],
      config: {
        systemInstruction: RSA_GENERAL_KNOWLEDGE_SYSTEM_PROMPT,
        temperature: 0.3,
      },
    });

    const answerText = response.text || "";
    const durationMs = Date.now() - startTime;

    logLlmResponse({
      requestId: logContext?.requestId,
      sessionId: logContext?.sessionId,
      stage: "simpleAnswer_rsaFallback",
      model: MODEL_NAME,
      responseText: answerText,
      durationMs,
    });

    if (!answerText) {
      return "No directly relevant material was found for this New Hampshire statute question. Please consult the official RSA text at gencourt.state.nh.us/rsa/html/indexes/ or contact NHMA for guidance.";
    }

    return answerText;
  } catch (error) {
    logLlmError({
      requestId: logContext?.requestId,
      sessionId: logContext?.sessionId,
      stage: "simpleAnswer_rsaFallback",
      model: MODEL_NAME,
      error: error instanceof Error ? error : new Error(String(error)),
    });

    return "An error occurred while processing this New Hampshire statute question. Please consult the official RSA text at gencourt.state.nh.us/rsa/html/indexes/ or contact NHMA for guidance.";
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

  if (response.candidates?.[0]?.groundingMetadata?.retrievalMetadata?.googleSearchDynamicRetrievalScore !== undefined) {
    const sources = response.candidates?.[0]?.groundingMetadata?.webSearchQueries;
    if (sources) {
      console.log("Web search was used:", sources);
    }
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
