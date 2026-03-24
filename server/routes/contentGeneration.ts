import { Router } from "express";
import { z } from "zod";
import * as fs from "fs/promises";
import * as path from "path";
import { authenticateAdmin } from "../middleware/auth";
import {
  createTownFeedItem,
  getTownFeedItems,
  getTownFeedItemById,
  updateTownFeedItem,
  deleteTownFeedItem,
  getPublishedFeedItems,
} from "../storage/townFeed";
import { runContentGenerationPipeline, scoreArticleRelevancy, regenerateSummaryWithNews, generateCuriosityQuestions, generateFeedItemFromChat, generateFeedItemFromDocuments } from "../services/contentGeneration";
import { searchNewsForTopic, getConfiguredNewsSources } from "../services/newsCrawler";
import { getChatTemplateById, updateChatTemplate } from "../storage/chatTemplates";
import type { TownFeedNewsArticle, TownFeedPayload, ScoredTopic } from "@shared/schema";

const adminRouter = Router();
adminRouter.use(authenticateAdmin);

adminRouter.post("/generate", async (req, res) => {
  try {
    const { town } = z.object({ town: z.string().min(1) }).parse(req.body);

    const result = await runContentGenerationPipeline(town);

    const feedItem = await createTownFeedItem({
      town,
      title: result.title,
      summary: result.summary,
      topics: result.topics,
      routineTopics: result.routineTopics,
      sourceMinutesIds: result.sourceMinutesIds,
      newsArticles: [],
      status: "draft",
    });

    res.json(feedItem);
  } catch (error: any) {
    console.error("Content generation failed:", error);
    res.status(500).json({ message: error.message || "Content generation failed" });
  }
});

adminRouter.post("/generate-from-chat", async (req, res) => {
  try {
    const { sessionId, town } = z.object({
      sessionId: z.string().min(1),
      town: z.string().min(1),
    }).parse(req.body);

    const feedItem = await generateFeedItemFromChat(sessionId, town);
    res.json(feedItem);
  } catch (error: any) {
    console.error("Content generation from chat failed:", error);
    res.status(500).json({ message: error.message || "Content generation from chat failed" });
  }
});

adminRouter.post("/generate-from-documents", async (req, res) => {
  try {
    const { town, documentVersionIds } = z.object({
      town: z.string().min(1),
      documentVersionIds: z.array(z.string().min(1)).min(1).max(3),
    }).parse(req.body);

    const { getDocumentVersionById } = await import("../storage/documents");
    const { db, schema, eq } = await import("../storage/db");
    for (const versionId of documentVersionIds) {
      const version = await getDocumentVersionById(versionId);
      if (!version) {
        return res.status(400).json({ message: `Document version not found: ${versionId}` });
      }
      const [logDoc] = await db.select({ town: schema.logicalDocuments.town })
        .from(schema.logicalDocuments)
        .where(eq(schema.logicalDocuments.id, version.documentId))
        .limit(1);
      if (logDoc && logDoc.town !== town) {
        return res.status(400).json({ message: `Document ${versionId} belongs to ${logDoc.town}, not ${town}` });
      }
    }

    const feedItem = await generateFeedItemFromDocuments(town, documentVersionIds);
    res.json(feedItem);
  } catch (error: any) {
    if (error?.issues) {
      return res.status(400).json({ message: "Invalid input. Maximum 3 documents allowed per generation.", errors: error.issues });
    }
    console.error("Content generation from documents failed:", error);
    res.status(500).json({ message: error.message || "Content generation from documents failed" });
  }
});

adminRouter.post("/publish-from-template", async (req, res) => {
  try {
    const { templateId } = z.object({
      templateId: z.string().min(1),
    }).parse(req.body);

    const template = await getChatTemplateById(templateId);
    if (!template) {
      return res.status(404).json({ message: "Template not found" });
    }

    if (!template.generatedPayload) {
      return res.status(400).json({ message: "Template has no generated payload. Generate a summary first." });
    }

    if (template.linkedFeedItemId) {
      const existingItem = await getTownFeedItemById(template.linkedFeedItemId);
      if (existingItem) {
        return res.json({ feedItem: existingItem, alreadyPublished: true });
      }
    }

    const payload = template.generatedPayload as any;
    const feedItem = await createTownFeedItem({
      town: template.town,
      title: template.title,
      summary: payload.summary || "",
      topics: [],
      routineTopics: [],
      sourceMinutesIds: (template.targetDocumentIds as string[]) || [],
      newsArticles: [],
      status: "draft",
      templateId: template.id,
      generatedPayload: {
        summary: payload.summary || "",
        sections: (payload.sections || []).map((s: any) => ({
          title: s.title || "",
          description: s.description || "",
          suggestedQuestions: Array.isArray(s.suggestedQuestions) ? s.suggestedQuestions : [],
        })),
        highLevelQuestions: Array.isArray(payload.highLevelQuestions) ? payload.highLevelQuestions : [],
      },
    });

    await updateChatTemplate(template.id, { linkedFeedItemId: feedItem.id });

    res.json({ feedItem, alreadyPublished: false });
  } catch (error: any) {
    console.error("Publishing template to feed failed:", error);
    res.status(500).json({ message: error.message || "Failed to publish template to feed" });
  }
});

adminRouter.get("/recent-minutes", async (req, res) => {
  try {
    const town = req.query.town as string | undefined;
    const limit = parseInt(req.query.limit as string) || 20;

    if (!town) {
      return res.status(400).json({ message: "Town parameter is required" });
    }

    const { getRecentMinutesUpdatesAdmin } = await import("../storage/documents");
    const items = await getRecentMinutesUpdatesAdmin({ town, limit });
    
    const { db } = await import("../storage/db");
    const schema = await import("@shared/schema");
    const { eq, inArray } = await import("drizzle-orm");
    
    const logicalDocIdSet = new Set(items.map(i => i.logicalDocumentId));
    const logicalDocIds = Array.from(logicalDocIdSet);
    let titleMap: Record<string, string> = {};
    if (logicalDocIds.length > 0) {
      const docs = await db
        .select({ id: schema.logicalDocuments.id, canonicalTitle: schema.logicalDocuments.canonicalTitle })
        .from(schema.logicalDocuments)
        .where(inArray(schema.logicalDocuments.id, logicalDocIds));
      for (const doc of docs) {
        titleMap[doc.id] = doc.canonicalTitle;
      }
    }

    const enriched = items.map(item => ({
      ...item,
      canonicalTitle: titleMap[item.logicalDocumentId] || null,
    }));

    res.json({ items: enriched });
  } catch (error) {
    console.error("Error fetching recent minutes:", error);
    res.status(500).json({ message: "Failed to fetch recent minutes" });
  }
});

adminRouter.get("/feed-items", async (req, res) => {
  try {
    const town = req.query.town as string | undefined;
    const status = req.query.status as string | undefined;
    const search = req.query.search as string | undefined;
    const sortBy = req.query.sortBy as string | undefined;
    const sortDir = req.query.sortDir as string | undefined;
    const items = await getTownFeedItems(town, { status, search, sortBy, sortDir });
    res.json(items);
  } catch (error) {
    console.error("Error fetching feed items:", error);
    res.status(500).json({ message: "Failed to fetch feed items" });
  }
});

adminRouter.get("/feed-items/:id", async (req, res) => {
  try {
    const item = await getTownFeedItemById(req.params.id);
    if (!item) {
      return res.status(404).json({ message: "Feed item not found" });
    }
    res.json(item);
  } catch (error) {
    console.error("Error fetching feed item:", error);
    res.status(500).json({ message: "Failed to fetch feed item" });
  }
});

adminRouter.patch("/feed-items/:id", async (req, res) => {
  try {
    const updateSchema = z.object({
      title: z.string().min(1).optional(),
      summary: z.string().min(1).optional(),
      topics: z.any().optional(),
      routineTopics: z.any().optional(),
      topicEmoji: z.string().optional().nullable(),
      generatedPayload: z.any().optional(),
    });
    const data = updateSchema.parse(req.body);
    const updated = await updateTownFeedItem(req.params.id, data);
    if (!updated) {
      return res.status(404).json({ message: "Feed item not found" });
    }
    res.json(updated);
  } catch (error) {
    console.error("Error updating feed item:", error);
    res.status(500).json({ message: "Failed to update feed item" });
  }
});

adminRouter.delete("/feed-items/:id", async (req, res) => {
  try {
    const item = await getTownFeedItemById(req.params.id);
    if (!item) {
      return res.status(404).json({ message: "Feed item not found" });
    }
    await deleteTownFeedItem(req.params.id);
    res.json({ message: "Deleted" });
  } catch (error) {
    console.error("Error deleting feed item:", error);
    res.status(500).json({ message: "Failed to delete feed item" });
  }
});

adminRouter.post("/feed-items/:id/publish", async (req, res) => {
  try {
    const item = await getTownFeedItemById(req.params.id);
    if (!item) {
      return res.status(404).json({ message: "Feed item not found" });
    }

    const highScoringTopics = (item.topics || []).filter((t: any) => t.score >= 8) as ScoredTopic[];

    const curiosityQuestions = await generateCuriosityQuestions(item.summary, highScoringTopics, item.town);

    const payload: TownFeedPayload = {
      summary: item.summary,
      sections: highScoringTopics.map((t: any) => {
        const matchingSection = curiosityQuestions.sections.find(
          (s) => s.topic.toLowerCase() === t.topic.toLowerCase()
        );
        return {
          title: t.topic,
          description: t.historicalContext || t.keyPoints?.join(". ") || "",
          suggestedQuestions: matchingSection?.questions?.length
            ? matchingSection.questions
            : [`What led to the decision on ${t.topic}?`, `What happens next with ${t.topic}?`],
        };
      }),
      highLevelQuestions: curiosityQuestions.highLevelQuestions.length
        ? curiosityQuestions.highLevelQuestions
        : [`What should ${item.town} residents watch for in the coming months?`],
    };

    const topArticles = (item.newsArticles || [])
      .sort((a: any, b: any) => (b.relevancyScore ?? 0) - (a.relevancyScore ?? 0))
      .slice(0, 5);

    const updated = await updateTownFeedItem(req.params.id, {
      status: "published",
      publishedAt: new Date(),
      generatedPayload: payload,
      newsArticles: topArticles,
    } as any);

    res.json(updated);
  } catch (error) {
    console.error("Error publishing feed item:", error);
    res.status(500).json({ message: "Failed to publish feed item" });
  }
});

adminRouter.post("/feed-items/:id/unpublish", async (req, res) => {
  try {
    const updated = await updateTownFeedItem(req.params.id, {
      status: "draft",
      publishedAt: null,
    } as any);
    if (!updated) {
      return res.status(404).json({ message: "Feed item not found" });
    }
    res.json(updated);
  } catch (error) {
    console.error("Error unpublishing feed item:", error);
    res.status(500).json({ message: "Failed to unpublish feed item" });
  }
});

adminRouter.post("/feed-items/:id/investigate", async (req, res) => {
  try {
    const { topics: topicStrings } = z.object({
      topics: z.array(z.string()).min(1),
    }).parse(req.body);

    const item = await getTownFeedItemById(req.params.id);
    if (!item) {
      return res.status(404).json({ message: "Feed item not found" });
    }

    const allNewArticles: TownFeedNewsArticle[] = [];
    for (const topic of topicStrings) {
      const articles = await searchNewsForTopic(topic);
      allNewArticles.push(...articles);
    }

    const existingUrls = new Set((item.newsArticles || []).map((a: any) => a.url));
    const deduped = allNewArticles.filter(a => !existingUrls.has(a.url));
    const mergedArticles = [...(item.newsArticles || []), ...deduped];

    const topics = (item.topics || []) as ScoredTopic[];
    const scoredArticles = await scoreArticleRelevancy(mergedArticles, topics, item.town);

    const updated = await updateTownFeedItem(req.params.id, {
      newsArticles: scoredArticles,
    } as any);

    res.json(updated);
  } catch (error: any) {
    console.error("Error investigating topics:", error);
    res.status(500).json({ message: error.message || "Investigation failed" });
  }
});

adminRouter.post("/feed-items/:id/regenerate-summary", async (req, res) => {
  try {
    const item = await getTownFeedItemById(req.params.id);
    if (!item) {
      return res.status(404).json({ message: "Feed item not found" });
    }

    const newSummary = await regenerateSummaryWithNews(item);
    const updated = await updateTownFeedItem(req.params.id, {
      summary: newSummary,
    } as any);

    res.json(updated);
  } catch (error: any) {
    console.error("Error regenerating summary:", error);
    res.status(500).json({ message: error.message || "Summary regeneration failed" });
  }
});

adminRouter.get("/news-sources", async (_req, res) => {
  res.json(getConfiguredNewsSources());
});

// ============================================================
// PUBLISHING INBOX — Automated feature articles awaiting review
// ============================================================

adminRouter.get("/inbox", async (req, res) => {
  try {
    const town = req.query.town as string | undefined;
    const items = await getTownFeedItems(town, { status: "pending_review" });
    res.json(items);
  } catch (error) {
    console.error("Error fetching publishing inbox:", error);
    res.status(500).json({ message: "Failed to fetch inbox" });
  }
});

adminRouter.post("/feed-items/:id/approve", async (req, res) => {
  try {
    const item = await getTownFeedItemById(req.params.id);
    if (!item) {
      return res.status(404).json({ message: "Feed item not found" });
    }
    if (item.status !== "pending_review") {
      return res.status(400).json({ message: `Item is not pending review (status: ${item.status})` });
    }

    const highScoringTopics = (item.topics || []).filter((t: any) => t.score >= 8) as ScoredTopic[];
    let payload = item.generatedPayload as TownFeedPayload | undefined;

    if (!payload) {
      const curiosityQuestions = await generateCuriosityQuestions(item.summary, highScoringTopics, item.town);
      payload = {
        summary: item.summary,
        sections: highScoringTopics.map((t: any) => {
          const matchingSection = curiosityQuestions.sections.find(
            (s) => s.topic.toLowerCase() === t.topic.toLowerCase()
          );
          return {
            title: t.topic,
            description: t.historicalContext || t.keyPoints?.join(". ") || "",
            suggestedQuestions: matchingSection?.questions?.length
              ? matchingSection.questions
              : [`What led to the decision on ${t.topic}?`, `What happens next with ${t.topic}?`],
          };
        }),
        highLevelQuestions: curiosityQuestions.highLevelQuestions.length
          ? curiosityQuestions.highLevelQuestions
          : [`What should ${item.town} residents watch for in the coming months?`],
      };
    }

    const updated = await updateTownFeedItem(req.params.id, {
      status: "published",
      publishedAt: new Date(),
      generatedPayload: payload,
    } as any);

    res.json(updated);
  } catch (error) {
    console.error("Error approving feed item:", error);
    res.status(500).json({ message: "Failed to approve feed item" });
  }
});

adminRouter.post("/feed-items/:id/reject", async (req, res) => {
  try {
    const item = await getTownFeedItemById(req.params.id);
    if (!item) {
      return res.status(404).json({ message: "Feed item not found" });
    }
    if (item.status !== "pending_review") {
      return res.status(400).json({ message: `Item is not pending review (status: ${item.status})` });
    }

    const updated = await updateTownFeedItem(req.params.id, {
      status: "rejected",
    } as any);

    res.json(updated);
  } catch (error) {
    console.error("Error rejecting feed item:", error);
    res.status(500).json({ message: "Failed to reject feed item" });
  }
});

// ============================================================
// FEED IMAGES — Serve AI-generated header images
// ============================================================

const imagesRouter = Router();

imagesRouter.get("/:filename", async (req, res) => {
  try {
    const { filename } = req.params;
    if (!filename.match(/^[a-zA-Z0-9_-]+\.png$/)) {
      return res.status(400).json({ message: "Invalid filename" });
    }
    const filePath = path.join("uploads/feed-images", filename);
    try {
      await fs.access(filePath);
    } catch {
      return res.status(404).json({ message: "Image not found" });
    }
    res.setHeader("Content-Type", "image/png");
    res.setHeader("Cache-Control", "public, max-age=86400");
    const buffer = await fs.readFile(filePath);
    res.send(buffer);
  } catch (error) {
    console.error("Error serving feed image:", error);
    res.status(500).json({ message: "Failed to serve image" });
  }
});

const publicRouter = Router();

publicRouter.get("/items/:id", async (req, res) => {
  try {
    const item = await getTownFeedItemById(req.params.id);
    if (!item || item.status !== "published") {
      return res.status(404).json({ message: "Feed item not found" });
    }
    res.json(item);
  } catch (error) {
    console.error("Error fetching feed item:", error);
    res.status(500).json({ message: "Failed to fetch feed item" });
  }
});

publicRouter.get("/town/:town", async (req, res) => {
  try {
    const items = await getPublishedFeedItems(req.params.town);
    res.json(items);
  } catch (error) {
    console.error("Error fetching published feed:", error);
    res.status(500).json({ message: "Failed to fetch feed" });
  }
});

export { adminRouter as contentAdminRouter, publicRouter as contentPublicRouter, imagesRouter as feedImagesRouter };
