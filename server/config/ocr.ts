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

export function shouldQueueOcr(
  extractedText: string | null,
  mimeType: string
): ShouldQueueOcrResult {
  const config = getOcrConfig();
  const charCount = extractedText?.length ?? 0;

  if (!mimeType.includes('pdf')) {
    return {
      queue: false,
      charCount,
      reason: 'OCR only applies to PDF files',
    };
  }

  if (charCount >= config.minCharThreshold) {
    return {
      queue: false,
      charCount,
      reason: `Text extraction successful (${charCount} chars >= ${config.minCharThreshold} threshold)`,
    };
  }

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
