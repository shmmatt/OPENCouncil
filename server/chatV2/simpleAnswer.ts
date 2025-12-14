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
  selectScopeNotice,
  archiveNotConfiguredNotice,
  statewideScopeNotice,
  noDocsScopeNotice,
  processingErrorNotice,
} from "./scopeUtils";
import type { ChatNotice } from "@shared/chatNotices";

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY || "" });

const MODEL_NAME = "gemini-3-pro-preview";

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
  notices: ChatNotice[];
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

    // CRITICAL: Extract retrieval doc count from File Search response
    // This is the ONLY signal used for scope/no-doc notice logic
    const retrievalResult = extractRetrievalDocCount(response);
    const retrievalDocCount = retrievalResult.count;
    const retrievalDocNames = retrievalResult.documentNames;
    
    // Grounding info is for LOGGING ONLY - not for notice logic
    const groundingInfo = extractGroundingInfoForLogging(response);
    
    // Use retrievalDocCount for determining if docs were found
    const hasDocResults = retrievalDocCount > 0;
    const userQuestion = routerOutput.rerankedQuestion || question;
    const isRSA = isRSAQuestion(userQuestion);

    // Verification logging: prove that retrievalDocCount is derived from file_search_response
    logDebug("scope_notice_inputs", {
      requestId: logContext?.requestId,
      sessionId: logContext?.sessionId,
      stage: "simpleAnswer",
      retrievalDocCount,
      note: "retrievalDocCount is derived ONLY from file_search_response",
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

    logLlmResponse({
      requestId: logContext?.requestId,
      sessionId: logContext?.sessionId,
      stage: "simpleAnswer",
      model: MODEL_NAME,
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
          model: MODEL_NAME,
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

    if (!hasDocResults && isRSA) {
      const rsaAnswer = await generateRSAGeneralKnowledgeAnswer(userQuestion, logContext);
      return { 
        answerText: rsaAnswer, 
        sourceDocumentNames: [],
        docSourceType: "statewide" as DocSourceType,
        docSourceTown: null,
        notices: [statewideScopeNotice()],
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
          notices: [statewideScopeNotice()],
        };
      }
      return {
        answerText: "No directly relevant material was found in the OpenCouncil archive for this question. The following general guidance may still be helpful, but local procedures can differ.",
        sourceDocumentNames: [],
        docSourceType: "none" as DocSourceType,
        docSourceTown: null,
        notices: [noDocsScopeNotice()],
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

    // Build notice based on doc source type
    // CRITICAL: Use retrievalDocCount for sourceCount - this is derived ONLY from file_search_response
    const scopeNotice = selectScopeNotice({ 
      docSourceType, 
      docSourceTown, 
      sourceCount: retrievalDocCount,
      isRSAQuestion: isRSA,
    });
    
    // Run sanity check in development to catch scope mismatches
    // Use retrievalDocCount - derived from file_search_response
    checkSimpleAnswerScopeMismatch(
      rawAnswerText,
      docSourceType,
      docSourceTown,
      retrievalDocCount,
      logContext
    );
    
    return { 
      answerText: rawAnswerText, 
      sourceDocumentNames: retrievalDocNames,
      docSourceType,
      docSourceTown,
      notices: [scopeNotice],
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

  return `You are an assistant helping small-town elected officials and public workers in New Hampshire.

${townContext}

Your role:
- Answer questions based on documents indexed in the OpenCouncil archive (municipal budgets, minutes, town reports, ordinances, etc.)
- Provide concise, practical answers (2-4 sentences unless the question clearly needs more)
- Reference specific document titles or sections when answering
- When a clear, document-based answer is not possible, explain that no directly relevant material was found in the OpenCouncil archive, and provide carefully labeled general guidance based on New Hampshire practice or law

---

INTERPRETING MEETING MINUTES AS NARRATIVE RECORDS

Meeting minutes often record decisions, proposals, and actions through discussion and motions, rather than through a single declarative sentence.

When answering questions based on meeting minutes:
- You may summarize proposals, actions, or issues by synthesizing consistent statements made during discussion, motions, or board comments.
- Treat repeated or uncontradicted discussion as evidence of scope or intent, even if the document does not explicitly label the project using formal terms.

Use careful attribution language such as:
- "The minutes indicate..."
- "Board discussion reflects..."
- "The proposal involved..."
- "Discussion focused on..."

Do not introduce facts that are not supported by the record.

---

GRADED CERTAINTY IS ALLOWED (NOT BINARY)

You are not required to choose between being fully specific or fully vague.

When documents support details indirectly or through discussion:
- Use graded confidence language (e.g., "appears to involve," "discussion suggests," "was described as...").
- Avoid speculation, but do not withhold reasonable summaries when the record supports them.

This applies especially to:
- Zoning and planning matters
- Variances and special exceptions
- Building or site changes discussed by boards

---

SEPARATE "WHAT IS DESCRIBED" FROM "WHAT IS NOT SPECIFIED"

When appropriate, structure answers to clearly distinguish between:
- What the minutes describe or show, and
- What the minutes do not explicitly specify

For example:
- "The minutes describe modifications to the roofline and upper structure without expanding the building footprint."
- "The minutes do not explicitly label the project as a 'second floor' or include construction drawings."

This improves clarity without overstating certainty.

---

SCOPE & SOURCE DISCIPLINE

- When your answer is based on OpenCouncil documents (including meeting minutes), do not state or imply that no relevant material was found.
- Only provide general New Hampshire guidance when no local documents are available or relevant.
- Maintain professional, neutral language suitable for public officials and municipal staff.

---

GUARDRAILS

- Do not speculate beyond what the documents reasonably support.
- Do not infer motives, legal conclusions, or outcomes unless explicitly recorded.
- Do not recharacterize informal discussion as finalized decisions unless a motion or vote is recorded.

---

Additional Guidelines:
- Be conservative and accurate
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

    // Log usage for cost tracking
    if (logContext?.actor) {
      const tokens = extractTokenCounts(response);
      await logLLMCall(
        {
          actor: logContext.actor,
          sessionId: logContext.sessionId,
          requestId: logContext.requestId,
          stage: "simpleAnswer",
          model: MODEL_NAME,
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
      model: MODEL_NAME,
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
