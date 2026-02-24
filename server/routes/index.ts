import type { Express } from "express";
import { authenticateAdmin } from "../middleware/auth";
import adminRouter from "./admin";
import ingestionRouter from "./ingestion";
import ocrRouter from "./ocr";
import storageRouter from "./storage";
import chatRouter from "./chat";
import preferencesRouter from "./preferences";
import debugChatRoutes from "./debugChatRoutes";
import chatTestRoutes from "./chatTestRoutes";
import { registerChatV2Routes } from "../chatV2/chatV2Route";
import { registerAdminUsageRoutes } from "./adminUsageRoutes";
import { registerAdminChatAnalyticsRoutes } from "./adminChatAnalyticsRoutes";
import crawlerRouter from "./crawler";
import crawlerIntelRouter from "./crawlerIntel";
import { templateRouter, publicTemplateRouter } from "./templates";

export {
  adminRouter,
  ingestionRouter,
  ocrRouter,
  storageRouter,
  chatRouter,
  preferencesRouter,
  crawlerRouter,
};

export function registerAllRoutes(app: Express): void {
  app.use("/api/admin/debug", authenticateAdmin, debugChatRoutes);
  app.use("/api/admin/test", authenticateAdmin, chatTestRoutes);

  app.use("/api/admin", adminRouter);
  app.use("/api/admin/ingestion", ingestionRouter);
  app.use("/api/admin/ocr", ocrRouter);
  app.use("/api/admin/crawler", crawlerRouter);
  app.use("/api/crawler-intel", crawlerIntelRouter);
  app.use("/api/admin", storageRouter);

  app.use("/api/admin/templates", templateRouter);
  app.use("/api/templates", publicTemplateRouter);

  app.use("/api/chat", chatRouter);
  app.use("/api", preferencesRouter);

  registerChatV2Routes(app);
  registerAdminUsageRoutes(app);
  registerAdminChatAnalyticsRoutes(app);
}
