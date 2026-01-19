/**
 * Situation Extractor
 * 
 * Extracts situation context from user messages to maintain topic continuity.
 * This prevents the assistant from "drifting" to unrelated but high-signal documents.
 * 
 * Key features:
 * - Named entity extraction (projects, people, boards, locations)
 * - Event/situation detection (votes, meetings, controversies)
 * - Time range extraction
 * - Confidence scoring for situation updates
 */

import type { SituationContext } from "@shared/schema";
import { GoogleGenAI } from "@google/genai";
import { getModelForStage } from "../llm/modelRegistry";
import { logDebug, logError } from "../utils/logger";
import { chatConfig } from "./chatConfig";
import type { PipelineLogContext } from "./types";

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY || "" });

export interface SituationExtractionResult {
  shouldUpdate: boolean;
  newContext: SituationContext | null;
  confidence: number;
  reason: string;
}

const ENTITY_PATTERNS = {
  boards: [
    /\b(select\s*board|selectboard|planning\s*board|zba|zoning\s*board|conservation\s*commission|budget\s*committee|school\s*board)\b/gi,
  ],
  projects: [
    /\b(constitution\s*park|deer\s*run|boardwalk|ada\s*compliance|town\s*hall|library|fire\s*station|highway\s*department)\b/gi,
  ],
  events: [
    /\b(vote|voted|voting|meeting|hearing|warrant|article|motion|approved|denied|tabled)\b/gi,
  ],
  dates: [
    /\b(january|february|march|april|may|june|july|august|september|october|november|december)\s+\d{1,2},?\s*\d{4}\b/gi,
    /\b\d{1,2}\/\d{1,2}\/\d{2,4}\b/g,
    /\b\d{4}-\d{2}-\d{2}\b/g,
  ],
  legal: [
    /\b(rsa\s*\d+[-:]\w+|ada|americans?\s*with\s*disabilities|nh\s*law|statute)\b/gi,
  ],
};

function extractEntitiesHeuristic(text: string): string[] {
  const entities = new Set<string>();
  
  for (const [category, patterns] of Object.entries(ENTITY_PATTERNS)) {
    for (const pattern of patterns) {
      const matches = text.match(pattern);
      if (matches) {
        matches.forEach(m => {
          const normalized = m.trim().replace(/\s+/g, ' ');
          entities.add(normalized);
        });
      }
    }
  }
  
  return Array.from(entities);
}

function extractDatesHeuristic(text: string): { start?: string; end?: string } | undefined {
  const datePatterns = ENTITY_PATTERNS.dates;
  const dates: string[] = [];
  
  for (const pattern of datePatterns) {
    const matches = text.match(pattern);
    if (matches) {
      dates.push(...matches);
    }
  }
  
  if (dates.length === 0) return undefined;
  
  return {
    start: dates[0],
    end: dates.length > 1 ? dates[dates.length - 1] : undefined,
  };
}

function hasSignificantNewEntities(
  existingEntities: string[],
  newEntities: string[]
): boolean {
  const existingLower = new Set(existingEntities.map(e => e.toLowerCase()));
  const newUnique = newEntities.filter(e => !existingLower.has(e.toLowerCase()));
  return newUnique.length >= 2;
}

function detectEventMarker(text: string): boolean {
  const eventMarkers = [
    /\bvote\b/i,
    /\bmeeting\b/i,
    /\bhearing\b/i,
    /\bwarrant\b/i,
    /\bdecision\b/i,
    /\bcontroversy\b/i,
    /\bproject\b/i,
    /\bdispute\b/i,
    /\blawsuit\b/i,
    /\bcase\b/i,
    /\bissue\b/i,
  ];
  
  return eventMarkers.some(pattern => pattern.test(text));
}

function detectTopicBroadeningSignal(text: string): boolean {
  const broadeningSignals = [
    /\bhow\s+does\s+(this|it)\s+work\s+(statewide|in\s+nh|generally|across)\b/i,
    /\bwhat\s+about\s+other\s+towns?\b/i,
    /\bswitching\s+topics?\b/i,
    /\bdifferent\s+(topic|question|subject)\b/i,
    /\bgenerally\s+speaking\b/i,
    /\bin\s+general\b/i,
    /\bacross\s+(new\s+hampshire|nh|the\s+state)\b/i,
    /\bstatewide\b/i,
  ];
  
  return broadeningSignals.some(pattern => pattern.test(text));
}

export function extractSituationHeuristic(
  userMessage: string,
  existingContext: SituationContext | null,
  hasUserArtifact: boolean = false
): SituationExtractionResult {
  const newEntities = extractEntitiesHeuristic(userMessage);
  const timeRange = extractDatesHeuristic(userMessage);
  const hasEventMarker = detectEventMarker(userMessage);
  const isBroadening = detectTopicBroadeningSignal(userMessage);
  
  if (isBroadening) {
    return {
      shouldUpdate: true,
      newContext: null,
      confidence: 0.3,
      reason: "User explicitly broadening scope",
    };
  }
  
  if (!existingContext) {
    if (newEntities.length >= 2 || hasUserArtifact) {
      const title = generateSituationTitle(newEntities, userMessage);
      return {
        shouldUpdate: true,
        newContext: {
          title,
          entities: newEntities,
          timeRange,
          sourceRefs: hasUserArtifact ? ["user_artifact"] : undefined,
          lastUpdatedAt: new Date().toISOString(),
        },
        confidence: hasUserArtifact ? 0.9 : 0.7,
        reason: hasUserArtifact 
          ? "User provided artifact establishing new situation"
          : "Multiple entities detected, establishing new situation",
      };
    }
    
    return {
      shouldUpdate: false,
      newContext: null,
      confidence: 0.5,
      reason: "Not enough context to establish situation",
    };
  }
  
  if (hasSignificantNewEntities(existingContext.entities, newEntities) && hasEventMarker) {
    const combinedEntities = Array.from(new Set([...existingContext.entities, ...newEntities]));
    const title = generateSituationTitle(combinedEntities, userMessage);
    
    return {
      shouldUpdate: true,
      newContext: {
        title,
        entities: combinedEntities,
        timeRange: timeRange || existingContext.timeRange,
        sourceRefs: existingContext.sourceRefs,
        lastUpdatedAt: new Date().toISOString(),
      },
      confidence: 0.8,
      reason: "Significant new entities with event marker - updating situation",
    };
  }
  
  if (newEntities.length > 0) {
    const overlappingEntities = newEntities.filter(e => 
      existingContext.entities.some(existing => 
        existing.toLowerCase().includes(e.toLowerCase()) ||
        e.toLowerCase().includes(existing.toLowerCase())
      )
    );
    
    if (overlappingEntities.length > 0) {
      return {
        shouldUpdate: false,
        newContext: existingContext,
        confidence: 0.85,
        reason: "Message references existing situation entities - maintaining context",
      };
    }
  }
  
  return {
    shouldUpdate: false,
    newContext: existingContext,
    confidence: 0.7,
    reason: "Assuming continuation of current situation",
  };
}

function generateSituationTitle(entities: string[], message: string): string {
  const projectEntities = entities.filter(e => 
    /park|boardwalk|hall|station|library/i.test(e)
  );
  const boardEntities = entities.filter(e =>
    /board|commission|committee/i.test(e)
  );
  const eventEntities = entities.filter(e =>
    /vote|meeting|hearing|warrant/i.test(e)
  );
  
  const parts: string[] = [];
  
  if (projectEntities.length > 0) {
    parts.push(projectEntities[0]);
  }
  if (eventEntities.length > 0) {
    parts.push(eventEntities[0]);
  }
  if (boardEntities.length > 0 && parts.length < 2) {
    parts.push(boardEntities[0]);
  }
  
  if (parts.length === 0 && entities.length > 0) {
    parts.push(entities.slice(0, 2).join(' / '));
  }
  
  return parts.join(' - ') || "Current discussion";
}

export async function extractSituationWithLLM(
  userMessage: string,
  existingContext: SituationContext | null,
  hasUserArtifact: boolean,
  logContext?: PipelineLogContext
): Promise<SituationExtractionResult> {
  if (!chatConfig.ENABLE_LLM_SITUATION_EXTRACTION) {
    return extractSituationHeuristic(userMessage, existingContext, hasUserArtifact);
  }
  
  try {
    const { model } = getModelForStage('simpleAnswer');
    
    const systemPrompt = `You are a context extraction assistant. Analyze the user message and extract:
1. The main situation/topic being discussed (project, event, controversy)
2. Key named entities (people, places, boards, projects, dates)
3. Whether this continues the existing context or introduces a new topic

Respond in JSON format:
{
  "situation_title": "brief 3-10 word title",
  "entities": ["entity1", "entity2"],
  "is_new_topic": true/false,
  "confidence": 0.0-1.0,
  "reason": "brief explanation"
}`;

    const existingContextStr = existingContext 
      ? `\nExisting context: "${existingContext.title}" with entities: ${existingContext.entities.join(', ')}`
      : "\nNo existing context established.";

    const userPrompt = `${existingContextStr}

User message: "${userMessage}"
${hasUserArtifact ? "\n(User attached a document)" : ""}

Extract the situation context:`;

    const response = await ai.models.generateContent({
      model,
      contents: [{ role: "user", parts: [{ text: userPrompt }] }],
      config: {
        systemInstruction: systemPrompt,
        temperature: 0.1,
        maxOutputTokens: 500,
      },
    });

    const responseText = response.text || "";
    
    const jsonMatch = responseText.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      logDebug("situation_extraction_no_json", {
        requestId: logContext?.requestId,
        stage: "situation_extraction",
        responsePreview: responseText.slice(0, 200),
      });
      return extractSituationHeuristic(userMessage, existingContext, hasUserArtifact);
    }

    const parsed = JSON.parse(jsonMatch[0]);
    
    if (parsed.is_new_topic || !existingContext) {
      return {
        shouldUpdate: true,
        newContext: {
          title: parsed.situation_title || "Current discussion",
          entities: parsed.entities || [],
          lastUpdatedAt: new Date().toISOString(),
          sourceRefs: hasUserArtifact ? ["user_artifact"] : undefined,
        },
        confidence: parsed.confidence || 0.7,
        reason: parsed.reason || "LLM extracted new situation",
      };
    }

    return {
      shouldUpdate: false,
      newContext: existingContext,
      confidence: parsed.confidence || 0.8,
      reason: parsed.reason || "Continuing existing situation",
    };

  } catch (error) {
    logError("situation_extraction_error", {
      requestId: logContext?.requestId,
      stage: "situation_extraction",
      error: error instanceof Error ? error.message : String(error),
    });
    
    return extractSituationHeuristic(userMessage, existingContext, hasUserArtifact);
  }
}

export function computeSituationMatchScore(
  chunkContent: string,
  situationContext: SituationContext | null
): number {
  if (!situationContext || situationContext.entities.length === 0) {
    return 0;
  }
  
  const contentLower = chunkContent.toLowerCase();
  let matchCount = 0;
  let totalWeight = 0;
  
  for (const entity of situationContext.entities) {
    const entityLower = entity.toLowerCase();
    const entityWords = entityLower.split(/\s+/);
    
    if (contentLower.includes(entityLower)) {
      matchCount += 2;
    } else {
      const partialMatches = entityWords.filter(word => 
        word.length > 3 && contentLower.includes(word)
      ).length;
      matchCount += partialMatches * 0.5;
    }
    
    totalWeight += 2;
  }
  
  const titleWords = situationContext.title.toLowerCase().split(/\s+/);
  for (const word of titleWords) {
    if (word.length > 3 && contentLower.includes(word)) {
      matchCount += 0.5;
      totalWeight += 0.5;
    }
  }
  
  return totalWeight > 0 ? matchCount / totalWeight : 0;
}

/**
 * Determines if stored situation context should be applied to a new question.
 * This prevents "sticky context" where old topics (e.g., boardwalk vote) leak into
 * unrelated questions (e.g., budget committee rules).
 * 
 * Scoring:
 * +1 for each situation entity appearing in the question
 * +1 for key topic keyword overlap (ADA, boardwalk, etc.)
 * +1 for explicit references ("the article", "that vote", etc.)
 * -2 if question is clearly a different domain (budget, RSA 32, etc.)
 * 
 * Decision: useSituationContext = (score >= 2)
 */
export interface SituationRelevanceResult {
  useSituationContext: boolean;
  score: number;
  reason: string;
}

const DIFFERENT_DOMAIN_KEYWORDS = [
  'budget', 'appropriation', 'warrant article', 'rsa 32', 'budget committee', 
  'tax rate', 'default budget', 'overlay', 'encumbrance', 'fund balance',
  'school budget', 'municipal budget', 'sewer budget', 'water budget',
  'deliberative session', 'town meeting', 'sb2', 'official ballot',
  'zoning amendment', 'zoning variance', 'special exception',
  'wetlands', 'shoreland', 'subdivision', 'site plan',
  'personnel', 'hiring', 'firing', 'compensation', 'benefits',
  'collective bargaining', 'union', 'grievance',
];

const EXPLICIT_SITUATION_REFERENCES = [
  'the article', 'that article', 'the boardwalk', 'that vote', 'the vote',
  'that decision', 'the decision', 'that meeting', 'the jan 6', 'january 6',
  'that case', 'the case', 'that situation', 'the ada issue',
  'the constitution park', 'that project', 'the project',
];

export function computeQuestionSituationMatch(
  questionText: string,
  situationContext: SituationContext | null
): SituationRelevanceResult {
  if (!situationContext || situationContext.entities.length === 0) {
    return {
      useSituationContext: false,
      score: 0,
      reason: "No situation context established",
    };
  }

  const questionLower = questionText.toLowerCase();
  let score = 0;
  const matchReasons: string[] = [];
  const penaltyReasons: string[] = [];

  // Check for entity matches (+1 each)
  for (const entity of situationContext.entities) {
    const entityLower = entity.toLowerCase();
    if (questionLower.includes(entityLower)) {
      score += 1;
      matchReasons.push(`entity:${entity}`);
    } else {
      // Check for partial word matches (e.g., "boardwalk" in entities, "boardwalk" in question)
      const entityWords = entityLower.split(/\s+/).filter(w => w.length > 3);
      for (const word of entityWords) {
        if (questionLower.includes(word)) {
          score += 0.5;
          matchReasons.push(`partial:${word}`);
          break;
        }
      }
    }
  }

  // Check for title keyword overlap (+1)
  const titleWords = situationContext.title.toLowerCase().split(/\s+/).filter(w => w.length > 3);
  for (const word of titleWords) {
    if (questionLower.includes(word)) {
      score += 0.5;
      matchReasons.push(`title:${word}`);
    }
  }

  // Check for explicit situation references (+1)
  for (const ref of EXPLICIT_SITUATION_REFERENCES) {
    if (questionLower.includes(ref)) {
      score += 1;
      matchReasons.push(`explicit_ref:${ref}`);
      break; // Only count once
    }
  }

  // Check for clearly different domain (-2)
  let isDifferentDomain = false;
  for (const keyword of DIFFERENT_DOMAIN_KEYWORDS) {
    if (questionLower.includes(keyword)) {
      isDifferentDomain = true;
      penaltyReasons.push(`different_domain:${keyword}`);
      break;
    }
  }

  // Apply penalty only if different domain AND no entity matches
  if (isDifferentDomain && matchReasons.length === 0) {
    score -= 2;
  }

  const useSituationContext = score >= 2;
  
  let reason = "";
  if (useSituationContext) {
    reason = `Matches: ${matchReasons.slice(0, 3).join(', ')}`;
  } else if (isDifferentDomain) {
    reason = `Different domain: ${penaltyReasons.join(', ')}`;
  } else {
    reason = `Insufficient overlap (score=${score.toFixed(1)})`;
  }

  return {
    useSituationContext,
    score,
    reason,
  };
}
