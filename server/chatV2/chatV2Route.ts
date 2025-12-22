import { randomUUID } from "crypto";
import type { Express, Response, NextFunction } from "express";
import type { IdentityRequest } from "../auth/types";
import { storage } from "../storage";
import { generateFollowups } from "./generateFollowups";
import { mapFileSearchDocumentsToCitations } from "./sources";
import { logInfo, logDebug, logError, logWarn, sanitizeUserContent } from "../utils/logger";
import { GeminiQuotaExceededError, getQuotaExceededMessage } from "../utils/geminiErrors";
import { resolveTownPreference, buildTrimmedHistoryForAnswer } from "./pipelineUtils";
import { runUnifiedChatPipeline } from "./unifiedPipeline";
import type {
  ChatV2Request,
  ChatV2Response,
  ChatHistoryMessage,
  CriticScore,
  FinalAnswerMeta,
  SourceCitation,
  PipelineLogContext,
  DocSourceType,
} from "./types";
import type { ChatNotice } from "@shared/chatNotices";
import multer from "multer";
import * as path from "path";
import * as fs from "fs/promises";
import { extractPreviewText, getMimeType } from "../services/fileProcessing";

const chatUpload = multer({
  dest: "uploads/chat/",
  limits: { fileSize: 25 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = ['.pdf', '.docx', '.txt'];
    const ext = path.extname(file.originalname).toLowerCase();
    if (allowed.includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error('Invalid file type. Only PDF, DOCX, and TXT files are allowed.'));
    }
  },
});

export function registerChatV2Routes(app: Express): void {
  app.post("/api/chat/v2/sessions/:sessionId/messages", async (req: IdentityRequest, res: Response) => {
    const startTime = Date.now();
    const requestId = randomUUID();
    const { sessionId } = req.params;

    const logCtx: PipelineLogContext = { requestId, sessionId, actor: req.actor };

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

      // Resolve town preference: explicit > session > actor > fallback (Ossipee)
      const resolvedTown = await resolveTownPreference({
        explicitTown: metadata?.town,
        sessionId,
        actor: req.actor,
      });

      logDebug("chat_v2_pipeline_start", {
        ...logCtx,
        stage: "pipeline_start",
        historyLength: chatHistory.length,
        resolvedTown,
      });

      // SIMPLIFIED PIPELINE: Two-lane retrieval + single synthesis
      const trimmedHistory = buildTrimmedHistoryForAnswer(chatHistory);
      
      const pipelineResult = await runUnifiedChatPipeline({
        question: trimmedContent,
        sessionHistory: trimmedHistory,
        townPreference: resolvedTown,
        logContext: logCtx,
      });

      const answerText = pipelineResult.answerText;
      const sourceDocumentNames = pipelineResult.sourceDocumentNames;
      const docSourceType = pipelineResult.docSourceType;
      const docSourceTown = pipelineResult.docSourceTown;
      
      // Generate follow-up suggestions
      const suggestedFollowUps = await generateFollowups({
        userQuestion: trimmedContent,
        answerText,
        townPreference: resolvedTown,
        detectedDomains: [],
        logContext: logCtx,
      });

      logDebug("unified_pipeline_complete_with_followups", {
        ...logCtx,
        stage: "unified_pipeline",
        answerLength: answerText.length,
        sourceCount: sourceDocumentNames.length,
        followUpCount: suggestedFollowUps.length,
        durationMs: pipelineResult.durationMs,
      });

      // Map sources to citations
      const sources = await mapFileSearchDocumentsToCitations(sourceDocumentNames);

      const answerMeta: FinalAnswerMeta = {
        complexity: "simple",
        requiresClarification: false,
        criticScore: { relevance: 1, completeness: 1, clarity: 1, riskOfMisleading: 0 },
      };

      const v2Metadata = {
        v2: true,
        answerMeta,
        sources,
        suggestedFollowUps,
        notices: [] as ChatNotice[],
      };

      const assistantMessage = await storage.createChatMessage({
        sessionId,
        role: "assistant",
        content: answerText,
        citations: JSON.stringify(v2Metadata),
      });

      if (chatHistory.filter((m) => m.role === "user").length === 0) {
        const title = trimmedContent.slice(0, 60) + (trimmedContent.length > 60 ? "..." : "");
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
        sourceCount: sources.length,
        suggestedFollowUpCount: suggestedFollowUps.length,
        durationMs: duration,
        answerLength: answerText.length,
        docSourceType,
        docSourceTown,
        retrievedChunkCount: pipelineResult.retrievedChunkCount,
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
          content: "An error occurred while processing this question. Please try again or simplify your question.",
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

  app.post(
    "/api/chat/v2/sessions/:sessionId/messages/upload",
    (req: IdentityRequest, res: Response, next: NextFunction) => {
      chatUpload.single("file")(req, res, (err: any) => {
        if (err) {
          if (err.code === 'LIMIT_FILE_SIZE') {
            return res.status(400).json({ message: "File too large. Maximum size is 25MB." });
          }
          if (err.message) {
            return res.status(400).json({ message: err.message });
          }
          return res.status(400).json({ message: "File upload failed" });
        }
        next();
      });
    },
    async (req: IdentityRequest, res: Response) => {
      const startTime = Date.now();
      const requestId = randomUUID();
      const { sessionId } = req.params;
      const uploadedFile = req.file;

      const logCtx: PipelineLogContext = { requestId, sessionId, actor: req.actor };

      try {
        const content = req.body.content || "";
        let metadata: { town?: string; board?: string } | undefined;
        
        try {
          if (req.body.metadata) {
            metadata = JSON.parse(req.body.metadata);
          }
        } catch {
          metadata = undefined;
        }

        logInfo("chat_v2_upload_request_received", {
          ...logCtx,
          stage: "entry",
          userQuestion: sanitizeUserContent(content, 200),
          hasFile: !!uploadedFile,
          filename: uploadedFile?.originalname,
        });

        if (!content.trim() && !uploadedFile) {
          return res.status(400).json({ message: "Message content or file is required" });
        }

        const session = await storage.getChatSessionById(sessionId);
        if (!session) {
          if (uploadedFile) {
            await fs.unlink(uploadedFile.path).catch(() => {});
          }
          return res.status(404).json({ message: "Chat session not found" });
        }

        let attachmentInfo: {
          filename: string;
          mimeType: string;
          extractedText: string;
        } | undefined;

        if (uploadedFile) {
          try {
            const extractedText = await extractPreviewText(
              uploadedFile.path,
              uploadedFile.originalname,
              30000
            );

            attachmentInfo = {
              filename: uploadedFile.originalname,
              mimeType: getMimeType(uploadedFile.originalname),
              extractedText: extractedText || "(File uploaded but text could not be extracted - file may contain images or be password protected)",
            };

            if (!extractedText || extractedText.trim().length === 0) {
              logWarn("chat_file_extraction_empty", {
                ...logCtx,
                stage: "file_extraction",
                filename: uploadedFile.originalname,
              });
            } else {
              logDebug("chat_file_extracted", {
                ...logCtx,
                stage: "file_extraction",
                filename: uploadedFile.originalname,
                extractedLength: extractedText.length,
              });
            }
          } catch (extractionError) {
            logError("chat_file_extraction_error", {
              ...logCtx,
              stage: "file_extraction",
              filename: uploadedFile.originalname,
              error: extractionError instanceof Error ? extractionError.message : String(extractionError),
            });
            // Still proceed with the upload, but note the extraction failed
            attachmentInfo = {
              filename: uploadedFile.originalname,
              mimeType: getMimeType(uploadedFile.originalname),
              extractedText: "(File uploaded but text extraction failed)",
            };
          } finally {
            await fs.unlink(uploadedFile.path).catch(() => {});
          }
        }

        const allMessages = await storage.getMessagesBySessionId(sessionId);
        const trimmedContent = content.trim();

        const displayContent = attachmentInfo
          ? `${trimmedContent}\n\n[Attached: ${attachmentInfo.filename}]`
          : trimmedContent;

        const userMessage = await storage.createChatMessage({
          sessionId,
          role: "user",
          content: displayContent,
          citations: null,
          attachmentFilename: attachmentInfo?.filename || null,
          attachmentMimeType: attachmentInfo?.mimeType || null,
          attachmentExtractedText: attachmentInfo?.extractedText || null,
        });

        const chatHistory: ChatHistoryMessage[] = allMessages
          .map((m) => ({
            role: m.role as "user" | "assistant",
            content: m.content,
          }));

        const resolvedTown = await resolveTownPreference({
          explicitTown: metadata?.town,
          sessionId,
          actor: req.actor,
        });

        // Build question with attachment context if present
        const questionWithAttachment = attachmentInfo
          ? `${trimmedContent || "Please analyze this document."}\n\n---\nATTACHED DOCUMENT (${attachmentInfo.filename}):\n${attachmentInfo.extractedText.slice(0, 20000)}`
          : trimmedContent;

        const trimmedHistory = buildTrimmedHistoryForAnswer(chatHistory);

        // SIMPLIFIED PIPELINE: Two-lane retrieval + single synthesis
        const pipelineResult = await runUnifiedChatPipeline({
          question: questionWithAttachment,
          sessionHistory: trimmedHistory,
          townPreference: resolvedTown,
          logContext: logCtx,
        });

        const answerText = pipelineResult.answerText;
        const sourceDocumentNames = pipelineResult.sourceDocumentNames;
        const docSourceType = pipelineResult.docSourceType;
        const docSourceTown = pipelineResult.docSourceTown;

        // Generate follow-up suggestions
        const suggestedFollowUps = await generateFollowups({
          userQuestion: trimmedContent || "Analyze this document",
          answerText,
          townPreference: resolvedTown,
          detectedDomains: [],
          logContext: logCtx,
        });

        const sources = await mapFileSearchDocumentsToCitations(sourceDocumentNames);

        const answerMeta: FinalAnswerMeta = {
          complexity: "simple",
          requiresClarification: false,
          criticScore: { relevance: 1, completeness: 1, clarity: 1, riskOfMisleading: 0 },
        };

        const v2Metadata = {
          v2: true,
          answerMeta,
          sources,
          suggestedFollowUps,
          notices: [] as ChatNotice[],
        };

        const assistantMessage = await storage.createChatMessage({
          sessionId,
          role: "assistant",
          content: answerText,
          citations: JSON.stringify(v2Metadata),
        });

        if (chatHistory.filter((m) => m.role === "user").length === 0) {
          const title = (trimmedContent || attachmentInfo?.filename || "Document Analysis").slice(0, 60);
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

        logInfo("chat_v2_upload_response_ready", {
          ...logCtx,
          stage: "exit",
          sourceCount: sources.length,
          durationMs: duration,
          hasAttachment: !!attachmentInfo,
          docSourceType,
          docSourceTown,
        });

        return res.json(response);
      } catch (error) {
        const duration = Date.now() - startTime;

        if (uploadedFile) {
          await fs.unlink(uploadedFile.path).catch(() => {});
        }

        logError("chat_v2_upload_error", {
          ...logCtx,
          stage: "error",
          error: error instanceof Error ? error.message : String(error),
          durationMs: duration,
        });

        return res.status(500).json({
          message: error instanceof Error ? error.message : "Failed to process message with file",
        });
      }
    }
  );
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

/**
 * Development sanity check: warns if the answer content appears to reference
 * local documents but docSourceType is set to "none".
 * This helps catch mis-wiring early without blocking responses.
 */
function checkScopeAnswerMismatch(
  answer: string,
  docSourceType: DocSourceType,
  docSourceTown: string | null,
  logCtx: PipelineLogContext
): void {
  if (docSourceType === "none") {
    // Check for patterns that suggest local document usage
    const localPatterns = [
      /According to the .* minutes/i,
      /As noted in the .* budget/i,
      /Planning Board/i,
      /Board of Selectmen/i,
      /BOS minutes/i,
      /warrant article/i,
      /town report/i,
    ];

    const hasLocalReferences = localPatterns.some(pattern => pattern.test(answer));

    if (hasLocalReferences) {
      logWarning("scope_answer_mismatch_detected", {
        requestId: logCtx.requestId,
        sessionId: logCtx.sessionId,
        stage: "sanity_check",
        docSourceType,
        docSourceTown,
        reason: "Answer contains local document references but docSourceType=none",
        answerPreview: answer.slice(0, 200),
      });
    }
  }
}
