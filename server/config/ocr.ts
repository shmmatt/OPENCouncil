export type OcrProvider = 'none' | 'tesseract';

export interface OcrConfig {
  enabled: boolean;
  provider: OcrProvider;
  minCharThreshold: number;
}

export function getOcrConfig(): OcrConfig {
  const enabled = process.env.OCR_ENABLED !== 'false';
  const provider = (process.env.OCR_PROVIDER as OcrProvider) || 'tesseract';
  const minCharThreshold = parseInt(process.env.OCR_MIN_CHAR_THRESHOLD || '1200', 10);

  return {
    enabled,
    provider,
    minCharThreshold,
  };
}

export interface ShouldQueueOcrResult {
  queue: boolean;
  charCount: number;
  reason?: string;
}

// Common English words for quick dictionary check
const COMMON_WORDS = new Set([
  'the', 'be', 'to', 'of', 'and', 'a', 'in', 'that', 'have', 'i',
  'it', 'for', 'not', 'on', 'with', 'he', 'as', 'you', 'do', 'at',
  'this', 'but', 'his', 'by', 'from', 'they', 'we', 'say', 'her', 'she',
  'or', 'an', 'will', 'my', 'one', 'all', 'would', 'there', 'their', 'what',
  'so', 'up', 'out', 'if', 'about', 'who', 'get', 'which', 'go', 'me',
  'when', 'make', 'can', 'like', 'time', 'no', 'just', 'him', 'know', 'take',
  'people', 'into', 'year', 'your', 'good', 'some', 'could', 'them', 'see', 'other',
  'than', 'then', 'now', 'look', 'only', 'come', 'its', 'over', 'think', 'also',
  'back', 'after', 'use', 'two', 'how', 'our', 'work', 'first', 'well', 'way',
  'even', 'new', 'want', 'because', 'any', 'these', 'give', 'day', 'most', 'us',
  // Municipal/government words
  'town', 'board', 'meeting', 'vote', 'motion', 'member', 'minutes', 'public',
  'budget', 'property', 'tax', 'road', 'water', 'fire', 'police', 'school',
  'planning', 'zoning', 'permit', 'application', 'hearing', 'approval', 'denied',
  'selectmen', 'committee', 'department', 'office', 'resident', 'citizen',
]);

/**
 * Analyze text quality to determine if it's real readable text or garbage
 */
function analyzeTextQuality(text: string): {
  wordCount: number;
  avgWordLength: number;
  knownWordRatio: number;
  hasNormalSpacing: boolean;
  isLikelyGarbage: boolean;
} {
  if (!text || text.length < 50) {
    return {
      wordCount: 0,
      avgWordLength: 0,
      knownWordRatio: 0,
      hasNormalSpacing: false,
      isLikelyGarbage: true,
    };
  }

  // Extract words (letters only, 2+ chars)
  const words = text.toLowerCase().match(/[a-z]{2,}/g) || [];
  const wordCount = words.length;
  
  if (wordCount < 10) {
    return {
      wordCount,
      avgWordLength: 0,
      knownWordRatio: 0,
      hasNormalSpacing: false,
      isLikelyGarbage: true,
    };
  }

  // Calculate average word length (real text: 4-7, garbage: often 1-2 or 10+)
  const totalLength = words.reduce((sum, w) => sum + w.length, 0);
  const avgWordLength = totalLength / wordCount;

  // Check how many words are in our known word list
  const knownWords = words.filter(w => COMMON_WORDS.has(w)).length;
  const knownWordRatio = knownWords / Math.min(wordCount, 100); // Sample first 100 words

  // Check for normal spacing (real text has spaces ~every 5-6 chars on average)
  const spaceCount = (text.match(/\s/g) || []).length;
  const spaceRatio = spaceCount / text.length;
  const hasNormalSpacing = spaceRatio > 0.1 && spaceRatio < 0.3;

  // Determine if likely garbage
  // Good text: avg word length 3-10, known word ratio > 0.15, normal spacing
  const isLikelyGarbage = 
    avgWordLength < 2 || 
    avgWordLength > 15 || 
    knownWordRatio < 0.08 ||  // Less than 8% recognizable words
    !hasNormalSpacing;

  return {
    wordCount,
    avgWordLength: Math.round(avgWordLength * 10) / 10,
    knownWordRatio: Math.round(knownWordRatio * 100) / 100,
    hasNormalSpacing,
    isLikelyGarbage,
  };
}

export function shouldQueueOcr(
  extractedText: string | null,
  mimeType: string
): ShouldQueueOcrResult {
  const config = getOcrConfig();
  const charCount = extractedText?.length ?? 0;

  // Only PDF files need OCR consideration
  if (!mimeType.includes('pdf')) {
    return {
      queue: false,
      charCount,
      reason: 'OCR only applies to PDF files',
    };
  }

  // Very low char count = definitely needs OCR
  if (charCount < 100) {
    if (!config.enabled || config.provider === 'none') {
      return {
        queue: true,
        charCount,
        reason: 'Almost no text extracted, OCR needed but disabled',
      };
    }
    return {
      queue: true,
      charCount,
      reason: `Almost no text extracted (${charCount} chars), queuing for OCR`,
    };
  }

  // Analyze text quality
  const quality = analyzeTextQuality(extractedText || '');

  // If text quality is good, don't need OCR even if char count is lowish
  if (!quality.isLikelyGarbage && charCount >= 500) {
    return {
      queue: false,
      charCount,
      reason: `Text quality good (${quality.wordCount} words, ${Math.round(quality.knownWordRatio * 100)}% recognized)`,
    };
  }

  // If we have lots of chars but quality is garbage, still need OCR
  if (quality.isLikelyGarbage && charCount >= config.minCharThreshold) {
    if (!config.enabled || config.provider === 'none') {
      return {
        queue: true,
        charCount,
        reason: `Text appears garbled (${Math.round(quality.knownWordRatio * 100)}% recognized), OCR needed but disabled`,
      };
    }
    return {
      queue: true,
      charCount,
      reason: `Text appears garbled (${Math.round(quality.knownWordRatio * 100)}% recognized, avg word ${quality.avgWordLength} chars), queuing for OCR`,
    };
  }

  // Standard threshold check
  if (charCount >= config.minCharThreshold && !quality.isLikelyGarbage) {
    return {
      queue: false,
      charCount,
      reason: `Text extraction successful (${charCount} chars, quality OK)`,
    };
  }

  // Below threshold, queue for OCR
  if (!config.enabled) {
    return {
      queue: true,
      charCount,
      reason: 'OCR disabled - document will be blocked',
    };
  }

  if (config.provider === 'none') {
    return {
      queue: true,
      charCount,
      reason: 'No OCR provider configured - document will be blocked',
    };
  }

  return {
    queue: true,
    charCount,
    reason: `Text below threshold (${charCount} chars < ${config.minCharThreshold}), queuing for OCR`,
  };
}

export function getInitialOcrStatus(
  shouldQueue: boolean
): 'none' | 'queued' | 'blocked' {
  if (!shouldQueue) {
    return 'none';
  }

  const config = getOcrConfig();
  
  if (!config.enabled || config.provider === 'none') {
    return 'blocked';
  }

  return 'queued';
}
