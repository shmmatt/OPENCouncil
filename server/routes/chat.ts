import { Router } from "express";
import { storage } from "../storage";
import { runChatV3Pipeline } from "../chatV2/chatOrchestratorV3";
import { chatConfig } from "../chatV2/chatConfig";
import { chatMessageLimiter, sessionCreationLimiter } from "../middleware/rateLimiter";

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
    const { title } = req.body;
    const actor = req.actor;
    
    if (!actor || (!actor.userId && !actor.anonId)) {
      return res.status(401).json({ message: "Authentication required to create chat sessions" });
    }
    
    const session = await storage.createChatSession({
      title: title || "New conversation",
      userId: actor.actorType === 'user' ? actor.userId : undefined,
      anonId: actor.anonId,
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

    const userMessage = await storage.createChatMessage({
      sessionId: id,
      role: "user",
      content: content.trim(),
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
    
    try {
      const townContext = req.body.townContext || session.townPreference || null;
      const v3Result = await runChatV3Pipeline({
        userMessage: content.trim(),
        sessionHistory: chatHistory,
        townPreference: townContext,
        situationContext: null,
        sessionSources: [],
      });
      answer = v3Result.answerText;
      citations = v3Result.sourceDocumentNames || [];
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

    res.json(assistantMessage);
  } catch (error) {
    console.error("Error sending message:", error);
    res.status(500).json({ 
      message: error instanceof Error ? error.message : "Failed to send message" 
    });
  }
});

router.get("/config", (req, res) => {
  res.json({
    deepAnswerEnabled: chatConfig.DEEP_ANSWER_ENABLED,
  });
});

export default router;
