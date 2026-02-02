import * as fs from "fs/promises";
import * as path from "path";
import { 
  suggestMetadataFromPreview, 
  inferMetadataFromFilename, 
  type SuggestedMetadata 
} from "./services/metadataExtraction";

let pdfParseModule: ((buffer: Buffer, options?: any) => Promise<{ text: string }>) | null = null;

async function getPdfParser(): Promise<(buffer: Buffer, options?: any) => Promise<{ text: string }>> {
  if (!pdfParseModule) {
    // Use direct path to avoid pdf-parse trying to load test files in production
    // @ts-ignore - pdf-parse types don't include this path but it works at runtime
    const mod = await import("pdf-parse/lib/pdf-parse.js");
    pdfParseModule = (mod as any).default || mod;
  }
  return pdfParseModule!;
}

// Re-export types and functions from metadataExtraction
export type { SuggestedMetadata };
export { inferMetadataFromFilename };

export async function extractPreviewText(filePath: string, filename: string): Promise<string> {
  const ext = path.extname(filename).toLowerCase();
  
  try {
    if (ext === ".pdf") {
      const pdfParse = await getPdfParser();
      const dataBuffer = await fs.readFile(filePath);
      const pdfData = await pdfParse(dataBuffer, {
        max: 5,
      });
      const text = pdfData.text.slice(0, 15000);
      return text;
    } else if (ext === ".txt") {
      const text = await fs.readFile(filePath, "utf-8");
      return text.slice(0, 15000);
    } else if (ext === ".docx") {
      return "";
    }
    
    return "";
  } catch (error) {
    console.error(`Error extracting text from ${filename}:`, error);
    return "";
  }
}

export async function suggestMetadataFromContent(
  filename: string, 
  preview: string
): Promise<SuggestedMetadata> {
  // Delegate to the centralized metadata extraction service
  return suggestMetadataFromPreview(filename, preview);
}
