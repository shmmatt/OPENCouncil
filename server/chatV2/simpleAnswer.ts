import { GoogleGenAI } from "@google/genai";
import { getOrCreateFileSearchStoreId } from "../gemini-store";
import type { RouterOutput, ChatHistoryMessage, PipelineLogContext, DocSourceType } from "./types";
import { logLlmRequest, logLlmResponse, logLlmError } from "../utils/llmLogging";
import { logDebug } from "../utils/logger";
import { logFileSearchRequest, logFileSearchResponse, extractGroundingInfoForLogging, extractRetrievalDocCount } from "../utils/fileSearchLogging";
import { isQuotaError, GeminiQuotaExceededError } from "../utils/geminiErrors";
import { isRSAQuestion } from "./router";
import { logLLMCall, extractTokenCounts } from "../llm/callLLMWithLogging";
import { 
  archiveNotConfiguredNotice,
  processingErrorNotice,
} from "./scopeUtils";
import type { ChatNotice } from "@shared/chatNotices";
import { augmentSystemPromptWithComposedAnswer, type ComposedAnswerFlags } from "./composedFirstAnswer";
import { getModelForStage, type ModelContext } from "../llm/modelRegistry";
import { chatConfig } from "./chatConfig";
import { 
  twoLaneRetrieve,
  extractTwoLaneDocNames,
  buildTwoLaneSnippetText,
  classifyTwoLaneDocSource,
} from "./twoLaneRetrieve";

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY || "" });

const RSA_GENERAL_KNOWLEDGE_SYSTEM_PROMPT = `You are an assistant for New Hampshire municipal officials. The user is asking about New Hampshire Revised Statutes (RSA).

Provide a concise, plain-language summary based on general knowledge. Recommend consulting the official RSA text or municipal counsel for precise legal language when appropriate.

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
  composedAnswerFlags?: ComposedAnswerFlags;
  hasUserArtifact?: boolean;
}

interface SimpleAnswerResult {
  answerText: string;
  sourceDocumentNames: string[];
  docSourceType: import("./types").DocSourceType;
  docSourceTown: string | null;
  notices: ChatNotice[];
  composedAnswerApplied?: boolean;
}

export async function generateSimpleAnswer(
  options: SimpleAnswerOptions
): Promise<SimpleAnswerResult> {
  const { question, routerOutput, sessionHistory, userHints, logContext, composedAnswerFlags, hasUserArtifact } = options;

  // Build context for model selection (enables escalation for complex questions or user artifacts)
  const modelContext: ModelContext = {
    complexity: routerOutput.complexity,
    requiresComposedAnswer: routerOutput.requiresComposedAnswer,
    scopeHint: routerOutput.scopeHint,
    hasUserArtifact: hasUserArtifact ?? false,
  };
  const { model: modelName, wasEscalated, escalationReason } = getModelForStage('simpleAnswer', modelContext);

  const storeId = await getOrCreateFileSearchStoreId();

  if (!storeId) {
    return {
      answerText:
        "Document search is not yet configured. Please contact your administrator to set up document indexing.",
      sourceDocumentNames: [],
      docSourceType: "none" as DocSourceType,
      docSourceTown: null,
      notices: [archiveNotConfiguredNotice()],
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

  const baseSystemPrompt = buildSimpleAnswerSystemPrompt(userHints);
  
  const { prompt: systemInstruction, composedAnswerApplied } = composedAnswerFlags
    ? augmentSystemPromptWithComposedAnswer(baseSystemPrompt, composedAnswerFlags, userHints?.town)
    : { prompt: baseSystemPrompt, composedAnswerApplied: false };

  logLlmRequest({
    requestId: logContext?.requestId,
    sessionId: logContext?.sessionId,
    stage: "simpleAnswer",
    model: modelName,
    systemPrompt: systemInstruction,
    userPrompt: enhancedQuestion,
    extra: {
      domains: routerOutput.domains,
      historyLength: sessionHistory.length,
      hasUserHints: !!userHints,
      composedAnswerApplied,
      modelWasEscalated: wasEscalated,
      escalationReason,
    },
  });

  // ===== TWO-LANE RETRIEVAL INTEGRATION =====
  // If enabled, run parallel local + state retrieval first
  let twoLaneResult: Awaited<ReturnType<typeof twoLaneRetrieve>> | null = null;
  let useTwoLaneResults = false;
  
  if (chatConfig.ENABLE_PARALLEL_STATE_LANE) {
    try {
      twoLaneResult = await twoLaneRetrieve({
        userQuestion: question,
        rerankedQuestion: routerOutput.rerankedQuestion || question,
        townPreference: userHints?.town,
        domains: routerOutput.domains,
        scopeHint: routerOutput.scopeHint,
        logContext,
      });
      
      useTwoLaneResults = twoLaneResult.mergedTopChunks.length > 0;
      
      logDebug("simpleAnswer_twoLane_result", {
        requestId: logContext?.requestId,
        sessionId: logContext?.sessionId,
        stage: "simpleAnswer_twoLane",
        localCount: twoLaneResult.debug.localCount,
        stateCount: twoLaneResult.debug.stateCount,
        mergedCount: twoLaneResult.debug.mergedCount,
        durationMs: twoLaneResult.debug.durationMs,
        useTwoLaneResults,
      });
    } catch (twoLaneError) {
      logDebug("simpleAnswer_twoLane_error", {
        requestId: logContext?.requestId,
        sessionId: logContext?.sessionId,
        stage: "simpleAnswer_twoLane",
        error: twoLaneError instanceof Error ? twoLaneError.message : String(twoLaneError),
      });
      // Fall back to single File Search
    }
  }

  logFileSearchRequest({
    requestId: logContext?.requestId,
    sessionId: logContext?.sessionId,
    stage: "simpleAnswer_fileSearch",
    storeId,
    queryText: enhancedQuestion,
    filters: {
      domains: routerOutput.domains,
      town: userHints?.town,
      twoLaneEnabled: chatConfig.ENABLE_PARALLEL_STATE_LANE,
    },
  });

  const startTime = Date.now();

  try {
    // If two-lane retrieval succeeded, use its combined evidence
    // Otherwise fall back to standard File Search
    let rawAnswerText: string;
    let retrievalDocCount: number;
    let retrievalDocNames: string[];
    let durationMs: number;
    
    if (useTwoLaneResults && twoLaneResult) {
      // Use two-lane results - build context from both lanes
      const twoLaneSnippet = buildTwoLaneSnippetText(twoLaneResult);
      retrievalDocNames = extractTwoLaneDocNames(twoLaneResult);
      retrievalDocCount = retrievalDocNames.length;
      
      // Build enhanced prompt with two-lane evidence
      const twoLaneContents = [...contents];
      if (twoLaneSnippet) {
        twoLaneContents[twoLaneContents.length - 1] = {
          role: "user",
          parts: [{ text: `${enhancedQuestion}\n\n=== RETRIEVED EVIDENCE ===\n${twoLaneSnippet}` }],
        };
      }
      
      const response = await ai.models.generateContent({
        model: modelName,
        contents: twoLaneContents,
        config: {
          systemInstruction: systemInstruction,
          temperature: 0.3,
        },
      });
      
      rawAnswerText = response.text || "";
      durationMs = Date.now() - startTime;
      
      logLlmResponse({
        requestId: logContext?.requestId,
        sessionId: logContext?.sessionId,
        stage: "simpleAnswer",
        model: modelName,
        responseText: rawAnswerText,
        durationMs,
        extra: { twoLaneUsed: true },
      });

      // Log usage for cost tracking
      if (logContext?.actor) {
        const tokens = extractTokenCounts(response);
        await logLLMCall(
          {
            actor: logContext.actor,
            sessionId: logContext.sessionId,
            requestId: logContext.requestId,
            stage: "simpleAnswer",
            model: modelName,
            metadata: { twoLaneUsed: true },
          },
          { text: rawAnswerText, tokensIn: tokens.tokensIn, tokensOut: tokens.tokensOut }
        );
      }
    } else {
      // Standard File Search path
      const response = await ai.models.generateContent({
        model: modelName,
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

      rawAnswerText = response.text || "";
      durationMs = Date.now() - startTime;

      // CRITICAL: Extract retrieval doc count from File Search response
      const retrievalResult = extractRetrievalDocCount(response);
      retrievalDocCount = retrievalResult.count;
      retrievalDocNames = retrievalResult.documentNames;
      
      // Grounding info is for LOGGING ONLY - not for notice logic
      const groundingInfo = extractGroundingInfoForLogging(response);

      logLlmResponse({
        requestId: logContext?.requestId,
        sessionId: logContext?.sessionId,
        stage: "simpleAnswer",
        model: modelName,
        responseText: rawAnswerText,
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
            stage: "simpleAnswer",
            model: modelName,
          },
          { text: rawAnswerText, tokensIn: tokens.tokensIn, tokensOut: tokens.tokensOut }
        );
      }

      logFileSearchResponse({
        requestId: logContext?.requestId,
        sessionId: logContext?.sessionId,
        stage: "simpleAnswer_fileSearch",
        results: groundingInfo,
        responseText: rawAnswerText,
        durationMs,
      });
    }
    
    // Use retrievalDocCount for determining if docs were found
    const hasDocResults = retrievalDocCount > 0;
    const userQuestion = routerOutput.rerankedQuestion || question;
    const isRSA = isRSAQuestion(userQuestion);

    // Verification logging
    logDebug("scope_notice_inputs", {
      requestId: logContext?.requestId,
      sessionId: logContext?.sessionId,
      stage: "simpleAnswer",
      retrievalDocCount,
      twoLaneUsed: useTwoLaneResults,
    });

    logDebug("simpleAnswer_scope_check", {
      requestId: logContext?.requestId,
      sessionId: logContext?.sessionId,
      stage: "simpleAnswer",
      isRSAQuestion: isRSA,
      scopeHint: routerOutput.scopeHint,
      hasDocResults,
      retrievalDocCount,
    });

    if (!hasDocResults && isRSA) {
      const rsaAnswer = await generateRSAGeneralKnowledgeAnswer(userQuestion, logContext);
      return { 
        answerText: rsaAnswer, 
        sourceDocumentNames: [],
        docSourceType: "statewide" as DocSourceType,
        docSourceTown: null,
        notices: [],
      };
    }

    if (!rawAnswerText || rawAnswerText.toLowerCase().includes("i couldn't generate a response")) {
      if (isRSA) {
        const rsaAnswer = await generateRSAGeneralKnowledgeAnswer(userQuestion, logContext);
        return { 
          answerText: rsaAnswer, 
          sourceDocumentNames: [],
          docSourceType: "statewide" as DocSourceType,
          docSourceTown: null,
          notices: [],
        };
      }
      return {
        answerText: "No directly relevant material was found in available documents for this question. The following general guidance may still be helpful, but local procedures can differ.",
        sourceDocumentNames: [],
        docSourceType: "none" as DocSourceType,
        docSourceTown: null,
        notices: [],
      };
    }

    // Determine docSourceType based on actual retrieved documents (from File Search)
    const docClassification = classifyDocumentSources(retrievalDocNames, userHints?.town);
    let docSourceType: DocSourceType = docClassification.type;
    let docSourceTown: string | null = docClassification.town;

    // If no docs found but RSA question, mark as statewide
    if (!hasDocResults && isRSA) {
      docSourceType = "statewide";
    }

    // Log the doc source classification for debugging
    logDebug("simpleAnswer_docSource", {
      requestId: logContext?.requestId,
      sessionId: logContext?.sessionId,
      stage: "simpleAnswer_docSource",
      docSourceType,
      docSourceTown,
      retrievalDocCount,
      userHintsTown: userHints?.town,
      retrievalDocNames: retrievalDocNames.slice(0, 5),
    });

    // Scope badges disabled - classification was unreliable
    // TODO: Re-enable when badge logic analyzes answer content, not just document names
    
    return { 
      answerText: rawAnswerText, 
      sourceDocumentNames: retrievalDocNames,
      docSourceType,
      docSourceTown,
      notices: [],
      composedAnswerApplied,
    };
  } catch (error) {
    if (isQuotaError(error)) {
      const errMessage = error instanceof Error ? error.message : String(error);
      logLlmError({
        requestId: logContext?.requestId,
        sessionId: logContext?.sessionId,
        stage: "simpleAnswer",
        model: modelName,
        error: error instanceof Error ? error : new Error(String(error)),
      });
      throw new GeminiQuotaExceededError(errMessage || "Gemini quota exceeded in simpleAnswer");
    }

    logLlmError({
      requestId: logContext?.requestId,
      sessionId: logContext?.sessionId,
      stage: "simpleAnswer",
      model: modelName,
      error: error instanceof Error ? error : new Error(String(error)),
    });

    return {
      answerText:
        "Document search is temporarily unavailable. Please try again in a moment.",
      sourceDocumentNames: [],
      docSourceType: "none" as DocSourceType,
      docSourceTown: null,
      notices: [processingErrorNotice()],
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

  return `You are generating a concise answer for OpenCouncil.

${townContext}

Your goal is to provide a clear, practical response in 2–4 sentences.

RULES:

• Answer primarily based on the retrieved documents.
• Use neutral, professional language.
• Clearly distinguish between:
  - what the documents explicitly describe
  - what is not specified or not found

• EVIDENCE STRUCTURE:
  - Evidence may come from TWO sources: LOCAL (town-specific) and STATE (NH RSA, NHMA handbooks)
  - When evidence includes both local and state sections, synthesize them naturally
  - Lead with the most directly relevant information, then add context from the other source
  - Cite specific documents when possible (e.g., "According to the Ossipee Planning Board minutes...")

• If the question implies multiple contributing factors but only one facet is supported by retrieved documents:
  - explicitly state that the answer reflects only that facet
  - do NOT imply it explains the entire outcome

• EVIDENCE-FIRST APPROACH:
  - Only describe general NH process/mechanism if you have statewide documents that support it
  - Do NOT invent or assume statewide context without document evidence
  - If no statewide documents are retrieved, focus on what the local documents show

• If no relevant local documents are found:
  - state that local specifics were not available
  - only provide general NH context if you have evidence for it

• Always include appropriate non-legal-advice language when discussing law, regulation, or official process.

Never apologize for missing documents. Be factual and transparent.

IMPORTANT: All information is informational only and is not legal advice. Users should consult town counsel or NHMA for formal legal opinions.`;
}

async function generateRSAGeneralKnowledgeAnswer(
  question: string,
  logContext?: PipelineLogContext
): Promise<string> {
  const { model: modelName } = getModelForStage('degraded');
  
  logLlmRequest({
    requestId: logContext?.requestId,
    sessionId: logContext?.sessionId,
    stage: "simpleAnswer_rsaFallback",
    model: modelName,
    systemPrompt: RSA_GENERAL_KNOWLEDGE_SYSTEM_PROMPT,
    userPrompt: question,
    temperature: 0.3,
  });

  const startTime = Date.now();

  try {
    const response = await ai.models.generateContent({
      model: modelName,
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
      model: modelName,
      responseText: answerText,
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
          stage: "simpleAnswer",
          model: modelName,
          metadata: { fallback: "rsa" },
        },
        { text: answerText, tokensIn: tokens.tokensIn, tokensOut: tokens.tokensOut }
      );
    }

    if (!answerText) {
      return "No directly relevant material was found for this New Hampshire statute question. Please consult the official RSA text at gencourt.state.nh.us/rsa/html/indexes/ or contact NHMA for guidance.";
    }

    return answerText;
  } catch (error) {
    logLlmError({
      requestId: logContext?.requestId,
      sessionId: logContext?.sessionId,
      stage: "simpleAnswer_rsaFallback",
      model: modelName,
      error: error instanceof Error ? error : new Error(String(error)),
    });

    return "An error occurred while processing this New Hampshire statute question. Please consult the official RSA text at gencourt.state.nh.us/rsa/html/indexes/ or contact NHMA for guidance.";
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
 * List of known NH town names for automatic detection when no townHint is provided.
 * This helps classify documents correctly for simple path questions that mention
 * towns by name but don't have metadata.town set.
 */
const KNOWN_NH_TOWNS = [
  "Acworth", "Albany", "Alexandria", "Allenstown", "Alstead", "Alton", "Amherst",
  "Andover", "Antrim", "Ashland", "Atkinson", "Auburn", "Barnstead", "Barrington",
  "Bartlett", "Bath", "Bedford", "Belmont", "Bennington", "Benton", "Berlin",
  "Bethlehem", "Boscawen", "Bow", "Bradford", "Brentwood", "Bridgewater", "Bristol",
  "Brookfield", "Brookline", "Campton", "Canaan", "Candia", "Canterbury", "Carroll",
  "Center Harbor", "Charlestown", "Chatham", "Chester", "Chesterfield", "Chichester",
  "Claremont", "Clarksville", "Colebrook", "Columbia", "Concord", "Conway", "Cornish",
  "Croydon", "Dalton", "Danbury", "Danville", "Deerfield", "Deering", "Derry",
  "Dorchester", "Dover", "Dublin", "Dummer", "Dunbarton", "Durham", "East Kingston",
  "Easton", "Eaton", "Effingham", "Ellsworth", "Enfield", "Epping", "Epsom", "Errol",
  "Exeter", "Farmington", "Fitzwilliam", "Francestown", "Franconia", "Franklin",
  "Freedom", "Fremont", "Gilford", "Gilmanton", "Gilsum", "Goffstown", "Gorham",
  "Goshen", "Grafton", "Grantham", "Greenfield", "Greenland", "Greenville", "Groton",
  "Hampstead", "Hampton", "Hampton Falls", "Hancock", "Hanover", "Harrisville", "Hart's Location",
  "Haverhill", "Hebron", "Henniker", "Hill", "Hillsborough", "Hinsdale", "Holderness",
  "Hollis", "Hooksett", "Hopkinton", "Hudson", "Jackson", "Jaffrey", "Jefferson",
  "Keene", "Kensington", "Kingston", "Laconia", "Lancaster", "Landaff", "Langdon",
  "Lebanon", "Lee", "Lempster", "Lincoln", "Lisbon", "Litchfield", "Littleton",
  "Londonderry", "Loudon", "Lyman", "Lyme", "Lyndeborough", "Madbury", "Madison",
  "Manchester", "Marlborough", "Marlow", "Mason", "Meredith", "Merrimack", "Middleton",
  "Milan", "Milford", "Milton", "Monroe", "Mont Vernon", "Moultonborough", "Nashua",
  "Nelson", "New Boston", "New Castle", "New Durham", "New Hampton", "New Ipswich",
  "New London", "Newbury", "Newfields", "Newington", "Newmarket", "Newport", "Newton",
  "North Hampton", "Northfield", "Northumberland", "Northwood", "Nottingham", "Orange",
  "Orford", "Ossipee", "Pelham", "Pembroke", "Peterborough", "Piermont", "Pittsburg",
  "Pittsfield", "Plainfield", "Plaistow", "Plymouth", "Portsmouth", "Randolph", "Raymond",
  "Richmond", "Rindge", "Rochester", "Rollinsford", "Roxbury", "Rumney", "Rye",
  "Salem", "Salisbury", "Sanbornton", "Sandown", "Sandwich", "Seabrook", "Sharon",
  "Shelburne", "Somersworth", "South Hampton", "Springfield", "Stark", "Stewartstown",
  "Stoddard", "Strafford", "Stratford", "Stratham", "Sugar Hill", "Sullivan", "Sunapee",
  "Surry", "Sutton", "Swanzey", "Tamworth", "Temple", "Thornton", "Tilton", "Troy",
  "Tuftonboro", "Unity", "Wakefield", "Walpole", "Warner", "Warren", "Washington",
  "Waterville Valley", "Weare", "Webster", "Wentworth", "Westmoreland", "Whitefield",
  "Wilmot", "Wilton", "Winchester", "Windham", "Windsor", "Wolfeboro", "Woodstock"
];

/**
 * Try to detect a town name from document names/URIs when no explicit townHint is provided.
 * Scans document names for known NH town names.
 */
function detectTownFromDocuments(docNames: string[]): string | null {
  const combinedText = docNames.join(" ").toLowerCase();
  
  // Check for known NH towns in document names
  for (const town of KNOWN_NH_TOWNS) {
    const townLower = town.toLowerCase();
    // Use word boundary matching to avoid partial matches
    const regex = new RegExp(`\\b${townLower}\\b`, 'i');
    if (regex.test(combinedText)) {
      return town; // Return the properly capitalized version
    }
  }
  
  // Also check for patterns like "Town of X" in the document names
  const townOfPattern = /\btown\s+of\s+([A-Z][a-zA-Z\s]+?)(?:\s+(?:planning|board|select|budget|minutes|report)|,|\.|$)/i;
  for (const docName of docNames) {
    const match = docName.match(townOfPattern);
    if (match && match[1]) {
      const extractedTown = match[1].trim();
      // Verify it's a known town
      const knownMatch = KNOWN_NH_TOWNS.find(t => t.toLowerCase() === extractedTown.toLowerCase());
      if (knownMatch) {
        return knownMatch;
      }
    }
  }
  
  return null;
}

/**
 * Classify document sources based on their names/URIs.
 * Returns the doc source type and detected town.
 * 
 * Enhanced to detect town from document names when no townHint is provided,
 * fixing the bug where simple path answers using municipal docs would
 * still show "no docs found" scope note.
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
  let detectedTown: string | null = townHint || null;

  // If no town hint provided, try to detect from document names
  if (!detectedTown) {
    detectedTown = detectTownFromDocuments(docNames);
  }

  for (const docName of docNames) {
    const isStatewideDoc = STATEWIDE_PATTERNS.some(pattern => pattern.test(docName));
    
    if (isStatewideDoc) {
      hasStatewide = true;
    } else {
      // If not matching statewide patterns, assume local
      hasLocal = true;
      // If we still don't have a detected town, try to find one from this doc
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
 * Development sanity check: warns if the answer content appears to reference
 * local documents but docSourceType is set to "none".
 * This helps catch mis-wiring early without blocking responses.
 */
function checkSimpleAnswerScopeMismatch(
  answer: string,
  docSourceType: DocSourceType,
  docSourceTown: string | null,
  sourceDocCount: number,
  logContext?: { requestId?: string; sessionId?: string }
): void {
  if (process.env.NODE_ENV !== "development") return;
  
  if (docSourceType === "none" && sourceDocCount > 0) {
    // We have docs but docSourceType is none - this is definitely a bug
    logDebug("scope_answer_mismatch_simple", {
      requestId: logContext?.requestId,
      sessionId: logContext?.sessionId,
      stage: "sanity_check",
      docSourceType,
      docSourceTown,
      sourceDocCount,
      reason: "Has source docs but docSourceType=none",
      answerPreview: answer.slice(0, 200),
    });
  }
  
  if (docSourceType === "none") {
    // Check for patterns that suggest local document usage
    const localPatterns = [
      /According to the .* minutes/i,
      /As noted in the .* budget/i,
      /Planning Board/i,
      /Board of Selectmen/i,
      /BOS minutes/i,
      /warrant article/i,
      /town report/i,
      /Case\s*#?\d+/i, // Case numbers like "Case #25-02-LM"
      /OpenCouncil archive/i,
    ];

    const hasLocalReferences = localPatterns.some(pattern => pattern.test(answer));

    if (hasLocalReferences) {
      logDebug("scope_answer_mismatch_simple_patterns", {
        requestId: logContext?.requestId,
        sessionId: logContext?.sessionId,
        stage: "sanity_check",
        docSourceType,
        docSourceTown,
        sourceDocCount,
        reason: "Answer contains local document references but docSourceType=none",
        answerPreview: answer.slice(0, 200),
      });
    }
  }
}
