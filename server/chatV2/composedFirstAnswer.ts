/**
 * Composed First Answer Pattern
 * 
 * Implements intent detection and synthesis prompt augmentation for questions
 * that benefit from a structured, complete first response (causal, mechanism,
 * breakdown, interpretation questions).
 */

import type { RouterOutput, ScopeHint } from "./types";
import { logDebug } from "../utils/logger";

/**
 * Question intent types that benefit from composed first answer
 */
export type ComposedAnswerIntent = 
  | "causal"         // Why did X change/increase/decrease
  | "mechanism"      // How is X calculated/determined
  | "breakdown"      // What goes into X / components of X
  | "interpretation" // Explain this document/data
  | "none";          // Standard question, no special handling

/**
 * Result of composed answer detection
 */
export interface ComposedAnswerFlags {
  requiresComposedFirstAnswer: boolean;
  hasUserArtifact: boolean;
  detectedIntent: ComposedAnswerIntent;
}

const CAUSAL_PATTERNS = [
  /\bwhy\s+(?:did|has|have|is|was|were|are)\b/i,
  /\bwhy\s+(?:the|my|our)\b/i,
  /\bwhat\s+(?:caused|led\s+to|explains?)\b/i,
  /\b(?:increase|decrease|change|go\s+up|go\s+down|rise|drop|jump|spike)\b.*\?/i,
  /\breason\s+(?:for|why|behind)\b/i,
];

const MECHANISM_PATTERNS = [
  /\bhow\s+(?:is|are|does|do)\b.*\b(?:calculated|determined|computed|set|established|figured)\b/i,
  /\bhow\s+(?:is|are)\b.*\b(?:rate|tax|fee|assessment|value)\b/i,
  /\bwhat\s+(?:is|are)\s+the\s+(?:formula|calculation|method|process)\b/i,
  /\bhow\s+(?:do|does)\b.*\bwork\b/i,
];

const BREAKDOWN_PATTERNS = [
  /\bwhat\s+(?:goes\s+into|makes\s+up|comprises?|consists?\s+of)\b/i,
  /\bbreak\s*down\b/i,
  /\bcomponents?\s+of\b/i,
  /\bparts?\s+of\b/i,
  /\bcomposition\s+of\b/i,
  /\bwhat\s+(?:is|are)\s+(?:the\s+)?(?:different\s+)?(?:parts?|pieces?|elements?|portions?)\b/i,
  /\bpercentage\s+(?:breakdown|composition|split)\b/i,
];

const INTERPRETATION_PATTERNS = [
  /\bexplain\s+(?:this|the|my|what)\b/i,
  /\bwhat\s+does\s+(?:this|it)\s+mean\b/i,
  /\binterpret\b/i,
  /\bunderstand\b.*\b(?:this|document|bill|statement|report)\b/i,
  /\bhelp\s+(?:me\s+)?(?:understand|read|interpret)\b/i,
  /\bcan\s+you\s+(?:explain|read|analyze)\b/i,
];

/**
 * Detect if a question requires a composed first answer based on intent patterns
 */
export function detectComposedAnswerIntent(
  question: string,
  routerOutput?: RouterOutput
): ComposedAnswerIntent {
  const normalizedQuestion = question.toLowerCase().trim();
  
  if (INTERPRETATION_PATTERNS.some(p => p.test(question))) {
    return "interpretation";
  }
  
  if (CAUSAL_PATTERNS.some(p => p.test(question))) {
    return "causal";
  }
  
  if (MECHANISM_PATTERNS.some(p => p.test(question))) {
    return "mechanism";
  }
  
  if (BREAKDOWN_PATTERNS.some(p => p.test(question))) {
    return "breakdown";
  }
  
  if (routerOutput?.complexity === "complex") {
    if (normalizedQuestion.includes("why")) {
      return "causal";
    }
    if (normalizedQuestion.includes("how") && 
        (normalizedQuestion.includes("work") || 
         normalizedQuestion.includes("calculate") || 
         normalizedQuestion.includes("determin"))) {
      return "mechanism";
    }
  }
  
  return "none";
}

/**
 * Compute all composed answer flags for a request
 */
export function computeComposedAnswerFlags(
  question: string,
  hasAttachment: boolean,
  routerOutput?: RouterOutput,
  logContext?: { requestId?: string; sessionId?: string }
): ComposedAnswerFlags {
  const detectedIntent = detectComposedAnswerIntent(question, routerOutput);
  const hasUserArtifact = hasAttachment;
  
  const requiresComposedFirstAnswer = 
    detectedIntent !== "none" || 
    hasUserArtifact;
  
  if (logContext?.requestId) {
    logDebug("composed_answer_detection", {
      requestId: logContext.requestId,
      sessionId: logContext.sessionId,
      stage: "composedAnswerDetection",
      detectedIntent,
      hasUserArtifact,
      requiresComposedFirstAnswer,
    });
  }
  
  return {
    requiresComposedFirstAnswer,
    hasUserArtifact,
    detectedIntent,
  };
}

/**
 * Generate the composed first answer addendum for synthesis prompts.
 * This addendum is appended to existing system prompts when flags indicate
 * a structured first response is beneficial.
 */
export function getComposedAnswerAddendum(
  flags: ComposedAnswerFlags,
  townPreference?: string
): { addendum: string; applied: boolean } {
  if (!flags.requiresComposedFirstAnswer) {
    return { addendum: "", applied: false };
  }
  
  const intentGuidance = getIntentSpecificGuidance(flags.detectedIntent);
  const artifactAcknowledgment = flags.hasUserArtifact
    ? `\n   - If the user attached/uploaded a document, explicitly acknowledge it (e.g., "Looking at the document you provided...") without inventing details not in retrieved evidence.`
    : "";
  
  const addendum = `

---
COMPOSED FIRST ANSWER INSTRUCTIONS (applies to this question):

This question requires a complete, well-structured first response. Follow this order:

1. **Acknowledge the situation${flags.hasUserArtifact ? "/artifact" : ""}** (1-2 sentences)
   - Briefly frame what the user is asking about.${artifactAcknowledgment}

2. **Mechanism explainer** (brief, general)
   - Provide a short, plain-English explanation of how the thing works in general (process/mechanics/components), before diving into local details.
   - This section may use general New Hampshire context when appropriate, but must not claim town-specific facts without citations.
   ${intentGuidance}

3. **Local synthesis** (evidence-first)
   - Summarize what the retrieved municipal documents indicate about recent changes, decisions, budgets, timelines, or votes.
   - Cite documents when making ${townPreference ? `${townPreference}-specific` : "town-specific"} claims.

4. **Explicit uncertainty / missing facets**
   - If the retrieved evidence does not cover major facets implied by the question, explicitly say what is missing (e.g., "I don't yet have the final X document...").
   - Do NOT present a partial facet as the whole picture. Label it as partial.
   - Be honest about limitations without being overly apologetic.

5. **Bridge to follow-ups** (1-2 sentences)
   - End with 1-2 sentences that naturally tee up deeper follow-ups.
   - Follow-ups should add depth, not patch gaps in this answer.

Formatting: Keep the answer concise but structured. You may use short headings like "### At a glance" or "### How it works", but avoid excessive verbosity. Maintain a neutral civic tone.
---`;

  return { addendum, applied: true };
}

/**
 * Get intent-specific guidance for the mechanism explainer section
 */
function getIntentSpecificGuidance(intent: ComposedAnswerIntent): string {
  switch (intent) {
    case "causal":
      return "For 'why' questions: Explain the general factors that typically cause such changes before addressing specific local circumstances.";
    case "mechanism":
      return "For 'how' questions: Start with the general process or formula, then show how it applies locally with available data.";
    case "breakdown":
      return "For breakdown questions: List all major components/categories first, then detail what local data is available for each.";
    case "interpretation":
      return "For interpretation questions: Explain what the document type typically contains, then walk through the specific content.";
    default:
      return "";
  }
}

/**
 * Append the composed answer addendum to an existing system prompt
 */
export function augmentSystemPromptWithComposedAnswer(
  baseSystemPrompt: string,
  flags: ComposedAnswerFlags,
  townPreference?: string
): { prompt: string; composedAnswerApplied: boolean } {
  const { addendum, applied } = getComposedAnswerAddendum(flags, townPreference);
  
  if (!applied) {
    return { prompt: baseSystemPrompt, composedAnswerApplied: false };
  }
  
  return {
    prompt: baseSystemPrompt + addendum,
    composedAnswerApplied: true,
  };
}
