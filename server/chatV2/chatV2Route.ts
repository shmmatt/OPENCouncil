import type { Express, Request, Response } from "express";
import { storage } from "../storage";
import { routeQuestion } from "./router";
import { generateSimpleAnswer } from "./simpleAnswer";
import { planRetrieval } from "./retrievalPlanner";
import { generateComplexDraftAnswer } from "./complexAnswer";
import { critiqueAndImproveAnswer } from "./critic";
import { mapFileSearchDocumentsToCitations } from "./sources";
import type {
  ChatV2Request,
  ChatV2Response,
  ChatHistoryMessage,
  CriticScore,
  FinalAnswerMeta,
  SourceCitation,
} from "./types";

export function registerChatV2Routes(app: Express): void {
  app.post("/api/chat/v2/sessions/:sessionId/messages", async (req: Request, res: Response) => {
    const startTime = Date.now();

    try {
      const { sessionId } = req.params;
      const { content, metadata }: ChatV2Request = req.body;

      if (!content || !content.trim()) {
        return res.status(400).json({ message: "Message content is required" });
      }

      const session = await storage.getChatSessionById(sessionId);
      if (!session) {
        return res.status(404).json({ message: "Chat session not found" });
      }

      const allMessages = await storage.getMessagesBySessionId(sessionId);

      const recentDuplicateWindow = 120000;
      const now = Date.now();
      const trimmedContent = content.trim();

      const recentDuplicate = allMessages.find((m) => {
        if (m.role !== "user") return false;
        if (m.content !== trimmedContent) return false;
        const messageAge = now - new Date(m.createdAt).getTime();
        return messageAge < recentDuplicateWindow;
      });

      if (recentDuplicate) {
        console.log(`[ChatV2] Detected duplicate message within ${recentDuplicateWindow}ms window, checking for existing response...`);

        const messagesAfterDuplicate = allMessages.filter(
          (m) => new Date(m.createdAt) > new Date(recentDuplicate.createdAt) && m.role === "assistant"
        );

        if (messagesAfterDuplicate.length > 0) {
          const existingResponse = messagesAfterDuplicate[0];
          console.log("[ChatV2] Found existing response, returning cached result");

          const cachedData = parseCachedV2Response(existingResponse.citations);
          const response: ChatV2Response = {
            message: {
              id: existingResponse.id,
              sessionId,
              role: "assistant",
              content: existingResponse.content,
              createdAt: existingResponse.createdAt.toISOString(),
            },
            answerMeta: cachedData.answerMeta,
            sources: cachedData.sources,
            suggestedFollowUps: cachedData.suggestedFollowUps,
          };
          return res.json(response);
        }

        console.log("[ChatV2] No response found for duplicate message, processing may still be in progress. Waiting...");
        await new Promise((resolve) => setTimeout(resolve, 5000));

        const refreshedMessages = await storage.getMessagesBySessionId(sessionId);
        const laterResponses = refreshedMessages.filter(
          (m) => new Date(m.createdAt) > new Date(recentDuplicate.createdAt) && m.role === "assistant"
        );

        if (laterResponses.length > 0) {
          const existingResponse = laterResponses[0];
          console.log("[ChatV2] Found response after waiting, returning cached result");

          const cachedData = parseCachedV2Response(existingResponse.citations);
          const response: ChatV2Response = {
            message: {
              id: existingResponse.id,
              sessionId,
              role: "assistant",
              content: existingResponse.content,
              createdAt: existingResponse.createdAt.toISOString(),
            },
            answerMeta: cachedData.answerMeta,
            sources: cachedData.sources,
            suggestedFollowUps: cachedData.suggestedFollowUps,
          };
          return res.json(response);
        }
      }

      const userMessage = await storage.createChatMessage({
        sessionId,
        role: "user",
        content: trimmedContent,
        citations: null,
      });

      const chatHistory: ChatHistoryMessage[] = allMessages
        .map((m) => ({
          role: m.role as "user" | "assistant",
          content: m.content,
        }));

      console.log(`[ChatV2] Starting pipeline for question: "${content.trim().slice(0, 100)}..."`);

      const routerOutput = await routeQuestion(
        content.trim(),
        chatHistory.slice(-6),
        metadata
      );

      console.log(`[ChatV2] Router decision: complexity=${routerOutput.complexity}, domains=${routerOutput.domains.join(",")}, clarification=${routerOutput.requiresClarification}`);

      if (routerOutput.requiresClarification && routerOutput.clarificationQuestions.length > 0) {
        const clarificationText = buildClarificationResponse(routerOutput.clarificationQuestions);

        const clarificationMeta: FinalAnswerMeta = {
          complexity: routerOutput.complexity,
          requiresClarification: true,
          criticScore: { relevance: 1, completeness: 1, clarity: 1, riskOfMisleading: 0 },
        };

        const clarificationV2Metadata = {
          v2: true,
          answerMeta: clarificationMeta,
          sources: [],
          suggestedFollowUps: [],
        };

        const assistantMessage = await storage.createChatMessage({
          sessionId,
          role: "assistant",
          content: clarificationText,
          citations: JSON.stringify(clarificationV2Metadata),
        });

        const response: ChatV2Response = {
          message: {
            id: assistantMessage.id,
            sessionId,
            role: "assistant",
            content: clarificationText,
            createdAt: assistantMessage.createdAt.toISOString(),
          },
          answerMeta: clarificationMeta,
          sources: [],
          suggestedFollowUps: [],
        };

        return res.json(response);
      }

      let answerText: string;
      let sourceDocumentNames: string[] = [];
      let criticScore: CriticScore = { relevance: 1, completeness: 1, clarity: 1, riskOfMisleading: 0 };
      let limitationsNote: string | undefined;
      let suggestedFollowUps: string[] = [];

      if (routerOutput.complexity === "simple") {
        console.log("[ChatV2] Taking simple path...");

        const simpleResult = await generateSimpleAnswer({
          question: content.trim(),
          routerOutput,
          sessionHistory: chatHistory,
          userHints: metadata,
        });

        answerText = simpleResult.answerText;
        sourceDocumentNames = simpleResult.sourceDocumentNames;

      } else {
        console.log("[ChatV2] Taking complex path...");

        const retrievalPlan = await planRetrieval({
          question: content.trim(),
          routerOutput,
          userHints: metadata,
        });

        console.log(`[ChatV2] Retrieval plan: categories=${retrievalPlan.filters.categories.join(",")}, town=${retrievalPlan.filters.townPreference || "statewide"}`);

        const draftResult = await generateComplexDraftAnswer({
          question: content.trim(),
          retrievalPlan,
          sessionHistory: chatHistory,
        });

        sourceDocumentNames = draftResult.sourceDocumentNames;

        console.log("[ChatV2] Running critic...");

        const critiqueResult = await critiqueAndImproveAnswer({
          question: content.trim(),
          draftAnswerText: draftResult.draftAnswerText,
          routerOutput,
          retrievalPlan,
        });

        answerText = critiqueResult.improvedAnswerText;
        criticScore = critiqueResult.criticScore;
        limitationsNote = critiqueResult.limitationsNote;
        suggestedFollowUps = critiqueResult.suggestedFollowUps;

        console.log(`[ChatV2] Critic scores: relevance=${criticScore.relevance}, completeness=${criticScore.completeness}, clarity=${criticScore.clarity}, risk=${criticScore.riskOfMisleading}`);
      }

      const sources = await mapFileSearchDocumentsToCitations(sourceDocumentNames);

      const answerMeta: FinalAnswerMeta = {
        complexity: routerOutput.complexity,
        requiresClarification: false,
        criticScore,
        limitationsNote,
      };

      const v2Metadata = {
        v2: true,
        answerMeta,
        sources,
        suggestedFollowUps,
      };

      const assistantMessage = await storage.createChatMessage({
        sessionId,
        role: "assistant",
        content: answerText,
        citations: JSON.stringify(v2Metadata),
      });

      if (chatHistory.filter((m) => m.role === "user").length === 0) {
        const title = content.trim().slice(0, 60) + (content.trim().length > 60 ? "..." : "");
        await storage.updateChatSession(sessionId, { title });
      }

      const response: ChatV2Response = {
        message: {
          id: assistantMessage.id,
          sessionId,
          role: "assistant",
          content: answerText,
          createdAt: assistantMessage.createdAt.toISOString(),
        },
        answerMeta,
        sources,
        suggestedFollowUps,
      };

      const duration = Date.now() - startTime;
      console.log(`[ChatV2] Pipeline completed in ${duration}ms`);

      return res.json(response);
    } catch (error) {
      console.error("[ChatV2] Pipeline error:", error);

      try {
        const { sessionId } = req.params;

        const errorMessage = await storage.createChatMessage({
          sessionId,
          role: "assistant",
          content: "I apologize, but something went wrong while analyzing your question. Please try again or simplify your question. If the problem persists, contact your administrator.",
          citations: null,
        });

        const errorResponse: ChatV2Response = {
          message: {
            id: errorMessage.id,
            sessionId,
            role: "assistant",
            content: errorMessage.content,
            createdAt: errorMessage.createdAt.toISOString(),
          },
          answerMeta: {
            complexity: "simple",
            requiresClarification: false,
            criticScore: { relevance: 0, completeness: 0, clarity: 0, riskOfMisleading: 1 },
            limitationsNote: "An error occurred during processing.",
          },
          sources: [],
          suggestedFollowUps: [],
        };

        return res.json(errorResponse);
      } catch (saveError) {
        console.error("[ChatV2] Failed to save error message:", saveError);
        return res.status(500).json({
          message: error instanceof Error ? error.message : "Failed to process message",
        });
      }
    }
  });
}

function buildClarificationResponse(questions: string[]): string {
  if (questions.length === 1) {
    return `Before I can answer, I need a bit more information:\n\n${questions[0]}`;
  }

  const questionList = questions.map((q, i) => `${i + 1}. ${q}`).join("\n");
  return `Before I can provide a complete answer, I have a few clarifying questions:\n\n${questionList}\n\nPlease provide any details you can, and I'll give you a more accurate response.`;
}

interface CachedV2Data {
  answerMeta: FinalAnswerMeta;
  sources: SourceCitation[];
  suggestedFollowUps: string[];
}

function parseCachedV2Response(citations: string | null): CachedV2Data {
  const defaultData: CachedV2Data = {
    answerMeta: {
      complexity: "simple",
      requiresClarification: false,
      criticScore: { relevance: 1, completeness: 1, clarity: 1, riskOfMisleading: 0 },
    },
    sources: [],
    suggestedFollowUps: [],
  };

  if (!citations) {
    return defaultData;
  }

  try {
    const parsed = JSON.parse(citations);

    if (parsed.v2 === true) {
      return {
        answerMeta: parsed.answerMeta || defaultData.answerMeta,
        sources: Array.isArray(parsed.sources) ? parsed.sources : [],
        suggestedFollowUps: Array.isArray(parsed.suggestedFollowUps) ? parsed.suggestedFollowUps : [],
      };
    }

    return defaultData;
  } catch (error) {
    return defaultData;
  }
}
