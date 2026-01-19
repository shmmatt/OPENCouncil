/**
 * V3 Planner - Stage 1 of the Chat v3 Pipeline
 * 
 * Responsibilities:
 * 1. Extract IssueMap from user message + session sources
 * 2. Generate multi-query retrieval plan per lane
 * 3. Validate entities against source text (no hallucinated entities)
 * 4. Apply query budget constraints
 */

import { GoogleGenAI } from "@google/genai";
import { getModelForStage } from "../llm/modelRegistry";
import { logLlmRequest, logLlmResponse, logLlmError } from "../utils/llmLogging";
import { logLLMCall, extractTokenCounts } from "../llm/callLLMWithLogging";
import { isQuotaError, GeminiQuotaExceededError } from "../utils/geminiErrors";
import { logDebug } from "../utils/logger";
import { chatConfigV3 } from "./chatConfigV3";
import type { 
  IssueMap, 
  RetrievalPlanV3, 
  PlannerOutput, 
  LanePlan,
  PipelineLogContext 
} from "./types";
import type { SessionSource, SituationContext } from "@shared/schema";

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY || "" });

const PLANNER_SYSTEM_PROMPT = `You are the planning agent for OpenCouncil's civic research assistant.

Your job is to analyze a user's question (and any pasted article/document) to produce:
1. An IssueMap - structured extraction of entities, topics, and intent
2. A RetrievalPlan - specific queries for local and state document lanes

CRITICAL RULES:
- Only include entities that APPEAR in the provided text (user message or session source)
- Do NOT guess or infer RSA numbers - leave legalTopics as descriptions
- Be conservative with plannerConfidence if question is ambiguous

Return JSON matching this exact schema:
{
  "issueMap": {
    "town": "string or null",
    "situationTitle": "brief title for the situation",
    "entities": ["entity names from text only"],
    "actions": ["action verbs/topics mentioned"],
    "legalTopics": ["legal concepts mentioned - NOT RSA numbers"],
    "boards": ["boards mentioned"],
    "timeHints": ["dates, years, time references"],
    "requestedOutput": "explain|steps|cite_laws|risk|process",
    "legalSalience": 0.0-1.0,
    "plannerConfidence": 0.0-1.0
  },
  "retrievalPlan": {
    "local": {
      "queries": ["query strings for local lane"],
      "k": 12,
      "cap": 10
    },
    "state": {
      "queries": ["query strings for state lane"],
      "k": 8,
      "cap": 5
    },
    "mustInclude": {
      "minState": 0-4,
      "minLocalFacts": 0-4
    },
    "priority": "law-first|facts-first|process-first",
    "reason": "brief explanation of plan"
  }
}

Legal salience indicators (high = 0.7+):
- liability, negligence, illegal, lawsuit, ADA, compliance
- RSA, statute, code, regulation, immunity
- damages, enforcement, penalty, violation

Query guidelines:
- Local queries: town-specific, board actions, meeting decisions, votes
- State queries: NH law, RSA topics, NHMA guidance, municipal procedures
- Max 6 queries per lane
- Make queries specific and grounded in the actual question`;

interface PlannerV3Options {
  userMessage: string;
  sessionSources?: SessionSource[];
  situationContext?: SituationContext | null;
  townHint?: string;
  logContext?: PipelineLogContext;
}

export async function runPlannerV3(options: PlannerV3Options): Promise<PlannerOutput> {
  const { userMessage, sessionSources, situationContext, townHint, logContext } = options;
  const { model: modelName } = getModelForStage('retrievalPlanner');

  const sessionSourceText = sessionSources?.length 
    ? sessionSources.slice(0, 2).map(s => 
        `=== ${s.type.toUpperCase()}: ${s.title || 'User-provided text'} ===\n${s.text.slice(0, 10000)}`
      ).join('\n\n')
    : '';

  const situationHint = situationContext 
    ? `Current situation: "${situationContext.title}" with entities: ${situationContext.entities.slice(0, 5).join(', ')}`
    : '';

  const userPrompt = `Analyze this question and create a retrieval plan:

USER QUESTION: "${userMessage}"

${sessionSourceText ? `USER-PROVIDED DOCUMENT:\n${sessionSourceText}\n` : ''}
${situationHint ? `${situationHint}\n` : ''}
${townHint ? `Town hint: ${townHint}` : 'No specific town mentioned'}

Return valid JSON only.`;

  logLlmRequest({
    requestId: logContext?.requestId,
    sessionId: logContext?.sessionId,
    stage: "plannerV3",
    model: modelName,
    systemPrompt: PLANNER_SYSTEM_PROMPT.slice(0, 500),
    userPrompt: userPrompt.slice(0, 500),
    temperature: 0.2,
  });

  const startTime = Date.now();

  try {
    const response = await ai.models.generateContent({
      model: modelName,
      contents: [{ role: "user", parts: [{ text: userPrompt }] }],
      config: {
        systemInstruction: PLANNER_SYSTEM_PROMPT,
        temperature: 0.2,
      },
    });

    const responseText = response.text || "";
    const durationMs = Date.now() - startTime;

    logLlmResponse({
      requestId: logContext?.requestId,
      sessionId: logContext?.sessionId,
      stage: "plannerV3",
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
          stage: "plannerV3" as any,
          model: modelName,
        },
        { text: responseText, tokensIn: tokens.tokensIn, tokensOut: tokens.tokensOut }
      );
    }

    const cleanedText = responseText
      .replace(/```json\n?/g, "")
      .replace(/```\n?/g, "")
      .trim();

    const parsed = parseAndValidatePlannerOutput(cleanedText, userMessage, sessionSourceText, logContext);
    return parsed;

  } catch (error) {
    if (isQuotaError(error)) {
      const errMessage = error instanceof Error ? error.message : String(error);
      logLlmError({
        requestId: logContext?.requestId,
        sessionId: logContext?.sessionId,
        stage: "plannerV3",
        model: modelName,
        error: error instanceof Error ? error : new Error(String(error)),
      });
      throw new GeminiQuotaExceededError(errMessage || "Gemini quota exceeded in plannerV3");
    }

    logLlmError({
      requestId: logContext?.requestId,
      sessionId: logContext?.sessionId,
      stage: "plannerV3",
      model: modelName,
      error: error instanceof Error ? error : new Error(String(error)),
    });

    return getFallbackPlannerOutput(userMessage, townHint);
  }
}

function parseAndValidatePlannerOutput(
  jsonText: string,
  userMessage: string,
  sessionSourceText: string,
  logContext?: PipelineLogContext
): PlannerOutput {
  const validationWarnings: string[] = [];
  const combinedSourceText = (userMessage + ' ' + sessionSourceText).toLowerCase();

  try {
    const parsed = JSON.parse(jsonText);
    
    let issueMap: IssueMap = {
      town: parsed.issueMap?.town || undefined,
      situationTitle: parsed.issueMap?.situationTitle || extractDefaultTitle(userMessage),
      entities: [],
      actions: Array.isArray(parsed.issueMap?.actions) ? parsed.issueMap.actions.slice(0, 8) : [],
      legalTopics: Array.isArray(parsed.issueMap?.legalTopics) ? parsed.issueMap.legalTopics.slice(0, 8) : [],
      boards: Array.isArray(parsed.issueMap?.boards) ? parsed.issueMap.boards.slice(0, 5) : [],
      timeHints: Array.isArray(parsed.issueMap?.timeHints) ? parsed.issueMap.timeHints.slice(0, 5) : [],
      requestedOutput: validateRequestedOutput(parsed.issueMap?.requestedOutput),
      legalSalience: clamp(parsed.issueMap?.legalSalience ?? computeLegalSalience(userMessage), 0, 1),
      plannerConfidence: clamp(parsed.issueMap?.plannerConfidence ?? 0.5, 0, 1),
    };

    if (Array.isArray(parsed.issueMap?.entities)) {
      for (const entity of parsed.issueMap.entities) {
        if (typeof entity === 'string' && combinedSourceText.includes(entity.toLowerCase())) {
          issueMap.entities.push(entity);
        } else if (typeof entity === 'string') {
          validationWarnings.push(`Dropped hallucinated entity: ${entity}`);
        }
      }
    }

    if (issueMap.entities.length === 0) {
      issueMap.entities = extractEntitiesHeuristic(userMessage);
    }

    const rawLocal = parsed.retrievalPlan?.local;
    const rawState = parsed.retrievalPlan?.state;

    const localPlan: LanePlan = {
      queries: validateAndCapQueries(rawLocal?.queries, chatConfigV3.MAX_QUERIES_PER_LANE, 'local'),
      k: rawLocal?.k ?? chatConfigV3.DEFAULT_LOCAL_K,
      cap: rawLocal?.cap ?? chatConfigV3.DEFAULT_LOCAL_CAP,
    };

    const statePlan: LanePlan = {
      queries: validateAndCapQueries(rawState?.queries, chatConfigV3.MAX_QUERIES_PER_LANE, 'state'),
      k: rawState?.k ?? chatConfigV3.DEFAULT_STATE_K,
      cap: rawState?.cap ?? chatConfigV3.DEFAULT_STATE_CAP,
    };

    if (localPlan.queries.length === 0) {
      localPlan.queries = [buildDefaultLocalQuery(userMessage, issueMap)];
    }
    if (statePlan.queries.length === 0) {
      statePlan.queries = [buildDefaultStateQuery(userMessage, issueMap)];
    }

    const minStateFromSalience = issueMap.legalSalience >= 0.5 ? 3 : 1;

    const retrievalPlan: RetrievalPlanV3 = {
      local: localPlan,
      state: statePlan,
      mustInclude: {
        minState: parsed.retrievalPlan?.mustInclude?.minState ?? minStateFromSalience,
        minLocalFacts: parsed.retrievalPlan?.mustInclude?.minLocalFacts ?? 2,
      },
      priority: validatePriority(parsed.retrievalPlan?.priority, issueMap.legalSalience),
      reason: parsed.retrievalPlan?.reason || 'Planner-generated plan',
    };

    if (issueMap.plannerConfidence < chatConfigV3.LOW_CONFIDENCE_THRESHOLD) {
      validationWarnings.push('Low planner confidence - using conservative retrieval');
      localPlan.queries = localPlan.queries.slice(0, 2);
      statePlan.queries = statePlan.queries.slice(0, 2);
    }

    logDebug("planner_v3_validated", {
      requestId: logContext?.requestId,
      sessionId: logContext?.sessionId,
      stage: "plannerV3",
      entityCount: issueMap.entities.length,
      localQueryCount: localPlan.queries.length,
      stateQueryCount: statePlan.queries.length,
      legalSalience: issueMap.legalSalience,
      plannerConfidence: issueMap.plannerConfidence,
      warningCount: validationWarnings.length,
    });

    return {
      issueMap,
      retrievalPlan,
      validationWarnings,
    };

  } catch (parseError) {
    validationWarnings.push(`JSON parse failed: ${parseError}`);
    return getFallbackPlannerOutput(userMessage);
  }
}

function getFallbackPlannerOutput(userMessage: string, townHint?: string): PlannerOutput {
  const issueMap: IssueMap = {
    town: townHint,
    situationTitle: extractDefaultTitle(userMessage),
    entities: extractEntitiesHeuristic(userMessage),
    actions: [],
    legalTopics: extractLegalTopicsHeuristic(userMessage),
    boards: extractBoardsHeuristic(userMessage),
    timeHints: [],
    requestedOutput: "explain",
    legalSalience: computeLegalSalience(userMessage),
    plannerConfidence: 0.3,
  };

  const retrievalPlan: RetrievalPlanV3 = {
    local: {
      queries: [buildDefaultLocalQuery(userMessage, issueMap)],
      k: chatConfigV3.DEFAULT_LOCAL_K,
      cap: chatConfigV3.DEFAULT_LOCAL_CAP,
    },
    state: {
      queries: [buildDefaultStateQuery(userMessage, issueMap)],
      k: chatConfigV3.DEFAULT_STATE_K,
      cap: chatConfigV3.DEFAULT_STATE_CAP,
    },
    mustInclude: {
      minState: issueMap.legalSalience >= 0.5 ? 3 : 1,
      minLocalFacts: 2,
    },
    priority: issueMap.legalSalience >= 0.6 ? "law-first" : "facts-first",
    reason: "Fallback plan due to planner error",
  };

  return {
    issueMap,
    retrievalPlan,
    validationWarnings: ["Using fallback planner output"],
  };
}

function validateAndCapQueries(queries: unknown, maxQueries: number, lane: string): string[] {
  if (!Array.isArray(queries)) return [];
  
  const validQueries = queries
    .filter((q): q is string => typeof q === 'string' && q.trim().length > 5)
    .slice(0, maxQueries);
  
  return validQueries;
}

function validateRequestedOutput(output: unknown): IssueMap['requestedOutput'] {
  const valid = ["explain", "steps", "cite_laws", "risk", "process"];
  if (typeof output === 'string' && valid.includes(output)) {
    return output as IssueMap['requestedOutput'];
  }
  return "explain";
}

function validatePriority(priority: unknown, legalSalience: number): RetrievalPlanV3['priority'] {
  const valid = ["law-first", "facts-first", "process-first"];
  if (typeof priority === 'string' && valid.includes(priority)) {
    return priority as RetrievalPlanV3['priority'];
  }
  return legalSalience >= 0.6 ? "law-first" : "facts-first";
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function extractDefaultTitle(text: string): string {
  const firstSentence = text.split(/[.!?]/)[0]?.trim() || text.slice(0, 60);
  return firstSentence.slice(0, 80);
}

function extractEntitiesHeuristic(text: string): string[] {
  const entities: string[] = [];
  const properNounPattern = /\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)\s+(?:Park|Property|Building|Road|Street|Avenue|Lane|Drive|School|Library|Center|Hall)\b/g;
  let match;
  while ((match = properNounPattern.exec(text)) !== null) {
    entities.push(match[0]);
  }
  return entities.slice(0, 5);
}

function extractLegalTopicsHeuristic(text: string): string[] {
  const topics: string[] = [];
  const lowerText = text.toLowerCase();
  
  const legalKeywords = [
    'liability', 'negligence', 'compliance', 'violation', 'enforcement',
    'ada', 'accessibility', 'permit', 'zoning', 'variance', 'building code',
    'immunity', 'damages', 'lawsuit', 'legal', 'illegal', 'ordinance'
  ];
  
  for (const keyword of legalKeywords) {
    if (lowerText.includes(keyword)) {
      topics.push(keyword);
    }
  }
  
  return topics.slice(0, 6);
}

function extractBoardsHeuristic(text: string): string[] {
  const boards: string[] = [];
  const lowerText = text.toLowerCase();
  
  const boardPatterns = [
    'select board', 'selectboard', 'planning board', 'zba', 'zoning board',
    'conservation commission', 'budget committee', 'school board'
  ];
  
  for (const board of boardPatterns) {
    if (lowerText.includes(board)) {
      boards.push(board);
    }
  }
  
  return boards;
}

function computeLegalSalience(text: string): number {
  const lowerText = text.toLowerCase();
  const highSalienceTerms = [
    'liability', 'negligence', 'illegal', 'lawsuit', 'ada', 'compliance',
    'rsa', 'statute', 'damages', 'immunity', 'violation', 'enforcement',
    'penalty', 'sue', 'legal action', 'attorney', 'building code'
  ];
  
  let count = 0;
  for (const term of highSalienceTerms) {
    if (lowerText.includes(term)) count++;
  }
  
  if (count >= 4) return 0.9;
  if (count >= 2) return 0.7;
  if (count >= 1) return 0.5;
  return 0.2;
}

function buildDefaultLocalQuery(userMessage: string, issueMap: IssueMap): string {
  const parts: string[] = [];
  
  if (issueMap.town) parts.push(issueMap.town);
  if (issueMap.entities.length > 0) parts.push(issueMap.entities[0]);
  if (issueMap.boards.length > 0) parts.push(issueMap.boards[0]);
  
  const questionCore = userMessage.slice(0, 100).replace(/[?.,!]/g, '').trim();
  parts.push(questionCore);
  
  return parts.join(' ').slice(0, 200);
}

function buildDefaultStateQuery(userMessage: string, issueMap: IssueMap): string {
  const parts: string[] = ['New Hampshire'];
  
  if (issueMap.legalTopics.length > 0) {
    parts.push(...issueMap.legalTopics.slice(0, 2));
  }
  
  if (issueMap.legalSalience >= 0.5) {
    parts.push('RSA municipal law');
  }
  
  const actionWord = issueMap.actions[0] || '';
  if (actionWord) parts.push(actionWord);
  
  return parts.join(' ').slice(0, 200);
}
