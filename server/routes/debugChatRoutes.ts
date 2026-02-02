
import { Router } from "express";
import { runChatV3Pipeline } from "../chatV2/chatOrchestratorV3";
import { v4 as uuidv4 } from "uuid";
import { chatSessions, db, eq } from "../storage/db";

const router = Router();

// Secure this endpoint! (Basic check for now, ideally use admin middleware)
// For now, we rely on the parent router to mount this under /api/admin/*
router.post("/debug-pipeline", async (req, res) => {
  try {
    const { message, town, sessionId } = req.body;

    if (!message) {
      return res.status(400).json({ error: "Message is required" });
    }

    // Mock history or fetch real history if sessionId provided
    let history: any[] = [];
    if (sessionId) {
      // Fetch session history if needed
      // history = await getChatHistory(sessionId); 
    }

    const logContext = {
      requestId: uuidv4(),
      sessionId: sessionId || "debug-session",
      startTime: Date.now(),
    };

    console.log(`[DebugChat] Running pipeline for: "${message}" (Town: ${town})`);

    const result = await runChatV3Pipeline({
      userMessage: message,
      sessionHistory: history,
      townPreference: town || null,
      situationContext: null,
      sessionSources: [],
      logContext
    });

    // Return the full internal state for inspection
    res.json({
      success: true,
      answer: result.answerText,
      sources: result.sourceDocumentNames,
      docSourceType: result.docSourceType,
      debug: {
        durationMs: result.durationMs,
        retrievalCounts: result.debug.retrievalCounts,
        planner: result.debug.issueMapSummary,
        auditFlags: result.debug.auditFlags,
        // Include raw queries to verify filtering
        queries: result.debug.planQueries
      }
    });

  } catch (error: any) {
    console.error("[DebugChat] Error:", error);
    res.status(500).json({
      success: false,
      error: error.message,
      stack: error.stack
    });
  }
});

export default router;
