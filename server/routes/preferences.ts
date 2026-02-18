import { Router } from "express";
import { storage } from "../storage";
import { requireRole } from "../auth/middleware";
import type { IdentityRequest } from "../auth/types";
import type { ActorIdentifier } from "@shared/schema";

const router = Router();

router.get("/meta/towns", async (req, res) => {
  try {
    const towns = await storage.getAvailableTowns();
    res.json({ towns });
  } catch (error) {
    console.error("Error fetching available towns:", error);
    res.status(500).json({ message: "Failed to fetch available towns" });
  }
});

router.post("/preferences/town", async (req: IdentityRequest, res) => {
  try {
    const { town } = req.body;

    if (!town || typeof town !== "string") {
      return res.status(400).json({ message: "Town is required" });
    }

    const availableTowns = await storage.getAvailableTowns();
    if (!availableTowns.includes(town)) {
      return res.status(400).json({ message: "Invalid town selection" });
    }

    const actor: ActorIdentifier = req.user 
      ? { type: 'user', userId: req.user.id }
      : req.anonId 
        ? { type: 'anon', anonId: req.anonId }
        : { type: 'anon' };

    if (actor.userId || actor.anonId) {
      await storage.setActorDefaultTown(actor, town);
    }

    const sessionId = req.body.sessionId;
    if (sessionId) {
      await storage.setSessionTownPreference(sessionId, town);
    }

    res.json({ success: true, town });
  } catch (error) {
    console.error("Error setting town preference:", error);
    res.status(500).json({ message: "Failed to set town preference" });
  }
});

router.get("/preferences/town", async (req: IdentityRequest, res) => {
  try {
    const actor: ActorIdentifier = req.user 
      ? { type: 'user', userId: req.user.id }
      : req.anonId 
        ? { type: 'anon', anonId: req.anonId }
        : { type: 'anon' };

    let town: string | null = null;

    const sessionId = req.query.sessionId as string | undefined;
    if (sessionId) {
      town = await storage.getSessionTownPreference(sessionId);
    }

    if (!town && (actor.userId || actor.anonId)) {
      town = await storage.getActorDefaultTown(actor);
    }

    town = town || "Ossipee";

    res.json({ town });
  } catch (error) {
    console.error("Error fetching town preference:", error);
    res.status(500).json({ message: "Failed to fetch town preference" });
  }
});

router.get("/updates/minutes", async (req: IdentityRequest, res) => {
  try {
    let town = req.query.town as string | undefined;
    const limit = parseInt(req.query.limit as string) || 5;

    if (!town) {
      const actor: ActorIdentifier = req.user 
        ? { type: 'user', userId: req.user.id }
        : req.anonId 
          ? { type: 'anon', anonId: req.anonId }
          : { type: 'anon' };

      if (actor.userId || actor.anonId) {
        town = await storage.getActorDefaultTown(actor) || undefined;
      }
    }

    town = town || "Ossipee";

    const items = await storage.getRecentMinutesUpdates({ town, limit });
    res.json({ items });
  } catch (error) {
    console.error("Error fetching recent minutes updates:", error);
    res.status(500).json({ message: "Failed to fetch recent minutes updates" });
  }
});

router.get(
  "/admin/updates/minutes",
  requireRole("admin", "municipal_admin"),
  async (req: IdentityRequest, res) => {
    try {
      const town = req.query.town as string | undefined;
      const board = req.query.board as string | undefined;
      const limit = parseInt(req.query.limit as string) || 50;

      const items = await storage.getRecentMinutesUpdatesAdmin({ town, board, limit });
      res.json({ items });
    } catch (error) {
      console.error("Error fetching admin minutes updates:", error);
      res.status(500).json({ message: "Failed to fetch admin minutes updates" });
    }
  }
);

export default router;
