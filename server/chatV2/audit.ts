/**
 * V3 Audit Module - Post-generation guardrails
 * 
 * Responsibilities:
 * 1. Detect uncited RSA references
 * 2. Detect absolute legal language without support
 * 3. Detect off-topic drift
 * 4. Trigger repair regeneration (max 1 pass)
 */

import { logDebug } from "../utils/logger";
import type { 
  AuditResult, 
  AuditViolation, 
  LabeledChunk,
  IssueMap,
  PipelineLogContext 
} from "./types";
import type { SituationContext } from "@shared/schema";

export interface AuditOptions {
  answerText: string;
  stateChunks: LabeledChunk[];
  citationsUsed: string[];
  issueMap: IssueMap;
  situationContext?: SituationContext | null;
  logContext?: PipelineLogContext;
}


const ABSOLUTE_LEGAL_PATTERNS = [
  /\bis\s+illegal\b/i,
  /\bwill\s+be\s+liable\b/i,
  /\bmust\s+result\s+in\b/i,
  /\bguaranteed\s+to\b/i,
  /\bwill\s+definitely\b/i,
  /\bis\s+certainly\s+illegal\b/i,
  /\bautomatically\s+(?:liable|responsible)\b/i,
];

const PROCEDURE_CLAIMS = [
  /\bPublic\s+Integrity\s+Unit\s+(?:process|procedure|requires?)\b/i,
  /\bDOJ\s+(?:process|procedure|requires?)\b/i,
  /\bmust\s+file\s+(?:within|by)\s+\d+\s+days?\b/i,
  /\bstatute\s+of\s+limitations?\s+(?:is|requires?)\s+\d+/i,
];

export function auditAnswer(options: AuditOptions): AuditResult {
  const { answerText, stateChunks, citationsUsed, issueMap, situationContext, logContext } = options;
  const violations: AuditViolation[] = [];

  const rsaViolations = checkUncitedRSA(answerText, stateChunks, citationsUsed);
  violations.push(...rsaViolations);

  const absoluteViolations = checkAbsoluteLegalClaims(answerText);
  violations.push(...absoluteViolations);

  const procedureViolations = checkUncitedProcedures(answerText, stateChunks, citationsUsed);
  violations.push(...procedureViolations);

  if (situationContext) {
    const driftViolations = checkOffTopicDrift(answerText, issueMap, situationContext);
    violations.push(...driftViolations);
  }

  const errorCount = violations.filter(v => v.severity === 'error').length;
  const shouldRepair = errorCount > 0;

  const result: AuditResult = {
    passed: violations.length === 0,
    violations,
    shouldRepair,
    repairHint: shouldRepair ? buildRepairHint(violations) : undefined,
  };

  logDebug("audit_v3_complete", {
    requestId: logContext?.requestId,
    sessionId: logContext?.sessionId,
    stage: "auditV3",
    passed: result.passed,
    violationCount: violations.length,
    errorCount,
    shouldRepair,
  });

  return result;
}

function checkUncitedRSA(
  answerText: string, 
  stateChunks: LabeledChunk[], 
  citationsUsed: string[]
): AuditViolation[] {
  const violations: AuditViolation[] = [];

  const stateChunkText = stateChunks.map(c => c.content).join(' ');

  const rsaRegex = /\bRSA\s+(\d+[-:]?[A-Z]?(?:[-:]\d+)?)/gi;
  let match: RegExpExecArray | null;
  
  while ((match = rsaRegex.exec(answerText)) !== null) {
    const rsaNumber = match[1];
    const rsaReference = `RSA ${rsaNumber}`;

    const matchIndex = match.index || 0;
    const contextStart = Math.max(0, matchIndex - 20);
    const contextEnd = Math.min(answerText.length, matchIndex + rsaReference.length + 30);
    const context = answerText.slice(contextStart, contextEnd);

    const hasCitationNearby = /\[S\d+\]/.test(context);

    const isInStateChunks = stateChunkText.toLowerCase().includes(rsaNumber.toLowerCase()) ||
                           stateChunkText.includes(`RSA ${rsaNumber}`);

    if (!hasCitationNearby && !isInStateChunks) {
      violations.push({
        type: 'uncited_rsa',
        evidence: `Found ${rsaReference} without supporting state citation: "${context.trim()}"`,
        severity: 'error',
      });
    }
  }

  return violations;
}

function checkAbsoluteLegalClaims(answerText: string): AuditViolation[] {
  const violations: AuditViolation[] = [];

  for (const pattern of ABSOLUTE_LEGAL_PATTERNS) {
    const match = pattern.exec(answerText);
    if (match) {
      const matchIndex = match.index || 0;
      const contextStart = Math.max(0, matchIndex - 30);
      const contextEnd = Math.min(answerText.length, matchIndex + match[0].length + 30);
      const context = answerText.slice(contextStart, contextEnd);

      violations.push({
        type: 'absolute_legal_claim',
        evidence: `Absolute claim found: "${context.trim()}"`,
        severity: 'warning',
      });
    }
  }

  return violations;
}

function checkUncitedProcedures(
  answerText: string,
  stateChunks: LabeledChunk[],
  citationsUsed: string[]
): AuditViolation[] {
  const violations: AuditViolation[] = [];
  const stateChunkText = stateChunks.map(c => c.content).join(' ');

  for (const pattern of PROCEDURE_CLAIMS) {
    const match = pattern.exec(answerText);
    if (match) {
      const matchIndex = match.index || 0;
      const contextStart = Math.max(0, matchIndex - 10);
      const contextEnd = Math.min(answerText.length, matchIndex + match[0].length + 30);
      const context = answerText.slice(contextStart, contextEnd);

      const hasCitationNearby = /\[S\d+\]/.test(context);

      const procedureKeyword = match[0].split(/\s+/)[0].toLowerCase();
      const isInStateChunks = stateChunkText.toLowerCase().includes(procedureKeyword);

      if (!hasCitationNearby && !isInStateChunks) {
        violations.push({
          type: 'uncited_procedure',
          evidence: `Procedure claim without citation: "${context.trim()}"`,
          severity: 'error',
        });
      }
    }
  }

  return violations;
}

function checkOffTopicDrift(
  answerText: string,
  issueMap: IssueMap,
  situationContext: SituationContext
): AuditViolation[] {
  const violations: AuditViolation[] = [];
  
  const KNOWN_OFF_TOPIC_ANCHORS = ['Brown property', 'Brown case', 'RV', 'cesspool', 'septic'];
  
  const lowerAnswer = answerText.toLowerCase();
  const situationTitle = situationContext.title.toLowerCase();

  for (const anchor of KNOWN_OFF_TOPIC_ANCHORS) {
    const lowerAnchor = anchor.toLowerCase();
    if (lowerAnswer.includes(lowerAnchor) && !situationTitle.includes(lowerAnchor)) {
      const idx = lowerAnswer.indexOf(lowerAnchor);
      const context = answerText.slice(Math.max(0, idx - 20), Math.min(answerText.length, idx + anchor.length + 40));
      
      violations.push({
        type: 'off_topic_drift',
        evidence: `Off-topic anchor "${anchor}" found when situation is "${situationContext.title}": "${context.trim()}"`,
        severity: 'warning',
      });
    }
  }

  return violations;
}

function buildRepairHint(violations: AuditViolation[]): string {
  const hints: string[] = [];

  const hasUncitedRSA = violations.some(v => v.type === 'uncited_rsa');
  const hasUncitedProcedure = violations.some(v => v.type === 'uncited_procedure');
  const hasAbsoluteClaim = violations.some(v => v.type === 'absolute_legal_claim');
  const hasOffTopic = violations.some(v => v.type === 'off_topic_drift');

  if (hasUncitedRSA) {
    hints.push('Remove specific RSA section numbers that are not in the provided state documents, or speak generally about NH law.');
  }

  if (hasUncitedProcedure) {
    hints.push('Remove specific procedure/process claims that are not supported by cited sources.');
  }

  if (hasAbsoluteClaim) {
    hints.push('Qualify absolute legal claims (is illegal, will be liable) with hedged language.');
  }

  if (hasOffTopic) {
    hints.push('Stay focused on the current situation. Do not substitute or heavily reference unrelated cases.');
  }

  return hints.join(' ');
}

export function shouldAttemptRepair(auditResult: AuditResult, alreadyRepaired: boolean): boolean {
  if (alreadyRepaired) return false;
  return auditResult.shouldRepair;
}
