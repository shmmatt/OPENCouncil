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

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY || "" });

export interface SynthesisV3Options extends SynthesisInputV3 {
  logContext?: PipelineLogContext;
  isRepairAttempt?: boolean;
  answerType?: AnswerType;
  renderStyle?: RenderStyle;
}

export interface SynthesisV3Result {
  answerText: string;
  citationsUsed: string[];
  durationMs: number;
}

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
    answerType = "QUICK_PROCESS",
    renderStyle = "PROSE",
  } = options;
  
  const { model: modelName } = getModelForStage('complexSynthesis');
  const startTime = Date.now();

  const prosePolicy = getProsePolicy(answerType, renderStyle);
  const systemPrompt = buildProseSystemPrompt(recordStrength, issueMap, answerType, renderStyle, prosePolicy, isRepairAttempt, stateChunks.length);
  const userPrompt = buildSynthesisUserPrompt(
    userMessage, 
    issueMap, 
    sessionSourceText, 
    localChunks, 
    stateChunks,
    history
  );

  // Lower temperature for more consistent, concise output
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
    },
  });

  try {
    const response = await ai.models.generateContent({
      model: modelName,
      contents: [{ role: "user", parts: [{ text: userPrompt }] }],
      config: {
        systemInstruction: systemPrompt,
        temperature: synthesisTemperature,
        maxOutputTokens: 2500, // Reduced to encourage conciseness
      },
    });

    const responseText = response.text || "Unable to synthesize an answer from the available sources.";
    const durationMs = Date.now() - startTime;

    logLlmResponse({
      requestId: logContext?.requestId,
      sessionId: logContext?.sessionId,
      stage: "synthesizerV3",
      model: modelName,
      responseText: responseText.slice(0, 500),
      durationMs,
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
        { text: responseText, tokensIn: tokens.tokensIn, tokensOut: tokens.tokensOut }
      );
    }

    const citationsUsed = extractCitationsFromAnswer(responseText);

    return {
      answerText: responseText,
      citationsUsed,
      durationMs,
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

  return `You are a town administrator explaining municipal governance to a resident in an email. Write calmly, neutrally, with short sentences.

## WORD COUNT (MANDATORY - COUNT CAREFULLY)
- Target: ${prosePolicy.wordMin}-${prosePolicy.wordMax} words (HARD LIMITS)
- Paragraphs: ${prosePolicy.paragraphs.min}-${prosePolicy.paragraphs.max}
${!prosePolicy.allowHeadings ? '- NO section headings allowed' : ''}
${!prosePolicy.allowBullets ? '- NO bullet lists allowed' : ''}

## PROSE-FIRST RENDERING
${answerTemplate}

## ANTI-CHATGPT STYLE CONSTRAINTS (MANDATORY)
${renderStyle === "PROSE" ? "- Do NOT use section headings, bold headings, or markdown headers" : ""}
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
      // Citeable format: [L1] Title — excerpt
      parts.push(`${chunk.label} ${chunk.title} — ${chunk.content.slice(0, 2000)}\n`);
    }
  }

  if (stateChunks.length > 0) {
    parts.push('=== STATE DOCUMENTS (cite as [S1], [S2], etc. for legal framework) ===');
    for (const chunk of stateChunks) {
      // Citeable format: [S1] Title — excerpt
      parts.push(`${chunk.label} ${chunk.title} — ${chunk.content.slice(0, 2000)}\n`);
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
