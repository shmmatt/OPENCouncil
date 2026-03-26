/**
 * Platform Manual Detection Tests
 *
 * Tests for detectPlatformQuery — the zero-cost keyword detector that decides
 * whether to inject the OPENCouncil platform manual into the synthesizer prompt.
 *
 * Cases are divided into:
 *  1. TRUE positives — platform meta-questions that MUST trigger injection
 *  2. FALSE negatives — municipal research questions that MUST NOT trigger
 *  3. Town-name guard — platform-flavored phrases that mention a local town
 *     (should be suppressed so the RAG pipeline handles them alone)
 */

import { describe, it, expect } from "vitest";
import { detectPlatformQuery } from "../platformManual";

// ---------------------------------------------------------------------------
// True positives — should trigger injection
// ---------------------------------------------------------------------------
describe("detectPlatformQuery — TRUE positives (should inject manual)", () => {
  describe("product name", () => {
    it("detects bare product name", () => {
      expect(detectPlatformQuery("What is OPENCouncil?")).toBe(true);
    });
    it("detects product name mid-sentence", () => {
      expect(detectPlatformQuery("Tell me about opencouncil")).toBe(true);
    });
    it("detects product name case-insensitive", () => {
      expect(detectPlatformQuery("Opencouncil — what is it exactly?")).toBe(true);
    });
  });

  describe("message quotas", () => {
    it("detects 'how many messages do I get'", () => {
      expect(detectPlatformQuery("How many messages do I get?")).toBe(true);
    });
    it("detects 'how many queries'", () => {
      expect(detectPlatformQuery("How many queries can I make?")).toBe(true);
    });
    it("detects 'message quota'", () => {
      expect(detectPlatformQuery("What is my message quota?")).toBe(true);
    });
    it("detects 'message limit'", () => {
      expect(detectPlatformQuery("I've hit my message limit")).toBe(true);
    });
    it("detects 'messages remaining'", () => {
      expect(detectPlatformQuery("How many messages are remaining?")).toBe(true);
    });
  });

  describe("subscription and pricing", () => {
    it("detects subscription", () => {
      expect(detectPlatformQuery("How do I get a subscription?")).toBe(true);
    });
    it("detects subscribe", () => {
      expect(detectPlatformQuery("I want to subscribe")).toBe(true);
    });
    it("detects pricing", () => {
      expect(detectPlatformQuery("What is the pricing?")).toBe(true);
    });
    it("detects cost question", () => {
      expect(detectPlatformQuery("How much does it cost?")).toBe(true);
    });
    it("detects 'do you charge'", () => {
      expect(detectPlatformQuery("Do you charge for this?")).toBe(true);
    });
    it("detects paid plan", () => {
      expect(detectPlatformQuery("Tell me about the paid plan")).toBe(true);
    });
    it("detects free tier", () => {
      expect(detectPlatformQuery("What is the free tier?")).toBe(true);
    });
    it("detects pro plan", () => {
      expect(detectPlatformQuery("How do I upgrade to the pro plan?")).toBe(true);
    });
  });

  describe("authorship / operators", () => {
    it("detects 'who made this'", () => {
      expect(detectPlatformQuery("Who made this?")).toBe(true);
    });
    it("detects 'who runs this'", () => {
      expect(detectPlatformQuery("Who runs this?")).toBe(true);
    });
    it("detects 'who built this'", () => {
      expect(detectPlatformQuery("Who built this tool?")).toBe(true);
    });
    it("detects 'who is behind opencouncil'", () => {
      expect(detectPlatformQuery("Who is behind OPENCouncil?")).toBe(true);
    });
  });

  describe("how the system works", () => {
    it("detects 'how does this work'", () => {
      expect(detectPlatformQuery("How does this work?")).toBe(true);
    });
    it("detects 'how does this system work'", () => {
      expect(detectPlatformQuery("How does this system work?")).toBe(true);
    });
    it("detects 'how does the AI work'", () => {
      expect(detectPlatformQuery("How does the AI work?")).toBe(true);
    });
    it("detects 'how does the search work'", () => {
      expect(detectPlatformQuery("How does the search work?")).toBe(true);
    });
  });

  describe("geographic / data coverage", () => {
    it("detects 'what towns do you cover'", () => {
      expect(detectPlatformQuery("What towns do you cover?")).toBe(true);
    });
    it("detects 'which towns does opencouncil index'", () => {
      expect(detectPlatformQuery("Which towns does OPENCouncil index?")).toBe(true);
    });
    it("detects 'what data do you have'", () => {
      expect(detectPlatformQuery("What data do you have?")).toBe(true);
    });
    it("detects 'what documents do you have'", () => {
      expect(detectPlatformQuery("What documents do you have?")).toBe(true);
    });
    it("detects 'what sources do you have'", () => {
      expect(detectPlatformQuery("What sources do you have?")).toBe(true);
    });
    it("detects data availability question", () => {
      expect(detectPlatformQuery("What data is available in the system?")).toBe(true);
    });
  });

  describe("what can you do", () => {
    it("detects 'what can you do'", () => {
      expect(detectPlatformQuery("What can you do?")).toBe(true);
    });
    it("detects 'what can you tell me' without topic following", () => {
      expect(detectPlatformQuery("What can you tell me?")).toBe(true);
    });
  });

  describe("data freshness", () => {
    it("detects 'how often do you update'", () => {
      expect(detectPlatformQuery("How often do you update?")).toBe(true);
    });
    it("detects 'how often does opencouncil crawl'", () => {
      expect(detectPlatformQuery("How often does OPENCouncil crawl?")).toBe(true);
    });
    it("detects 'how frequently do you refresh'", () => {
      expect(detectPlatformQuery("How frequently do you refresh the data?")).toBe(true);
    });
  });

  describe("about the platform", () => {
    it("detects 'about opencouncil'", () => {
      expect(detectPlatformQuery("Tell me about opencouncil")).toBe(true);
    });
    it("detects 'about this platform'", () => {
      expect(detectPlatformQuery("Tell me about this platform")).toBe(true);
    });
    it("detects 'about yourself'", () => {
      expect(detectPlatformQuery("Tell me about yourself")).toBe(true);
    });
  });

  describe("contact", () => {
    it("detects 'contact you'", () => {
      expect(detectPlatformQuery("How can I contact you?")).toBe(true);
    });
    it("detects 'contact support'", () => {
      expect(detectPlatformQuery("How do I contact support?")).toBe(true);
    });
    it("detects email address", () => {
      expect(detectPlatformQuery("Is info@opencouncil.co the right email?")).toBe(true);
    });
  });
});

// ---------------------------------------------------------------------------
// False negatives — should NOT trigger injection
// ---------------------------------------------------------------------------
describe("detectPlatformQuery — FALSE negatives (must not inject manual)", () => {
  describe("specific municipal research questions", () => {
    it("does not trigger for Conway Planning Board question", () => {
      expect(detectPlatformQuery(
        "What did the Conway Planning Board decide about the Route 16 bypass?"
      )).toBe(false);
    });
    it("does not trigger for cost-of-project research question", () => {
      expect(detectPlatformQuery(
        "What is the cost of the Tamworth road construction project?"
      )).toBe(false);
    });
    it("does not trigger for budget research question", () => {
      expect(detectPlatformQuery(
        "Tell me about the Madison school budget for 2024"
      )).toBe(false);
    });
  });

  describe("town-name guard blocks ambiguous phrases", () => {
    it("does not trigger for 'how does Conway water district work'", () => {
      expect(detectPlatformQuery(
        "How does the Conway water district work?"
      )).toBe(false);
    });
    it("does not trigger for 'how often does Ossipee update its zoning bylaws'", () => {
      expect(detectPlatformQuery(
        "How often does Ossipee update its zoning bylaws?"
      )).toBe(false);
    });
    it("does not trigger for 'how often does Tamworth update its master plan'", () => {
      expect(detectPlatformQuery(
        "How often does Tamworth update its master plan?"
      )).toBe(false);
    });
    it("does not trigger for 'what towns are near Conway'", () => {
      expect(detectPlatformQuery(
        "What towns are near Conway for regional planning purposes?"
      )).toBe(false);
    });
    it("does not trigger for 'what documents do you have on Moultonborough'", () => {
      expect(detectPlatformQuery(
        "What documents do you have on Moultonborough?"
      )).toBe(false);
    });
    it("does not trigger for 'what data do you have on the Ossipee ZBA'", () => {
      expect(detectPlatformQuery(
        "What data do you have on the Ossipee ZBA decisions from 2023?"
      )).toBe(false);
    });
    it("does not trigger for 'what can you tell me about the Ossipee zoning board'", () => {
      expect(detectPlatformQuery(
        "What can you tell me about the Ossipee zoning board?"
      )).toBe(false);
    });
  });

  describe("generic questions with no platform signal", () => {
    it("does not trigger for a generic budget question", () => {
      expect(detectPlatformQuery(
        "What is the Conway town budget for this year?"
      )).toBe(false);
    });
    it("does not trigger for a zoning decision question", () => {
      expect(detectPlatformQuery(
        "What did the Sandwich ZBA decide about the lakefront variance?"
      )).toBe(false);
    });
    it("does not trigger for RSA question", () => {
      expect(detectPlatformQuery(
        "What does RSA 91-A say about executive sessions?"
      )).toBe(false);
    });
    it("does not trigger for a permit fee question", () => {
      expect(detectPlatformQuery(
        "What is the fee for a building permit in Conway?"
      )).toBe(false);
    });
  });
});
