/**
 * Utility functions for the chat v2 pipeline.
 * Includes router bypass detection and history trimming.
 */

import type { ChatHistoryMessage, RouterOutput, RetrievalPlan } from "./types";
import type { ActorContext } from "../auth/types";
import type { ActorIdentifier } from "@shared/schema";
import { chatConfig } from "./chatConfig";
import { storage } from "../storage";

/**
 * Determines if the router should be bypassed for a trivial follow-up question.
 * 
 * Heuristics:
 * - Question is short (< 120 chars by default)
 * - There is at least one previous assistant message
 * - Question starts with common follow-up patterns
 */
export function shouldBypassRouterForFollowup(
  sessionHistory: ChatHistoryMessage[],
  newUserQuestion: string
): boolean {
  const hasAssistantMessage = sessionHistory.some((m) => m.role === "assistant");
  if (!hasAssistantMessage) {
    return false;
  }

  if (newUserQuestion.length > chatConfig.ROUTER_BYPASS_MAX_QUESTION_LENGTH) {
    return false;
  }

  const lowerQuestion = newUserQuestion.toLowerCase().trim();
  
  return chatConfig.ROUTER_BYPASS_PATTERNS.some((pattern) =>
    lowerQuestion.startsWith(pattern.toLowerCase())
  );
}

/**
 * Build a trimmed prompt for the router.
 * Includes only the new question and minimal context from the last turn.
 */
export function buildTrimmedRouterContext(
  sessionHistory: ChatHistoryMessage[],
  newUserQuestion: string
): string {
  const maxTurns = chatConfig.MAX_HISTORY_TURNS_FOR_ROUTER;
  const recentMessages = sessionHistory.slice(-maxTurns * 2);

  if (recentMessages.length === 0) {
    return newUserQuestion;
  }

  const lastAssistant = recentMessages
    .filter((m) => m.role === "assistant")
    .slice(-1)[0];

  const lastUser = recentMessages
    .filter((m) => m.role === "user")
    .slice(-1)[0];

  let context = "";

  if (lastUser) {
    context += `Previous question: "${lastUser.content.slice(0, 200)}${lastUser.content.length > 200 ? "..." : ""}"\n`;
  }

  if (lastAssistant) {
    const summaryLength = 300;
    context += `Previous answer summary: "${lastAssistant.content.slice(0, summaryLength)}${lastAssistant.content.length > summaryLength ? "..." : ""}"\n`;
  }

  return context + `\nNew question: ${newUserQuestion}`;
}

/**
 * Build trimmed history for answer generation.
 * Limits to recent turns for reduced token usage.
 */
export function buildTrimmedHistoryForAnswer(
  sessionHistory: ChatHistoryMessage[]
): ChatHistoryMessage[] {
  const maxTurns = chatConfig.MAX_HISTORY_TURNS_FOR_ANSWER;
  return sessionHistory.slice(-maxTurns * 2);
}

/**
 * Extract a topic tag from recent history for context.
 * Returns a short descriptive note about the conversation topic.
 */
export function extractTopicTag(
  sessionHistory: ChatHistoryMessage[]
): string | undefined {
  if (sessionHistory.length === 0) {
    return undefined;
  }

  const lastUserMessage = sessionHistory
    .filter((m) => m.role === "user")
    .slice(-1)[0];

  if (!lastUserMessage) {
    return undefined;
  }

  const content = lastUserMessage.content.toLowerCase();

  const townMatch = content.match(
    /\b(ossipee|conway|north conway|jackson|tamworth|bartlett|madison|albany|chatham|sandwich|effingham|freedom|moultonborough)\b/i
  );
  const topicMatch = content.match(
    /\b(lot merger|zoning|variance|subdivision|planning board|zba|selectmen|budget|warrant|rsa \d+[:\-]\d+[a-z\-]*|building permit|setback|wetlands)\b/i
  );

  if (townMatch && topicMatch) {
    return `(Discussing ${townMatch[0]} ${topicMatch[0]})`;
  }

  if (topicMatch) {
    return `(Topic: ${topicMatch[0]})`;
  }

  if (townMatch) {
    return `(Town: ${townMatch[0]})`;
  }

  return undefined;
}

/**
 * Create a default RouterOutput for when bypassing the router.
 * Uses previous domains if available, or sensible defaults.
 */
export function createBypassedRouterOutput(
  sessionHistory: ChatHistoryMessage[],
  previousDomains?: string[]
): RouterOutput {
  const domains = previousDomains?.length 
    ? previousDomains 
    : ["zoning", "ordinance", "planning_board_docs"];

  return {
    complexity: "simple",
    domains,
    requiresClarification: false,
    clarificationQuestions: [],
    rerankedQuestion: "",
    scopeHint: null,
    requiresComposedAnswer: false,
  };
}

/**
 * Merge multiple retrieval info needs into a single comprehensive query.
 * Used for single-pass retrieval optimization.
 */
export function buildMergedRetrievalQuery(
  question: string,
  plan: RetrievalPlan
): string {
  const infoNeedsStr = plan.infoNeeds.length > 0
    ? `\nKey information needed:\n${plan.infoNeeds.map((need, i) => `${i + 1}. ${need}`).join("\n")}`
    : "";

  const categoryStr = plan.filters.categories.length > 0
    ? plan.filters.categories.join(", ")
    : "all relevant";

  const townContext = plan.filters.townPreference
    ? `Focus on ${plan.filters.townPreference} documents when available.`
    : "Include statewide guidance and local examples.";

  const rsaContext = plan.filters.rsaChapters?.length > 0
    ? `\nRelevant RSA chapters: ${plan.filters.rsaChapters.join(", ")}`
    : "";

  const recencyContext = plan.preferRecent
    ? `\nIMPORTANT: Prioritize the MOST RECENT documents, especially recent meeting minutes (from the last 6-12 months) and current-year budget documents. Focus on what is happening "currently" or "now", not historical information.`
    : "";

  return `Question: ${question}

Context: New Hampshire municipal governance documents
Document categories: ${categoryStr}
${townContext}${rsaContext}${recencyContext}${infoNeedsStr}

Search for comprehensive information including:
- Applicable state law and RSA requirements
- Local ordinances and regulations
- Best practices and NHMA guidance
- Relevant examples or precedents if available

Provide detailed, relevant excerpts with specific section references.`;
}

/**
 * Resolve the effective town preference for a chat request.
 * Priority order:
 * 1. Explicit town from request metadata
 * 2. Session townPreference 
 * 3. Actor defaultTown (user or anonymous)
 * 4. Fallback to "Ossipee"
 */
export async function resolveTownPreference(options: {
  explicitTown?: string;
  sessionId?: string;
  actor?: ActorContext;
}): Promise<string> {
  const { explicitTown, sessionId, actor } = options;

  // 1. Explicit town from request metadata takes precedence
  if (explicitTown) {
    return explicitTown;
  }

  // 2. Check session town preference
  if (sessionId) {
    const sessionTown = await storage.getSessionTownPreference(sessionId);
    if (sessionTown) {
      return sessionTown;
    }
  }

  // 3. Check actor default town
  if (actor) {
    const actorIdentifier: ActorIdentifier = actor.actorType === 'user' && actor.userId
      ? { type: 'user', userId: actor.userId }
      : actor.anonId
        ? { type: 'anon', anonId: actor.anonId }
        : { type: 'anon' };

    if (actorIdentifier.userId || actorIdentifier.anonId) {
      const actorTown = await storage.getActorDefaultTown(actorIdentifier);
      if (actorTown) {
        return actorTown;
      }
    }
  }

  // 4. Fallback to Ossipee
  return "Ossipee";
}
