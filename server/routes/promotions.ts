import { Router } from "express";
import { z } from "zod";
import { authenticateAdmin } from "../middleware/auth";
import { generatePromotionAssets, generatePromotionAssetsFromTemplate } from "../services/promotions";
import {
  getAllPromotions,
  getPromotionById,
  getPromotionByFeedItemId,
  getPromotionByTemplateId,
  updatePromotion,
} from "../storage/promotions";

const router = Router();
router.use(authenticateAdmin);

router.post("/generate/:feedItemId", async (req, res) => {
  try {
    const { feedItemId } = req.params;
    const promotion = await generatePromotionAssets(feedItemId);
    res.json(promotion);
  } catch (error: any) {
    console.error("Promotion generation failed:", error);
    res.status(500).json({ message: error.message || "Promotion generation failed" });
  }
});

router.post("/generate-from-template/:templateId", async (req, res) => {
  try {
    const { templateId } = req.params;
    const promotion = await generatePromotionAssetsFromTemplate(templateId);
    res.json(promotion);
  } catch (error: any) {
    console.error("Promotion generation from template failed:", error);
    res.status(500).json({ message: error.message || "Promotion generation failed" });
  }
});

router.get("/", async (_req, res) => {
  try {
    const promotions = await getAllPromotions();
    res.json(promotions);
  } catch (error: any) {
    res.status(500).json({ message: error.message });
  }
});

router.get("/by-feed-item/:feedItemId", async (req, res) => {
  try {
    const promotion = await getPromotionByFeedItemId(req.params.feedItemId);
    if (!promotion) {
      return res.status(404).json({ message: "No promotion found for this feed item" });
    }
    res.json(promotion);
  } catch (error: any) {
    res.status(500).json({ message: error.message });
  }
});

router.get("/by-template/:templateId", async (req, res) => {
  try {
    const promotion = await getPromotionByTemplateId(req.params.templateId);
    if (!promotion) {
      return res.status(404).json({ message: "No promotion found for this template" });
    }
    res.json(promotion);
  } catch (error: any) {
    res.status(500).json({ message: error.message });
  }
});

router.get("/:id", async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return res.status(400).json({ message: "Invalid promotion ID" });
    const promotion = await getPromotionById(id);
    if (!promotion) return res.status(404).json({ message: "Promotion not found" });
    res.json(promotion);
  } catch (error: any) {
    res.status(500).json({ message: error.message });
  }
});

router.patch("/:id", async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return res.status(400).json({ message: "Invalid promotion ID" });

    const updateSchema = z.object({
      contentMatrix: z.object({
        facebookPost: z.string(),
        instagramCaption: z.string(),
        emailSubject: z.string(),
        emailBody: z.string(),
        tiktokScript: z.string(),
        youtubeShortScript: z.string(),
        reelsScript: z.string(),
      }).optional(),
      status: z.enum(["draft", "published"]).optional(),
    });

    const data = updateSchema.parse(req.body);
    const promotion = await updatePromotion(id, data as any);
    if (!promotion) return res.status(404).json({ message: "Promotion not found" });
    res.json(promotion);
  } catch (error: any) {
    if (error.name === "ZodError") {
      return res.status(400).json({ message: "Invalid request body", errors: error.errors });
    }
    res.status(500).json({ message: error.message });
  }
});

export default router;
