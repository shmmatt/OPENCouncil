/**
 * Drift Detector
 * 
 * Detects when an answer has drifted away from the anchored situation
 * to unrelated topics. This is a post-generation guardrail that checks
 * if the answer introduced unrelated cases without proper analogy framing.
 * 
 * Key features:
 * - Semantic drift detection based on entity coverage
 * - Checks for proper analogy framing when off-topic content appears
 * - Provides regeneration instructions when drift is detected
 */

import type { SituationContext } from "@shared/schema";
import { chatConfig } from "./chatConfig";
import { logDebug } from "../utils/logger";
import type { PipelineLogContext } from "./types";

export interface DriftDetectionResult {
  hasDrift: boolean;
  driftedToEntities: string[];
  missingAnalogyFraming: boolean;
  severity: "none" | "minor" | "major";
  situationCoverage: number;
  regenerationHint?: string;
}

const ANALOGY_PHRASES = [
  /as\s+a\s+separate\s+example/i,
  /in\s+an?\s+unrelated\s+(matter|case|situation)/i,
  /this\s+is\s+not\s+the\s+same\s+issue/i,
  /as\s+an?\s+analogy/i,
  /for\s+comparison/i,
  /in\s+contrast/i,
  /unlike\s+this\s+situation/i,
  /different(ly)?\s+from/i,
  /separately/i,
  /in\s+another\s+context/i,
];

function extractSignificantEntities(text: string): string[] {
  const propernounPatterns = [
    /\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)\s+(?:Park|Board|Committee|Commission|Department|Street|Road|Drive|Avenue|Lane|Court|Project|Property|Case|Center|School|Building|Hill|Lake|Pond|River|Creek|Brook|Bridge|Beach)\b/g,
    /\b(?:the\s+)?([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)\s+(?:vote|motion|amendment|proposal|resolution|ordinance|variance|appeal|hearing|meeting)\b/gi,
    /\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)\s+(?:enforcement|violation|complaint|investigation)\b/gi,
    /\b(?:Select|Planning|Zoning|School|Library|Conservation)\s+(?:Board|Committee|Commission)\b/g,
    /\b([A-Z][a-z]+)(?:'s)?\s+(?:property|land|lot|parcel|home|house|residence|business)\b/gi,
    /\b(?:the\s+)?([A-Z][a-z]+)\s+(?:case|matter|situation|issue)\b/gi,
  ];
  
  const lowercasePatterns = [
    /\b(?:the\s+)?(rv|r\.v\.|campground|cesspool|septic|sewage)\s+(?:enforcement|violation|matter|issue|case|problem)\b/gi,
    /\b(?:the\s+)?(\w+)\s+(?:enforcement|violation)\s+(?:case|matter|action)\b/gi,
    /\b(?:the\s+)?(\w+)\s+(?:property|lot)\s+(?:violation|enforcement|dispute)\b/gi,
    /\b(?:re(?:garding)?|concerning|about)\s+(?:the\s+)?(\w+)\s+(?:matter|case|issue)\b/gi,
  ];
  
  const entities: Set<string> = new Set();
  
  for (const pattern of propernounPatterns) {
    const matches = text.matchAll(pattern);
    for (const match of matches) {
      if (match[1]) entities.add(match[1].trim());
      if (match[0]) entities.add(match[0].trim());
    }
  }
  
  for (const pattern of lowercasePatterns) {
    const matches = text.matchAll(pattern);
    for (const match of matches) {
      if (match[0]) entities.add(match[0].trim());
      if (match[1]) entities.add(match[1].trim());
    }
  }
  
  return Array.from(entities).filter(n => n.length > 2);
}

function findOffTopicMentions(
  answerText: string,
  situationContext: SituationContext
): string[] {
  const answerEntities = extractSignificantEntities(answerText);
  const situationEntitiesLower = situationContext.entities.map(e => e.toLowerCase());
  
  const offTopicEntities: string[] = [];
  
  for (const entity of answerEntities) {
    const entityLower = entity.toLowerCase();
    const entityWords = entityLower.split(/\s+/).filter(w => w.length > 2);
    
    const isPartOfSituation = situationEntitiesLower.some(sitEntity => {
      const sitEntityWords = sitEntity.toLowerCase().split(/\s+/).filter(w => w.length > 2);
      return entityWords.some(ew => sitEntityWords.some(sew => 
        ew === sew || ew.includes(sew) || sew.includes(ew)
      ));
    });
    
    if (!isPartOfSituation) {
      offTopicEntities.push(entity);
    }
  }
  
  const boardNames = ["Select Board", "Planning Board", "Zoning Board", "School Board"];
  const filteredOffTopic = offTopicEntities.filter(entity => {
    const entityLower = entity.toLowerCase();
    return !boardNames.some(bn => entityLower.includes(bn.toLowerCase()));
  });
  
  return Array.from(new Set(filteredOffTopic));
}

function hasProperAnalogyFraming(
  answerText: string,
  offTopicEntity: string
): boolean {
  const entityIndex = answerText.toLowerCase().indexOf(offTopicEntity.toLowerCase());
  if (entityIndex === -1) return true;
  
  const contextWindow = 200;
  const contextStart = Math.max(0, entityIndex - contextWindow);
  const contextEnd = Math.min(answerText.length, entityIndex + offTopicEntity.length + contextWindow);
  const context = answerText.slice(contextStart, contextEnd);
  
  return ANALOGY_PHRASES.some(phrase => phrase.test(context));
}

function checkSituationCoverage(
  answerText: string,
  situationContext: SituationContext
): number {
  const answerLower = answerText.toLowerCase();
  let matchCount = 0;
  
  for (const entity of situationContext.entities) {
    const entityLower = entity.toLowerCase();
    if (answerLower.includes(entityLower)) {
      matchCount++;
    } else {
      const words = entityLower.split(/\s+/);
      const partialMatches = words.filter(w => w.length > 3 && answerLower.includes(w));
      if (partialMatches.length > 0) {
        matchCount += 0.5;
      }
    }
  }
  
  return situationContext.entities.length > 0 
    ? matchCount / situationContext.entities.length 
    : 1;
}

export function detectDrift(
  answerText: string,
  situationContext: SituationContext | null | undefined,
  logContext?: PipelineLogContext
): DriftDetectionResult {
  if (!chatConfig.ENABLE_DRIFT_DETECTION || !situationContext) {
    return {
      hasDrift: false,
      driftedToEntities: [],
      missingAnalogyFraming: false,
      severity: "none",
      situationCoverage: 1.0,
    };
  }
  
  const situationCoverage = checkSituationCoverage(answerText, situationContext);
  const offTopicEntities = findOffTopicMentions(answerText, situationContext);
  
  const lowCoverage = situationCoverage < chatConfig.MIN_ON_TOPIC_CHUNK_RATIO;
  
  if (offTopicEntities.length === 0 && !lowCoverage) {
    return {
      hasDrift: false,
      driftedToEntities: [],
      missingAnalogyFraming: false,
      severity: "none",
      situationCoverage,
    };
  }
  
  const unframedEntities = offTopicEntities.filter(
    entity => !hasProperAnalogyFraming(answerText, entity)
  );
  
  if (unframedEntities.length === 0 && !lowCoverage) {
    logDebug("drift_detector_analogy_ok", {
      requestId: logContext?.requestId,
      sessionId: logContext?.sessionId,
      stage: "drift_detection",
      offTopicEntities,
      situationCoverage,
      message: "Off-topic entities found but properly framed as analogies",
    });
    
    return {
      hasDrift: false,
      driftedToEntities: offTopicEntities,
      missingAnalogyFraming: false,
      severity: "none",
      situationCoverage,
    };
  }
  
  const severity: "minor" | "major" = 
    (situationCoverage < 0.2 && unframedEntities.length >= 1) || 
    (unframedEntities.length >= 3)
      ? "major" 
      : lowCoverage ? "major" : "minor";
  
  logDebug("drift_detector_found_drift", {
    requestId: logContext?.requestId,
    sessionId: logContext?.sessionId,
    stage: "drift_detection",
    unframedEntities,
    situationCoverage,
    severity,
    situationTitle: situationContext.title,
    lowCoverageFlag: lowCoverage,
  });
  
  const regenerationHint = buildRegenerationHint(situationContext, unframedEntities);
  
  return {
    hasDrift: true,
    driftedToEntities: unframedEntities,
    missingAnalogyFraming: unframedEntities.length > 0,
    severity,
    situationCoverage,
    regenerationHint,
  };
}

function buildRegenerationHint(
  situationContext: SituationContext,
  driftedEntities: string[]
): string {
  return `REGENERATION REQUIRED - DRIFT DETECTED

The previous answer drifted to unrelated topics (${driftedEntities.join(", ")}) without proper analogy framing.

STRICT INSTRUCTIONS:
1. Focus your answer on the current situation: "${situationContext.title}"
2. Key entities to address: ${situationContext.entities.slice(0, 5).join(", ")}
3. Do NOT mention ${driftedEntities.join(" or ")} unless clearly labeled as an analogy
4. If you cannot answer within the current situation, say what information is missing
5. Begin your response by anchoring to: "${situationContext.title}"

Remove any substitution of unrelated cases as the main answer.`;
}

export function shouldRegenerate(driftResult: DriftDetectionResult): boolean {
  if (!driftResult.hasDrift) {
    return false;
  }
  
  return driftResult.severity === "major" || driftResult.missingAnalogyFraming;
}
