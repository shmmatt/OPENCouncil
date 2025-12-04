import { GoogleGenAI } from "@google/genai";
import { getOrCreateFileSearchStoreId } from "../gemini-store";
import type { RetrievalPlan, ChatHistoryMessage } from "./types";

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY || "" });

interface ComplexAnswerOptions {
  question: string;
  retrievalPlan: RetrievalPlan;
  sessionHistory: ChatHistoryMessage[];
}

interface ComplexDraftResult {
  draftAnswerText: string;
  sourceDocumentNames: string[];
}

export async function generateComplexDraftAnswer(
  options: ComplexAnswerOptions
): Promise<ComplexDraftResult> {
  const { question, retrievalPlan, sessionHistory } = options;

  const storeId = await getOrCreateFileSearchStoreId();

  if (!storeId) {
    return {
      draftAnswerText:
        "No documents have been uploaded yet. Please ask an administrator to upload municipal documents.",
      sourceDocumentNames: [],
    };
  }

  const allSourceDocumentNames: string[] = [];

  const retrievalPrompts = buildRetrievalPrompts(question, retrievalPlan);

  const retrievedSnippets: { source: string; content: string }[] = [];

  for (const prompt of retrievalPrompts) {
    try {
      const response = await ai.models.generateContent({
        model: "gemini-2.5-flash",
        contents: [{ role: "user", parts: [{ text: prompt.query }] }],
        config: {
          systemInstruction: `You are a document retrieval assistant. Extract relevant information from municipal documents to answer the query. Be thorough and include specific details, quotes, and section references when available. Format as structured excerpts.`,
          tools: [
            {
              fileSearch: {
                fileSearchStoreNames: [storeId],
              },
            } as any,
          ],
        },
      });

      const snippetContent = response.text || "";
      if (snippetContent.length > 50) {
        retrievedSnippets.push({
          source: prompt.sourceLabel,
          content: snippetContent,
        });
      }

      const docNames = extractSourceDocumentNames(response);
      allSourceDocumentNames.push(...docNames);
    } catch (error) {
      console.error(`Error in retrieval for ${prompt.sourceLabel}:`, error);
    }
  }

  const draftAnswerText = await synthesizeDraftAnswer(
    question,
    retrievedSnippets,
    sessionHistory,
    retrievalPlan
  );

  const uniqueDocNames = [...new Set(allSourceDocumentNames)];

  return {
    draftAnswerText,
    sourceDocumentNames: uniqueDocNames,
  };
}

interface RetrievalPrompt {
  query: string;
  sourceLabel: string;
}

function buildRetrievalPrompts(
  question: string,
  plan: RetrievalPlan
): RetrievalPrompt[] {
  const prompts: RetrievalPrompt[] = [];

  if (plan.filters.allowStatewideFallback) {
    const statewideQuery = buildQueryWithContext(
      question,
      plan.infoNeeds,
      "statewide",
      plan.filters.categories
    );
    prompts.push({
      query: statewideQuery,
      sourceLabel: "Statewide Handbooks & Guides",
    });
  }

  if (plan.filters.townPreference) {
    const localQuery = buildQueryWithContext(
      question,
      plan.infoNeeds,
      plan.filters.townPreference,
      plan.filters.categories
    );
    prompts.push({
      query: localQuery,
      sourceLabel: `${plan.filters.townPreference} Local Documents`,
    });
  }

  const needsMinutes =
    plan.infoNeeds.some(
      (need) =>
        need.toLowerCase().includes("example") ||
        need.toLowerCase().includes("precedent") ||
        need.toLowerCase().includes("case")
    ) ||
    plan.filters.categories.includes("meeting_minutes");

  if (needsMinutes) {
    const minutesQuery = `Find examples in meeting minutes related to: ${question}. Look for similar cases, precedents, or past decisions.`;
    prompts.push({
      query: minutesQuery,
      sourceLabel: "Meeting Minutes & Examples",
    });
  }

  if (prompts.length === 0) {
    prompts.push({
      query: question,
      sourceLabel: "General Documents",
    });
  }

  return prompts.slice(0, 3);
}

function buildQueryWithContext(
  question: string,
  infoNeeds: string[],
  townContext: string,
  categories: string[]
): string {
  const categoryStr = categories.length > 0 ? categories.join(", ") : "all";
  const needsStr =
    infoNeeds.length > 0
      ? `\n\nSpecifically looking for: ${infoNeeds.join("; ")}`
      : "";

  return `Context: ${townContext} municipal governance documents (categories: ${categoryStr})

Question: ${question}${needsStr}

Provide detailed relevant excerpts from the documents.`;
}

async function synthesizeDraftAnswer(
  question: string,
  snippets: { source: string; content: string }[],
  history: ChatHistoryMessage[],
  plan: RetrievalPlan
): Promise<string> {
  if (snippets.length === 0) {
    return "I was unable to find relevant information in the available documents to answer this question. Please try rephrasing your question or consult with your municipal attorney or NHMA directly.";
  }

  const snippetText = snippets
    .map((s) => `=== ${s.source} ===\n${s.content}`)
    .join("\n\n");

  const historyContext =
    history.length > 0
      ? `\nRecent conversation:\n${history
          .slice(-4)
          .map((m) => `${m.role}: ${m.content.slice(0, 200)}...`)
          .join("\n")}\n`
      : "";

  const synthesisPrompt = `Based on the following document excerpts, provide a comprehensive answer to the question.
${historyContext}
Question: ${question}

Document Excerpts:
${snippetText}

Instructions:
1. Synthesize information from multiple sources when applicable
2. Clearly distinguish between:
   - State law/RSA requirements (mandatory)
   - Best practices and guidance (recommended)
   - Local/town-specific requirements (varies by municipality)
3. Use headings or bullet points for complex answers
4. Cite specific documents or sections when possible
5. If sources conflict or are unclear, note the ambiguity
6. ${plan.filters.townPreference ? `Focus on ${plan.filters.townPreference} when specific local information is available` : "Provide statewide guidance when no specific town is mentioned"}

Provide a thorough, well-organized answer:`;

  try {
    const response = await ai.models.generateContent({
      model: "gemini-2.5-flash",
      contents: [{ role: "user", parts: [{ text: synthesisPrompt }] }],
      config: {
        systemInstruction: `You are an expert municipal governance assistant for New Hampshire. Synthesize information from multiple document sources to provide accurate, practical answers. Always distinguish between legal requirements and best practices. Be thorough but organized.`,
        temperature: 0.3,
      },
    });

    return response.text || "Unable to synthesize an answer from the retrieved documents.";
  } catch (error) {
    console.error("Error synthesizing draft answer:", error);
    return "I encountered an error while processing the retrieved documents. Please try again.";
  }
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

  return documentNames;
}
