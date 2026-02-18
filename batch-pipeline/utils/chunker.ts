/**
 * Text chunking utility for embedding pipeline
 * Chunks text into ~500 token segments with overlap
 */

export interface TextChunk {
  index: number;
  content: string;
  charStart: number;
  charEnd: number;
}

// Rough token estimate: 1 token ≈ 4 characters for English text
const CHARS_PER_TOKEN = 4;
const TARGET_TOKENS = 500;
const OVERLAP_TOKENS = 50;

const TARGET_CHARS = TARGET_TOKENS * CHARS_PER_TOKEN;  // 2000 chars
const OVERLAP_CHARS = OVERLAP_TOKENS * CHARS_PER_TOKEN; // 200 chars

/**
 * Split text into chunks suitable for embedding
 * - Target size: ~500 tokens (2000 chars)
 * - Overlap: ~50 tokens (200 chars) for context continuity
 * - Splits on sentence boundaries when possible
 */
export function chunkText(text: string): TextChunk[] {
  if (!text || text.trim().length === 0) {
    return [];
  }

  const chunks: TextChunk[] = [];
  let position = 0;
  let chunkIndex = 0;

  while (position < text.length) {
    // Calculate end position for this chunk
    let endPos = Math.min(position + TARGET_CHARS, text.length);
    
    // If not at the end, try to break on a sentence boundary
    if (endPos < text.length) {
      const searchStart = Math.max(position + TARGET_CHARS - 400, position);
      const searchEnd = Math.min(position + TARGET_CHARS + 200, text.length);
      const searchRegion = text.slice(searchStart, searchEnd);
      
      // Look for sentence endings: . ! ? followed by space or newline
      const sentenceEnd = searchRegion.search(/[.!?]\s/);
      if (sentenceEnd !== -1) {
        endPos = searchStart + sentenceEnd + 1; // Include the punctuation
      } else {
        // Fall back to paragraph break
        const paragraphBreak = searchRegion.indexOf('\n\n');
        if (paragraphBreak !== -1) {
          endPos = searchStart + paragraphBreak;
        }
      }
    }

    const chunkContent = text.slice(position, endPos).trim();
    
    if (chunkContent.length > 0) {
      chunks.push({
        index: chunkIndex,
        content: chunkContent,
        charStart: position,
        charEnd: endPos,
      });
      chunkIndex++;
    }

    // Move position forward, accounting for overlap
    if (endPos >= text.length) {
      break;
    }
    position = endPos - OVERLAP_CHARS;
    if (position <= chunks[chunks.length - 1]?.charStart) {
      position = endPos; // Prevent infinite loop on very small chunks
    }
  }

  return chunks;
}

/**
 * Estimate token count for text
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}
