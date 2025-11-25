import { GoogleGenAI } from "@google/genai";
import * as fs from "fs";
import { getOrCreateFileSearchStoreId, setFileSearchStoreId } from "./gemini-store";

// Initialize Gemini client with API key
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY || "" });

interface UploadResult {
  fileId: string;
  storeId: string;
}

export async function uploadDocumentToFileStore(
  filePath: string,
  filename: string,
  metadata: Record<string, string>
): Promise<UploadResult> {
  try {
    // Get or create File Search store
    let storeId = await getOrCreateFileSearchStoreId();
    
    if (!storeId) {
      const store = await ai.fileSearchStores.create({
        config: { display_name: "OPENCouncil Municipal Documents" },
      });
      storeId = store.name;
      setFileSearchStoreId(storeId);
      console.log(`Created File Search store: ${storeId}`);
    }

    // Upload and import file to File Search store
    const operation = await ai.fileSearchStores.uploadToFileSearchStore({
      file: filePath,
      file_search_store_name: storeId,
      config: {
        display_name: filename,
        chunking_config: {
          white_space_config: {
            max_tokens_per_chunk: 200,
            max_overlap_tokens: 20,
          },
        },
      },
    });

    // Wait for operation to complete
    let completedOp = operation;
    let attempts = 0;
    const maxAttempts = 30;
    
    while (!completedOp.done && attempts < maxAttempts) {
      await new Promise((resolve) => setTimeout(resolve, 2000));
      completedOp = await ai.operations.get(completedOp);
      attempts++;
    }

    if (!completedOp.done) {
      throw new Error("Document indexing timed out");
    }

    console.log(`Document uploaded and indexed: ${filename}`);

    return {
      fileId: completedOp.name || "uploaded",
      storeId: storeId,
    };
  } catch (error) {
    console.error("Error uploading to File Search:", error);
    throw new Error(`Failed to upload document: ${error}`);
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
        answer: "No documents have been uploaded yet. Please ask an administrator to upload municipal documents before using the chat feature.",
        citations: [],
      };
    }

    // Build conversation history
    const contents: any[] = [];
    
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
            file_search: {
              file_search_store_names: [storeId],
            },
          },
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
