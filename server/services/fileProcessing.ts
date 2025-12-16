import * as crypto from "crypto";
import * as fs from "fs/promises";
import * as path from "path";

let pdfParseModule: ((buffer: Buffer, options?: any) => Promise<{ text: string }>) | null = null;
let mammothModule: { extractRawText: (options: { path: string }) => Promise<{ value: string }> } | null = null;

async function getPdfParser(): Promise<(buffer: Buffer, options?: any) => Promise<{ text: string }>> {
  if (!pdfParseModule) {
    // Use direct path to avoid pdf-parse trying to load test files in production
    // @ts-ignore - pdf-parse types don't include this path but it works at runtime
    const mod = await import("pdf-parse/lib/pdf-parse.js");
    pdfParseModule = (mod as any).default || mod;
  }
  return pdfParseModule!;
}

async function getMammoth(): Promise<{ extractRawText: (options: { path: string }) => Promise<{ value: string }> }> {
  if (!mammothModule) {
    const mod = await import("mammoth");
    mammothModule = mod as any;
  }
  return mammothModule!;
}

export function computeRawHash(fileBuffer: Buffer): string {
  return crypto.createHash("sha256").update(fileBuffer).digest("hex");
}

export function computePreviewHash(previewText: string): string {
  return crypto.createHash("sha256").update(previewText).digest("hex");
}

export async function extractPreviewText(
  filePath: string,
  filename: string,
  maxLength: number = 15000
): Promise<string> {
  const ext = path.extname(filename).toLowerCase();
  
  try {
    if (ext === ".pdf") {
      const pdfParse = await getPdfParser();
      const dataBuffer = await fs.readFile(filePath);
      const pdfData = await pdfParse(dataBuffer, {
        max: 5, // First 5 pages
      });
      return pdfData.text.slice(0, maxLength);
    } else if (ext === ".txt") {
      const text = await fs.readFile(filePath, "utf-8");
      return text.slice(0, maxLength);
    } else if (ext === ".docx") {
      try {
        const mammoth = await getMammoth();
        const result = await mammoth.extractRawText({ path: filePath });
        return result.value.slice(0, maxLength);
      } catch (docxError) {
        console.error(`Error extracting DOCX text:`, docxError);
        return "";
      }
    }
    
    return "";
  } catch (error) {
    console.error(`Error extracting text from ${filename}:`, error);
    return "";
  }
}

export function getMimeType(filename: string): string {
  const ext = filename.toLowerCase().split('.').pop();
  switch (ext) {
    case 'pdf':
      return 'application/pdf';
    case 'docx':
      return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    case 'doc':
      return 'application/msword';
    case 'txt':
      return 'text/plain';
    default:
      return 'application/octet-stream';
  }
}

export interface FileProcessingResult {
  rawHash: string;
  previewHash: string | null;
  previewText: string;
  sizeBytes: number;
  mimeType: string;
}

export async function processFile(
  filePath: string,
  filename: string
): Promise<FileProcessingResult> {
  const fileBuffer = await fs.readFile(filePath);
  
  const rawHash = computeRawHash(fileBuffer);
  const previewText = await extractPreviewText(filePath, filename);
  const previewHash = previewText ? computePreviewHash(previewText) : null;
  const sizeBytes = fileBuffer.length;
  const mimeType = getMimeType(filename);
  
  return {
    rawHash,
    previewHash,
    previewText,
    sizeBytes,
    mimeType,
  };
}

export interface DuplicateCheckResult {
  isExactDuplicate: boolean;
  isPreviewMatch: boolean;
  existingFilename?: string;
  existingBlobId?: string;
  message?: string;
}

export function formatDuplicateWarning(result: DuplicateCheckResult): string | null {
  if (result.isExactDuplicate) {
    return `exact_duplicate:${result.existingFilename || result.existingBlobId}`;
  }
  if (result.isPreviewMatch) {
    return `preview_match:${result.existingFilename || result.existingBlobId}`;
  }
  return null;
}
