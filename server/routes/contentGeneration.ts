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
import { runContentGenerationPipeline } from "../services/contentGeneration";
import { searchNewsForTopic, getConfiguredNewsSources } from "../services/newsCrawler";
import type { TownFeedNewsArticle, TownFeedPayload } from "@shared/schema";

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
    let items = await getTownFeedItems(town);
    if (status) {
      items = items.filter(i => i.status === status);
    }
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

    const highScoringTopics = (item.topics || []).filter((t: any) => t.score >= 8);

    const payload: TownFeedPayload = {
      summary: item.summary,
      sections: highScoringTopics.map((t: any) => ({
        title: t.topic,
        description: t.historicalContext || t.keyPoints?.join(". ") || "",
        suggestedQuestions: [
          `What decisions were made about ${t.topic} in ${item.town}?`,
          `What is the history of ${t.topic} in ${item.town}?`,
          `How does ${t.topic} affect ${item.town} residents?`,
        ],
      })),
      highLevelQuestions: [
        `What are the most important issues in ${item.town} right now?`,
        `Summarize recent municipal activity in ${item.town}.`,
      ],
    };

    const updated = await updateTownFeedItem(req.params.id, {
      status: "published",
      generatedPayload: payload,
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

    const updated = await updateTownFeedItem(req.params.id, {
      newsArticles: mergedArticles,
    } as any);

    res.json(updated);
  } catch (error: any) {
    console.error("Error investigating topics:", error);
    res.status(500).json({ message: error.message || "Investigation failed" });
  }
});

adminRouter.get("/news-sources", async (_req, res) => {
  res.json(getConfiguredNewsSources());
});

const publicRouter = Router();

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
