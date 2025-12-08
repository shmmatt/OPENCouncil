import { randomUUID } from "crypto";
import type { Express, Request, Response } from "express";
import { storage } from "../storage";
import { routeQuestion } from "./router";
import { generateSimpleAnswer } from "./simpleAnswer";
import { planRetrieval } from "./retrievalPlanner";
import { generateComplexDraftAnswer } from "./complexAnswer";
import { critiqueAndImproveAnswer } from "./critic";
import { generateFollowups } from "./generateFollowups";
import { mapFileSearchDocumentsToCitations } from "./sources";
import { logInfo, logDebug, logError, logWarn, sanitizeUserContent } from "../utils/logger";
import { shouldRunCritic } from "./chatConfig";
import { GeminiQuotaExceededError, getQuotaExceededMessage } from "../utils/geminiErrors";
import {
  shouldBypassRouterForFollowup,
  createBypassedRouterOutput,
  buildTrimmedHistoryForAnswer,
} from "./pipelineUtils";
import type {
  ChatV2Request,
  ChatV2Response,
  ChatHistoryMessage,
  CriticScore,
  FinalAnswerMeta,
  SourceCitation,
  PipelineLogContext,
} from "./types";

export function registerChatV2Routes(app: Express): void {
  app.post("/api/chat/v2/sessions/:sessionId/messages", async (req: Request, res: Response) => {
    const startTime = Date.now();
    const requestId = randomUUID();
    const { sessionId } = req.params;

    const logCtx: PipelineLogContext = { requestId, sessionId };

    try {
      const { content, metadata }: ChatV2Request = req.body;

      logInfo("chat_v2_request_received", {
        ...logCtx,
        stage: "entry",
        userQuestion: sanitizeUserContent(content, 200),
        userMetadata: metadata,
      });

      if (!content || !content.trim()) {
        logWarn("chat_v2_invalid_request", {
          ...logCtx,
          stage: "validation",
          reason: "empty_content",
        });
        return res.status(400).json({ message: "Message content is required" });
      }

      const session = await storage.getChatSessionById(sessionId);
      if (!session) {
        logWarn("chat_v2_session_not_found", {
          ...logCtx,
          stage: "validation",
        });
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
        logDebug("chat_v2_duplicate_detected", {
          ...logCtx,
          stage: "dedup",
          duplicateWindowMs: recentDuplicateWindow,
        });

        const messagesAfterDuplicate = allMessages.filter(
          (m) => new Date(m.createdAt) > new Date(recentDuplicate.createdAt) && m.role === "assistant"
        );

        if (messagesAfterDuplicate.length > 0) {
          const existingResponse = messagesAfterDuplicate[0];
          logInfo("chat_v2_cached_response_returned", {
            ...logCtx,
            stage: "dedup",
          });

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

        logDebug("chat_v2_duplicate_waiting", {
          ...logCtx,
          stage: "dedup",
        });
        await new Promise((resolve) => setTimeout(resolve, 5000));

        const refreshedMessages = await storage.getMessagesBySessionId(sessionId);
        const laterResponses = refreshedMessages.filter(
          (m) => new Date(m.createdAt) > new Date(recentDuplicate.createdAt) && m.role === "assistant"
        );

        if (laterResponses.length > 0) {
          const existingResponse = laterResponses[0];
          logInfo("chat_v2_cached_response_after_wait", {
            ...logCtx,
            stage: "dedup",
          });

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

      const bypassRouter = shouldBypassRouterForFollowup(chatHistory, content.trim());

      logDebug("chat_v2_pipeline_start", {
        ...logCtx,
        stage: "pipeline_start",
        historyLength: chatHistory.length,
        bypassRouter,
      });

      const routerOutput = bypassRouter
        ? createBypassedRouterOutput(chatHistory)
        : await routeQuestion(
            content.trim(),
            chatHistory.slice(-6),
            metadata,
            logCtx
          );

      logDebug("router_output", {
        ...logCtx,
        stage: "router",
        complexity: routerOutput.complexity,
        domains: routerOutput.domains,
        requiresClarification: routerOutput.requiresClarification,
        clarificationCount: routerOutput.clarificationQuestions.length,
      });

      if (routerOutput.requiresClarification && routerOutput.clarificationQuestions.length > 0) {
        logInfo("chat_v2_clarification_needed", {
          ...logCtx,
          stage: "clarification",
          questionCount: routerOutput.clarificationQuestions.length,
        });

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
      let criticUsed = false;

      let townPreference: string | undefined;

      if (routerOutput.complexity === "simple") {
        logDebug("chat_v2_simple_path", {
          ...logCtx,
          stage: "simple_path_start",
          domains: routerOutput.domains,
          bypassRouter,
        });

        const trimmedHistory = buildTrimmedHistoryForAnswer(chatHistory);

        const simpleResult = await generateSimpleAnswer({
          question: content.trim(),
          routerOutput,
          sessionHistory: trimmedHistory,
          userHints: metadata,
          logContext: logCtx,
        });

        answerText = simpleResult.answerText;
        sourceDocumentNames = simpleResult.sourceDocumentNames;
        townPreference = metadata?.town;

        logDebug("simple_answer_result", {
          ...logCtx,
          stage: "simpleAnswer",
          sourceCount: sourceDocumentNames.length,
          sourceDocNames: sourceDocumentNames.slice(0, 5),
          answerLength: answerText.length,
        });

        suggestedFollowUps = await generateFollowups({
          userQuestion: content.trim(),
          answerText,
          townPreference,
          detectedDomains: routerOutput.domains,
          logContext: logCtx,
        });

        logDebug("simple_path_followups_generated", {
          ...logCtx,
          stage: "generateFollowups",
          followUpCount: suggestedFollowUps.length,
        });

      } else {
        logDebug("chat_v2_complex_path", {
          ...logCtx,
          stage: "complex_path_start",
          domains: routerOutput.domains,
        });

        const retrievalPlan = await planRetrieval({
          question: content.trim(),
          routerOutput,
          userHints: metadata,
          logContext: logCtx,
        });

        logDebug("retrieval_plan", {
          ...logCtx,
          stage: "retrievalPlanner",
          categories: retrievalPlan.filters.categories,
          townPreference: retrievalPlan.filters.townPreference,
          allowStatewideFallback: retrievalPlan.filters.allowStatewideFallback,
          infoNeedsCount: retrievalPlan.infoNeeds.length,
          preferRecent: retrievalPlan.preferRecent,
        });

        const trimmedHistory = buildTrimmedHistoryForAnswer(chatHistory);

        const draftResult = await generateComplexDraftAnswer({
          question: content.trim(),
          retrievalPlan,
          sessionHistory: trimmedHistory,
          logContext: logCtx,
        });

        sourceDocumentNames = draftResult.sourceDocumentNames;

        logDebug("complex_answer_draft", {
          ...logCtx,
          stage: "complexAnswer",
          sourceCount: sourceDocumentNames.length,
          sourceDocNames: sourceDocumentNames.slice(0, 5),
          draftLength: draftResult.draftAnswerText.length,
        });

        const runCritic = shouldRunCritic(draftResult.draftAnswerText.length, content.trim());

        if (runCritic) {
          const critiqueResult = await critiqueAndImproveAnswer({
            question: content.trim(),
            draftAnswerText: draftResult.draftAnswerText,
            routerOutput,
            retrievalPlan,
            logContext: logCtx,
          });

          answerText = critiqueResult.improvedAnswerText;
          criticScore = critiqueResult.criticScore;
          limitationsNote = critiqueResult.limitationsNote;
          suggestedFollowUps = critiqueResult.suggestedFollowUps;
          criticUsed = true;

          logDebug("critic_result", {
            ...logCtx,
            stage: "critic",
            criticUsed: true,
            criticScore,
            limitationsNote: limitationsNote?.slice(0, 100),
            suggestedFollowUpCount: suggestedFollowUps.length,
          });

          if (suggestedFollowUps.length === 0) {
            suggestedFollowUps = await generateFollowups({
              userQuestion: content.trim(),
              answerText,
              townPreference: retrievalPlan.filters.townPreference,
              detectedDomains: routerOutput.domains,
              logContext: logCtx,
            });

            logDebug("complex_path_followups_generated_after_critic", {
              ...logCtx,
              stage: "generateFollowups",
              followUpCount: suggestedFollowUps.length,
            });
          }
        } else {
          answerText = draftResult.draftAnswerText;
          
          logDebug("critic_skipped", {
            ...logCtx,
            stage: "critic",
            criticUsed: false,
            reason: "gated_by_config",
            draftLength: draftResult.draftAnswerText.length,
          });

          suggestedFollowUps = await generateFollowups({
            userQuestion: content.trim(),
            answerText,
            townPreference: retrievalPlan.filters.townPreference,
            detectedDomains: routerOutput.domains,
            logContext: logCtx,
          });

          logDebug("complex_path_followups_generated", {
            ...logCtx,
            stage: "generateFollowups",
            followUpCount: suggestedFollowUps.length,
          });
        }
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

      logInfo("chat_v2_response_ready", {
        ...logCtx,
        stage: "exit",
        complexity: answerMeta.complexity,
        requiresClarification: answerMeta.requiresClarification,
        sourceCount: sources.length,
        sourceDocNames: sources.slice(0, 3).map((s) => s.title),
        suggestedFollowUpCount: suggestedFollowUps.length,
        bypassRouter,
        criticUsed,
        durationMs: duration,
        answerLength: answerText.length,
      });

      return res.json(response);
    } catch (error) {
      const duration = Date.now() - startTime;

      if (error instanceof GeminiQuotaExceededError) {
        logError("chat_v2_quota_exceeded", {
          ...logCtx,
          stage: "quota_error",
          error: error.message,
          durationMs: duration,
        });

        try {
          const quotaMessage = await storage.createChatMessage({
            sessionId,
            role: "assistant",
            content: getQuotaExceededMessage(),
            citations: null,
          });

          const quotaResponse: ChatV2Response = {
            message: {
              id: quotaMessage.id,
              sessionId,
              role: "assistant",
              content: quotaMessage.content,
              createdAt: quotaMessage.createdAt.toISOString(),
            },
            answerMeta: {
              complexity: "simple",
              requiresClarification: false,
              criticScore: { relevance: 0, completeness: 0, clarity: 0, riskOfMisleading: 0.5 },
              limitationsNote: "Quota limit reached.",
            },
            sources: [],
            suggestedFollowUps: [],
          };

          return res.json(quotaResponse);
        } catch (saveError) {
          return res.status(503).json({
            message: getQuotaExceededMessage(),
          });
        }
      }

      logError("chat_v2_request_error", {
        ...logCtx,
        stage: "error",
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack?.slice(0, 500) : undefined,
        durationMs: duration,
      });

      try {
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
        logError("chat_v2_save_error", {
          ...logCtx,
          stage: "error_save",
          error: saveError instanceof Error ? saveError.message : String(saveError),
        });
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
