/**
 * Session Source Detector
 * 
 * Detects when a user message contains a long paste (article, minutes excerpt, etc.)
 * and should be stored as a sessionSource for later retrieval context.
 * 
 * Detection heuristics:
 * - Message length >= 800 chars
 * - Many paragraph breaks (article-like structure)
 * - Contains date/byline/headline patterns
 */

import { randomUUID } from "crypto";
import { chatConfig } from "./chatConfig";
import type { SessionSource } from "@shared/schema";

export interface SessionSourceDetectionResult {
  isSessionSource: boolean;
  source: SessionSource | null;
  reason: string;
}

const DATE_BYLINE_PATTERNS = [
  /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+\d{1,2}/i,
  /\b\d{1,2}\/\d{1,2}\/\d{2,4}\b/,
  /\bUpdated\b/i,
  /\bPublished\b/i,
  /\bReporter\b/i,
  /\bBy\s+[A-Z][a-z]+\s+[A-Z][a-z]+/,
  /\bStaff\s+Writer\b/i,
  /\bPress\s+Release\b/i,
  /\bNews\b/i,
  /\bArticle\b/i,
];

const MINUTES_PATTERNS = [
  /\bMinutes\b/i,
  /\bMeeting\s+Called\s+to\s+Order\b/i,
  /\bAdjourned\b/i,
  /\bMotion\s+(to|by)\b/i,
  /\bSeconded\b/i,
  /\bAll\s+in\s+favor\b/i,
  /\bVote:\s*\d/i,
  /\bPresent:\s/i,
  /\bAbsent:\s/i,
  /\bQuorum\b/i,
];

function countParagraphs(text: string): number {
  const paragraphs = text.split(/\n\s*\n/).filter(p => p.trim().length > 50);
  return paragraphs.length;
}

function detectContentType(text: string): "article" | "minutes" | "document" | "paste" {
  const lowerText = text.toLowerCase();
  
  const minutesMatches = MINUTES_PATTERNS.filter(p => p.test(text)).length;
  if (minutesMatches >= 3) {
    return "minutes";
  }
  
  const articleMatches = DATE_BYLINE_PATTERNS.filter(p => p.test(text)).length;
  if (articleMatches >= 2) {
    return "article";
  }
  
  const hasStructuredContent = /^(#|\*|-|\d+\.)\s/.test(text) || 
    text.includes("WHEREAS") || 
    text.includes("RESOLVED") ||
    /\bSection\s+\d/i.test(text);
  
  if (hasStructuredContent) {
    return "document";
  }
  
  return "paste";
}

function extractTitle(text: string, contentType: string): string | undefined {
  const lines = text.split('\n').filter(l => l.trim().length > 0);
  if (lines.length === 0) return undefined;
  
  const firstLine = lines[0].trim();
  
  if (firstLine.length < 100 && firstLine.length > 5) {
    return firstLine.slice(0, 80);
  }
  
  if (contentType === "article") {
    const match = text.match(/^(.{10,80}?)(?:\n|$)/m);
    if (match) return match[1].trim();
  }
  
  if (contentType === "minutes") {
    const dateMatch = text.match(/\b(january|february|march|april|may|june|july|august|september|october|november|december)\s+\d{1,2},?\s*\d{4}/i);
    if (dateMatch) {
      return `Meeting ${dateMatch[0]}`;
    }
  }
  
  return undefined;
}

export function detectSessionSource(
  userMessage: string
): SessionSourceDetectionResult {
  if (!chatConfig.ENABLE_SESSION_SOURCES) {
    return {
      isSessionSource: false,
      source: null,
      reason: "Session sources disabled",
    };
  }

  const messageLength = userMessage.length;
  const paragraphCount = countParagraphs(userMessage);
  
  const meetsLengthThreshold = messageLength >= chatConfig.SESSION_SOURCE_MIN_LENGTH;
  const meetsParagraphThreshold = paragraphCount >= chatConfig.SESSION_SOURCE_MIN_PARAGRAPHS;
  
  const hasDateBylinePatterns = DATE_BYLINE_PATTERNS.some(p => p.test(userMessage));
  const hasMinutesPatterns = MINUTES_PATTERNS.filter(p => p.test(userMessage)).length >= 2;
  
  const isSessionSource = 
    meetsLengthThreshold || 
    meetsParagraphThreshold || 
    (hasDateBylinePatterns && messageLength > 400) ||
    (hasMinutesPatterns && messageLength > 400);

  if (!isSessionSource) {
    return {
      isSessionSource: false,
      source: null,
      reason: "Message does not meet session source criteria",
    };
  }

  const contentType = detectContentType(userMessage);
  const title = extractTitle(userMessage, contentType);

  const source: SessionSource = {
    id: randomUUID(),
    type: contentType,
    title,
    text: userMessage,
    createdAt: new Date().toISOString(),
  };

  let reason = `Detected as ${contentType}`;
  if (meetsLengthThreshold) reason += ` (length: ${messageLength})`;
  if (meetsParagraphThreshold) reason += ` (paragraphs: ${paragraphCount})`;

  return {
    isSessionSource: true,
    source,
    reason,
  };
}

export function getMostRecentSessionSource(
  sessionSources: SessionSource[]
): SessionSource | null {
  if (sessionSources.length === 0) return null;
  
  return sessionSources.sort((a, b) => 
    new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
  )[0];
}

export function getSessionSourceTextForContext(
  sessionSources: SessionSource[],
  maxLength: number = 15000
): string {
  const mostRecent = getMostRecentSessionSource(sessionSources);
  if (!mostRecent) return "";
  
  const prefix = mostRecent.title 
    ? `=== USER-PROVIDED ${mostRecent.type.toUpperCase()}: ${mostRecent.title} ===\n`
    : `=== USER-PROVIDED ${mostRecent.type.toUpperCase()} ===\n`;
  
  const truncatedText = mostRecent.text.slice(0, maxLength - prefix.length);
  
  return prefix + truncatedText;
}
