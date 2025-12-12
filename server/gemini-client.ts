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
  // Minutes-specific fields
  isMinutes?: boolean;
  meetingDate?: string | null;
  meetingType?: string | null;
  rawDateText?: string | null;
}

interface UploadResult {
  fileId: string;
  storeId: string;
  displayName: string;
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
  metadata: DocumentMetadata
): Promise<UploadResult> {
  try {
    // Get or create File Search store
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

    // Build display name with metadata for better searchability
    const displayName = buildDisplayName(filename, metadata);

    // Build custom metadata for filtering (only include non-empty values)
    const customMetadata: Array<{ key: string; stringValue: string }> = [];
    
    // If isMinutes is true, force category to meeting_minutes
    const finalCategory = metadata.isMinutes ? "meeting_minutes" : metadata.category;
    
    // Category is always required
    customMetadata.push({ key: "category", stringValue: finalCategory });
    
    // Only add optional fields if they have values
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
    
    // Minutes-specific metadata
    if (metadata.isMinutes !== undefined) {
      customMetadata.push({ key: "isMinutes", stringValue: String(metadata.isMinutes) });
    }
    if (metadata.meetingDate) {
      customMetadata.push({ key: "meetingDate", stringValue: metadata.meetingDate });
    }
    if (metadata.meetingType) {
      customMetadata.push({ key: "meetingType", stringValue: metadata.meetingType });
    }

    // Determine MIME type from filename
    const mimeType = getMimeType(filename);

    // Upload and import file to File Search store
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

    // Log initial operation structure for debugging
    console.log("Upload operation response:", JSON.stringify(operation, null, 2));

    // The upload operation returns documentName directly in response - that's our file ID
    // No polling needed - the upload completes synchronously
    const opResponse = operation as any;
    
    // Extract the file ID from response.documentName
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
      displayName,
    };
  } catch (error) {
    console.error("Error uploading to File Search:", error);
    throw new Error(`Failed to upload document: ${error}`);
  }
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

interface AskQuestionOptions {
  question: string;
  chatHistory: Array<{ role: string; content: string }>;
}

interface AskQuestionResult {
  answer: string;
  citations: string[];
}

export interface GeminiDocument {
  name: string; // e.g., "fileSearchStores/{store_id}/documents/{doc_id}"
  displayName: string;
  createTime?: string;
  updateTime?: string;
  customMetadata?: Array<{ key: string; stringValue?: string; numericValue?: number }>;
}

/**
 * List all documents in the Gemini File Search store.
 * Returns documents with their internal IDs and display names.
 */
export async function listDocumentsInStore(): Promise<GeminiDocument[]> {
  const storeId = await getOrCreateFileSearchStoreId();
  
  if (!storeId) {
    console.log("[listDocumentsInStore] No store ID found");
    return [];
  }

  console.log(`[listDocumentsInStore] Listing documents in store: ${storeId}`);
  
  const allDocuments: GeminiDocument[] = [];
  
  try {
    // Use the documents.list API with pagination
    const documentsApi = (ai as any).fileSearchStores?.documents;
    
    if (!documentsApi || !documentsApi.list) {
      console.error("[listDocumentsInStore] Documents API not available in SDK");
      return [];
    }

    let pageToken: string | undefined;
    let pageCount = 0;
    
    do {
      pageCount++;
      console.log(`[listDocumentsInStore] Fetching page ${pageCount}...`);
      
      const config: any = { pageSize: 20 };
      if (pageToken) {
        config.pageToken = pageToken;
      }
      
      const response = await documentsApi.list({
        fileSearchStoreName: storeId,
        config,
      });
      
      // Handle paginated response
      const pager = response as any;
      
      // Try to iterate directly (modern SDK style)
      if (Symbol.iterator in pager || Symbol.asyncIterator in pager) {
        for await (const doc of pager) {
          allDocuments.push({
            name: doc.name,
            displayName: doc.displayName || doc.display_name,
            createTime: doc.createTime || doc.create_time,
            updateTime: doc.updateTime || doc.update_time,
            customMetadata: doc.customMetadata || doc.custom_metadata,
          });
        }
        break; // Iterator handles pagination internally
      }
      
      // Fallback: handle as array response
      const docs = pager.documents || pager.data || [];
      for (const doc of docs) {
        allDocuments.push({
          name: doc.name,
          displayName: doc.displayName || doc.display_name,
          createTime: doc.createTime || doc.create_time,
          updateTime: doc.updateTime || doc.update_time,
          customMetadata: doc.customMetadata || doc.custom_metadata,
        });
      }
      
      pageToken = pager.nextPageToken || pager.next_page_token;
    } while (pageToken && pageCount < 50); // Safety limit
    
    console.log(`[listDocumentsInStore] Found ${allDocuments.length} documents total`);
    
    // Log first few for debugging
    if (allDocuments.length > 0) {
      console.log("[listDocumentsInStore] Sample documents:");
      allDocuments.slice(0, 3).forEach((doc, i) => {
        console.log(`  [${i}] name: ${doc.name}`);
        console.log(`      displayName: ${doc.displayName}`);
      });
    }
    
    return allDocuments;
  } catch (error) {
    console.error("[listDocumentsInStore] Error:", error);
    return [];
  }
}

/**
 * Build a mapping from Gemini document names (internal IDs) to display names.
 * This helps resolve citations when Gemini returns internal IDs in grounding metadata.
 */
export async function buildDocumentIdMapping(): Promise<Map<string, GeminiDocument>> {
  const documents = await listDocumentsInStore();
  const mapping = new Map<string, GeminiDocument>();
  
  for (const doc of documents) {
    // Map by full name
    mapping.set(doc.name, doc);
    
    // Also map by just the document ID part (after last /)
    const docIdPart = doc.name.split('/').pop();
    if (docIdPart) {
      mapping.set(docIdPart, doc);
    }
  }
  
  console.log(`[buildDocumentIdMapping] Built mapping with ${mapping.size} entries`);
  return mapping;
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
