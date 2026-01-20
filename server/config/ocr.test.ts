import { shouldQueueOcr, getInitialOcrStatus, getOcrConfig } from './ocr';

describe('OCR Configuration', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.resetModules();
    process.env = { ...originalEnv };
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  describe('shouldQueueOcr', () => {
    it('should not queue non-PDF files', () => {
      const result = shouldQueueOcr('some text content', 'text/plain');
      expect(result.queue).toBe(false);
      expect(result.charCount).toBe(17);
      expect(result.reason).toContain('only applies to PDF');
    });

    it('should not queue PDF with sufficient text', () => {
      const longText = 'x'.repeat(1500);
      const result = shouldQueueOcr(longText, 'application/pdf');
      expect(result.queue).toBe(false);
      expect(result.charCount).toBe(1500);
      expect(result.reason).toContain('Text extraction successful');
    });

    it('should queue PDF with insufficient text', () => {
      const shortText = 'x'.repeat(100);
      const result = shouldQueueOcr(shortText, 'application/pdf');
      expect(result.queue).toBe(true);
      expect(result.charCount).toBe(100);
      expect(result.reason).toContain('Text below threshold');
    });

    it('should queue PDF with null text', () => {
      const result = shouldQueueOcr(null, 'application/pdf');
      expect(result.queue).toBe(true);
      expect(result.charCount).toBe(0);
    });

    it('should queue PDF with empty text', () => {
      const result = shouldQueueOcr('', 'application/pdf');
      expect(result.queue).toBe(true);
      expect(result.charCount).toBe(0);
    });

    it('should respect custom threshold from env', () => {
      process.env.OCR_MIN_CHAR_THRESHOLD = '500';
      
      const { shouldQueueOcr: freshShouldQueueOcr } = require('./ocr');
      
      const result = freshShouldQueueOcr('x'.repeat(600), 'application/pdf');
      expect(result.queue).toBe(false);
    });
  });

  describe('getInitialOcrStatus', () => {
    it('should return "none" when not queuing', () => {
      const result = getInitialOcrStatus(false);
      expect(result).toBe('none');
    });

    it('should return "queued" when OCR is enabled', () => {
      process.env.OCR_ENABLED = 'true';
      process.env.OCR_PROVIDER = 'tesseract';
      
      const { getInitialOcrStatus: freshGetStatus } = require('./ocr');
      const result = freshGetStatus(true);
      expect(result).toBe('queued');
    });

    it('should return "blocked" when OCR is disabled', () => {
      process.env.OCR_ENABLED = 'false';
      
      const { getInitialOcrStatus: freshGetStatus } = require('./ocr');
      const result = freshGetStatus(true);
      expect(result).toBe('blocked');
    });

    it('should return "blocked" when no provider is configured', () => {
      process.env.OCR_ENABLED = 'true';
      process.env.OCR_PROVIDER = 'none';
      
      const { getInitialOcrStatus: freshGetStatus } = require('./ocr');
      const result = freshGetStatus(true);
      expect(result).toBe('blocked');
    });
  });
});
