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
import { twoLaneRetrieveWithPlan, type V3RetrievalResult } from "./twoLaneRetrieve";
import { synthesizeV3, computeRecordStrength } from "./synthesizerV3";
import { auditAnswer, shouldAttemptRepair, selectBetterAnswer, normalizeAnswerFormat, type AnswerScore } from "./audit";
import { chatConfigV3 } from "./chatConfigV3";
import { getSessionSourceTextForContext } from "./sessionSourceDetector";
import { computeQuestionSituationMatch } from "./situationExtractor";
import type {
  IssueMap,
  RecordStrength,
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
  } = options;

  const startTime = Date.now();

  // =====================================================
  // STAGE 0: SITUATION RELEVANCE GATE
  // =====================================================
  // Determine if stored situation context should be applied to this question
  // This prevents "sticky context" leakage (e.g., boardwalk vote appearing in budget questions)
  const situationRelevance = computeQuestionSituationMatch(userMessage, situationContext || null);
  const effectiveSituationContext = situationRelevance.useSituationContext ? situationContext : null;

  // Also filter history when situation context is gated
  // This prevents prior Q&A from leaking into unrelated domain questions
  const historyForSynthesis = situationRelevance.useSituationContext 
    ? sessionHistory 
    : []; // Clear history when domain switch detected

  logInfo("v3_pipeline_start", {
    requestId: logContext?.requestId,
    sessionId: logContext?.sessionId,
    stage: "v3_orchestrator",
    messageLength: userMessage.length,
    townPreference,
    hasSituationContext: !!situationContext,
    situationGated: !situationRelevance.useSituationContext,
    situationScore: situationRelevance.score,
    situationReason: situationRelevance.reason,
    sessionSourceCount: (sessionSources || []).length,
    historyCleared: !situationRelevance.useSituationContext && sessionHistory.length > 0,
  });

  // =====================================================
  // STAGE 1: PLAN
  // =====================================================
  const plannerResult = await runPlannerV3({
    userMessage,
    sessionSources,
    situationContext: effectiveSituationContext, // Only pass if relevant
    townHint: townPreference || undefined,
    logContext,
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
  });

  // =====================================================
  // STAGE 2: RETRIEVE
  // =====================================================
  const retrievalResult = await twoLaneRetrieveWithPlan(
    retrievalPlan,
    issueMap,
    {
      townPreference,
      situationContext: effectiveSituationContext, // Only pass if relevant
      logContext,
    }
  );

  logDebug("v3_retrieve_complete", {
    requestId: logContext?.requestId,
    sessionId: logContext?.sessionId,
    stage: "v3_retrieval",
    localSelected: retrievalResult.localCount,
    stateSelected: retrievalResult.stateCount,
    situationAlignment: retrievalResult.situationAlignment,
    legalTopicCoverage: retrievalResult.legalTopicCoverage,
    authoritativeStatePresent: retrievalResult.authoritativeStatePresent,
    earlyExitTriggered: retrievalResult.debug.earlyExitTriggered,
  });

  // =====================================================
  // STAGE 3: SYNTHESIZE
  // =====================================================
  const sessionSourceText = sessionSources?.length
    ? getSessionSourceTextForContext(sessionSources, chatConfigV3.MAX_SESSION_SOURCE_CHARS)
    : undefined;

  const recordStrength = computeRecordStrength(
    retrievalResult.localChunks,
    retrievalResult.stateChunks,
    issueMap,
    retrievalResult.situationAlignment
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
    recordStrength,
    history: historyForSynthesis,
    logContext,
    answerType,
    renderStyle,
  });

  let answerText = synthesisResult.answerText;
  let auditFlags: string[] = [];
  let repairRan = false;
  let selectedAnswerSource: 'original' | 'repair' | 'repair_normalized' | 'original_normalized' = 'original';
  let originalScore: AnswerScore | undefined;
  let repairScore: AnswerScore | undefined;

  // =====================================================
  // STAGE 4: AUDIT + REPAIR
  // =====================================================
  if (chatConfigV3.ENABLE_AUDIT) {
    const stateChunkCount = retrievalResult.stateChunks.length;
    
    const auditResult = auditAnswer({
      answerText,
      stateChunks: retrievalResult.stateChunks,
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

      const repairSynthesisResult = await synthesizeV3({
        userMessage,
        issueMap,
        sessionSourceText,
        localChunks: retrievalResult.localChunks,
        stateChunks: retrievalResult.stateChunks,
        recordStrength,
        history: historyForSynthesis,
        logContext,
        isRepairAttempt: true,
        answerType,
        renderStyle,
      });

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
          stateChunks: retrievalResult.stateChunks,
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
        stateChunks: retrievalResult.stateChunks,
        citationsUsed: synthesisResult.citationsUsed,
        issueMap,
        situationContext: effectiveSituationContext,
        logContext,
        renderStyle,
        answerType,
      });

      if (currentAuditResult.violations.some(v => v.type === 'format_violation')) {
        const normalizedAnswer = normalizeAnswerFormat(answerText);
        
        // Check if normalization helped
        const normalizedAudit = auditAnswer({
          answerText: normalizedAnswer,
          stateChunks: retrievalResult.stateChunks,
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
    }
  }

  // =====================================================
  // BUILD RESULT
  // =====================================================
  const durationMs = Date.now() - startTime;

  const docSourceType = classifyDocSourceType(
    retrievalResult.localCount,
    retrievalResult.stateCount
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
    },
    retrievalCounts: {
      localRetrieved: retrievalResult.debug.localRetrievedTotal,
      localSelected: retrievalResult.localCount,
      stateRetrieved: retrievalResult.debug.stateRetrievedTotal,
      stateSelected: retrievalResult.stateCount,
    },
    recordStrengthTier: recordStrength.tier,
    auditFlags,
    repairRan,
    durationMs,
    // New telemetry fields
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
    tier: recordStrength.tier,
    localSelected: retrievalResult.localCount,
    stateSelected: retrievalResult.stateCount,
    auditFlagCount: auditFlags.length,
    repairRan,
    durationMs,
  });

  return {
    answerText,
    sourceDocumentNames: retrievalResult.allDocumentNames,
    docSourceType,
    docSourceTown: townPreference || null,
    retrievedChunkCount: retrievalResult.localCount + retrievalResult.stateCount,
    recordStrength,
    debug: debugInfo,
    durationMs,
  };
}

function classifyDocSourceType(localCount: number, stateCount: number): DocSourceType {
  if (localCount === 0 && stateCount === 0) {
    return "none";
  }
  if (localCount > 0 && stateCount > 0) {
    return "mixed";
  }
  if (localCount > 0) {
    return "local";
  }
  return "statewide";
}
