import { Router } from "express";
import { authenticateAdmin } from "../middleware/auth";
import {
  getDocumentGaps,
  getDocumentGapById,
  updateDocumentGap,
  getDocumentGapStats,
  getDocumentGapTowns,
} from "../storage/documentGaps";

const router = Router();

router.use(authenticateAdmin);

router.get("/", async (req, res) => {
  try {
    const { status, town, limit, offset } = req.query;
    const gaps = await getDocumentGaps({
      status: status as string | undefined,
      town: town as string | undefined,
      limit: limit ? parseInt(limit as string) : undefined,
      offset: offset ? parseInt(offset as string) : undefined,
    });
    res.json(gaps);
  } catch (error) {
    console.error("Error fetching document gaps:", error);
    res.status(500).json({ message: "Failed to fetch document gaps" });
  }
});

router.get("/stats", async (_req, res) => {
  try {
    const stats = await getDocumentGapStats();
    res.json(stats);
  } catch (error) {
    console.error("Error fetching document gap stats:", error);
    res.status(500).json({ message: "Failed to fetch document gap stats" });
  }
});

router.get("/towns", async (_req, res) => {
  try {
    const towns = await getDocumentGapTowns();
    res.json(towns);
  } catch (error) {
    console.error("Error fetching document gap towns:", error);
    res.status(500).json({ message: "Failed to fetch towns" });
  }
});

const VALID_STATUSES = ["open", "in_progress", "resolved", "dismissed"];

router.patch("/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const { status, adminNotes } = req.body;

    const existing = await getDocumentGapById(id);
    if (!existing) {
      return res.status(404).json({ message: "Document gap not found" });
    }

    if (status !== undefined && !VALID_STATUSES.includes(status)) {
      return res.status(400).json({ message: `Invalid status. Must be one of: ${VALID_STATUSES.join(", ")}` });
    }

    if (adminNotes !== undefined && typeof adminNotes !== "string") {
      return res.status(400).json({ message: "Admin notes must be a string" });
    }

    const updates: { status?: string; adminNotes?: string; resolvedAt?: Date | null } = {};

    if (status !== undefined) {
      updates.status = status;
      if (status === "resolved") {
        updates.resolvedAt = new Date();
      } else if (existing.status === "resolved" && status !== "resolved") {
        updates.resolvedAt = null;
      }
    }

    if (adminNotes !== undefined) {
      updates.adminNotes = adminNotes;
    }

    const updated = await updateDocumentGap(id, updates);
    res.json(updated);
  } catch (error) {
    console.error("Error updating document gap:", error);
    res.status(500).json({ message: "Failed to update document gap" });
  }
});

export default router;
