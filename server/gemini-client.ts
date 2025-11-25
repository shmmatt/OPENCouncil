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
}

interface UploadResult {
  fileId: string;
  storeId: string;
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
    
    // Category is always required
    customMetadata.push({ key: "category", stringValue: metadata.category });
    
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
    console.log(`Metadata: category=${metadata.category}, town=${metadata.town || 'N/A'}, board=${metadata.board || 'N/A'}, year=${metadata.year || 'N/A'}`);

    return {
      fileId,
      storeId: storeId,
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
  if (metadata.category) parts.push(metadata.category.replace(/_/g, ' '));
  if (metadata.year) parts.push(metadata.year);
  
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

export async function askQuestionWithFileSearch(
  options: AskQuestionOptions
): Promise<AskQuestionResult> {
  try {
    const storeId = await getOrCreateFileSearchStoreId();
    
    if (!storeId) {
      return {
        answer: "No documents have been uploaded yet. Please ask an administrator to upload municipal documents before using the chat feature.",
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
- Answer questions based ONLY on the provided municipal documents
- Provide concise, practical answers with clear citations
- Reference specific document titles or sections when answering
- If information is not in the documents, clearly state that and suggest consulting a municipal attorney or state association

Guidelines:
- Be conservative and accurate - don't speculate
- Use professional but accessible language
- Prioritize actionable guidance
- When citing, mention the document name clearly`;

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

    const answer = response.text || "I apologize, but I couldn't generate a response.";

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
      answer: "I apologize, but I'm having trouble accessing the document search system right now. Please try again in a moment. If the problem persists, contact your administrator.",
      citations: [],
    };
  }
}
