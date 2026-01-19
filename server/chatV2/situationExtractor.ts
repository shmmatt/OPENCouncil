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

// Generic entity patterns - NO example-specific terms
// These patterns match common municipal governance entities
const ENTITY_PATTERNS = {
  boards: [
    // Municipal boards and commissions (generic patterns)
    /\b(select\s*board|selectboard|planning\s*board|zba|zoning\s*board|conservation\s*commission|budget\s*committee|school\s*board|trustees|recreation\s*committee|heritage\s*commission|library\s*trustees|cemetery\s*trustees|parks?\s*commission)\b/gi,
  ],
  facilities: [
    // Generic facility types (not specific named projects)
    /\b(town\s*hall|library|fire\s*station|police\s*station|highway\s*department|transfer\s*station|recreation\s*center|community\s*center|senior\s*center|school|elementary|middle\s*school|high\s*school)\b/gi,
  ],
  events: [
    /\b(vote|voted|voting|meeting|hearing|warrant|article|motion|approved|denied|tabled|deliberative\s*session|town\s*meeting)\b/gi,
  ],
  dates: [
    /\b(january|february|march|april|may|june|july|august|september|october|november|december)\s+\d{1,2},?\s*\d{4}\b/gi,
    /\b\d{1,2}\/\d{1,2}\/\d{2,4}\b/g,
    /\b\d{4}-\d{2}-\d{2}\b/g,
  ],
  legal: [
    /\b(rsa\s*\d+[-:]\w+|rsa\s*\d+|nh\s*law|statute|ordinance|regulation)\b/gi,
  ],
  propertyTypes: [
    // Generic property/project type patterns
    /\b(park|trail|sidewalk|road|bridge|intersection|property|parcel|lot|subdivision|development|construction|renovation|expansion)\b/gi,
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
  // Categorize entities by type using generic patterns
  const facilityEntities = entities.filter(e => 
    /park|hall|station|library|center|school|department/i.test(e)
  );
  const boardEntities = entities.filter(e =>
    /board|commission|committee|trustees/i.test(e)
  );
  const eventEntities = entities.filter(e =>
    /vote|meeting|hearing|warrant|session/i.test(e)
  );
  const propertyEntities = entities.filter(e =>
    /property|parcel|lot|subdivision|development|project|trail|road|bridge/i.test(e)
  );
  
  const parts: string[] = [];
  
  // Prioritize: facility/property > event > board
  if (facilityEntities.length > 0) {
    parts.push(facilityEntities[0]);
  } else if (propertyEntities.length > 0) {
    parts.push(propertyEntities[0]);
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
 * This prevents "sticky context" where old topics leak into unrelated questions.
 * 
 * Scoring (generalizable to any situation):
 * +1 for each situation entity appearing in the question
 * +0.5 for partial word matches on significant words
 * +0.5 for title keyword overlap
 * +1 for generic explicit references ("that vote", "the project", etc.)
 * +1.5 for dynamic explicit entity references ("the [stored entity]")
 * -2 if question is in a clearly different domain AND no entity overlap
 * 
 * Domain detection uses DOMAIN_CATEGORIES (budget, zoning, personnel, etc.)
 * to identify topic switches without hardcoded example terms.
 * 
 * Decision: useSituationContext = (score >= 2)
 */
export interface SituationRelevanceResult {
  useSituationContext: boolean;
  score: number;
  reason: string;
}

// Generic domain categories - used to detect when a question is about a clearly different topic
// These are broad municipal governance domains, NOT specific examples
const DOMAIN_CATEGORIES: Record<string, string[]> = {
  budget: [
    'budget', 'appropriation', 'tax rate', 'default budget', 'overlay', 
    'encumbrance', 'fund balance', 'fiscal year', 'revenue', 'expenditure',
  ],
  zoning: [
    'zoning amendment', 'zoning variance', 'special exception', 'setback',
    'lot coverage', 'building permit', 'conditional use',
  ],
  environmental: [
    'wetlands', 'shoreland', 'stormwater', 'septic', 'groundwater',
  ],
  development: [
    'subdivision', 'site plan', 'lot line adjustment', 'annexation',
  ],
  personnel: [
    'personnel', 'hiring', 'firing', 'compensation', 'benefits',
    'collective bargaining', 'union', 'grievance', 'employee',
  ],
  elections: [
    'deliberative session', 'official ballot', 'election', 'ballot',
    'voter registration', 'absentee', 'moderator',
  ],
  public_safety: [
    'police', 'fire department', 'emergency services', 'ambulance',
  ],
  infrastructure: [
    'highway', 'road maintenance', 'bridge', 'culvert', 'drainage',
    'water system', 'sewer system', 'utility',
  ],
};

// Generic explicit reference patterns - these work for ANY stored situation
// NO example-specific terms (boardwalk, jan 6, constitution park, etc.)
const GENERIC_EXPLICIT_REFERENCES = [
  'that vote', 'the vote', 'this vote',
  'that decision', 'the decision', 'this decision',
  'that meeting', 'the meeting', 'this meeting',
  'that case', 'the case', 'this case',
  'that situation', 'the situation', 'this situation',
  'that project', 'the project', 'this project',
  'that issue', 'the issue', 'this issue',
  'that article', 'the article', 'this article',
  'that property', 'the property', 'this property',
  'as mentioned', 'as discussed', 'we were discussing',
  'going back to', 'regarding the', 'about the earlier',
];

/**
 * Detects the domain category of a question based on keyword matching.
 * Returns the domain name if detected, null otherwise.
 */
export function detectQuestionDomain(questionLower: string): string | null {
  for (const [domain, keywords] of Object.entries(DOMAIN_CATEGORIES)) {
    for (const keyword of keywords) {
      if (questionLower.includes(keyword)) {
        return domain;
      }
    }
  }
  return null;
}

/**
 * Detects the domain category of stored situation context based on its entities.
 * Returns the domain name if detected, null otherwise.
 */
function detectSituationDomain(situationContext: SituationContext): string | null {
  const contextText = [
    situationContext.title,
    ...situationContext.entities,
  ].join(' ').toLowerCase();
  
  for (const [domain, keywords] of Object.entries(DOMAIN_CATEGORIES)) {
    for (const keyword of keywords) {
      if (contextText.includes(keyword)) {
        return domain;
      }
    }
  }
  return null;
}

/**
 * Checks if the question contains a dynamic explicit reference to any stored entity.
 * E.g., "the [entity]", "that [entity]", "this [entity]"
 */
function hasExplicitEntityReference(questionLower: string, situationContext: SituationContext): boolean {
  const referencePatterns = ['the ', 'that ', 'this ', 'about the ', 'regarding the '];
  
  for (const entity of situationContext.entities) {
    const entityLower = entity.toLowerCase();
    for (const prefix of referencePatterns) {
      if (questionLower.includes(prefix + entityLower)) {
        return true;
      }
    }
  }
  return false;
}

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

  // Check for entity matches (+1 each)
  for (const entity of situationContext.entities) {
    const entityLower = entity.toLowerCase();
    if (questionLower.includes(entityLower)) {
      score += 1;
      matchReasons.push(`entity:${entity}`);
    } else {
      // Check for partial word matches (significant words only)
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

  // Check for title keyword overlap (+0.5 per significant word)
  const titleWords = situationContext.title.toLowerCase().split(/\s+/).filter(w => w.length > 3);
  for (const word of titleWords) {
    if (questionLower.includes(word)) {
      score += 0.5;
      matchReasons.push(`title:${word}`);
    }
  }

  // Check for generic explicit situation references (+1)
  for (const ref of GENERIC_EXPLICIT_REFERENCES) {
    if (questionLower.includes(ref)) {
      score += 1;
      matchReasons.push(`generic_ref:${ref}`);
      break; // Only count once
    }
  }

  // Check for dynamic explicit entity references (+1.5)
  // E.g., if context has "constitution park", detect "the constitution park" in question
  if (hasExplicitEntityReference(questionLower, situationContext)) {
    score += 1.5;
    matchReasons.push('explicit_entity_ref');
  }

  // Domain-based penalty: if question is clearly in a different domain AND no entity overlap
  const questionDomain = detectQuestionDomain(questionLower);
  const situationDomain = detectSituationDomain(situationContext);
  
  let isDifferentDomain = false;
  let domainPenaltyReason = "";
  
  if (questionDomain && situationDomain && questionDomain !== situationDomain) {
    // Both have detected domains and they're different
    isDifferentDomain = true;
    domainPenaltyReason = `${questionDomain} vs ${situationDomain}`;
  } else if (questionDomain && !situationDomain) {
    // Question has a clear domain but situation doesn't - likely a topic switch
    isDifferentDomain = true;
    domainPenaltyReason = `new_domain:${questionDomain}`;
  }

  // Apply penalty only if different domain AND no entity matches
  if (isDifferentDomain && matchReasons.length === 0) {
    score -= 2;
  }

  const useSituationContext = score >= 2;
  
  let reason = "";
  if (useSituationContext) {
    reason = `Matches: ${matchReasons.slice(0, 3).join(', ')}`;
  } else if (isDifferentDomain && matchReasons.length === 0) {
    reason = `Different domain (${domainPenaltyReason}), no entity overlap`;
  } else if (matchReasons.length === 0) {
    reason = `No overlap with stored context`;
  } else {
    reason = `Insufficient overlap (score=${score.toFixed(1)}): ${matchReasons.slice(0, 2).join(', ')}`;
  }

  return {
    useSituationContext,
    score,
    reason,
  };
}
