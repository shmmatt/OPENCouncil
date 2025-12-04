import { GoogleGenAI } from "@google/genai";
import { getOrCreateFileSearchStoreId } from "../gemini-store";
import type { RouterOutput, ChatHistoryMessage } from "./types";

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY || "" });

interface SimpleAnswerOptions {
  question: string;
  routerOutput: RouterOutput;
  sessionHistory: ChatHistoryMessage[];
  userHints?: { town?: string; board?: string };
}

interface SimpleAnswerResult {
  answerText: string;
  sourceDocumentNames: string[];
}

export async function generateSimpleAnswer(
  options: SimpleAnswerOptions
): Promise<SimpleAnswerResult> {
  const { question, routerOutput, sessionHistory, userHints } = options;

  const storeId = await getOrCreateFileSearchStoreId();

  if (!storeId) {
    return {
      answerText:
        "No documents have been uploaded yet. Please ask an administrator to upload municipal documents before using the chat feature.",
      sourceDocumentNames: [],
    };
  }

  const contents: Array<{ role: string; parts: Array<{ text: string }> }> = [];

  sessionHistory.slice(-6).forEach((msg) => {
    contents.push({
      role: msg.role === "user" ? "user" : "model",
      parts: [{ text: msg.content }],
    });
  });

  const enhancedQuestion = buildEnhancedQuestion(
    routerOutput.rerankedQuestion || question,
    routerOutput.domains,
    userHints
  );

  contents.push({
    role: "user",
    parts: [{ text: enhancedQuestion }],
  });

  const systemInstruction = buildSimpleAnswerSystemPrompt(userHints);

  try {
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

    const answerText =
      response.text || "I apologize, but I couldn't generate a response.";

    const sourceDocumentNames = extractSourceDocumentNames(response);

    return { answerText, sourceDocumentNames };
  } catch (error) {
    console.error("Error generating simple answer:", error);
    return {
      answerText:
        "I apologize, but I'm having trouble accessing the document search system right now. Please try again in a moment.",
      sourceDocumentNames: [],
    };
  }
}

function buildEnhancedQuestion(
  question: string,
  domains: string[],
  userHints?: { town?: string; board?: string }
): string {
  let enhanced = question;

  if (userHints?.town && !question.toLowerCase().includes(userHints.town.toLowerCase())) {
    enhanced += ` (Context: ${userHints.town} town)`;
  }

  if (userHints?.board && !question.toLowerCase().includes(userHints.board.toLowerCase())) {
    enhanced += ` (Relevant board: ${userHints.board})`;
  }

  return enhanced;
}

function buildSimpleAnswerSystemPrompt(
  userHints?: { town?: string; board?: string }
): string {
  let townContext = "";
  if (userHints?.town) {
    townContext = `The user is asking about ${userHints.town}. Prioritize ${userHints.town}-specific documents when available, but you may reference statewide guidance if local information is not available.`;
  }

  return `You are an assistant helping small-town elected officials and public workers in New Hampshire.

${townContext}

Your role:
- Answer questions based ONLY on the provided municipal documents
- Provide concise, practical answers (2-4 sentences unless the question clearly needs more)
- Reference specific document titles or sections when answering
- If information is not in the documents, clearly state that and suggest consulting a municipal attorney or NHMA

Guidelines:
- Be conservative and accurate - don't speculate
- Use professional but accessible language
- Prioritize actionable guidance
- When citing, mention the document name clearly
- Prefer saying "I don't have specific information about this" over making assumptions

IMPORTANT: This is informational only, not legal advice. Users should consult town counsel or NHMA for formal legal opinions.`;
}

function extractSourceDocumentNames(response: any): string[] {
  const documentNames: string[] = [];

  if (response.candidates?.[0]?.groundingMetadata?.groundingChunks) {
    const chunks = response.candidates[0].groundingMetadata.groundingChunks;
    const seenDocs = new Set<string>();

    chunks.forEach((chunk: any) => {
      const uri = chunk.retrievedContext?.uri;
      if (uri && !seenDocs.has(uri)) {
        documentNames.push(uri);
        seenDocs.add(uri);
      }
      const title = chunk.web?.title;
      if (title && !seenDocs.has(title)) {
        documentNames.push(title);
        seenDocs.add(title);
      }
    });
  }

  if (response.candidates?.[0]?.groundingMetadata?.retrievalMetadata?.googleSearchDynamicRetrievalScore !== undefined) {
    const sources = response.candidates?.[0]?.groundingMetadata?.webSearchQueries;
    if (sources) {
      console.log("Web search was used:", sources);
    }
  }

  return documentNames;
}
