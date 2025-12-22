/**
 * Character Cap Enforcement Utility
 * 
 * Enforces hard character limits on answer text with:
 * - Safe sentence-boundary truncation
 * - Markdown code fence protection
 * - NO truncation messaging (per product requirements)
 */

export interface CharCapResult {
  text: string;
  wasTruncated: boolean;
  originalLength: number;
  finalLength: number;
}

const ELLIPSIS = "...";

/**
 * Enforce a hard character cap on answer text.
 * 
 * IMPORTANT: Per product requirements, truncation is a safety guardrail only.
 * No truncation notes, mode mentions, or upsell copy are added.
 * 
 * @param text - The text to truncate if necessary
 * @param cap - Maximum allowed characters (hard limit)
 * @param _isDeepMode - Unused, kept for backward compatibility
 * @returns CharCapResult with truncated text and metadata
 */
export function enforceCharCap(
  text: string,
  cap: number,
  _isDeepMode: boolean = false
): CharCapResult {
  const originalLength = text.length;

  if (originalLength <= cap) {
    return {
      text,
      wasTruncated: false,
      originalLength,
      finalLength: originalLength,
    };
  }

  // Leave room for ellipsis only (no footer)
  const effectiveCap = cap - ELLIPSIS.length;
  
  if (effectiveCap <= 0) {
    return {
      text: text.slice(0, cap),
      wasTruncated: true,
      originalLength,
      finalLength: cap,
    };
  }

  // Try to truncate at a sentence boundary
  let truncated = truncateAtSentenceBoundary(text, effectiveCap);
  
  // If we couldn't find a good sentence boundary, use word boundary
  if (truncated.length < effectiveCap * 0.5) {
    truncated = truncateAtWordBoundary(text, effectiveCap);
  }

  // Ensure we don't break markdown code fences
  truncated = fixBrokenMarkdownFences(truncated);

  // Add ellipsis only - NO truncation messaging per product requirements
  const finalText = truncated + ELLIPSIS;

  return {
    text: finalText,
    wasTruncated: true,
    originalLength,
    finalLength: finalText.length,
  };
}

/**
 * Truncate text at the last complete sentence within the character limit.
 */
function truncateAtSentenceBoundary(text: string, maxLength: number): string {
  if (text.length <= maxLength) {
    return text;
  }

  const substring = text.slice(0, maxLength);
  
  // Find sentence endings: . ! ? followed by space or end of string
  // Also handle markdown bullet points and numbered lists
  const sentenceEndPatterns = [
    /\.\s+(?=[A-Z])/g,  // Period followed by capital letter
    /\.\s*$/g,          // Period at end
    /!\s+/g,            // Exclamation mark
    /\?\s+/g,           // Question mark
    /\n\n/g,            // Double newline (paragraph break)
    /\n[-*]\s/g,        // Start of bullet point
    /\n\d+\.\s/g,       // Start of numbered list
  ];

  let lastGoodEnd = -1;

  for (const pattern of sentenceEndPatterns) {
    let match;
    const regex = new RegExp(pattern.source, pattern.flags);
    while ((match = regex.exec(substring)) !== null) {
      const endPos = match.index + match[0].length - 1;
      if (endPos > lastGoodEnd && endPos < maxLength) {
        lastGoodEnd = endPos;
      }
    }
  }

  // Also check for simple period endings
  for (let i = Math.min(substring.length - 1, maxLength - 1); i >= maxLength * 0.5; i--) {
    const char = substring[i];
    const nextChar = substring[i + 1] || " ";
    
    if ((char === "." || char === "!" || char === "?") && 
        (nextChar === " " || nextChar === "\n" || i === substring.length - 1)) {
      if (i > lastGoodEnd) {
        lastGoodEnd = i;
        break;
      }
    }
  }

  if (lastGoodEnd > 0) {
    return text.slice(0, lastGoodEnd + 1).trim();
  }

  return substring.trim();
}

/**
 * Truncate text at the last word boundary within the character limit.
 */
function truncateAtWordBoundary(text: string, maxLength: number): string {
  if (text.length <= maxLength) {
    return text;
  }

  const substring = text.slice(0, maxLength);
  
  // Find the last space before the limit
  const lastSpace = substring.lastIndexOf(" ");
  const lastNewline = substring.lastIndexOf("\n");
  const lastBreak = Math.max(lastSpace, lastNewline);
  
  if (lastBreak > maxLength * 0.5) {
    return text.slice(0, lastBreak).trim();
  }

  return substring.trim();
}

/**
 * Fix broken markdown code fences that might result from truncation.
 * If we cut inside a code block, either close it or remove the incomplete fence.
 */
function fixBrokenMarkdownFences(text: string): string {
  // Count opening and closing code fences
  const openingFences = (text.match(/```\w*/g) || []).length;
  const closingFences = (text.match(/```\s*$/gm) || []).length;
  const standaloneFences = (text.match(/^```$/gm) || []).length;
  
  // Rough check: if we have an odd number of triple backticks, we might be in a broken state
  const totalFences = (text.match(/```/g) || []).length;
  
  if (totalFences % 2 !== 0) {
    // Check if the last code fence is an opener (has language tag or is just ```)
    const lastFenceMatch = text.match(/```(\w*)([^`]*)$/);
    
    if (lastFenceMatch) {
      const afterFence = lastFenceMatch[2];
      // If there's significant content after the last fence opener, close the block
      if (afterFence.trim().length > 10) {
        return text + "\n```";
      }
      // Otherwise, remove the incomplete fence
      return text.replace(/```\w*[^`]*$/, "").trim();
    }
  }

  // Also check for incomplete inline code
  const backtickCount = (text.match(/`/g) || []).length;
  if (backtickCount % 2 !== 0) {
    // Find and fix the trailing incomplete inline code
    const lastBacktickPos = text.lastIndexOf("`");
    // Check if there's a matching opener
    const textBeforeLast = text.slice(0, lastBacktickPos);
    const prevBacktickPos = textBeforeLast.lastIndexOf("`");
    
    // If the content between backticks seems like code, close it
    if (prevBacktickPos >= 0 && lastBacktickPos - prevBacktickPos < 100) {
      // It's probably meant to be inline code, leave it
    } else {
      // Remove the dangling backtick
      return text.slice(0, lastBacktickPos) + text.slice(lastBacktickPos + 1);
    }
  }

  return text;
}

/**
 * Character caps configuration by path and mode
 * Updated to new policy values from answerPolicy.ts
 */
export interface CharCapConfig {
  simple: {
    standard: number;
    deep: number;
  };
  complex: {
    standard: number;
    deep: number;
  };
}

export const DEFAULT_CHAR_CAPS: CharCapConfig = {
  simple: {
    standard: 950,
    deep: 1700,
  },
  complex: {
    standard: 1900,
    deep: 5400,
  },
};

/**
 * Get the appropriate character cap for a given path and mode.
 */
export function getCharCap(
  complexity: "simple" | "complex",
  answerMode: "standard" | "deep"
): number {
  return DEFAULT_CHAR_CAPS[complexity][answerMode];
}

/**
 * Prompt length targets (soft targets for LLM prompts)
 */
export interface LengthTargets {
  description: string;
  charMax: number;
}

export function getLengthTargets(
  complexity: "simple" | "complex",
  answerMode: "standard" | "deep"
): LengthTargets {
  if (complexity === "simple") {
    if (answerMode === "standard") {
      return {
        description: "target 2-4 sentences, max 900 chars",
        charMax: 900,
      };
    } else {
      return {
        description: "target 5-8 sentences, max 1600 chars",
        charMax: 1600,
      };
    }
  } else {
    if (answerMode === "standard") {
      return {
        description: "target ~250-400 words, max 1800 chars",
        charMax: 1800,
      };
    } else {
      return {
        description: "target ~600-900 words, max 5200 chars",
        charMax: 5200,
      };
    }
  }
}
