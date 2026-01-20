import { GoogleGenAI } from "@google/genai";
import { getOrCreateFileSearchStoreId, setFileSearchStoreId } from "./gemini-store";

// Initialize Gemini client with API key
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY || "" });

export interface DocumentMetadata {
  category: string;
  town?: string;
  board?: string;
  year?: string;
  notes?: string;
  isMinutes?: boolean;
  meetingDate?: string | null;
  meetingType?: string | null;
  rawDateText?: string | null;
}

interface UploadResult {
  fileId: string;
  storeId: string;
}

interface RetryConfig {
  maxRetries: number;
  baseDelayMs: number;
  maxDelayMs: number;
}

const DEFAULT_RETRY_CONFIG: RetryConfig = {
  maxRetries: 5,
  baseDelayMs: 1000,
  maxDelayMs: 30000,
};

function isRetryableError(error: any): boolean {
  if (!error) return false;
  
  const errorMessage = error.message?.toLowerCase() || "";
  const errorCode = error.code || error.statusCode || error.status;
  
  if (errorCode === 503 || errorCode === "503") return true;
  if (errorCode === 429 || errorCode === "429") return true;
  if (errorCode === 500 || errorCode === "500") return true;
  if (errorCode === 502 || errorCode === "502") return true;
  if (errorCode === 504 || errorCode === "504") return true;
  
  if (errorMessage.includes("service unavailable")) return true;
  if (errorMessage.includes("temporarily unavailable")) return true;
  if (errorMessage.includes("rate limit")) return true;
  if (errorMessage.includes("quota exceeded")) return true;
  if (errorMessage.includes("timeout")) return true;
  if (errorMessage.includes("econnreset")) return true;
  if (errorMessage.includes("network error")) return true;
  
  return false;
}

function calculateBackoffDelay(attempt: number, config: RetryConfig): number {
  const exponentialDelay = config.baseDelayMs * Math.pow(2, attempt);
  const jitter = Math.random() * config.baseDelayMs;
  return Math.min(exponentialDelay + jitter, config.maxDelayMs);
}

async function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function getMimeType(filename: string): string {
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

export async function uploadDocumentToFileStore(
  filePath: string,
  filename: string,
  metadata: DocumentMetadata,
  retryConfig: RetryConfig = DEFAULT_RETRY_CONFIG
): Promise<UploadResult> {
  let lastError: Error | null = null;
  
  for (let attempt = 0; attempt <= retryConfig.maxRetries; attempt++) {
    try {
      return await attemptUploadToFileStore(filePath, filename, metadata);
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      
      if (attempt < retryConfig.maxRetries && isRetryableError(error)) {
        const delay = calculateBackoffDelay(attempt, retryConfig);
        console.warn(
          `File Search upload attempt ${attempt + 1}/${retryConfig.maxRetries + 1} failed with retryable error. ` +
          `Retrying in ${Math.round(delay)}ms...`,
          { error: lastError.message, filename }
        );
        await sleep(delay);
      } else {
        console.error(
          `File Search upload failed after ${attempt + 1} attempt(s)`,
          { error: lastError.message, filename, isRetryable: isRetryableError(error) }
        );
        break;
      }
    }
  }
  
  throw new Error(`Failed to upload document after ${retryConfig.maxRetries + 1} attempts: ${lastError?.message}`);
}

async function attemptUploadToFileStore(
  filePath: string,
  filename: string,
  metadata: DocumentMetadata
): Promise<UploadResult> {
  let storeId = await getOrCreateFileSearchStoreId();
  
  if (!storeId) {
    const store = await ai.fileSearchStores.create({
      config: { displayName: "OPENCouncil Municipal Documents" },
    });
    storeId = store.name || "";
    if (storeId) {
      setFileSearchStoreId(storeId);
      console.log(`Created File Search store: ${storeId}`);
    } else {
      throw new Error("Failed to create File Search store");
    }
  }

  const displayName = buildDisplayName(filename, metadata);
  const customMetadata: Array<{ key: string; stringValue: string }> = [];
  
  const finalCategory = metadata.isMinutes ? "meeting_minutes" : metadata.category;
  
  customMetadata.push({ key: "category", stringValue: finalCategory });
  
  if (metadata.town) {
    customMetadata.push({ key: "town", stringValue: metadata.town });
  }
  if (metadata.board) {
    customMetadata.push({ key: "board", stringValue: metadata.board });
  }
  if (metadata.year) {
    customMetadata.push({ key: "year", stringValue: metadata.year });
  }
  if (metadata.notes) {
    customMetadata.push({ key: "notes", stringValue: metadata.notes });
  }
  if (metadata.isMinutes !== undefined) {
    customMetadata.push({ key: "isMinutes", stringValue: String(metadata.isMinutes) });
  }
  if (metadata.meetingDate) {
    customMetadata.push({ key: "meetingDate", stringValue: metadata.meetingDate });
  }
  if (metadata.meetingType) {
    customMetadata.push({ key: "meetingType", stringValue: metadata.meetingType });
  }

  const mimeType = getMimeType(filename);

  const operation = await ai.fileSearchStores.uploadToFileSearchStore({
    file: filePath,
    fileSearchStoreName: storeId,
    config: {
      displayName: displayName,
      mimeType: mimeType,
      customMetadata: customMetadata,
      chunkingConfig: {
        whiteSpaceConfig: {
          maxTokensPerChunk: 200,
          maxOverlapTokens: 20,
        },
      },
    },
  });

  console.log("Upload operation response:", JSON.stringify(operation, null, 2));

  const opResponse = operation as any;
  
  let fileId = opResponse.response?.documentName 
            || opResponse.documentName
            || opResponse.response?.files?.[0]?.name;
  
  if (!fileId) {
    console.error("Could not find documentName in response");
    throw new Error("Failed to extract document ID from Gemini upload response");
  }
  
  console.log(`Extracted file ID: ${fileId}`);
  console.log(`Document uploaded and indexed: ${displayName}`);
  console.log(`File ID: ${fileId}`);
  console.log(`Metadata: category=${finalCategory}, town=${metadata.town || 'N/A'}, board=${metadata.board || 'N/A'}, year=${metadata.year || 'N/A'}, isMinutes=${metadata.isMinutes || false}, meetingDate=${metadata.meetingDate || 'N/A'}`);

  return {
    fileId,
    storeId: storeId,
  };
}

function buildDisplayName(filename: string, metadata: DocumentMetadata): string {
  const parts: string[] = [];
  
  if (metadata.town) parts.push(metadata.town);
  if (metadata.board) parts.push(metadata.board);
  
  // For minutes, prefer meetingDate over year
  if (metadata.isMinutes && metadata.meetingDate) {
    parts.push(`Meeting ${metadata.meetingDate}`);
  } else if (metadata.category) {
    parts.push(metadata.category.replace(/_/g, ' '));
  }
  
  if (!metadata.isMinutes && metadata.year) {
    parts.push(metadata.year);
  }
  
  const prefix = parts.length > 0 ? `[${parts.join(' - ')}] ` : '';
  return `${prefix}${filename}`;
}

import * as fs from "fs/promises";
import * as path from "path";

export interface ReindexOcrResult {
  fileId: string;
  storeId: string;
  charCount: number;
}

export async function reindexOcrDocument(
  ocrText: string,
  filename: string,
  metadata: DocumentMetadata,
  retryConfig: RetryConfig = DEFAULT_RETRY_CONFIG
): Promise<ReindexOcrResult> {
  let lastError: Error | null = null;
  
  for (let attempt = 0; attempt <= retryConfig.maxRetries; attempt++) {
    try {
      return await attemptReindexOcrDocument(ocrText, filename, metadata);
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      
      if (attempt < retryConfig.maxRetries && isRetryableError(error)) {
        const delay = calculateBackoffDelay(attempt, retryConfig);
        console.warn(
          `OCR reindex attempt ${attempt + 1}/${retryConfig.maxRetries + 1} failed with retryable error. ` +
          `Retrying in ${Math.round(delay)}ms...`,
          { error: lastError.message, filename }
        );
        await sleep(delay);
      } else {
        console.error(
          `OCR reindex failed after ${attempt + 1} attempt(s)`,
          { error: lastError.message, filename, isRetryable: isRetryableError(error) }
        );
        break;
      }
    }
  }
  
  throw new Error(`Failed to reindex OCR document after ${retryConfig.maxRetries + 1} attempts: ${lastError?.message}`);
}

async function attemptReindexOcrDocument(
  ocrText: string,
  filename: string,
  metadata: DocumentMetadata
): Promise<ReindexOcrResult> {
  let storeId = await getOrCreateFileSearchStoreId();
  
  if (!storeId) {
    const store = await ai.fileSearchStores.create({
      config: { displayName: "OPENCouncil Municipal Documents" },
    });
    storeId = store.name || "";
    if (storeId) {
      setFileSearchStoreId(storeId);
      console.log(`Created File Search store: ${storeId}`);
    } else {
      throw new Error("Failed to create File Search store");
    }
  }

  const tmpDir = path.join('/tmp', `ocr-reindex-${Date.now()}`);
  await fs.mkdir(tmpDir, { recursive: true });
  
  const baseFilename = filename.replace(/\.[^/.]+$/, '');
  const txtFilename = `${baseFilename}_ocr.txt`;
  const txtPath = path.join(tmpDir, txtFilename);
  
  try {
    await fs.writeFile(txtPath, ocrText, 'utf-8');
    
    const displayName = buildDisplayName(filename, metadata) + " [OCR]";
    const customMetadata: Array<{ key: string; stringValue: string }> = [];
    
    const finalCategory = metadata.isMinutes ? "meeting_minutes" : metadata.category;
    
    customMetadata.push({ key: "category", stringValue: finalCategory });
    customMetadata.push({ key: "source", stringValue: "ocr" });
    
    if (metadata.town) {
      customMetadata.push({ key: "town", stringValue: metadata.town });
    }
    if (metadata.board) {
      customMetadata.push({ key: "board", stringValue: metadata.board });
    }
    if (metadata.year) {
      customMetadata.push({ key: "year", stringValue: metadata.year });
    }
    if (metadata.notes) {
      customMetadata.push({ key: "notes", stringValue: metadata.notes });
    }
    if (metadata.isMinutes !== undefined) {
      customMetadata.push({ key: "isMinutes", stringValue: String(metadata.isMinutes) });
    }
    if (metadata.meetingDate) {
      customMetadata.push({ key: "meetingDate", stringValue: metadata.meetingDate });
    }
    if (metadata.meetingType) {
      customMetadata.push({ key: "meetingType", stringValue: metadata.meetingType });
    }

    const operation = await ai.fileSearchStores.uploadToFileSearchStore({
      file: txtPath,
      fileSearchStoreName: storeId,
      config: {
        displayName: displayName,
        mimeType: 'text/plain',
        customMetadata: customMetadata,
        chunkingConfig: {
          whiteSpaceConfig: {
            maxTokensPerChunk: 200,
            maxOverlapTokens: 20,
          },
        },
      },
    });

    const opResponse = operation as any;
    
    let fileId = opResponse.response?.documentName 
              || opResponse.documentName
              || opResponse.response?.files?.[0]?.name;
    
    if (!fileId) {
      console.error("Could not find documentName in OCR reindex response");
      throw new Error("Failed to extract document ID from Gemini OCR reindex response");
    }
    
    console.log(`[OCR Reindex] Successfully indexed: ${displayName}`);
    console.log(`[OCR Reindex] File ID: ${fileId}, ${ocrText.length} chars`);

    return {
      fileId,
      storeId: storeId,
      charCount: ocrText.length,
    };
  } finally {
    try {
      await fs.unlink(txtPath);
      await fs.rmdir(tmpDir);
    } catch (e) {
    }
  }
}

interface AskQuestionOptions {
  question: string;
  chatHistory: Array<{ role: string; content: string }>;
}

interface AskQuestionResult {
  answer: string;
  citations: string[];
}

export async function askQuestionWithFileSearch(
  options: AskQuestionOptions
): Promise<AskQuestionResult> {
  try {
    const storeId = await getOrCreateFileSearchStoreId();
    
    if (!storeId) {
      return {
        answer: "The OpenCouncil archive is not yet configured. Please contact your administrator to set up document indexing.",
        citations: [],
      };
    }

    // Build conversation history
    const contents: Array<{ role: string; parts: Array<{ text: string }> }> = [];
    
    // Add chat history
    options.chatHistory.slice(-10).forEach((msg) => {
      contents.push({
        role: msg.role === "user" ? "user" : "model",
        parts: [{ text: msg.content }],
      });
    });

    // Add current question
    contents.push({
      role: "user",
      parts: [{ text: options.question }],
    });

    const systemInstruction = `You are an assistant helping small-town elected officials and public workers in New Hampshire.

Your role:
- Answer questions based on documents indexed in the OpenCouncil archive (municipal budgets, minutes, town reports, ordinances, etc.)
- Provide concise, practical answers with clear citations
- Reference specific document titles or sections when answering
- When a clear, document-based answer is not possible, explain that no directly relevant material was found in the OpenCouncil archive, and provide carefully labeled general guidance based on New Hampshire practice or law

Guidelines:
- Be conservative and accurate - don't speculate
- Use professional but accessible language
- Prioritize actionable guidance
- When citing, mention the document name clearly
- Never use phrases like "your documents" or imply the user personally provided documents

All information is informational only and is not legal advice.`;

    // Call Gemini with File Search
    const response = await ai.models.generateContent({
      model: "gemini-2.5-flash",
      contents: contents,
      config: {
        systemInstruction: systemInstruction,
        tools: [
          {
            fileSearch: {
              fileSearchStoreNames: [storeId],
            },
          } as any,
        ],
      },
    });

    const answer = response.text || "No directly relevant material was found in the OpenCouncil archive for this question.";

    // Extract citations from grounding metadata
    const citations: string[] = [];
    if (response.candidates?.[0]?.groundingMetadata?.groundingChunks) {
      const chunks = response.candidates[0].groundingMetadata.groundingChunks;
      const seenDocs = new Set<string>();
      
      chunks.forEach((chunk: any) => {
        if (chunk.web?.title && !seenDocs.has(chunk.web.title)) {
          citations.push(chunk.web.title);
          seenDocs.add(chunk.web.title);
        }
      });
    }

    return { answer, citations };
  } catch (error) {
    console.error("Error asking question with File Search:", error);
    
    // Return a graceful error message instead of throwing
    return {
      answer: "The OpenCouncil archive is temporarily unavailable. Please try again in a moment.",
      citations: [],
    };
  }
}
