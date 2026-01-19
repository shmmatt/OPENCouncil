/**
 * V3 Audit Module - Post-generation guardrails
 * 
 * Responsibilities:
 * 1. Detect uncited RSA references
 * 2. Detect absolute legal language without support
 * 3. Detect off-topic drift
 * 4. Validate answer format (word count, headings, bullets, citations)
 * 5. Trigger repair regeneration (max 1 pass)
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

// =====================================================
// FORMAT VALIDATION CONSTANTS
// =====================================================

const REQUIRED_HEADINGS = [
  "Bottom line",
  "What happened",
  "What the law generally requires",
  "What the Jan 6 vote changes",
  "Unknowns that matter",
];

const SECTION_BULLET_LIMITS: Record<string, number> = {
  "Bottom line": 0, // No bullets, just sentences
  "What happened": 5,
  "What the law generally requires": 5,
  "What the Jan 6 vote changes": 4,
  "Unknowns that matter": 4,
};

const MAX_WORD_COUNT = 500;
const MAX_BULLET_WORDS = 20; // Hard cap per spec

// LLM tail phrases to reject
const LLM_TAIL_PATTERNS = [
  /\bnext\s+steps?\b/i,
  /\bconsult\s+counsel\b/i,
  /\byou\s+may\s+wish\s+to\b/i,
  /\bi\s+recommend\b/i,
  /\bwhat\s+to\s+pull\s+next\b/i,
  /\bwhat\s+would\s+clarify\b/i,
  /\bfurther\s+research\b/i,
  /\bseek\s+legal\s+advice\b/i,
  /\bconsider\s+consulting\b/i,
];

export interface FormatValidationResult {
  passed: boolean;
  wordCount: number;
  headingsPresent: boolean[];
  headingsInOrder: boolean;
  bulletCounts: Record<string, number>;
  bulletViolations: string[];
  stateCitationCount: number;
  lawSectionHasStateCitations: boolean;
  llmTailsFound: string[];
  violations: AuditViolation[];
}

export interface AuditOptions {
  answerText: string;
  stateChunks: LabeledChunk[];
  citationsUsed: string[];
  issueMap: IssueMap;
  situationContext?: SituationContext | null;
  logContext?: PipelineLogContext;
  stateChunkCount?: number;
}


// =====================================================
// FORMAT VALIDATION FUNCTION
// =====================================================

/**
 * Validate answer format against strict requirements
 */
export function validateAnswerFormat(
  answerText: string,
  stateChunkCount: number
): FormatValidationResult {
  const violations: AuditViolation[] = [];
  
  // 1. Word count check
  const words = answerText.split(/\s+/).filter(w => w.length > 0);
  const wordCount = words.length;
  
  if (wordCount > MAX_WORD_COUNT) {
    violations.push({
      type: 'format_violation',
      evidence: `Word count ${wordCount} exceeds limit of ${MAX_WORD_COUNT}`,
      severity: 'error',
    });
  }

  // 2. Check headings presence and order (using same flexible patterns as extractSections)
  const headingPositions: number[] = [];
  const headingsPresent: boolean[] = [];
  
  for (const heading of REQUIRED_HEADINGS) {
    const escapedHeading = heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    
    // Use same flexible patterns as extractSections
    const patterns = [
      new RegExp(`\\*\\*${escapedHeading}\\*\\*[:\\s]*`, 'i'),
      new RegExp(`\\d+\\.\\s*\\*\\*${escapedHeading}\\*\\*[:\\s]*`, 'i'),
      new RegExp(`\\d+\\.\\s*${escapedHeading}[:\\s]+`, 'i'),
      new RegExp(`^${escapedHeading}[:\\s]+`, 'im'),
      new RegExp(`^#+\\s*${escapedHeading}[:\\s]*`, 'im'),
    ];
    
    let matchFound: RegExpMatchArray | null = null;
    for (const pattern of patterns) {
      const match = answerText.match(pattern);
      if (match) {
        matchFound = match;
        break;
      }
    }
    
    const isPresent = matchFound !== null;
    headingsPresent.push(isPresent);
    
    if (isPresent && matchFound) {
      headingPositions.push(answerText.indexOf(matchFound[0]));
    } else {
      headingPositions.push(-1);
    }
  }
  
  // Check if present headings are in order
  const presentPositions = headingPositions.filter(p => p >= 0);
  const headingsInOrder = presentPositions.every((pos, i) => 
    i === 0 || pos > presentPositions[i - 1]
  );

  const missingHeadings = REQUIRED_HEADINGS.filter((_, i) => !headingsPresent[i]);
  if (missingHeadings.length > 0) {
    violations.push({
      type: 'format_violation',
      evidence: `Missing required headings: ${missingHeadings.join(', ')}`,
      severity: 'warning',
    });
  }

  if (!headingsInOrder && presentPositions.length > 1) {
    violations.push({
      type: 'format_violation',
      evidence: 'Headings are not in the required order',
      severity: 'warning',
    });
  }

  // 3. Check bullet counts per section
  const bulletCounts: Record<string, number> = {};
  const bulletViolations: string[] = [];
  
  const sections = extractSections(answerText);
  
  for (const [sectionName, sectionContent] of Object.entries(sections)) {
    const bullets = sectionContent.match(/^\s*[-•*]\s+/gm) || [];
    bulletCounts[sectionName] = bullets.length;
    
    const limit = SECTION_BULLET_LIMITS[sectionName];
    if (limit !== undefined && bullets.length > limit) {
      bulletViolations.push(`${sectionName}: ${bullets.length} bullets (max ${limit})`);
      violations.push({
        type: 'format_violation',
        evidence: `Section "${sectionName}" has ${bullets.length} bullets, exceeds limit of ${limit}`,
        severity: 'warning',
      });
    }
    
    // Check for long bullets - add format violation for bullets exceeding word limit
    const bulletLines = sectionContent.split('\n').filter(line => /^\s*[-•*]\s+/.test(line));
    for (const bulletLine of bulletLines) {
      const bulletWords = bulletLine.split(/\s+/).filter(w => w.length > 0);
      if (bulletWords.length > MAX_BULLET_WORDS) {
        bulletViolations.push(`Long bullet in ${sectionName}: ${bulletWords.length} words`);
        violations.push({
          type: 'format_violation',
          evidence: `Bullet in "${sectionName}" has ${bulletWords.length} words (max ${MAX_BULLET_WORDS})`,
          severity: 'warning',
        });
      }
    }
  }

  // 4. Check state citations in law section
  const stateCitationPattern = /\[S\d+\]/g;
  const allStateCitations = answerText.match(stateCitationPattern) || [];
  const stateCitationCount = allStateCitations.length;
  
  const lawSection = sections["What the law generally requires"] || "";
  const lawSectionCitations = lawSection.match(stateCitationPattern) || [];
  const lawSectionHasStateCitations = lawSectionCitations.length >= 2;
  
  if (stateChunkCount > 0 && !lawSectionHasStateCitations) {
    violations.push({
      type: 'missing_state_citation',
      evidence: `"What the law generally requires" section has ${lawSectionCitations.length} [Sx] citations (requires at least 2 when state chunks exist)`,
      severity: 'error',
    });
  }

  // 5. Check for uncited RSA in law section
  if (lawSection) {
    const rsaPattern = /\bRSA\s+\d+[-:A-Z]?/gi;
    const rsaMatches = lawSection.match(rsaPattern) || [];
    for (const rsaMatch of rsaMatches) {
      // Check if this RSA mention has a nearby [Sx] citation
      const rsaIndex = lawSection.indexOf(rsaMatch);
      const nearbyText = lawSection.slice(Math.max(0, rsaIndex - 20), Math.min(lawSection.length, rsaIndex + rsaMatch.length + 30));
      if (!stateCitationPattern.test(nearbyText)) {
        violations.push({
          type: 'uncited_rsa',
          evidence: `RSA "${rsaMatch}" in law section without nearby [Sx] citation`,
          severity: 'error',
        });
      }
    }
  }

  // 6. Check for LLM tail phrases
  const llmTailsFound: string[] = [];
  for (const pattern of LLM_TAIL_PATTERNS) {
    const match = answerText.match(pattern);
    if (match) {
      llmTailsFound.push(match[0]);
    }
  }
  
  if (llmTailsFound.length > 0) {
    violations.push({
      type: 'llm_tail',
      evidence: `Found disallowed phrases: ${llmTailsFound.join(', ')}`,
      severity: 'warning',
    });
  }

  // 7. Check [USER] citation placement - should only be in "What happened"
  const whatHappenedSection = sections["What happened"] || "";
  const otherSections = Object.entries(sections)
    .filter(([name]) => name !== "What happened")
    .map(([_, content]) => content)
    .join(' ');
  
  const userCitationPattern = /\[USER\]/g;
  const userInOtherSections = otherSections.match(userCitationPattern) || [];
  
  if (userInOtherSections.length > 0) {
    violations.push({
      type: 'format_violation',
      evidence: `[USER] citation found outside "What happened" section (${userInOtherSections.length} occurrences)`,
      severity: 'warning',
    });
  }

  const passed = violations.filter(v => v.severity === 'error').length === 0;

  return {
    passed,
    wordCount,
    headingsPresent,
    headingsInOrder,
    bulletCounts,
    bulletViolations,
    stateCitationCount,
    lawSectionHasStateCitations,
    llmTailsFound,
    violations,
  };
}

/**
 * Extract sections from answer text by heading
 */
function extractSections(answerText: string): Record<string, string> {
  const sections: Record<string, string> = {};
  
  // Find all heading positions with flexible matching
  const headingMatches: { name: string; start: number; end: number }[] = [];
  
  for (const heading of REQUIRED_HEADINGS) {
    const escapedHeading = heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    
    // More flexible patterns to handle various formatting variations
    const patterns = [
      // Standard markdown: **Bottom line**
      new RegExp(`\\*\\*${escapedHeading}\\*\\*[:\\s]*`, 'i'),
      // Numbered with bold: 1. **Bottom line**
      new RegExp(`\\d+\\.\\s*\\*\\*${escapedHeading}\\*\\*[:\\s]*`, 'i'),
      // Numbered without bold: 1. Bottom line:
      new RegExp(`\\d+\\.\\s*${escapedHeading}[:\\s]+`, 'i'),
      // Just the heading with colon: Bottom line:
      new RegExp(`^${escapedHeading}[:\\s]+`, 'im'),
      // Heading-style markdown: # Bottom line or ## Bottom line
      new RegExp(`^#+\\s*${escapedHeading}[:\\s]*`, 'im'),
    ];
    
    for (const pattern of patterns) {
      const match = answerText.match(pattern);
      if (match && match.index !== undefined) {
        headingMatches.push({
          name: heading,
          start: match.index,
          end: match.index + match[0].length,
        });
        break;
      }
    }
  }
  
  // Sort by position
  headingMatches.sort((a, b) => a.start - b.start);
  
  // Extract content between headings
  for (let i = 0; i < headingMatches.length; i++) {
    const current = headingMatches[i];
    const nextStart = i < headingMatches.length - 1 
      ? headingMatches[i + 1].start 
      : answerText.length;
    
    sections[current.name] = answerText.slice(current.end, nextStart).trim();
  }
  
  return sections;
}

// =====================================================
// CONTENT VALIDATION PATTERNS
// =====================================================

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
  const { answerText, stateChunks, citationsUsed, issueMap, situationContext, logContext, stateChunkCount } = options;
  const violations: AuditViolation[] = [];

  // 1. Format validation (new)
  const formatValidation = validateAnswerFormat(answerText, stateChunkCount || stateChunks.length);
  violations.push(...formatValidation.violations);

  // 2. Content violations
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
    formatValidation: {
      wordCount: formatValidation.wordCount,
      headingsInOrder: formatValidation.headingsInOrder,
      stateCitationCount: formatValidation.stateCitationCount,
      lawSectionHasStateCitations: formatValidation.lawSectionHasStateCitations,
      llmTailsFound: formatValidation.llmTailsFound,
    },
  };

  logDebug("audit_v3_complete", {
    requestId: logContext?.requestId,
    sessionId: logContext?.sessionId,
    stage: "auditV3",
    passed: result.passed,
    violationCount: violations.length,
    errorCount,
    shouldRepair,
    wordCount: formatValidation.wordCount,
    headingsInOrder: formatValidation.headingsInOrder,
    stateCitationCount: formatValidation.stateCitationCount,
    lawSectionHasStateCitations: formatValidation.lawSectionHasStateCitations,
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
  const hasFormatViolation = violations.some(v => v.type === 'format_violation');
  const hasMissingStateCitation = violations.some(v => v.type === 'missing_state_citation');
  const hasLlmTail = violations.some(v => v.type === 'llm_tail');

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

  if (hasFormatViolation) {
    hints.push('Shorten answer to 500 words max. Reduce bullets to section limits (5/5/4/4). Keep all 5 required headings in order.');
  }

  if (hasMissingStateCitation) {
    hints.push('Add at least 2 [Sx] citations to "What the law generally requires" section using provided state documents.');
  }

  if (hasLlmTail) {
    hints.push('Remove "next steps", "consult counsel", "you may wish to", and similar phrases.');
  }

  return hints.join(' ');
}

export function shouldAttemptRepair(auditResult: AuditResult, alreadyRepaired: boolean): boolean {
  if (alreadyRepaired) return false;
  return auditResult.shouldRepair;
}

// =====================================================
// ANSWER SCORING FUNCTION
// =====================================================

const MIN_COMPLETE_WORD_COUNT = 180;

export interface AnswerScore {
  score: number;
  isComplete: boolean;
  headingsFound: number;
  wordCount: number;
  hasLawCitations: boolean;
  hasBannedPhrases: boolean;
  violationCount: number;
}

/**
 * Score an answer for quality and completeness.
 * Higher score = better answer.
 * Used to choose between original and repair.
 */
export function scoreAnswer(
  answerText: string,
  stateChunkCount: number
): AnswerScore {
  const formatResult = validateAnswerFormat(answerText, stateChunkCount);
  const headingsFound = formatResult.headingsPresent.filter(Boolean).length;
  const wordCount = formatResult.wordCount;
  const hasLawCitations = formatResult.lawSectionHasStateCitations;
  const hasBannedPhrases = formatResult.llmTailsFound.length > 0;
  const violationCount = formatResult.violations.length;
  
  // Completeness gate: must have all 5 headings and minimum word count
  const hasAllHeadings = headingsFound === REQUIRED_HEADINGS.length;
  const hasMinWords = wordCount >= MIN_COMPLETE_WORD_COUNT;
  const isComplete = hasAllHeadings && hasMinWords;
  
  // Build score
  let score = 0;
  
  // Big bonus for having all headings
  score += headingsFound * 10; // +50 max for all 5
  
  // Bonus for law section having citations when state chunks available
  if (stateChunkCount > 0 && hasLawCitations) {
    score += 20;
  }
  
  // Penalty for violations
  score -= violationCount * 2;
  
  // Penalty for banned phrases
  if (hasBannedPhrases) {
    score -= 10;
  }
  
  // Penalty for being too short (incomplete)
  if (wordCount < MIN_COMPLETE_WORD_COUNT) {
    score -= 30;
  }
  
  // Bonus for good word count (sweet spot 200-500)
  if (wordCount >= 200 && wordCount <= 500) {
    score += 15;
  }
  
  return {
    score,
    isComplete,
    headingsFound,
    wordCount,
    hasLawCitations,
    hasBannedPhrases,
    violationCount,
  };
}

/**
 * Compare two answers and return which one is better.
 * Returns 'original' or 'repair'
 */
export function selectBetterAnswer(
  originalText: string,
  repairText: string,
  stateChunkCount: number
): {
  selectedSource: 'original' | 'repair';
  originalScore: AnswerScore;
  repairScore: AnswerScore;
} {
  const originalScore = scoreAnswer(originalText, stateChunkCount);
  const repairScore = scoreAnswer(repairText, stateChunkCount);
  
  // HARD GATE: If original is incomplete but repair is complete, always prefer repair
  if (!originalScore.isComplete && repairScore.isComplete) {
    return { selectedSource: 'repair', originalScore, repairScore };
  }
  
  // If repair is incomplete but original is complete, always prefer original
  if (!repairScore.isComplete && originalScore.isComplete) {
    return { selectedSource: 'original', originalScore, repairScore };
  }
  
  // Otherwise, pick the higher score
  if (repairScore.score > originalScore.score) {
    return { selectedSource: 'repair', originalScore, repairScore };
  }
  
  return { selectedSource: 'original', originalScore, repairScore };
}

// =====================================================
// DETERMINISTIC POST-FORMATTER (NORMALIZE)
// =====================================================

/**
 * Normalize answer format to enforce bullet caps and word limits
 * without requiring another LLM call.
 */
export function normalizeAnswerFormat(answerText: string): string {
  const sections = extractSections(answerText);
  const normalizedParts: string[] = [];
  
  for (const heading of REQUIRED_HEADINGS) {
    const content = sections[heading];
    
    if (!content) {
      // Add placeholder for missing section
      normalizedParts.push(`**${heading}**\n- Information not available in sources.`);
      continue;
    }
    
    if (heading === "Bottom line") {
      // No bullets for bottom line - just truncate if too long
      const truncated = truncateToParagraph(content, 60);
      normalizedParts.push(`**${heading}**\n${truncated}`);
    } else {
      // Apply bullet limit for this section
      const limit = SECTION_BULLET_LIMITS[heading] || 4;
      const normalizedContent = normalizeSectionBullets(content, limit);
      normalizedParts.push(`**${heading}**\n${normalizedContent}`);
    }
  }
  
  let result = normalizedParts.join('\n\n');
  
  // Remove any LLM tail phrases
  for (const pattern of LLM_TAIL_PATTERNS) {
    result = result.replace(pattern, '');
  }
  
  // Clean up extra whitespace
  result = result.replace(/\n{3,}/g, '\n\n').trim();
  
  return result;
}

/**
 * Normalize bullets in a section: trim to limit and cap word count per bullet
 */
function normalizeSectionBullets(content: string, maxBullets: number): string {
  const lines = content.split('\n');
  const bulletLines: string[] = [];
  const nonBulletLines: string[] = [];
  
  for (const line of lines) {
    const trimmed = line.trim();
    if (/^[-•*]\s+/.test(trimmed)) {
      bulletLines.push(trimmed);
    } else if (trimmed) {
      // Convert non-bullet text to bullet if content exists
      if (nonBulletLines.length < 2) { // Keep some intro text
        nonBulletLines.push(trimmed);
      }
    }
  }
  
  // Take only first maxBullets
  const keptBullets = bulletLines.slice(0, maxBullets);
  
  // Truncate long bullets while preserving citations at end
  const normalizedBullets = keptBullets.map(bullet => {
    const words = bullet.split(/\s+/);
    if (words.length > MAX_BULLET_WORDS) {
      // Try to preserve citation tokens at end (e.g., [S1], [L2])
      const lastWord = words[words.length - 1];
      const hasCitation = /^\[(?:S|L|USER)\d*\]$/.test(lastWord);
      
      if (hasCitation && words.length > MAX_BULLET_WORDS + 1) {
        // Keep citation at end
        return words.slice(0, MAX_BULLET_WORDS - 1).join(' ') + '... ' + lastWord;
      }
      return words.slice(0, MAX_BULLET_WORDS).join(' ') + '...';
    }
    return bullet;
  });
  
  // Combine intro text with bullets
  const parts: string[] = [];
  if (nonBulletLines.length > 0) {
    parts.push(nonBulletLines.join(' '));
  }
  parts.push(...normalizedBullets);
  
  return parts.join('\n');
}

// =====================================================
// HARD TRUNCATE FALLBACK
// =====================================================

/**
 * Hard truncate answer when repair fails - removes extra bullets and content
 * to meet format requirements as a last resort
 */
export function hardTruncateAnswer(answerText: string): string {
  const sections = extractSections(answerText);
  const truncatedParts: string[] = [];
  
  // Try to preserve bottom line as-is
  const bottomLine = sections["Bottom line"];
  if (bottomLine) {
    truncatedParts.push("**Bottom line**\n" + truncateToParagraph(bottomLine, 50));
  }
  
  // Truncate other sections to their bullet limits
  for (const heading of REQUIRED_HEADINGS.slice(1)) {
    const content = sections[heading];
    if (!content) continue;
    
    const limit = SECTION_BULLET_LIMITS[heading] || 4;
    const truncated = truncateBullets(content, limit);
    truncatedParts.push(`**${heading}**\n${truncated}`);
  }
  
  // Remove any LLM tail phrases
  let result = truncatedParts.join('\n\n');
  for (const pattern of LLM_TAIL_PATTERNS) {
    result = result.replace(pattern, '');
  }
  
  // Hard cap word count
  const words = result.split(/\s+/);
  if (words.length > MAX_WORD_COUNT) {
    result = words.slice(0, MAX_WORD_COUNT).join(' ') + '...';
  }
  
  return result.trim();
}

function truncateToParagraph(text: string, maxWords: number): string {
  const words = text.split(/\s+/).filter(w => w.length > 0);
  if (words.length <= maxWords) return text;
  return words.slice(0, maxWords).join(' ') + '...';
}

function truncateBullets(content: string, maxBullets: number): string {
  const lines = content.split('\n');
  const bulletLines: string[] = [];
  const otherLines: string[] = [];
  
  for (const line of lines) {
    if (/^\s*[-•*]\s+/.test(line)) {
      bulletLines.push(line);
    } else if (line.trim()) {
      otherLines.push(line);
    }
  }
  
  // Take only first maxBullets
  const keptBullets = bulletLines.slice(0, maxBullets);
  
  // Truncate long bullets
  const truncatedBullets = keptBullets.map(bullet => {
    const words = bullet.split(/\s+/);
    if (words.length > MAX_BULLET_WORDS) {
      return words.slice(0, MAX_BULLET_WORDS).join(' ') + '...';
    }
    return bullet;
  });
  
  return truncatedBullets.join('\n');
}

/**
 * Get fallback Tier C minimal answer when repair fails completely
 */
export function getTierCFallback(issueMap: IssueMap): string {
  const situationRef = issueMap.situationTitle 
    ? `Regarding "${issueMap.situationTitle}"`
    : "For this question";
    
  return `**Bottom line**
${situationRef}, the available sources do not provide sufficient detail for a complete analysis.

**What happened**
- Limited documentation found in the archive for this specific situation.

**What the law generally requires**
- NH municipal law may apply, but specific statutory references were not confirmed in available sources.

**What the Jan 6 vote changes**
- Impact depends on specifics not fully covered in available sources.

**Unknowns that matter**
- Specific local documentation for this situation would clarify the analysis.`;
}
