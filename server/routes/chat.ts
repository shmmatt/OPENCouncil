import { Router } from "express";
import sanitizeHtml from "sanitize-html";
import { storage } from "../storage";
import { runChatV3Pipeline } from "../chatV2/chatOrchestratorV3";
import { chatConfig } from "../chatV2/chatConfig";
import { chatMessageLimiter, sessionCreationLimiter } from "../middleware/rateLimiter";
import { getChatTemplateById } from "../storage/chatTemplates";
import { getTownFeedItemById } from "../storage/townFeed";
import { createDocumentGap, findSimilarOpenGap, incrementGapHitCount } from "../storage/documentGaps";
import { getDocumentVersionContext } from "../storage/documents";
import { detectPlatformQuery, OPENCOUNCIL_PLATFORM_MANUAL } from "../chatV2/platformManual";

const sanitizeOptions: sanitizeHtml.IOptions = {
  allowedTags: [],
  allowedAttributes: {},
};

const router = Router();

router.get("/sessions", async (req, res) => {
  try {
    const actor = req.actor;
    const sessions = await storage.getChatSessions(actor ? {
      type: actor.actorType === 'user' ? 'user' : 'anon',
      userId: actor.userId,
      anonId: actor.anonId,
    } : undefined);
    res.json(sessions);
  } catch (error) {
    console.error("Error fetching sessions:", error);
    res.status(500).json({ message: "Failed to fetch sessions" });
  }
});

router.post("/sessions", sessionCreationLimiter, async (req, res) => {
  try {
    const { title, templateId, feedItemId, documentVersionId } = req.body;
    const actor = req.actor;
    
    if (!actor || (!actor.userId && !actor.anonId)) {
      return res.status(401).json({ message: "Authentication required to create chat sessions" });
    }

    // When launched from a feed item, inherit its town so the AI searches the right documents
    let townPreference: string | undefined;
    if (feedItemId) {
      try {
        const feedItem = await getTownFeedItemById(feedItemId);
        if (feedItem?.town) townPreference = feedItem.town;
      } catch {
        // Non-fatal — session still created, town resolution will fall through to actor default
      }
    }
    
    const session = await storage.createChatSession({
      title: title || "New conversation",
      userId: actor.actorType === 'user' ? actor.userId : undefined,
      anonId: actor.anonId,
      templateId: templateId || undefined,
      feedItemId: feedItemId || undefined,
      documentVersionId: documentVersionId || undefined,
      townPreference: townPreference || undefined,
    });

    res.json(session);
  } catch (error) {
    console.error("Error creating session:", error);
    res.status(500).json({ message: "Failed to create session" });
  }
});

router.get("/sessions/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const messages = await storage.getMessagesBySessionId(id);
    res.json(messages);
  } catch (error) {
    console.error("Error fetching messages:", error);
    res.status(500).json({ message: "Failed to fetch messages" });
  }
});

router.post("/sessions/:id/messages", chatMessageLimiter, async (req, res) => {
  try {
    const { id } = req.params;
    const { content } = req.body;

    if (!content || !content.trim()) {
      return res.status(400).json({ message: "Message content is required" });
    }

    const session = await storage.getChatSessionById(id);
    if (!session) {
      return res.status(404).json({ message: "Chat session not found" });
    }

    const sanitizedContent = sanitizeHtml(content.trim(), sanitizeOptions);

    const userMessage = await storage.createChatMessage({
      sessionId: id,
      role: "user",
      content: sanitizedContent,
      citations: null,
    });

    const allMessages = await storage.getMessagesBySessionId(id);
    const chatHistory = allMessages
      .filter(m => m.id !== userMessage.id)
      .map(m => ({
        role: m.role as "user" | "assistant",
        content: m.content,
      }));

    let answer: string;
    let citations: string[];
    
    let templateContext: string | null = null;
    if ((session as any).feedItemId) {
      try {
        const feedItem = await getTownFeedItemById((session as any).feedItemId);
        if (feedItem) {
          const contextParts: string[] = [];

          const meetingDateStr = feedItem.meetingDate
            ? new Date(feedItem.meetingDate).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" })
            : null;
          contextParts.push(`This chat was launched from a town feed item for ${feedItem.town}.`);
          if (meetingDateStr) contextParts.push(`Meeting date: ${meetingDateStr}`);
          contextParts.push(`Title: "${feedItem.title}"`);

          const payload = feedItem.generatedPayload
            ? (typeof feedItem.generatedPayload === "string"
                ? JSON.parse(feedItem.generatedPayload as string)
                : feedItem.generatedPayload)
            : null;
          const payloadSummary = (payload as any)?.summary || feedItem.summary || "";
          const payloadSections = ((payload as any)?.sections || [])
            .map((s: any) => `- ${s.title}: ${s.description || ""}`)
            .join("\n");
          if (payloadSummary) contextParts.push(`\nSummary:\n${payloadSummary}`);
          if (payloadSections) contextParts.push(`Topics covered:\n${payloadSections}`);

          const versionId = feedItem.automationSourceVersionId;
          if (versionId) {
            try {
              const { db, schema, eq } = await import("../storage/db");
              const [docRow] = await db
                .select({
                  ocrText: schema.fileBlobs.ocrText,
                  previewText: schema.fileBlobs.previewText,
                  board: schema.logicalDocuments.board,
                })
                .from(schema.documentVersions)
                .leftJoin(schema.fileBlobs, eq(schema.documentVersions.fileBlobId, schema.fileBlobs.id))
                .leftJoin(schema.logicalDocuments, eq(schema.documentVersions.documentId, schema.logicalDocuments.id))
                .where(eq(schema.documentVersions.id, versionId));
              if (docRow?.board) contextParts.splice(1, 0, `Board: ${docRow.board}`);
              const rawText = docRow?.ocrText || docRow?.previewText || null;
              if (rawText) {
                contextParts.push(`\nSource document excerpt:\n${rawText.substring(0, 3000)}`);
              }
            } catch (ocrErr) {
              console.error("Feed item OCR text lookup error:", ocrErr);
            }
          }

          templateContext = contextParts.join("\n");
        }
      } catch (err) {
        console.error("Feed item context lookup error:", err);
      }
    } else if ((session as any).templateId) {
      try {
        const template = await getChatTemplateById((session as any).templateId);
        if (template?.generatedPayload) {
          const payload = typeof template.generatedPayload === "string"
            ? JSON.parse(template.generatedPayload)
            : template.generatedPayload;
          templateContext = `This chat was launched from a document template: "${template.title}" for ${template.town}. The template covers the following document sections:\n${(payload.sections || []).map((s: any) => `- ${s.title}: ${s.description || ""}`).join("\n")}`;
        }
      } catch (err) {
        console.error("Template context lookup error:", err);
      }
    }

    let v3DocSourceType: string = "unknown";
    let v3RecordStrengthTier: string = "C";
    let v3MissingQuery: string | null = null;
    let v3SecondHopRan = false;

    try {
      const townContext = req.body.townContext || session.townPreference || null;
      const platformContext = detectPlatformQuery(content.trim()) ? OPENCOUNCIL_PLATFORM_MANUAL : null;
      const v3Result = await runChatV3Pipeline({
        userMessage: content.trim(),
        sessionHistory: chatHistory,
        townPreference: townContext,
        situationContext: null,
        sessionSources: [],
        templateContext,
        platformContext,
      });
      answer = v3Result.answerText;
      citations = v3Result.sourceDocumentNames || [];
      v3DocSourceType = v3Result.docSourceType;
      v3RecordStrengthTier = v3Result.recordStrength.tier;
      v3MissingQuery = v3Result.missingInformationQuery;
      v3SecondHopRan = v3Result.debug.secondHopRan || false;
    } catch (aiError) {
      console.error("AI response error:", aiError);
      answer = "An error occurred while processing this question. Please try again in a moment.";
      citations = [];
    }

    const assistantMessage = await storage.createChatMessage({
      sessionId: id,
      role: "assistant",
      content: answer,
      citations: citations.length > 0 ? JSON.stringify(citations) : null,
    });

    if (allMessages.filter(m => m.role === "user").length === 0) {
      const title = content.trim().slice(0, 60) + (content.trim().length > 60 ? "..." : "");
      await storage.updateChatSession(id, { title });
    }

    const shouldFlagGap =
      v3DocSourceType === "none" ||
      (v3RecordStrengthTier === "C" && v3SecondHopRan) ||
      (v3MissingQuery && v3RecordStrengthTier === "C");

    if (shouldFlagGap) {
      try {
        let detectionSource = "retrieval_empty";
        if (v3DocSourceType !== "none" && v3SecondHopRan) {
          detectionSource = "insufficient_context_after_second_hop";
        } else if (v3MissingQuery) {
          detectionSource = "insufficient_context";
        }

        const gapDescription = v3MissingQuery || content.trim().slice(0, 200);
        const townContext = req.body.townContext || session.townPreference || null;

        const existingGap = await findSimilarOpenGap(townContext, gapDescription);

        if (existingGap) {
          await incrementGapHitCount(existingGap.id);
        } else {
          await createDocumentGap({
            town: townContext,
            description: gapDescription,
            userQuery: content.trim().slice(0, 500),
            sessionId: id,
            messageId: assistantMessage.id,
            detectionSource,
            recordStrengthTier: v3RecordStrengthTier,
            status: "open",
            hitCount: 1,
          });
        }
      } catch (gapErr) {
        console.error("Failed to flag document gap:", gapErr);
      }
    }

    res.json(assistantMessage);
  } catch (error) {
    console.error("Error sending message:", error);
    res.status(500).json({ 
      message: error instanceof Error ? error.message : "Failed to send message" 
    });
  }
});

router.post("/messages/:messageId/feedback", async (req, res) => {
  try {
    const { messageId } = req.params;
    const { feedback } = req.body;

    if (feedback !== null && feedback !== "up" && feedback !== "down") {
      return res.status(400).json({ message: "Feedback must be 'up', 'down', or null" });
    }

    const message = await storage.getMessageById(messageId);
    if (!message) {
      return res.status(404).json({ message: "Message not found" });
    }

    if (message.role !== "assistant") {
      return res.status(400).json({ message: "Can only provide feedback on assistant messages" });
    }

    await storage.updateMessageFeedback(messageId, feedback);
    res.json({ success: true });
  } catch (error) {
    console.error("Error updating feedback:", error);
    res.status(500).json({ message: "Failed to update feedback" });
  }
});

router.get("/config", (req, res) => {
  res.json({
    deepAnswerEnabled: chatConfig.DEEP_ANSWER_ENABLED,
  });
});

export default router;
