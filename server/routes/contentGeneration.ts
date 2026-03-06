import { Router } from "express";
import { z } from "zod";
import { authenticateAdmin } from "../middleware/auth";
import {
  createTownFeedItem,
  getTownFeedItems,
  getTownFeedItemById,
  updateTownFeedItem,
  deleteTownFeedItem,
  getPublishedFeedItems,
} from "../storage/townFeed";
import { runContentGenerationPipeline, scoreArticleRelevancy, regenerateSummaryWithNews, generateCuriosityQuestions } from "../services/contentGeneration";
import { searchNewsForTopic, getConfiguredNewsSources } from "../services/newsCrawler";
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

export { adminRouter as contentAdminRouter, publicRouter as contentPublicRouter };
