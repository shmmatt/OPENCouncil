/**
 * V3 Synthesizer - Stage 3 of the Chat v3 Pipeline
 * 
 * Responsibilities:
 * 1. Generate prose-first answers (civic memo style)
 * 2. Apply RecordStrength tier behavior (A/B/C confidence levels)
 * 3. Enforce citation requirements (no uncited RSA claims)
 * 4. Anti-ChatGPT style: no headings, no filler, no template language
 */

import { GoogleGenAI } from "@google/genai";
import { getModelForStage } from "../llm/modelRegistry";
import { logLlmRequest, logLlmResponse, logLlmError } from "../utils/llmLogging";
import { logLLMCall, extractTokenCounts } from "../llm/callLLMWithLogging";
import { isQuotaError, GeminiQuotaExceededError } from "../utils/geminiErrors";
import { logDebug } from "../utils/logger";
import { getProsePolicy, type ProsePolicy } from "./answerPolicy";
import type {
  SynthesisInputV3,
  RecordStrength,
  LabeledChunk,
  IssueMap,
  PipelineLogContext,
  ChatHistoryMessage,
  AnswerType,
  RenderStyle,
} from "./types";

const ai = new GoogleGenAI({ apiKey: process.env.GEM_API_KEY || "" });

export interface SynthesisV3Options extends SynthesisInputV3 {
  logContext?: PipelineLogContext;
  isRepairAttempt?: boolean;
  isFinalAttempt?: boolean;
  answerType?: AnswerType;
  renderStyle?: RenderStyle;
}

export interface SynthesisV3Result {
  answerText: string;
  citationsUsed: string[];
  durationMs: number;
  hasSufficientContext: boolean;
  missingInformationQuery: string | null;
  suggestedYear: number | null;
}

const SYNTHESIS_RESPONSE_SCHEMA = {
  type: "object" as const,
  properties: {
    has_sufficient_context: {
      type: "boolean" as const,
      description: "True if the provided chunks are sufficient to fully answer the prompt. False if a specific, critical piece of evidence is missing.",
    },
    missing_information_query: {
      type: "string" as const,
      nullable: true,
      description: "If has_sufficient_context is false, a highly targeted search query to find the missing data. Otherwise null.",
    },
    suggested_year: {
      type: "number" as const,
      nullable: true,
      description: "If has_sufficient_context is false, the year the missing information is most likely found in. Otherwise null.",
    },
    response: {
      type: "string" as const,
      description: "The full markdown response to the user's question.",
    },
  },
  required: ["has_sufficient_context", "missing_information_query", "suggested_year", "response"],
};

export async function synthesizeV3(options: SynthesisV3Options): Promise<SynthesisV3Result> {
  const { 
    userMessage, 
    issueMap, 
    sessionSourceText, 
    localChunks, 
    stateChunks, 
    recordStrength,
    history,
    logContext,
    isRepairAttempt,
    isFinalAttempt,
    answerType = "QUICK_PROCESS",
    renderStyle = "PROSE",
    templateContext,
  } = options;
  
  const { model: modelName } = getModelForStage('complexSynthesis');
  const startTime = Date.now();

  const prosePolicy = getProsePolicy(answerType, renderStyle);
  let systemPrompt = buildProseSystemPrompt(recordStrength, issueMap, answerType, renderStyle, prosePolicy, isRepairAttempt, stateChunks.length);

  systemPrompt += `\n\n## EVIDENCE SUFFICIENCY (IMPORTANT)
- You are analyzing municipal and legal documents. Do NOT infer or guess the outcome of votes, budgets, or legal decisions.
- If you see a proposal (e.g., a warrant article) but no document confirming the result (vote outcome, approval, rejection), you MUST set has_sufficient_context to false.
- When has_sufficient_context is false, generate a highly targeted missing_information_query (e.g., "March 2025 Town Meeting election results Article 13 passed failed").
- Set suggested_year to the year the missing information is most likely found in (this may differ from the year the user asked about).
- If all critical evidence is present, set has_sufficient_context to true, missing_information_query to null, and suggested_year to null.`;

  if (isFinalAttempt) {
    systemPrompt += `\n\n## FINAL ATTEMPT — NO FURTHER SEARCHES
- This is your SECOND and FINAL attempt with additional evidence retrieved.
- You MUST set has_sufficient_context to true (do NOT request another search).
- Set missing_information_query to null and suggested_year to null.
- If the missing information was found in the new evidence, incorporate it into your response.
- If the missing information is STILL not found, explicitly state which specific document (e.g., "official Town Meeting voting results for 2025") is not present in the current database. Do NOT guess the outcome.`;
  }

  if (templateContext) {
    systemPrompt += `\n\n## Template Document Context\n${templateContext}\nWhen answering, keep the above template context in mind. The user is exploring a structured document and may ask follow-up questions about specific sections, budget items, or warrant articles. Search the full municipal database for historical context and related records, not just the template's target documents.`;
  }
  const userPrompt = buildSynthesisUserPrompt(
    userMessage, 
    issueMap, 
    sessionSourceText, 
    localChunks, 
    stateChunks,
    history
  );

  const synthesisTemperature = isRepairAttempt ? 0.15 : 0.2;

  logLlmRequest({
    requestId: logContext?.requestId,
    sessionId: logContext?.sessionId,
    stage: "synthesizerV3",
    model: modelName,
    systemPrompt: systemPrompt.slice(0, 500),
    userPrompt: userPrompt.slice(0, 500),
    temperature: synthesisTemperature,
    extra: {
      tier: recordStrength.tier,
      localChunkCount: localChunks.length,
      stateChunkCount: stateChunks.length,
      isRepairAttempt,
      isFinalAttempt,
    },
  });

  try {
    const response = await ai.models.generateContent({
      model: modelName,
      contents: [{ role: "user", parts: [{ text: userPrompt }] }],
      config: {
        systemInstruction: systemPrompt,
        temperature: synthesisTemperature,
        maxOutputTokens: 8192,
        responseMimeType: "application/json",
        responseSchema: SYNTHESIS_RESPONSE_SCHEMA,
      },
    });

    const finishReason = response.candidates?.[0]?.finishReason;
    if (finishReason === 'MAX_TOKENS') {
      logDebug(`synthesizerV3: WARNING: Gemini response truncated due to MAX_TOKENS (requestId: ${logContext?.requestId})`);
    }

    const rawText = response.text || "";
    const durationMs = Date.now() - startTime;

    const parsed = parseSynthesisJsonResponse(rawText, isFinalAttempt);

    logLlmResponse({
      requestId: logContext?.requestId,
      sessionId: logContext?.sessionId,
      stage: "synthesizerV3",
      model: modelName,
      responseText: parsed.response.slice(0, 500),
      durationMs,
      extra: {
        hasSufficientContext: parsed.hasSufficientContext,
        missingInformationQuery: parsed.missingInformationQuery,
        suggestedYear: parsed.suggestedYear,
      },
    });

    if (logContext?.actor) {
      const tokens = extractTokenCounts(response);
      await logLLMCall(
        {
          actor: logContext.actor,
          sessionId: logContext.sessionId,
          requestId: logContext.requestId,
          stage: "synthesizerV3" as any,
          model: modelName,
        },
        { text: parsed.response, tokensIn: tokens.tokensIn, tokensOut: tokens.tokensOut }
      );
    }

    const citationsUsed = extractCitationsFromAnswer(parsed.response);

    return {
      answerText: parsed.response,
      citationsUsed,
      durationMs,
      hasSufficientContext: parsed.hasSufficientContext,
      missingInformationQuery: parsed.missingInformationQuery,
      suggestedYear: parsed.suggestedYear,
    };

  } catch (error) {
    if (isQuotaError(error)) {
      const errMessage = error instanceof Error ? error.message : String(error);
      throw new GeminiQuotaExceededError(errMessage || "Gemini quota exceeded in synthesizerV3");
    }

    logLlmError({
      requestId: logContext?.requestId,
      sessionId: logContext?.sessionId,
      stage: "synthesizerV3",
      model: modelName,
      error: error instanceof Error ? error : new Error(String(error)),
    });

    return {
      answerText: "An error occurred while synthesizing the answer. Please try again.",
      citationsUsed: [],
      durationMs: Date.now() - startTime,
      hasSufficientContext: true,
      missingInformationQuery: null,
      suggestedYear: null,
    };
  }
}

interface ParsedSynthesisResponse {
  hasSufficientContext: boolean;
  missingInformationQuery: string | null;
  suggestedYear: number | null;
  response: string;
}

function parseSynthesisJsonResponse(rawText: string, isFinalAttempt?: boolean): ParsedSynthesisResponse {
  try {
    const parsed = JSON.parse(rawText);
    const hasSufficient = isFinalAttempt ? true : (parsed.has_sufficient_context === true);
    const missingQuery = hasSufficient ? null : (typeof parsed.missing_information_query === 'string' ? parsed.missing_information_query : null);
    const sugYear = hasSufficient ? null : (typeof parsed.suggested_year === 'number' ? parsed.suggested_year : null);
    const response = typeof parsed.response === 'string' && parsed.response.length > 0
      ? parsed.response
      : "Unable to synthesize an answer from the available sources.";

    return { hasSufficientContext: hasSufficient, missingInformationQuery: missingQuery, suggestedYear: sugYear, response };
  } catch {
    logDebug("synthesizerV3: JSON parse failed, treating raw text as response");
    return {
      hasSufficientContext: true,
      missingInformationQuery: null,
      suggestedYear: null,
      response: rawText || "Unable to synthesize an answer from the available sources.",
    };
  }
}

function buildProseSystemPrompt(
  recordStrength: RecordStrength, 
  issueMap: IssueMap,
  answerType: AnswerType,
  renderStyle: RenderStyle,
  prosePolicy: ProsePolicy,
  isRepairAttempt?: boolean,
  stateChunkCount?: number
): string {
  const tierInstructions = getTierInstructions(recordStrength);
  const hasStateChunks = (stateChunkCount || 0) > 0;
  const answerTemplate = getAnswerTypeTemplate(answerType, renderStyle, prosePolicy, hasStateChunks);
  
  const repairNote = isRepairAttempt 
    ? `\n\n**REPAIR ATTEMPT**: Previous answer violated prose rules. You MUST:
- Rewrite as flowing paragraphs (no headings unless LIST mode)
- Remove any template-style phrases
- Keep citations but make them inline and subtle
- Stay within ${prosePolicy.wordMin}-${prosePolicy.wordMax} words`
    : '';

  const crossRefInstructions = buildCrossReferenceInstructions(issueMap);
  const recencyInstructions = buildRecencyInstructions(issueMap);

  return `You are a town administrator explaining municipal governance to a resident in an email. Write calmly, neutrally, with short sentences.

## TL;DR SECTION (MANDATORY - EVERY RESPONSE)
- Start EVERY response with a **TL;DR** line followed by 2-3 bold bullet points summarizing the key takeaway
- Format exactly like this:
  **TL;DR**
  - **Key point one** — brief explanation
  - **Key point two** — brief explanation
  - **Key point three** — brief explanation (optional)
- After the TL;DR bullets, add a blank line and then provide the detailed explanation below
- The TL;DR should be ~30-50 words total — punchy and scannable
- Use **bold** for key terms, proper nouns, dollar amounts, and important concepts throughout the entire response

## WORD COUNT (MANDATORY - COUNT CAREFULLY)
- Target: ${prosePolicy.wordMin}-${prosePolicy.wordMax} words (HARD LIMITS — includes TL;DR section)
- Paragraphs: ${prosePolicy.paragraphs.min}-${prosePolicy.paragraphs.max} (after the TL;DR)
${!prosePolicy.allowHeadings ? '- NO section headings allowed (except the TL;DR label)' : ''}
${!prosePolicy.allowBullets ? '- NO bullet lists allowed (except in the TL;DR section)' : ''}

## PROSE-FIRST RENDERING
${answerTemplate}

## ANTI-CHATGPT STYLE CONSTRAINTS (MANDATORY)
${renderStyle === "PROSE" ? "- Do NOT use section headings, bold headings, or markdown headers (except the TL;DR label)" : ""}
- Do NOT use phrases like: "Bottom line", "What we know", "Unknowns that matter", "What changes"
- Do NOT use phrases like: "next steps", "you may wish to", "consult counsel", "I recommend", "consider"
- Do NOT use meta-language like: "based on the provided documents...", "the sources indicate..."
- Do NOT start sentences with: "It's important to note...", "It should be noted...", "Worth mentioning..."
- Prefer plain statements with citations at sentence ends: "...as outlined in the ordinance. [L1]"
- Write like you're explaining this to a neighbor, not generating a report

## CIVIC TONE
- Calm, neutral, professional
- Short sentences preferred
- No legalese unless quoting a source
- Be direct and helpful without being preachy
${crossRefInstructions}${recencyInstructions}
## CITATION RULES
- Cite facts/legal claims inline at sentence end: "...requires a public hearing. [S1]"
- [Lx] for local documents (minutes, ordinances, etc.)
- [Sx] for state law (RSA, NHMA guidance)
- [USER] only when referencing user-provided text
- If only local sources exist, answer using local only
- If state sources are weak/irrelevant, do not mention state law
${hasStateChunks ? '- Include at least 1 state citation [Sx] if relevant to the legal framework' : ''}

## TIER INSTRUCTIONS (${recordStrength.tier})
${tierInstructions}

## HARD RULES
1. NEVER mention specific RSA numbers unless cited with [Sx]
2. Do NOT fabricate procedures or requirements
3. Do NOT substitute related cases or prior conversation topics
4. Keep answer grounded in retrieved sources only
${repairNote}

## CONTEXT
${issueMap.situationTitle ? `Situation: "${issueMap.situationTitle}"` : 'General question'}
${issueMap.legalTopics.length > 0 ? `Topics: ${issueMap.legalTopics.join(', ')}` : ''}`;
}

function getAnswerTypeTemplate(answerType: AnswerType, renderStyle: RenderStyle, prosePolicy: ProsePolicy, hasStateChunks: boolean): string {
  if (renderStyle === "LIST") {
    return `Write answer as a numbered or bulleted list since the user requested list format.
Include brief intro sentence, then list items, then brief sources line.
Target ${prosePolicy.wordMin}-${prosePolicy.wordMax} words.`;
  }

  switch (answerType) {
    case "QUICK_PROCESS":
      return `QUICK_PROCESS answer (${prosePolicy.wordMin}-${prosePolicy.wordMax} words):
- Write ${prosePolicy.paragraphs.min}-${prosePolicy.paragraphs.max} short paragraphs
- NO headings, NO bullet lists
- Must include: what to file, where to file, key requirement/constraint
- Include 1 local citation and 0-1 state citation if relevant
- Be direct and practical`;

    case "EXPLAINER":
      return `EXPLAINER answer (${prosePolicy.wordMin}-${prosePolicy.wordMax} words):
- Write ${prosePolicy.paragraphs.min}-${prosePolicy.paragraphs.max} paragraphs
- NO headings, NO bullet lists (unless user asked)
- Define terms briefly, then explain how it works in NH and locally
- Use minimal citations - just enough to ground claims
- Focus on helping reader understand the concept`;

    case "RISK_DISPUTE":
      return `RISK_DISPUTE answer (${prosePolicy.wordMin}-${prosePolicy.wordMax} words):
- Write ${prosePolicy.paragraphs.min}-${prosePolicy.paragraphs.max} short paragraphs
- NO headings, NO bullet lists
- Paragraph 1: situation overview and why it matters
- Paragraph 2-3: what sources say happened (facts with citations)
- Paragraph 4: what the governing rules generally require (cite state if present)
- Paragraph 5 (optional): realistic outcomes/risks, only if supported by sources
- NO "unknowns that matter", NO "next steps", NO "consult counsel" language`;
  }
}

function getTierInstructions(recordStrength: RecordStrength): string {
  switch (recordStrength.tier) {
    case 'A':
      return `TIER A (Strong sources): 
- Cite specifics from documents with confidence
- Direct framing where supported by citations
- Include statutory references from state chunks [Sx]
- Connect facts to legal standards clearly`;

    case 'B':
      return `TIER B (Moderate sources):
- Cite available specifics from documents
- Add "gaps/depends" qualifiers where coverage is thin
- Use hedged language for areas without strong [Sx] support
- Note which legal topics lack citation`;

    case 'C':
      return `TIER C (Limited sources):
- Summarize user-provided facts primarily [USER]
- Provide GENERAL legal framework only (no specific RSA numbers without [Sx])
- Be explicit about limited archival coverage
- Keep answer brief - focus on what IS known`;
  }
}

function buildSynthesisUserPrompt(
  userMessage: string,
  issueMap: IssueMap,
  sessionSourceText: string | undefined,
  localChunks: LabeledChunk[],
  stateChunks: LabeledChunk[],
  history: ChatHistoryMessage[]
): string {
  const parts: string[] = [];

  if (history.length > 0) {
    const recentHistory = history.slice(-4).map(m => 
      `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content.slice(0, 200)}${m.content.length > 200 ? '...' : ''}`
    ).join('\n');
    parts.push(`=== RECENT CONVERSATION ===\n${recentHistory}\n`);
  }

  parts.push(`=== USER QUESTION ===\n${userMessage}\n`);

  if (sessionSourceText) {
    parts.push(`=== USER-PROVIDED TEXT [USER] ===\n${sessionSourceText.slice(0, 12000)}\n`);
  }

  if (localChunks.length > 0) {
    parts.push('=== LOCAL DOCUMENTS (cite as [L1], [L2], etc.) ===');
    for (const chunk of localChunks) {
      const meta = formatChunkMeta(chunk);
      parts.push(`${chunk.label} ${chunk.title}${meta} — ${chunk.content.slice(0, 2000)}\n`);
    }
  }

  if (stateChunks.length > 0) {
    parts.push('=== STATE DOCUMENTS (cite as [S1], [S2], etc. for legal framework) ===');
    for (const chunk of stateChunks) {
      const meta = formatChunkMeta(chunk);
      parts.push(`${chunk.label} ${chunk.title}${meta} — ${chunk.content.slice(0, 2000)}\n`);
    }
  }

  if (localChunks.length === 0 && stateChunks.length === 0 && !sessionSourceText) {
    parts.push('=== NO ARCHIVE DOCUMENTS FOUND ===\nNo relevant documents were retrieved from the archive. Provide a general response and note this limitation.');
  }

  parts.push('\nGenerate a structured answer following the format in your instructions. Cite sources appropriately.');

  return parts.join('\n');
}

function extractCitationsFromAnswer(answerText: string): string[] {
  const citations: string[] = [];
  const citationPattern = /\[(L\d+|S\d+|USER)\]/g;
  let match;
  
  while ((match = citationPattern.exec(answerText)) !== null) {
    if (!citations.includes(match[1])) {
      citations.push(match[1]);
    }
  }
  
  return citations;
}

export function computeRecordStrength(
  localChunks: LabeledChunk[],
  stateChunks: LabeledChunk[],
  issueMap: IssueMap,
  situationAlignment: number
): RecordStrength {
  const localCount = localChunks.length;
  const stateCount = stateChunks.length;
  
  // Compute distinct state documents by title (deduped)
  const distinctStateDocs = new Set(stateChunks.map(c => c.title.toLowerCase().trim())).size;
  const distinctLocalDocs = new Set(localChunks.map(c => c.title.toLowerCase().trim())).size;
  
  // Robust authority detection - check both title AND content for RSA patterns
  const authoritativeStatePresent = detectAuthoritativeState(stateChunks);

  const legalTopicCoverage = computeLegalTopicCoverage(stateChunks, issueMap.legalTopics);
  const legalSalience = issueMap.legalSalience;

  let tier: RecordStrength['tier'];
  
  // NEW TIER RUBRIC (simpler and more stable)
  // Tier A: Strong sources with authoritative state coverage
  if (
    stateCount >= 4 && 
    (authoritativeStatePresent || distinctStateDocs >= 2) && 
    situationAlignment >= 0.30
  ) {
    tier = 'A';
  } 
  // Tier B: Moderate sources with some state coverage
  else if (stateCount >= 2 && situationAlignment >= 0.20) {
    tier = 'B';
  } 
  // Tier C: Weak sources
  else {
    tier = 'C';
  }

  // NEVER drop below Tier B when legalSalience is high and we have some state
  if (legalSalience >= 0.6 && stateCount >= 2 && tier === 'C') {
    tier = 'B';
  }

  return {
    tier,
    localCount,
    stateCount,
    situationAlignment,
    legalTopicCoverage,
    authoritativeStatePresent,
    distinctStateDocs,
    distinctLocalDocs,
  };
}

/**
 * Robust detection of authoritative state sources
 * Checks both title AND content for RSA patterns and official sources
 */
function detectAuthoritativeState(stateChunks: LabeledChunk[]): boolean {
  const RSA_PATTERN = /\bRSA\s+\d+/i;
  const NHMA_PATTERN = /\b(NHMA|Municipal\s+Association)\b/i;
  const OFFICIAL_PATTERNS = [
    /\bDepartment\b/i,
    /\bDOJ\b/i,
    /\bNHDES\b/i,
    /\bNH\s+Secretary\s+of\s+State\b/i,
    /\bAttorney\s+General\b/i,
    /\bAdministrative\s+Rules?\b/i,
  ];

  for (const chunk of stateChunks) {
    const combinedText = (chunk.title + ' ' + chunk.content);
    
    // Check for RSA pattern in title or content
    if (RSA_PATTERN.test(combinedText)) {
      return true;
    }
    
    // Check for NHMA
    if (NHMA_PATTERN.test(combinedText)) {
      return true;
    }
    
    // Check for official government sources
    for (const pattern of OFFICIAL_PATTERNS) {
      if (pattern.test(chunk.title)) {
        return true;
      }
    }
  }
  
  return false;
}

function formatChunkMeta(chunk: LabeledChunk): string {
  const parts: string[] = [];
  if (chunk.year) parts.push(`Year: ${chunk.year}`);
  if (chunk.category) parts.push(`Type: ${chunk.category}`);
  if (parts.length === 0) return '';
  return ` [${parts.join(', ')}]`;
}

function buildCrossReferenceInstructions(issueMap: IssueMap): string {
  if (issueMap.queryFocus === "financial_exact" || issueMap.queryFocus === "narrative_context") {
    return `
## CROSS-REFERENCING (IMPORTANT)
- When both numeric sources (budgets, warrants, town reports) and narrative sources (meeting minutes) are present, cross-reference them
- Connect dollar amounts or article numbers from financial documents with discussions or votes recorded in meeting minutes
- If a budget line item or warrant article appears in minutes, mention what was discussed or decided
- Do not treat numeric and narrative sources in isolation — weave them together into a coherent account
`;
  }
  return '';
}

function buildRecencyInstructions(issueMap: IssueMap): string {
  if (!issueMap.temporalTarget) return '';

  const { year, strategy } = issueMap.temporalTarget;
  if (strategy === "none") return '';

  return `
## TEMPORAL PRIORITIZATION
- The user's question targets year ${year}. Prioritize sources from that year.
- When sources from multiple years are present, lead with ${year} data and clearly label older sources as historical context.
- If an older document contradicts a ${year} document on the same topic, favor the ${year} source and note the change.
- When citing older sources, note the year explicitly (e.g., "In ${year - 1}, the budget was..." vs "The current ${year} budget shows...").
`;
}

function computeLegalTopicCoverage(stateChunks: LabeledChunk[], legalTopics: string[]): number {
  if (legalTopics.length === 0) return 1.0;
  if (stateChunks.length === 0) return 0;

  const chunkText = stateChunks.map(c => c.content.toLowerCase()).join(' ');
  let covered = 0;

  for (const topic of legalTopics) {
    if (chunkText.includes(topic.toLowerCase())) {
      covered++;
    }
  }

  return covered / legalTopics.length;
}
