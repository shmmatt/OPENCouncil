import { Router } from "express";
import { requireUser } from "../auth/middleware";
import type { IdentityRequest } from "../auth/types";
import { browseDocuments } from "../storage/documents";

const router = Router();

router.get("/", requireUser, async (req: IdentityRequest, res) => {
  try {
    const town = req.query.town as string;
    if (!town) {
      return res.status(400).json({ message: "town is required" });
    }

    const viewMode = (req.query.viewMode as string) === "calendar" ? "calendar" : "list";
    const board = req.query.board as string | undefined;
    const category = req.query.category as string | undefined;
    const cursor = req.query.cursor as string | undefined;
    const limit = parseInt(req.query.limit as string) || 20;

    let month: number | undefined;
    let year: number | undefined;
    if (viewMode === "calendar") {
      month = parseInt(req.query.month as string);
      year = parseInt(req.query.year as string);
      if (!month || !year || month < 1 || month > 12) {
        const now = new Date();
        month = now.getUTCMonth() + 1;
        year = now.getUTCFullYear();
      }
    }

    const result = await browseDocuments({
      town,
      board,
      category,
      viewMode,
      cursor,
      limit,
      month,
      year,
    });

    res.json(result);
  } catch (error) {
    console.error("Error browsing documents:", error);
    res.status(500).json({ message: "Failed to browse documents" });
  }
});

export default router;
