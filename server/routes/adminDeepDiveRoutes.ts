import { Router } from "express";
import { authenticateAdmin } from "../middleware/auth";
import {
  getDeepDiveSessions,
  getDeepDiveSession,
  getDeepDiveSteps,
  getDeepDiveStats,
} from "../storage/deepDive";

const router = Router();

router.get("/stats", authenticateAdmin, async (req, res) => {
  try {
    const stats = await getDeepDiveStats();
    res.json(stats);
  } catch (error) {
    res.status(500).json({ message: "Failed to fetch deep dive stats" });
  }
});

router.get("/", authenticateAdmin, async (req, res) => {
  try {
    const limit = parseInt(req.query.limit as string) || 20;
    const offset = parseInt(req.query.offset as string) || 0;
    const status = req.query.status as string | undefined;
    const town = req.query.town as string | undefined;

    const result = await getDeepDiveSessions({ limit, offset, status, town });
    res.json(result);
  } catch (error) {
    res.status(500).json({ message: "Failed to fetch deep dive sessions" });
  }
});

router.get("/:id", authenticateAdmin, async (req, res) => {
  try {
    const session = await getDeepDiveSession(req.params.id);
    if (!session) {
      return res.status(404).json({ message: "Deep dive session not found" });
    }

    const steps = await getDeepDiveSteps(req.params.id);
    res.json({ session, steps });
  } catch (error) {
    res.status(500).json({ message: "Failed to fetch deep dive session" });
  }
});

export default router;
