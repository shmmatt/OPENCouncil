/**
 * V3 Chat Orchestrator
 * 
 * Main entry point for the Chat v3 Pipeline that coordinates:
 * Stage 0: Session Sources (handled externally)
 * Stage 1: Plan - Extract IssueMap and create RetrievalPlan
 * Stage 2: Retrieve - Multi-query retrieval with coverage guarantees
 * Stage 3: Synthesize - Structured answer with tier-based confidence
 * Stage 4: Audit - Post-generation checks and optional repair
 */

import { logDebug, logInfo } from "../utils/logger";
import { runPlannerV3 } from "./plannerV3";
import { detectConceptMatches } from "./municipalOntology";
import { type V3RetrievalResult } from "./twoLaneRetrieve";
import { pgvectorTwoLaneRetrieveWithPlan, executeQueryOnLane } from "./pgvectorRetrieveAdapter";
import { synthesizeV3, computeRecordStrength } from "./synthesizerV3";
import { auditAnswer, shouldAttemptRepair, selectBetterAnswer, normalizeAnswerFormat, stripInvalidCitationMarkers, type AnswerScore } from "./audit";
import { chatConfigV3 } from "./chatConfigV3";
import { getSessionSourceTextForContext } from "./sessionSourceDetector";
import { classifyFollowUp } from "./situationExtractor";
import type {
  IssueMap,
  RecordStrength,
  TemporalTarget,
  V3PipelineResult,
  V3DebugInfo,
  PipelineLogContext,
  ChatHistoryMessage,
  DocSourceType,
  LabeledChunk,
  AnswerType,
  RenderStyle,
} from "./types";
import type { SessionSource, SituationContext } from "@shared/schema";

import { detectAnswerTypeFromQuestion } from "./router";

const LIST_TRIGGER_PATTERNS = [
  /\blist\b/i,
  /\bchecklist\b/i,
  /\bsteps?\b/i,
  /\bbullet/i,
  /\bin a table\b/i,
  /\bitemize\b/i,
  /\bnumber(?:ed)?\s+(?:list|steps)\b/i,
];

function detectRenderStyle(question: string): RenderStyle {
  for (const pattern of LIST_TRIGGER_PATTERNS) {
    if (pattern.test(question)) {
      return "LIST";
    }
  }
  return "PROSE";
}

function detectAnswerType(question: string, issueMap: IssueMap): AnswerType {
  const baseType = detectAnswerTypeFromQuestion(question);
  
  if (baseType === "QUICK_PROCESS") {
    if (issueMap.legalSalience >= 0.7 && issueMap.requestedOutput === "risk") {
      return "RISK_DISPUTE";
    }
    if (issueMap.requestedOutput === "explain") {
      return "EXPLAINER";
    }
  }
  
  return baseType;
}

export interface V3OrchestratorOptions {
  userMessage: string;
  sessionHistory: ChatHistoryMessage[];
  townPreference?: string | null;
  situationContext?: SituationContext | null;
  sessionSources?: SessionSource[];
  logContext?: PipelineLogContext;
  templateContext?: string | null;
  platformContext?: string | null;
  onStageChange?: (stage: string) => void;
}

export async function runChatV3Pipeline(
  options: V3OrchestratorOptions
): Promise<V3PipelineResult> {
  const {
    userMessage,
    sessionHistory,
    townPreference,
    situationContext,
    sessionSources,
    logContext,
    templateContext,
    platformContext,
    onStageChange,
  } = options;

  const startTime = Date.now();
  const notifyStage = (stage: string) => { if (onStageChange) onStageChange(stage); };

  // =====================================================
  // STAGE 0: SITUATION RELEVANCE GATE (LLM-based)
  // =====================================================
  // Determine if stored situation context should be applied to this question.
  // Uses a fast LLM classifier (with heuristic fallback) instead of fragile keyword scoring.
  // This prevents "sticky context" leakage while correctly recognising implicit follow-ups.

  // ---------------------------------------------------------------------------
  // Helper utilities for session anchor extraction
  // ---------------------------------------------------------------------------

  function extractYearFromText(text: string): number | undefined {
    const match = text.match(/\b(20(?:1[5-9]|2[0-9]|3[0-5]))\b/);
    return match ? parseInt(match[1], 10) : undefined;
  }

  function extractTownFromText(text: string): string | undefined {
    // Look for "in <Town>" / "<Town> town" / "<Town> town meeting" patterns
    const m = text.match(/\bin\s+([A-Z][a-z]{2,})\b|\b([A-Z][a-z]{2,})\s+(?:town|meeting|meeting|warrant)\b/);
    return m ? (m[1] ?? m[2]) : undefined;
  }

  // Back-scan history for most recent user turn (history may end with assistant)
  let lastUserMessage: string | undefined;
  for (let i = sessionHistory.length - 1; i >= 0; i--) {
    if (sessionHistory[i].role === "user") {
      lastUserMessage = sessionHistory[i].content;
      break;
    }
  }

  const followUpResult = await classifyFollowUp(
    userMessage,
    situationContext || null,
    lastUserMessage
  );

  const effectiveSituationContext = followUpResult.isContinuation ? situationContext : null;

  // Also filter history when situation context is gated
  // This prevents prior Q&A from leaking into unrelated domain questions
  const historyForSynthesis = followUpResult.isContinuation
    ? sessionHistory
    : []; // Clear history when topic switch detected

  // ---------------------------------------------------------------------------
  // Session anchor: carry forward town + year even when situation gate fires.
  // Priority: townPreference > situationContext > sessionHistory text
  // ---------------------------------------------------------------------------

  // Town: prefer explicit townPreference, then situationContext proper-noun entities,
  //       then a lightweight scan of recent history turns
  let sessionAnchorTown: string | undefined = townPreference || undefined;

  if (!sessionAnchorTown) {
    sessionAnchorTown = (situationContext?.entities ?? []).find(e => /^[A-Z][a-z]{2,}$/.test(e));
  }

  if (!sessionAnchorTown) {
    const recentHistory = sessionHistory.slice(-6);
    for (let i = recentHistory.length - 1; i >= 0; i--) {
      const t = extractTownFromText(recentHistory[i].content);
      if (t) { sessionAnchorTown = t; break; }
    }
  }

  // Year: prefer situationContext time range, then entity list, then recent history
  let sessionAnchorYear: number | undefined;

  if (situationContext?.timeRange?.start) {
    const y = parseInt(situationContext.timeRange.start.slice(0, 4), 10);
    if (!isNaN(y) && y >= 2015 && y <= 2035) sessionAnchorYear = y;
  }

  if (!sessionAnchorYear) {
    const yearFromEntities = (situationContext?.entities ?? [])
      .map(e => parseInt(e, 10))
      .find(n => n >= 2015 && n <= 2035);
    if (yearFromEntities) sessionAnchorYear = yearFromEntities;
  }

  if (!sessionAnchorYear) {
    const recentHistory = sessionHistory.slice(-6);
    for (let i = recentHistory.length - 1; i >= 0; i--) {
      const yr = extractYearFromText(recentHistory[i].content);
      if (yr) { sessionAnchorYear = yr; break; }
    }
  }

  const sessionAnchor =
    sessionAnchorTown || sessionAnchorYear
      ? { town: sessionAnchorTown, year: sessionAnchorYear }
      : undefined;

  logInfo("v3_pipeline_start", {
    requestId: logContext?.requestId,
    sessionId: logContext?.sessionId,
    stage: "v3_orchestrator",
    messageLength: userMessage.length,
    townPreference,
    hasSituationContext: !!situationContext,
    situationGated: !followUpResult.isContinuation,
    classifierMethod: followUpResult.method,
    classifierConfidence: followUpResult.confidence,
    situationReason: followUpResult.reason,
    sessionSourceCount: (sessionSources || []).length,
    historyCleared: !followUpResult.isContinuation && sessionHistory.length > 0,
    sessionAnchorTown: sessionAnchorTown ?? null,
    sessionAnchorYear: sessionAnchorYear ?? null,
  });

  // =====================================================
  // CONCEPT EXPANSION: scan query against municipal ontology
  // =====================================================
  const { expansions: conceptExpansions, matchedGroups } = detectConceptMatches(userMessage);

  if (matchedGroups.length > 0) {
    logInfo("v3_concept_expansion", {
      requestId: logContext?.requestId,
      sessionId: logContext?.sessionId,
      stage: "v3_orchestrator",
      matchedGroups,
      conceptExpansions,
    });
  }

  // =====================================================
  // STAGE 1: PLAN
  // =====================================================
  notifyStage("planning");
  const plannerResult = await runPlannerV3({
    userMessage,
    sessionSources,
    situationContext: effectiveSituationContext,
    townHint: townPreference || undefined,
    templateContext,
    logContext,
    sessionAnchor,
    domainHints: conceptExpansions.length > 0 ? conceptExpansions : undefined,
  });

  const { issueMap, retrievalPlan, validationWarnings } = plannerResult;

  logDebug("v3_plan_complete", {
    requestId: logContext?.requestId,
    sessionId: logContext?.sessionId,
    stage: "v3_planner",
    entityCount: issueMap.entities.length,
    legalTopicCount: issueMap.legalTopics.length,
    localQueryCount: retrievalPlan.local.queries.length,
    stateQueryCount: retrievalPlan.state.queries.length,
    legalSalience: issueMap.legalSalience,
    plannerConfidence: issueMap.plannerConfidence,
    validationWarnings,
    temporalFilter: retrievalPlan.temporalFilter || null,
    queryFocus: retrievalPlan.queryFocus,
    keywordTermCount: retrievalPlan.keywordTerms?.length || 0,
  });

  // =====================================================
  // STAGE 2: RETRIEVE
  // =====================================================
  notifyStage("retrieving");
  logInfo("v3_retrieval_pgvector", {
    requestId: logContext?.requestId,
    stage: "v3_retrieval",
  });

  const retrievalResult: V3RetrievalResult = await pgvectorTwoLaneRetrieveWithPlan(
    retrievalPlan,
    issueMap,
    {
      townPreference,
      situationContext: effectiveSituationContext,
      logContext,
    },
  );

  const totalChunks = retrievalResult.localCount + retrievalResult.stateCount + retrievalResult.sauCount;

  if (totalChunks === 0) {
    logInfo("v3_retrieval_empty", {
      requestId: logContext?.requestId,
      stage: "v3_retrieval",
      message: "pgvector returned zero chunks — synthesis will rely on general knowledge only",
    });
  } else if (totalChunks < 3) {
    logInfo("v3_retrieval_thin", {
      requestId: logContext?.requestId,
      stage: "v3_retrieval",
      localCount: retrievalResult.localCount,
      stateCount: retrievalResult.stateCount,
    });
  }

  logDebug("v3_retrieve_complete", {
    requestId: logContext?.requestId,
    sessionId: logContext?.sessionId,
    stage: "v3_retrieval",
    localSelected: retrievalResult.localCount,
    stateSelected: retrievalResult.stateCount,
    sauSelected: retrievalResult.sauCount,
    situationAlignment: retrievalResult.situationAlignment,
    legalTopicCoverage: retrievalResult.legalTopicCoverage,
    authoritativeStatePresent: retrievalResult.authoritativeStatePresent,
    earlyExitTriggered: retrievalResult.debug.earlyExitTriggered,
  });

  // =====================================================
  // STAGE 3: SYNTHESIZE
  // =====================================================
  notifyStage("synthesizing");
  const sessionSourceText = sessionSources?.length
    ? getSessionSourceTextForContext(sessionSources, chatConfigV3.MAX_SESSION_SOURCE_CHARS)
    : undefined;

  const recordStrength = computeRecordStrength(
    retrievalResult.localChunks,
    retrievalResult.stateChunks,
    issueMap,
    retrievalResult.situationAlignment,
    retrievalResult.sauChunks
  );

  const answerType = detectAnswerType(userMessage, issueMap);
  const renderStyle = detectRenderStyle(userMessage);

  logDebug("v3_render_style_detected", {
    requestId: logContext?.requestId,
    sessionId: logContext?.sessionId,
    stage: "v3_synthesizer",
    answerType,
    renderStyle,
    legalSalience: issueMap.legalSalience,
  });

  let synthesisResult = await synthesizeV3({
    userMessage,
    issueMap,
    sessionSourceText,
    localChunks: retrievalResult.localChunks,
    stateChunks: retrievalResult.stateChunks,
    sauChunks: retrievalResult.sauChunks,
    recordStrength,
    history: historyForSynthesis,
    logContext,
    answerType,
    renderStyle,
    templateContext,
    platformContext,
    sauId: retrievalPlan.sauId,
  });

  let answerText = synthesisResult.answerText;
  let auditFlags: string[] = [];
  let repairRan = false;
  let secondHopRan = false;
  let secondHopQuery: string | null = null;
  let secondHopChunksAdded = 0;
  let selectedAnswerSource: 'original' | 'repair' | 'repair_normalized' | 'original_normalized' = 'original';
  let originalScore: AnswerScore | undefined;
  let repairScore: AnswerScore | undefined;

  let effectiveLocalChunks = retrievalResult.localChunks;
  let effectiveStateChunks = retrievalResult.stateChunks;
  let effectiveSauChunks = retrievalResult.sauChunks;
  let effectiveRecordStrength = recordStrength;

  // =====================================================
  // STAGE 3.5: SECOND HOP (Conditional)
  // =====================================================
  if (
    !synthesisResult.hasSufficientContext &&
    synthesisResult.missingInformationQuery &&
    synthesisResult.missingInformationQuery.length > 0
  ) {
    secondHopQuery = synthesisResult.missingInformationQuery;
    secondHopRan = true;

    logInfo("v3_second_hop_triggered", {
      requestId: logContext?.requestId,
      sessionId: logContext?.sessionId,
      stage: "v3_orchestrator",
      missingQuery: secondHopQuery,
      suggestedYear: synthesisResult.suggestedYear,
    });

    let secondHopTemporal: TemporalTarget | undefined;
    if (synthesisResult.suggestedYear) {
      secondHopTemporal = { year: synthesisResult.suggestedYear, strategy: "boost" };
    }

    try {
      const secondHopChunks = await executeQueryOnLane(
        secondHopQuery,
        "local",
        townPreference || null,
        8,
        {
          keywordTerms: secondHopQuery.split(/\s+/).filter(w => w.length > 3),
          temporalFilter: secondHopTemporal,
          queryFocus: retrievalPlan.queryFocus,
        },
      );

      const originalLocalCount = effectiveLocalChunks.length;
      const secondHopAsLabeled: LabeledChunk[] = secondHopChunks.map((chunk, idx) => ({
        label: `[L${effectiveLocalChunks.length + idx + 1}]`,
        title: chunk.title,
        content: chunk.content,
        lane: "local" as const,
        authority: "other" as const,
        year: chunk.year,
        category: chunk.category,
      }));
      const existingContents = new Set(effectiveLocalChunks.map(c => c.content.slice(0, 200)));
      const newChunks = secondHopAsLabeled.filter(c => !existingContents.has(c.content.slice(0, 200)));
      const mergedLocal = [...effectiveLocalChunks, ...newChunks];
      secondHopChunksAdded = mergedLocal.length - originalLocalCount;

      logDebug("v3_second_hop_results", {
        requestId: logContext?.requestId,
        sessionId: logContext?.sessionId,
        stage: "v3_orchestrator",
        secondHopRetrieved: secondHopChunks.length,
        newChunksAdded: secondHopChunksAdded,
        mergedTotal: mergedLocal.length,
      });

      if (secondHopChunksAdded > 0) {
        effectiveLocalChunks = mergedLocal;
        effectiveRecordStrength = computeRecordStrength(
          effectiveLocalChunks,
          effectiveStateChunks,
          issueMap,
          retrievalResult.situationAlignment,
          effectiveSauChunks
        );

        synthesisResult = await synthesizeV3({
          userMessage,
          issueMap,
          sessionSourceText,
          localChunks: effectiveLocalChunks,
          stateChunks: effectiveStateChunks,
          sauChunks: effectiveSauChunks,
          recordStrength: effectiveRecordStrength,
          history: historyForSynthesis,
          logContext,
          isFinalAttempt: true,
          answerType,
          renderStyle,
          templateContext,
          platformContext,
          sauId: retrievalPlan.sauId,
        });

        answerText = synthesisResult.answerText;
      } else {
        synthesisResult = await synthesizeV3({
          userMessage,
          issueMap,
          sessionSourceText,
          localChunks: effectiveLocalChunks,
          stateChunks: effectiveStateChunks,
          sauChunks: effectiveSauChunks,
          recordStrength: effectiveRecordStrength,
          history: historyForSynthesis,
          logContext,
          isFinalAttempt: true,
          answerType,
          renderStyle,
          templateContext,
          platformContext,
          sauId: retrievalPlan.sauId,
        });

        answerText = synthesisResult.answerText;
      }
    } catch (error) {
      logDebug("v3_second_hop_error", {
        requestId: logContext?.requestId,
        sessionId: logContext?.sessionId,
        stage: "v3_orchestrator",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // =====================================================
  // STAGE 4: AUDIT + REPAIR
  // =====================================================
  if (chatConfigV3.ENABLE_AUDIT) {
    notifyStage("auditing");
    const stateChunkCount = effectiveStateChunks.length;
    
    const auditResult = auditAnswer({
      answerText,
      stateChunks: effectiveStateChunks,
      citationsUsed: synthesisResult.citationsUsed,
      issueMap,
      situationContext: effectiveSituationContext,
      logContext,
      renderStyle,
      answerType,
    });

    auditFlags = auditResult.violations.map(v => `${v.type}:${v.severity}`);

    if (shouldAttemptRepair(auditResult, false)) {
      logDebug("v3_repair_triggered", {
        requestId: logContext?.requestId,
        sessionId: logContext?.sessionId,
        stage: "v3_audit",
        violations: auditResult.violations.map(v => v.type),
        repairHint: auditResult.repairHint,
      });

      const REPAIR_TIMEOUT_MS = 40_000;
      let repairSynthesisResult: Awaited<ReturnType<typeof synthesizeV3>> | null = null;

      try {
        repairSynthesisResult = await Promise.race([
          synthesizeV3({
            userMessage,
            issueMap,
            sessionSourceText,
            localChunks: effectiveLocalChunks,
            stateChunks: effectiveStateChunks,
            sauChunks: effectiveSauChunks,
            recordStrength: effectiveRecordStrength,
            history: historyForSynthesis,
            logContext,
            isRepairAttempt: true,
            isFinalAttempt: true,
            answerType,
            renderStyle,
            templateContext,
            platformContext,
            sauId: retrievalPlan.sauId,
          }),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error("repair_timeout")), REPAIR_TIMEOUT_MS)
          ),
        ]);
      } catch (repairErr: unknown) {
        const isTimeout = repairErr instanceof Error && repairErr.message === "repair_timeout";
        logInfo("v3_repair_timeout", {
          requestId: logContext?.requestId,
          sessionId: logContext?.sessionId,
          stage: "v3_audit",
          reason: isTimeout ? "Repair LLM call timed out after 40s" : "Repair LLM call failed",
          error: isTimeout ? undefined : String(repairErr),
        });
      }

      if (repairSynthesisResult === null) {
        // Repair timed out or errored — keep the original answer
      } else {
      repairRan = true;

      // Use the new scoring system to pick better answer
      const selection = selectBetterAnswer(
        synthesisResult.answerText,
        repairSynthesisResult.answerText,
        stateChunkCount
      );
      
      originalScore = selection.originalScore;
      repairScore = selection.repairScore;

      if (selection.selectedSource === 'repair') {
        answerText = repairSynthesisResult.answerText;
        selectedAnswerSource = 'repair';
        
        // Re-audit the selected answer for flags
        const repairAuditResult = auditAnswer({
          answerText,
          stateChunks: effectiveStateChunks,
          citationsUsed: repairSynthesisResult.citationsUsed,
          issueMap,
          situationContext: effectiveSituationContext,
          logContext,
          renderStyle,
          answerType,
        });
        auditFlags = repairAuditResult.violations.map(v => `${v.type}:${v.severity}`);
        
        logDebug("v3_repair_selected", {
          requestId: logContext?.requestId,
          sessionId: logContext?.sessionId,
          stage: "v3_audit",
          reason: "Repair scored higher or is more complete",
          originalScore: selection.originalScore.score,
          repairScore: selection.repairScore.score,
          originalComplete: selection.originalScore.isComplete,
          repairComplete: selection.repairScore.isComplete,
        });
      } else {
        logDebug("v3_original_kept", {
          requestId: logContext?.requestId,
          sessionId: logContext?.sessionId,
          stage: "v3_audit",
          reason: "Original scored higher or repair not better",
          originalScore: selection.originalScore.score,
          repairScore: selection.repairScore.score,
        });
      }

      // Apply normalization if answer has format violations
      const currentAuditResult = auditAnswer({
        answerText,
        stateChunks: effectiveStateChunks,
        citationsUsed: synthesisResult.citationsUsed,
        issueMap,
        situationContext: effectiveSituationContext,
        logContext,
        renderStyle,
        answerType,
      });

      if (currentAuditResult.violations.some(v => v.type === 'format_violation')) {
        const normalizedAnswer = normalizeAnswerFormat(answerText);
        
        const normalizedAudit = auditAnswer({
          answerText: normalizedAnswer,
          stateChunks: effectiveStateChunks,
          citationsUsed: synthesisResult.citationsUsed,
          issueMap,
          situationContext: effectiveSituationContext,
          logContext,
          renderStyle,
          answerType,
        });
        
        const normalizedFormatViolations = normalizedAudit.violations.filter(v => v.type === 'format_violation').length;
        const currentFormatViolations = currentAuditResult.violations.filter(v => v.type === 'format_violation').length;
        
        if (normalizedFormatViolations < currentFormatViolations) {
          answerText = normalizedAnswer;
          selectedAnswerSource = selectedAnswerSource === 'repair' ? 'repair_normalized' : 'original_normalized';
          auditFlags = normalizedAudit.violations.map(v => `${v.type}:${v.severity}`);
          
          logDebug("v3_answer_normalized", {
            requestId: logContext?.requestId,
            sessionId: logContext?.sessionId,
            stage: "v3_audit",
            originalFormatViolations: currentFormatViolations,
            normalizedFormatViolations,
          });
        }
      }
      } // end else (repairSynthesisResult !== null)
    }
  }

  // =====================================================
  // STAGE 4.5: STRIP INVALID CITATION MARKERS
  // =====================================================
  answerText = stripInvalidCitationMarkers(
    answerText,
    effectiveLocalChunks.length,
    effectiveStateChunks.length,
    effectiveSauChunks.length
  );

  // =====================================================
  // BUILD RESULT
  // =====================================================
  const durationMs = Date.now() - startTime;

  const docSourceType = classifyDocSourceType(
    retrievalResult.localCount,
    retrievalResult.stateCount,
    retrievalResult.sauCount
  );

  const debugInfo: V3DebugInfo = {
    issueMapSummary: {
      entities: issueMap.entities.slice(0, 5),
      legalTopics: issueMap.legalTopics.slice(0, 5),
      legalSalience: issueMap.legalSalience,
      plannerConfidence: issueMap.plannerConfidence,
    },
    planQueries: {
      local: retrievalPlan.local.queries,
      state: retrievalPlan.state.queries,
      sau: retrievalPlan.sau?.queries,
    },
    retrievalCounts: {
      localRetrieved: retrievalResult.debug.localRetrievedTotal,
      localSelected: retrievalResult.localCount,
      stateRetrieved: retrievalResult.debug.stateRetrievedTotal,
      stateSelected: retrievalResult.stateCount,
      sauRetrieved: retrievalResult.debug.sauRetrievedTotal,
      sauSelected: retrievalResult.sauCount,
    },
    recordStrengthTier: effectiveRecordStrength.tier,
    auditFlags,
    repairRan,
    durationMs,
    secondHopRan,
    secondHopQuery,
    secondHopChunksAdded,
    selectedAnswerSource,
    originalScore: originalScore ? {
      score: originalScore.score,
      isComplete: originalScore.isComplete,
      wordCount: originalScore.wordCount,
    } : undefined,
    repairScore: repairScore ? {
      score: repairScore.score,
      isComplete: repairScore.isComplete,
      wordCount: repairScore.wordCount,
    } : undefined,
    finalAnswerCharLen: answerText.length,
    finalAnswerWordCount: answerText.split(/\s+/).filter(w => w.length > 0).length,
  };

  logInfo("v3_pipeline_complete", {
    requestId: logContext?.requestId,
    sessionId: logContext?.sessionId,
    stage: "v3_orchestrator",
    answerLength: answerText.length,
    tier: effectiveRecordStrength.tier,
    localSelected: effectiveLocalChunks.length,
    stateSelected: effectiveStateChunks.length,
    sauSelected: effectiveSauChunks.length,
    auditFlagCount: auditFlags.length,
    repairRan,
    secondHopRan,
    secondHopQuery,
    secondHopChunksAdded,
    durationMs,
  });

  return {
    answerText,
    sourceDocumentNames: retrievalResult.allDocumentNames,
    docSourceType,
    docSourceTown: townPreference || null,
    retrievedChunkCount: effectiveLocalChunks.length + effectiveStateChunks.length + effectiveSauChunks.length,
    recordStrength: effectiveRecordStrength,
    debug: debugInfo,
    durationMs,
    missingInformationQuery: synthesisResult.missingInformationQuery || secondHopQuery || null,
  };
}

function classifyDocSourceType(localCount: number, stateCount: number, sauCount: number = 0): DocSourceType {
  const totalLocal = localCount + sauCount;
  if (totalLocal === 0 && stateCount === 0) {
    return "none";
  }
  if (totalLocal > 0 && stateCount > 0) {
    return "mixed";
  }
  if (sauCount > 0 && localCount === 0) {
    return "sau";
  }
  if (totalLocal > 0) {
    return "local";
  }
  return "statewide";
}
