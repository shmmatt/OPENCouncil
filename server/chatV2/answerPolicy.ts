/**
 * Answer Policy Module
 * 
 * Centralized output policies for answer generation based on complexity and mode.
 * This module defines character targets, hard caps, token limits, and structure constraints.
 */

import type { AnswerMode } from "./types";

/**
 * Policy name for logging and debugging
 */
export type PolicyName = 
  | "simple_standard" 
  | "simple_deep" 
  | "complex_standard" 
  | "complex_deep";

/**
 * Output policy for a specific complexity/mode combination
 */
export interface AnswerPolicy {
  policyName: PolicyName;
  charTargetMin: number;
  charTargetMax: number;
  charCap: number;
  maxOutputTokens: number;
  structure: StructureConstraints;
}

/**
 * Structure constraints for answer formatting
 */
export interface StructureConstraints {
  maxBullets: number;
  maxBulletLength: number;
  sections: string[];
  forbiddenSections?: string[];
  requireSources: boolean;
  requireKeyPoints: boolean;
}

/**
 * Logging metadata for observability
 */
export interface AnswerPolicyMetrics {
  policyName: PolicyName;
  charTargetMin: number;
  charTargetMax: number;
  charCap: number;
  maxOutputTokensUsed: number;
  generationLengthChars: number;
  finalAnswerLengthChars: number;
  wasRewrittenForLength: boolean;
  wasTruncated: boolean;
}

/**
 * Get the answer policy for a given complexity and mode combination.
 */
export function getAnswerPolicy(
  complexity: "simple" | "complex",
  answerMode: AnswerMode
): AnswerPolicy {
  if (complexity === "simple") {
    if (answerMode === "standard") {
      return SIMPLE_STANDARD_POLICY;
    } else {
      return SIMPLE_DEEP_POLICY;
    }
  } else {
    if (answerMode === "standard") {
      return COMPLEX_STANDARD_POLICY;
    } else {
      return COMPLEX_DEEP_POLICY;
    }
  }
}

/**
 * SIMPLE + STANDARD
 * - Target: 450-750 chars
 * - Hard cap: 950 chars
 * - Structure: 1 short paragraph + up to 3 bullets (only if helpful)
 * - Max output tokens: 220
 */
const SIMPLE_STANDARD_POLICY: AnswerPolicy = {
  policyName: "simple_standard",
  charTargetMin: 450,
  charTargetMax: 750,
  charCap: 950,
  maxOutputTokens: 220,
  structure: {
    maxBullets: 3,
    maxBulletLength: 120,
    sections: [],
    requireSources: false,
    requireKeyPoints: false,
  },
};

/**
 * SIMPLE + DEEP
 * - Target: 900-1400 chars
 * - Hard cap: 1700 chars
 * - Structure: short paragraph + 4-6 bullets
 * - Max output tokens: 420
 */
const SIMPLE_DEEP_POLICY: AnswerPolicy = {
  policyName: "simple_deep",
  charTargetMin: 900,
  charTargetMax: 1400,
  charCap: 1700,
  maxOutputTokens: 420,
  structure: {
    maxBullets: 6,
    maxBulletLength: 160,
    sections: [],
    requireSources: true,
    requireKeyPoints: false,
  },
};

/**
 * COMPLEX + STANDARD (MOST IMPORTANT)
 * - Target: 1100-1700 chars
 * - Hard cap: 1900 chars
 * - Structure MUST be:
 *   - 1-2 sentence direct answer (no preamble)
 *   - "Key points" bullets: max 6 bullets, each <= 160 chars
 *   - "Sources" line/list using existing citation format
 * - Forbidden: multiple sections beyond "Key points" and "Sources", long narrative
 * - Max output tokens: 520
 */
const COMPLEX_STANDARD_POLICY: AnswerPolicy = {
  policyName: "complex_standard",
  charTargetMin: 1100,
  charTargetMax: 1700,
  charCap: 1900,
  maxOutputTokens: 520,
  structure: {
    maxBullets: 6,
    maxBulletLength: 160,
    sections: ["Key points", "Sources"],
    forbiddenSections: ["At a glance", "How this works", "Timeline", "What's next", "Details from recent meetings", "Key numbers"],
    requireSources: true,
    requireKeyPoints: true,
  },
};

/**
 * COMPLEX + DEEP
 * - Target: 3200-4800 chars
 * - Hard cap: 5400 chars
 * - Allow richer structure (At a glance / Key numbers / Timeline / What's next / Sources)
 * - Max output tokens: 1300
 */
const COMPLEX_DEEP_POLICY: AnswerPolicy = {
  policyName: "complex_deep",
  charTargetMin: 3200,
  charTargetMax: 4800,
  charCap: 5400,
  maxOutputTokens: 1300,
  structure: {
    maxBullets: 12,
    maxBulletLength: 200,
    sections: ["At a glance", "Key numbers", "Timeline", "What's next", "Sources"],
    requireSources: true,
    requireKeyPoints: false,
  },
};

/**
 * Get a prompt instruction string describing the length and structure constraints.
 * This is used in LLM system prompts.
 */
export function getPolicyPromptInstructions(policy: AnswerPolicy): string {
  const { charTargetMin, charTargetMax, charCap, structure } = policy;
  
  if (policy.policyName === "complex_standard") {
    return `
LENGTH AND STRUCTURE REQUIREMENTS (MANDATORY):
- Total answer length: ${charTargetMin}-${charTargetMax} characters (HARD LIMIT: ${charCap} chars)
- Start with 1-2 sentences directly answering the question (no preamble, no "Let me explain...")
- Then a "**Key points**" section with max ${structure.maxBullets} bullets
- Each bullet must be <= ${structure.maxBulletLength} characters
- End with "**Sources**" listing document names

FORBIDDEN in this format:
- Multiple narrative sections
- "At a glance", "How this works", "Timeline", "What's next" sections
- Background explainers unless absolutely needed for correctness
- Preambles like "Based on the documents..." or "Here's what I found..."`;
  }
  
  if (policy.policyName === "complex_deep") {
    return `
LENGTH REQUIREMENTS:
- Total answer length: ${charTargetMin}-${charTargetMax} characters (HARD LIMIT: ${charCap} chars)

STRUCTURE:
Use these sections as appropriate:
- **At a glance** - 3-5 bullet summary
- **Key numbers** - Quantitative details
- **Timeline** - Chronological events if relevant
- **Details** - Supporting information
- **What's next** - Future steps or considerations
- **Sources** - Document citations

Each bullet should be clear and substantive (max ${structure.maxBulletLength} chars).`;
  }
  
  if (policy.policyName === "simple_standard") {
    return `
LENGTH REQUIREMENTS:
- Total answer length: ${charTargetMin}-${charTargetMax} characters (HARD LIMIT: ${charCap} chars)
- Write 1 short paragraph answering the question directly
- Add up to ${structure.maxBullets} brief bullets ONLY if they add useful specific information
- Do NOT include section headers
- Keep it concise and actionable`;
  }
  
  if (policy.policyName === "simple_deep") {
    return `
LENGTH REQUIREMENTS:
- Total answer length: ${charTargetMin}-${charTargetMax} characters (HARD LIMIT: ${charCap} chars)
- Write 1-2 paragraphs with a clear answer
- Add ${structure.maxBullets} bullets with specific details and citations
- Reference document sources in the text
- Be thorough but stay within the character limit`;
  }
  
  return `Target length: ${charTargetMin}-${charTargetMax} characters. Hard limit: ${charCap} characters.`;
}

/**
 * Check if an answer exceeds the hard cap by more than the tolerance percentage.
 * Used to determine if a rewrite pass is needed.
 */
export function exceedsCap(
  text: string, 
  policy: AnswerPolicy, 
  tolerancePercent: number = 5
): boolean {
  const tolerance = policy.charCap * (tolerancePercent / 100);
  return text.length > policy.charCap + tolerance;
}

/**
 * Check if an answer is within the target range.
 */
export function isWithinTarget(text: string, policy: AnswerPolicy): boolean {
  return text.length >= policy.charTargetMin && text.length <= policy.charTargetMax;
}

/**
 * Build a rewrite-to-fit prompt for answers that exceed the cap.
 */
export function buildRewritePrompt(
  originalAnswer: string,
  policy: AnswerPolicy
): string {
  return `Rewrite the following answer to be under ${policy.charCap} characters while:
1. Preserving all factual claims and citations
2. Keeping the required structure (${policy.structure.sections.join(", ") || "direct answer + bullets"})
3. Maintaining accuracy and completeness
4. Prioritizing the most important information

Current length: ${originalAnswer.length} characters
Target length: ${policy.charTargetMin}-${policy.charTargetMax} characters
Maximum allowed: ${policy.charCap} characters

Original answer:
${originalAnswer}

Rewritten answer:`;
}

/**
 * FORBIDDEN SUBSTRINGS
 * Answers must never contain these mode/premium mentions.
 */
export const FORBIDDEN_SUBSTRINGS = [
  "deep",
  "standard",
  "mode",
  "toggle",
  "premium",
  "upgrade",
  "shortened",
  "truncated",
] as const;

/**
 * Check if answer contains any forbidden substrings.
 */
export function containsForbiddenSubstrings(text: string): string[] {
  const lowerText = text.toLowerCase();
  return FORBIDDEN_SUBSTRINGS.filter(s => lowerText.includes(s));
}
