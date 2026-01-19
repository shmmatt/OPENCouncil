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

  const systemPrompt = buildSynthesisSystemPrompt(recordStrength, issueMap, isRepairAttempt);
  const userPrompt = buildSynthesisUserPrompt(
    userMessage, 
    issueMap, 
    sessionSourceText, 
    localChunks, 
    stateChunks,
    history
  );

  logLlmRequest({
    requestId: logContext?.requestId,
    sessionId: logContext?.sessionId,
    stage: "synthesizerV3",
    model: modelName,
    systemPrompt: systemPrompt.slice(0, 500),
    userPrompt: userPrompt.slice(0, 500),
    temperature: 0.3,
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
        temperature: 0.3,
        maxOutputTokens: 4000,
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
  isRepairAttempt?: boolean
): string {
  const tierInstructions = getTierInstructions(recordStrength);
  const repairNote = isRepairAttempt 
    ? `\n\n**REPAIR ATTEMPT**: Previous answer had violations. Be EXTRA careful to:
- Remove or qualify any claim not supported by provided excerpts
- Do NOT mention statutes/procedures without citations
- Stay anchored to the current situation`
    : '';

  return `You are an assistant for New Hampshire municipal officials. Generate a structured answer based on the provided documents.

## ANSWER STRUCTURE (follow this format):

1. **Situation anchor** (1-2 sentences connecting to the user's specific situation)

2. **What we know (facts)** — Based on retrieved documents and user-provided text. Cite sources like [L1], [L2] for local, [S1], [S2] for state.

3. **Applicable legal framework (NH + federal)** — Only if state lane chunks are available. Cite [Sx] sources.

4. **Risk / likely outcomes** — Hedged language, cite the standards + facts supporting the assessment.

5. **What would clarify / what to pull next** — List any gaps or documents that would provide more certainty.

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

6. **Citation format**: Use [L1], [L2]... for local chunks, [S1], [S2]... for state chunks, [USER] for user-provided text.
${repairNote}

## SITUATION CONTEXT
${issueMap.situationTitle ? `Current situation: "${issueMap.situationTitle}"` : 'General question'}
${issueMap.legalTopics.length > 0 ? `Legal topics: ${issueMap.legalTopics.join(', ')}` : ''}
${issueMap.legalSalience >= 0.6 ? 'HIGH legal salience - ensure legal framework section is included' : ''}`;
}

function getTierInstructions(recordStrength: RecordStrength): string {
  switch (recordStrength.tier) {
    case 'A':
      return `TIER A (Strong sources): 
- Cite specifics from documents
- Direct, confident framing where supported
- Include statutory references when found in state chunks
- Detailed analysis is appropriate`;

    case 'B':
      return `TIER B (Moderate sources):
- Cite available specifics
- Add explicit "gaps/depends" qualifiers
- Use hedged language for areas without strong support
- Acknowledge where more documentation would help`;

    case 'C':
      return `TIER C (Weak sources):
- Summarize user-provided facts primarily
- Provide GENERAL legal framework only (no specific RSA numbers)
- Focus on "what to research next"
- Be explicit about limited archival coverage`;
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
    parts.push('=== LOCAL DOCUMENTS ===');
    for (const chunk of localChunks) {
      parts.push(`${chunk.label} [${chunk.authority.toUpperCase()}] ${chunk.title}\n${chunk.content.slice(0, 2000)}\n`);
    }
  }

  if (stateChunks.length > 0) {
    parts.push('=== STATE DOCUMENTS ===');
    for (const chunk of stateChunks) {
      parts.push(`${chunk.label} [${chunk.authority.toUpperCase()}] ${chunk.title}\n${chunk.content.slice(0, 2000)}\n`);
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
  
  const authoritativeStatePresent = stateChunks.some(
    c => c.authority === 'rsa' || c.authority === 'nhma'
  );

  const legalTopicCoverage = computeLegalTopicCoverage(stateChunks, issueMap.legalTopics);

  let tier: RecordStrength['tier'];
  
  if (localCount >= 5 && stateCount >= 3 && authoritativeStatePresent && situationAlignment >= 0.6) {
    tier = 'A';
  } else if ((localCount >= 3 || stateCount >= 2) && situationAlignment >= 0.4) {
    tier = 'B';
  } else {
    tier = 'C';
  }

  if (issueMap.legalSalience >= 0.7 && stateCount < 2) {
    tier = 'C';
  }

  return {
    tier,
    localCount,
    stateCount,
    situationAlignment,
    legalTopicCoverage,
    authoritativeStatePresent,
  };
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
