import type { Express, Request, Response } from "express";
import { authenticateAdmin } from "../middleware/auth";
import { storage } from "../storage";
import {
  getChatAnalyticsList,
  analyzeChatSession,
  batchAnalyzeSessions,
} from "../services/chatAnalyticsService";

export function registerAdminChatAnalyticsRoutes(app: Express) {
  app.get(
    "/api/admin/chat-analytics",
    authenticateAdmin,
    async (req: Request, res: Response) => {
      try {
        const page = parseInt(req.query.page as string) || 1;
        const pageSize = parseInt(req.query.pageSize as string) || 20;
        const sortField = (req.query.sortField as string) || "date";
        const sortOrder = (req.query.sortOrder as string) || "desc";
        const search = (req.query.search as string) || "";
        const filterAnalyzed = req.query.filterAnalyzed as string | undefined;
        const filterMinDocScore = parseInt(req.query.filterMinDocScore as string) || 0;
        const filterMaxDocScore = parseInt(req.query.filterMaxDocScore as string) || 10;
        const filterMinAnswerScore = parseInt(req.query.filterMinAnswerScore as string) || 0;
        const filterMaxAnswerScore = parseInt(req.query.filterMaxAnswerScore as string) || 10;

        const result = await getChatAnalyticsList({
          page,
          pageSize,
          sortField,
          sortOrder: sortOrder as "asc" | "desc",
          search,
          filterAnalyzed: filterAnalyzed === "true" ? true : filterAnalyzed === "false" ? false : undefined,
          filterMinDocScore,
          filterMaxDocScore,
          filterMinAnswerScore,
          filterMaxAnswerScore,
        });

        res.json(result);
      } catch (error) {
        console.error("Error fetching chat analytics:", error);
        res.status(500).json({ message: "Failed to fetch chat analytics" });
      }
    }
  );

  app.get(
    "/api/admin/chat-analytics/:sessionId",
    authenticateAdmin,
    async (req: Request, res: Response) => {
      try {
        const { sessionId } = req.params;
        const session = await storage.getChatSessionById(sessionId);
        if (!session) {
          return res.status(404).json({ message: "Session not found" });
        }

        const messages = await storage.getMessagesBySessionId(sessionId);
        const analytics = await storage.getChatAnalyticsBySessionId(sessionId);

        res.json({
          session,
          messages,
          analytics,
        });
      } catch (error) {
        console.error("Error fetching chat session details:", error);
        res.status(500).json({ message: "Failed to fetch chat session details" });
      }
    }
  );

  app.post(
    "/api/admin/chat-analytics/:sessionId/analyze",
    authenticateAdmin,
    async (req: Request, res: Response) => {
      try {
        const { sessionId } = req.params;
        const result = await analyzeChatSession(sessionId);
        res.json(result);
      } catch (error) {
        console.error("Error analyzing chat session:", error);
        res.status(500).json({ message: "Failed to analyze chat session" });
      }
    }
  );

  app.post(
    "/api/admin/chat-analytics/batch-analyze",
    authenticateAdmin,
    async (req: Request, res: Response) => {
      try {
        const { sessionIds } = req.body;
        if (!Array.isArray(sessionIds) || sessionIds.length === 0) {
          return res.status(400).json({ message: "sessionIds array is required" });
        }
        const results = await batchAnalyzeSessions(sessionIds);
        res.json(results);
      } catch (error) {
        console.error("Error batch analyzing sessions:", error);
        res.status(500).json({ message: "Failed to batch analyze sessions" });
      }
    }
  );
}
