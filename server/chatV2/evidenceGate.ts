/**
 * Evidence Coverage Gate
 * 
 * Evaluates whether retrieved evidence is sufficiently broad and complete
 * for the user's question type. Can trigger additional retrieval passes
 * (up to 2) when coverage is insufficient.
 * 
 * Runs after initial retrieval in both simple and complex paths.
 */

import { GoogleGenAI } from "@google/genai";
import { logDebug, logError } from "../utils/logger";
import { logLlmRequest, logLlmResponse } from "../utils/llmLogging";
import type { PipelineLogContext, RouterOutput, RetrievalPlan } from "./types";
import { extractTokenCounts, logLLMCall } from "../llm/callLLMWithLogging";

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY || "" });

const MODEL_NAME = "gemini-2.0-flash";

/**
 * Question intent types that the gate uses to determine coverage needs
 */
export type QuestionIntent = 
  | "facts"           // Simple factual lookup
  | "mechanism"       // How something works/is calculated
  | "breakdown"       // Components/parts of something
  | "why"             // Reason for a change/decision
  | "compare"         // Year-to-year or entity comparison
  | "process"         // Who decides/procedural steps
  | "mixed";          // Multiple intents combined

/**
 * Recommended retrieval pass for expanding coverage
 */
export interface RecommendedRetrievalPass {
  queryText: string;
  filters: {
    townPreference: string | null;
    allowStatewideFallback: boolean;
    categories: string[];
    boards: string[];
    preferRecent: boolean;
  };
  reason: string;
}

/**
 * Output from the Evidence Coverage Gate
 */
export interface CoverageGateOutput {
  coverageScore: number;  // 0.0 - 1.0
  questionIntent: QuestionIntent;
  missingFacets: string[];
  shouldExpandRetrieval: boolean;
  recommendedPasses: RecommendedRetrievalPass[];
  shouldAskClarifyingQuestion: boolean;
  clarifyingQuestion: string | null;
}

/**
 * Summary of retrieval results for gate input
 */
export interface RetrievalResultsSummary {
  chunkCount: number;
  distinctDocCount: number;
  distinctCategories: string[];
  boardsRepresented: string[];
  townsRepresented: string[];
  topDocNames: string[];
  snippetSample: string;  // Token-capped sample of retrieved content
}

/**
 * Diversity metrics for structured logging
 */
export interface DiversityMetrics {
  categoryDiversityScore: number;  // 0-1, higher = more diverse
  boardDiversityScore: number;     // 0-1, higher = more diverse
  docDiversityScore: number;       // 0-1, higher = more documents
}

/**
 * Calculate diversity metrics from retrieval results
 */
export function calculateDiversityMetrics(
  summary: RetrievalResultsSummary,
  expectedCategories?: string[]
): DiversityMetrics {
  // Category diversity: how many distinct categories vs expected
  const expectedCatCount = expectedCategories?.length || 3;
  const categoryDiversityScore = Math.min(1, summary.distinctCategories.length / expectedCatCount);
  
  // Board diversity: having multiple boards is good for process/decision questions
  const boardDiversityScore = Math.min(1, summary.boardsRepresented.length / 2);
  
  // Document diversity: more documents generally means better coverage
  const docDiversityScore = Math.min(1, summary.distinctDocCount / 5);
  
  return {
    categoryDiversityScore,
    boardDiversityScore,
    docDiversityScore,
  };
}

/**
 * Check if question type typically needs broad coverage
 */
export function detectsBroadCoverageIntent(question: string): boolean {
  const lowerQ = question.toLowerCase();
  
  const broadPatterns = [
    /why\s+(did|does|has|have|is|was|were)/i,
    /how\s+(is|are|was|were)\s+\w+\s+(calculated|determined|set|decided)/i,
    /what\s+(goes|went)\s+into/i,
    /breakdown/i,
    /components?\s+of/i,
    /compare/i,
    /year[\s-]+(to|over)[\s-]+year/i,
    /who\s+(decides|decided|determines|determined)/i,
    /process\s+(for|of|to)/i,
    /explain\s+(how|why)/i,
    /what\s+factors/i,
    /contributing\s+factors/i,
  ];
  
  return broadPatterns.some(pattern => pattern.test(lowerQ));
}

const EVIDENCE_GATE_SYSTEM_PROMPT = `You are an Evidence Coverage Gate for a municipal Q&A system. Your job is to evaluate whether the retrieved documents provide sufficient evidence to answer the user's question completely and accurately.

TASK:
Analyze the user's question intent and the retrieved evidence, then determine if additional retrieval is needed.

QUESTION INTENT TYPES:
- "facts": Simple factual lookup (date, amount, name)
- "mechanism": How something works or is calculated (tax rate formula, fee structure)
- "breakdown": Components or parts of something (budget categories, assessment breakdown)
- "why": Reason for a change or decision (rate increase, policy change)
- "compare": Year-to-year or entity comparison
- "process": Who decides, procedural steps, approval workflow
- "mixed": Multiple intents combined

COVERAGE EVALUATION:
For "facts" questions: Single source is often sufficient
For "mechanism/breakdown/why/compare/process" questions: Need multiple perspectives/sources

WHEN TO EXPAND RETRIEVAL:
- Question is about mechanism/breakdown/why/compare/process AND evidence is narrow (single category, single board, few documents)
- Missing key facets that the question type requires
- Town-specific question but only statewide docs found (or vice versa)

OUTPUT FORMAT (JSON only):
{
  "coverageScore": 0.0-1.0,
  "questionIntent": "facts|mechanism|breakdown|why|compare|process|mixed",
  "missingFacets": ["facet1", "facet2"],
  "shouldExpandRetrieval": true|false,
  "recommendedPasses": [
    {
      "queryText": "specific search query",
      "filters": {
        "townPreference": "TownName" or null,
        "allowStatewideFallback": true|false,
        "categories": ["category1"],
        "boards": ["board1"],
        "preferRecent": true|false
      },
      "reason": "why this pass is needed"
    }
  ],
  "shouldAskClarifyingQuestion": false,
  "clarifyingQuestion": null
}

CONSTRAINTS:
- Max 2 recommended passes
- Only recommend expansion if it would meaningfully improve coverage
- Be conservative with clarifying questions (only for truly ambiguous questions)
- Categories must be from: zoning, planning_board_docs, selectboard_docs, budgets_warrants, meeting_minutes, rsa_statutes, policies_procedures, contracts_agreements, town_reports, elections, misc_other

Respond with valid JSON only.`;

/**
 * Evaluate evidence coverage and determine if expansion is needed
 */
export async function evaluateEvidenceCoverage(options: {
  userQuestion: string;
  conversationContext: string;
  townPreference: string | null;
  routerOutput: RouterOutput;
  retrievalPlan: RetrievalPlan | null;
  retrievalSummary: RetrievalResultsSummary;
  logContext?: PipelineLogContext;
}): Promise<CoverageGateOutput> {
  const { 
    userQuestion, 
    conversationContext, 
    townPreference, 
    routerOutput, 
    retrievalPlan, 
    retrievalSummary, 
    logContext 
  } = options;

  logDebug("coverage_gate_start", {
    requestId: logContext?.requestId,
    sessionId: logContext?.sessionId,
    stage: "evidenceGate",
    chunkCount: retrievalSummary.chunkCount,
    distinctDocCount: retrievalSummary.distinctDocCount,
    distinctCategories: retrievalSummary.distinctCategories,
    boardsRepresented: retrievalSummary.boardsRepresented,
  });

  const userPrompt = `Evaluate evidence coverage for this question:

USER QUESTION: "${userQuestion}"

CONVERSATION CONTEXT:
${conversationContext || "No prior context"}

TOWN PREFERENCE: ${townPreference || "None specified"}

ROUTER OUTPUT:
- Complexity: ${routerOutput.complexity}
- Domains: ${routerOutput.domains.join(", ")}
- Scope hint: ${routerOutput.scopeHint || "none"}

RETRIEVAL PLAN (if any):
${retrievalPlan ? JSON.stringify(retrievalPlan, null, 2) : "N/A - simple path"}

RETRIEVAL RESULTS SUMMARY:
- Chunk count: ${retrievalSummary.chunkCount}
- Distinct document count: ${retrievalSummary.distinctDocCount}
- Distinct categories: ${retrievalSummary.distinctCategories.join(", ") || "none"}
- Boards represented: ${retrievalSummary.boardsRepresented.join(", ") || "none"}
- Towns represented: ${retrievalSummary.townsRepresented.join(", ") || "none"}
- Top documents: ${retrievalSummary.topDocNames.slice(0, 5).join(", ") || "none"}

SAMPLE SNIPPETS (token-capped):
${retrievalSummary.snippetSample || "No snippets available"}

Respond with valid JSON only.`;

  logLlmRequest({
    requestId: logContext?.requestId,
    sessionId: logContext?.sessionId,
    stage: "evidenceGate",
    model: MODEL_NAME,
    systemPrompt: EVIDENCE_GATE_SYSTEM_PROMPT,
    userPrompt,
    temperature: 0.2,
    extra: {
      chunkCount: retrievalSummary.chunkCount,
      distinctDocCount: retrievalSummary.distinctDocCount,
    },
  });

  const startTime = Date.now();

  try {
    const response = await ai.models.generateContent({
      model: MODEL_NAME,
      contents: [{ role: "user", parts: [{ text: userPrompt }] }],
      config: {
        systemInstruction: EVIDENCE_GATE_SYSTEM_PROMPT,
        temperature: 0.2,
      },
    });

    const responseText = response.text || "";
    const durationMs = Date.now() - startTime;

    logLlmResponse({
      requestId: logContext?.requestId,
      sessionId: logContext?.sessionId,
      stage: "evidenceGate",
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
          stage: "evidenceGate",
          model: MODEL_NAME,
        },
        { text: responseText, tokensIn: tokens.tokensIn, tokensOut: tokens.tokensOut }
      );
    }

    const cleanedText = responseText
      .replace(/```json\n?/g, "")
      .replace(/```\n?/g, "")
      .trim();

    try {
      const parsed = JSON.parse(cleanedText);
      
      const result: CoverageGateOutput = {
        coverageScore: Number(parsed.coverageScore) || 0.5,
        questionIntent: parsed.questionIntent || "facts",
        missingFacets: Array.isArray(parsed.missingFacets) ? parsed.missingFacets : [],
        shouldExpandRetrieval: Boolean(parsed.shouldExpandRetrieval),
        recommendedPasses: Array.isArray(parsed.recommendedPasses) 
          ? parsed.recommendedPasses.slice(0, 2).map(normalizeRecommendedPass)
          : [],
        shouldAskClarifyingQuestion: Boolean(parsed.shouldAskClarifyingQuestion),
        clarifyingQuestion: parsed.clarifyingQuestion || null,
      };

      const diversityMetrics = calculateDiversityMetrics(
        retrievalSummary, 
        routerOutput.domains
      );

      logDebug("coverage_gate_result", {
        requestId: logContext?.requestId,
        sessionId: logContext?.sessionId,
        stage: "evidenceGate",
        coverageScore: result.coverageScore,
        questionIntent: result.questionIntent,
        missingFacets: result.missingFacets,
        shouldExpandRetrieval: result.shouldExpandRetrieval,
        passCount: result.recommendedPasses.length,
        categoryDiversity: diversityMetrics.categoryDiversityScore,
        boardDiversity: diversityMetrics.boardDiversityScore,
        docDiversity: diversityMetrics.docDiversityScore,
        durationMs,
      });

      return result;
    } catch (parseError) {
      logError("coverage_gate_parse_error", {
        requestId: logContext?.requestId,
        sessionId: logContext?.sessionId,
        stage: "evidenceGate",
        error: parseError instanceof Error ? parseError.message : String(parseError),
        responseText: cleanedText.slice(0, 200),
      });
      
      return getDefaultGateOutput(retrievalSummary);
    }
  } catch (error) {
    logError("coverage_gate_error", {
      requestId: logContext?.requestId,
      sessionId: logContext?.sessionId,
      stage: "evidenceGate",
      error: error instanceof Error ? error.message : String(error),
    });

    return getDefaultGateOutput(retrievalSummary);
  }
}

/**
 * Normalize a recommended pass from LLM output
 */
function normalizeRecommendedPass(pass: any): RecommendedRetrievalPass {
  return {
    queryText: String(pass.queryText || ""),
    filters: {
      townPreference: pass.filters?.townPreference || null,
      allowStatewideFallback: pass.filters?.allowStatewideFallback !== false,
      categories: Array.isArray(pass.filters?.categories) ? pass.filters.categories : [],
      boards: Array.isArray(pass.filters?.boards) ? pass.filters.boards : [],
      preferRecent: pass.filters?.preferRecent === true,
    },
    reason: String(pass.reason || "Expand coverage"),
  };
}

/**
 * Get default gate output when LLM fails
 * Uses heuristics based on retrieval summary
 */
function getDefaultGateOutput(summary: RetrievalResultsSummary): CoverageGateOutput {
  const hasGoodCoverage = summary.distinctDocCount >= 3 && summary.distinctCategories.length >= 2;
  
  return {
    coverageScore: hasGoodCoverage ? 0.7 : 0.4,
    questionIntent: "facts",
    missingFacets: [],
    shouldExpandRetrieval: false,  // Conservative: don't expand on error
    recommendedPasses: [],
    shouldAskClarifyingQuestion: false,
    clarifyingQuestion: null,
  };
}

/**
 * Build retrieval summary from File Search response data
 */
export function buildRetrievalSummary(
  documentNames: string[],
  snippets: Array<{ source: string; content: string }>,
  maxSnippetChars: number = 2000
): RetrievalResultsSummary {
  const uniqueDocs = [...new Set(documentNames)];
  
  // Extract metadata from document names (format: "Category | Town | Title | Year")
  const categories = new Set<string>();
  const boards = new Set<string>();
  const towns = new Set<string>();
  
  for (const docName of uniqueDocs) {
    const parts = docName.split(" | ").map(s => s.trim());
    if (parts.length >= 1) {
      const category = parts[0].toLowerCase().replace(/\s+/g, "_");
      if (category && !category.includes("statewide")) {
        categories.add(category);
      }
    }
    if (parts.length >= 2) {
      const townOrBoard = parts[1];
      if (townOrBoard && !townOrBoard.toLowerCase().includes("statewide")) {
        towns.add(townOrBoard);
      }
    }
    // Try to extract board from title if present
    const boardMatch = docName.match(/(selectboard|planning\s*board|zoning\s*board|budget\s*committee|trustees)/i);
    if (boardMatch) {
      boards.add(boardMatch[1].toLowerCase().replace(/\s+/g, "_"));
    }
  }

  // Build token-capped snippet sample
  let snippetSample = "";
  let charCount = 0;
  for (const snippet of snippets) {
    if (charCount >= maxSnippetChars) break;
    const remaining = maxSnippetChars - charCount;
    const toAdd = snippet.content.slice(0, remaining);
    snippetSample += `[${snippet.source}]: ${toAdd}\n\n`;
    charCount += toAdd.length;
  }

  return {
    chunkCount: snippets.length,
    distinctDocCount: uniqueDocs.length,
    distinctCategories: [...categories],
    boardsRepresented: [...boards],
    townsRepresented: [...towns],
    topDocNames: uniqueDocs.slice(0, 10),
    snippetSample: snippetSample.trim(),
  };
}

/**
 * Merge deduped snippets from multiple retrieval passes
 */
export function mergeRetrievalResults(
  existingSnippets: Array<{ source: string; content: string }>,
  newSnippets: Array<{ source: string; content: string }>,
  existingDocNames: string[],
  newDocNames: string[],
  maxChunks: number = 40
): {
  mergedSnippets: Array<{ source: string; content: string }>;
  mergedDocNames: string[];
} {
  // Create hash set for deduplication
  const seenHashes = new Set<string>();
  const mergedSnippets: Array<{ source: string; content: string }> = [];
  
  // Add existing snippets
  for (const snippet of existingSnippets) {
    const hash = `${snippet.source}:${snippet.content.slice(0, 100)}`;
    if (!seenHashes.has(hash)) {
      seenHashes.add(hash);
      mergedSnippets.push(snippet);
    }
  }
  
  // Add new snippets (if under limit)
  for (const snippet of newSnippets) {
    if (mergedSnippets.length >= maxChunks) break;
    const hash = `${snippet.source}:${snippet.content.slice(0, 100)}`;
    if (!seenHashes.has(hash)) {
      seenHashes.add(hash);
      mergedSnippets.push(snippet);
    }
  }

  // Merge document names
  const mergedDocNames = [...new Set([...existingDocNames, ...newDocNames])];

  return { mergedSnippets, mergedDocNames };
}
