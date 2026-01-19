/**
 * V3 Synthesizer - Stage 3 of the Chat v3 Pipeline
 * 
 * Responsibilities:
 * 1. Generate structured answer with clear sections
 * 2. Apply RecordStrength tier behavior (A/B/C confidence levels)
 * 3. Enforce citation requirements (no uncited RSA claims)
 * 4. Distinguish FACT vs STANDARD vs INFERENCE in writing
 */

import { GoogleGenAI } from "@google/genai";
import { getModelForStage } from "../llm/modelRegistry";
import { logLlmRequest, logLlmResponse, logLlmError } from "../utils/llmLogging";
import { logLLMCall, extractTokenCounts } from "../llm/callLLMWithLogging";
import { isQuotaError, GeminiQuotaExceededError } from "../utils/geminiErrors";
import { logDebug } from "../utils/logger";
import type {
  SynthesisInputV3,
  RecordStrength,
  LabeledChunk,
  IssueMap,
  PipelineLogContext,
  ChatHistoryMessage,
} from "./types";

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY || "" });

export interface SynthesisV3Options extends SynthesisInputV3 {
  logContext?: PipelineLogContext;
  isRepairAttempt?: boolean;
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
  } = options;
  
  const { model: modelName } = getModelForStage('complexSynthesis');
  const startTime = Date.now();

  const systemPrompt = buildSynthesisSystemPrompt(recordStrength, issueMap, isRepairAttempt, stateChunks.length);
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

function buildSynthesisSystemPrompt(
  recordStrength: RecordStrength, 
  issueMap: IssueMap,
  isRepairAttempt?: boolean,
  stateChunkCount?: number
): string {
  const tierInstructions = getTierInstructions(recordStrength);
  const hasStateChunks = (stateChunkCount || 0) > 0;
  
  const repairNote = isRepairAttempt 
    ? `\n\n**REPAIR ATTEMPT**: Previous answer violated format rules. You MUST:
- Rewrite to comply exactly with format/limits below
- Shorten all sections to fit within caps
- Keep citations intact
- Remove any "next steps" or "consult counsel" language
- No extra sections beyond the 5 required`
    : '';

  return `You are an assistant for New Hampshire municipal officials. Generate a concise, structured answer.

## HARD LIMITS (MUST FOLLOW)
- Max 500 words total (HARD CAP - count carefully)
- Use headings EXACTLY as specified, in order
- Bullet limits are STRICT per section
- No bullet may exceed ~20 words
- Do NOT repeat the same point across sections
- Do NOT include "next steps", "consult counsel", "you may wish to", or "I recommend" language
${hasStateChunks ? '- "What the law generally requires" MUST contain at least 2 [Sx] citations' : ''}
- NEVER mention a specific RSA number unless cited with [Sx]

## ANSWER FORMAT (use these exact headings in this order):

1. **Bottom line** (1-2 sentences; cite if factual/legal claim)

2. **What happened** (max 5 bullets; timeline facts only; cite [USER] or [Lx])

3. **What the law generally requires** (max 5 bullets; include federal + NH + local if relevant; cite [Sx] for state law)

4. **What the Jan 6 vote changes** (max 4 bullets; connect vote → compliance → risk; cite sources)

5. **Unknowns that matter** (max 4 bullets; ONLY uncertainties that materially affect the analysis; cite if possible)

## CITATION RULES
- [USER] is ONLY allowed in "What happened" section
- [Lx] citations for local documents (minutes, warrants, ordinances)
- [Sx] citations for state law (RSA, NHMA guidance, admin rules)
- "What the law generally requires" MUST use [Sx] citations if state chunks exist
- If no state chunks exist, keep law section general without specific RSA numbers

## TIER INSTRUCTIONS (${recordStrength.tier})
${tierInstructions}

## HARD RULES (MUST FOLLOW)
1. **No uncited RSA claims**: NEVER mention specific RSA section numbers (e.g., "RSA 91-A", "RSA 673") unless you have a STATE lane chunk [Sx] that contains that RSA reference.

2. **Weak state lane handling**: If no state chunks exist or they lack specific statutes:
   - Speak generally: "NH has municipal liability frameworks..." 
   - Add: "I did not find the specific NH RSA text in the archive excerpts provided."

3. **Claim-type discipline**:
   - FACT: What happened (from documents) - cite source
   - STANDARD: Legal requirements (from state law) - cite source
   - INFERENCE: Your analysis connecting facts to standards - be explicit this is analysis

4. **Avoid absolute legal claims**: Do NOT use "is illegal", "will be liable", "must result in" unless explicitly supported by cited sources.

5. **No topic substitution**: Answer about the situation the user asked about. Don't substitute related cases.
${repairNote}

## SITUATION CONTEXT
${issueMap.situationTitle ? `Current situation: "${issueMap.situationTitle}"` : 'General question'}
${issueMap.legalTopics.length > 0 ? `Legal topics: ${issueMap.legalTopics.join(', ')}` : ''}
${issueMap.legalSalience >= 0.6 ? 'HIGH legal salience - ensure law section is thorough with [Sx] citations' : ''}`;
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
