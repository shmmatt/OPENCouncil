/**
 * Situation Anchoring Tests
 * 
 * Tests for the topic continuity / situation anchoring feature.
 * These tests verify that:
 * 1. Situation extraction correctly identifies entities and topics
 * 2. Topic-prior re-ranking gives preference to on-topic chunks
 * 3. Drift detection identifies off-topic substitutions
 */

import { describe, it, expect } from "vitest";
import { 
  extractSituationHeuristic, 
  computeSituationMatchScore 
} from "../situationExtractor";
import { detectDrift, shouldRegenerate } from "../driftDetector";
import type { SituationContext } from "@shared/schema";

describe("Situation Extraction", () => {
  describe("extractSituationHeuristic", () => {
    it("should extract entities from boardwalk/park discussion", () => {
      const message = "I have a question about the Constitution Park boardwalk vote by the Select Board on January 6, 2026 regarding ADA compliance.";
      
      const result = extractSituationHeuristic(message, null, false);
      
      expect(result.shouldUpdate).toBe(true);
      expect(result.newContext).not.toBeNull();
      expect(result.newContext?.entities.length).toBeGreaterThan(0);
      expect(result.newContext?.title).toBeTruthy();
    });

    it("should maintain existing context for follow-up questions", () => {
      const existingContext: SituationContext = {
        title: "Constitution Park boardwalk - ADA vote",
        entities: ["Constitution Park", "boardwalk", "Select Board", "ADA"],
        lastUpdatedAt: new Date().toISOString(),
      };
      
      const followUp = "What actions led to liability?";
      
      const result = extractSituationHeuristic(followUp, existingContext, false);
      
      expect(result.shouldUpdate).toBe(false);
      expect(result.newContext).toEqual(existingContext);
    });

    it("should detect broadening signals and clear context", () => {
      const existingContext: SituationContext = {
        title: "Constitution Park boardwalk",
        entities: ["Constitution Park", "boardwalk"],
        lastUpdatedAt: new Date().toISOString(),
      };
      
      const broadeningMessage = "How does this work statewide?";
      
      const result = extractSituationHeuristic(broadeningMessage, existingContext, false);
      
      expect(result.shouldUpdate).toBe(true);
      expect(result.newContext).toBeNull();
      expect(result.reason).toContain("broadening");
    });

    it("should update context when significant new entities appear with event markers", () => {
      const existingContext: SituationContext = {
        title: "General discussion",
        entities: ["Select Board"],
        lastUpdatedAt: new Date().toISOString(),
      };
      
      const newTopicMessage = "There was a Planning Board meeting about the new subdivision vote on February 15.";
      
      const result = extractSituationHeuristic(newTopicMessage, existingContext, false);
      
      expect(result.shouldUpdate).toBe(true);
      expect(result.newContext?.entities.length).toBeGreaterThan(existingContext.entities.length);
    });
  });

  describe("computeSituationMatchScore", () => {
    it("should return high score for on-topic chunks", () => {
      const situationContext: SituationContext = {
        title: "Constitution Park boardwalk ADA vote",
        entities: ["Constitution Park", "boardwalk", "ADA", "Select Board"],
        lastUpdatedAt: new Date().toISOString(),
      };
      
      const onTopicContent = "The Select Board discussed the Constitution Park boardwalk project and its ADA compliance requirements at the January meeting.";
      
      const score = computeSituationMatchScore(onTopicContent, situationContext);
      
      expect(score).toBeGreaterThan(0.5);
    });

    it("should return low score for off-topic chunks", () => {
      const situationContext: SituationContext = {
        title: "Constitution Park boardwalk ADA vote",
        entities: ["Constitution Park", "boardwalk", "ADA", "Select Board"],
        lastUpdatedAt: new Date().toISOString(),
      };
      
      const offTopicContent = "The Brown property RV enforcement case resulted in significant zoning violations and cesspool issues.";
      
      const score = computeSituationMatchScore(offTopicContent, situationContext);
      
      expect(score).toBeLessThan(0.2);
    });

    it("should return 0 for null situation context", () => {
      const score = computeSituationMatchScore("Some content", null);
      expect(score).toBe(0);
    });
  });
});

describe("Drift Detection", () => {
  describe("detectDrift", () => {
    it("should detect drift when answer substitutes unrelated case", () => {
      const situationContext: SituationContext = {
        title: "Constitution Park boardwalk",
        entities: ["Constitution Park", "boardwalk", "ADA"],
        lastUpdatedAt: new Date().toISOString(),
      };
      
      const driftedAnswer = "Based on the Brown enforcement case, the town had to deal with RV park violations and zoning enforcement issues. The cesspool problems were significant.";
      
      const result = detectDrift(driftedAnswer, situationContext);
      
      expect(result.hasDrift).toBe(true);
      expect(result.driftedToEntities.length).toBeGreaterThan(0);
    });

    it("should not flag drift when answer stays on topic", () => {
      const situationContext: SituationContext = {
        title: "Constitution Park boardwalk",
        entities: ["Constitution Park", "boardwalk", "ADA", "Select Board"],
        lastUpdatedAt: new Date().toISOString(),
      };
      
      const onTopicAnswer = "Regarding the Constitution Park boardwalk project, the Select Board voted to ensure ADA compliance. The boardwalk construction must meet accessibility standards.";
      
      const result = detectDrift(onTopicAnswer, situationContext);
      
      expect(result.hasDrift).toBe(false);
    });

    it("should allow off-topic mentions when properly framed as analogies", () => {
      const situationContext: SituationContext = {
        title: "Constitution Park boardwalk",
        entities: ["Constitution Park", "boardwalk"],
        lastUpdatedAt: new Date().toISOString(),
      };
      
      const answerWithAnalogy = "Regarding the Constitution Park boardwalk, the ADA requirements must be met. As a separate example, in an unrelated matter involving Brown, the town learned about enforcement procedures.";
      
      const result = detectDrift(answerWithAnalogy, situationContext);
      
      expect(result.hasDrift).toBe(false);
    });

    it("should return no drift for null situation context", () => {
      const result = detectDrift("Any answer text", null);
      
      expect(result.hasDrift).toBe(false);
      expect(result.severity).toBe("none");
    });
  });

  describe("shouldRegenerate", () => {
    it("should recommend regeneration for major drift", () => {
      const driftResult = {
        hasDrift: true,
        driftedToEntities: ["Brown", "RV enforcement"],
        missingAnalogyFraming: true,
        severity: "major" as const,
        situationCoverage: 0.1,
      };
      
      expect(shouldRegenerate(driftResult)).toBe(true);
    });

    it("should not recommend regeneration when no drift", () => {
      const noDriftResult = {
        hasDrift: false,
        driftedToEntities: [],
        missingAnalogyFraming: false,
        severity: "none" as const,
        situationCoverage: 0.9,
      };
      
      expect(shouldRegenerate(noDriftResult)).toBe(false);
    });
  });
});
