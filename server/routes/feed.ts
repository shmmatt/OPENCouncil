import { Router } from "express";
import { z } from "zod";
import { getPublishedFeedItemsPaginated } from "../storage/townFeed";
import { toggleUpvote, getUserUpvotedFeedItemIds } from "../storage/userUpvotes";
import { getUserById, updateUser } from "../storage/users";
import type { IdentityRequest } from "../auth/types";

const feedUserRouter = Router();

feedUserRouter.get("/user", async (req: IdentityRequest, res) => {
  try {
    const cursor = req.query.cursor as string | undefined;
    const limit = Math.min(parseInt(req.query.limit as string) || 10, 50);

    let towns: string[] = [];

    if (req.actor?.userId && req.actor.user) {
      const user = req.actor.user;
      if (user.preferredTowns && (user.preferredTowns as string[]).length > 0) {
        towns = user.preferredTowns as string[];
      } else if (user.defaultTown) {
        towns = [user.defaultTown];
      }
    } else if (req.actor?.anon?.defaultTown) {
      towns = [req.actor.anon.defaultTown];
    }

    const { items, hasMore, nextCursor } = await getPublishedFeedItemsPaginated(towns, cursor, limit);

    let upvotedIds = new Set<string>();
    if (req.actor?.userId) {
      upvotedIds = await getUserUpvotedFeedItemIds(
        req.actor.userId,
        items.map((i) => i.id)
      );
    }

    const enrichedItems = items.map((item) => ({
      ...item,
      hasUpvoted: upvotedIds.has(item.id),
    }));

    res.json({ items: enrichedItems, nextCursor, hasMore });
  } catch (error) {
    console.error("Error fetching user feed:", error);
    res.status(500).json({ message: "Failed to fetch feed" });
  }
});

feedUserRouter.post("/items/:id/upvote", async (req: IdentityRequest, res) => {
  try {
    if (!req.actor?.userId) {
      return res.status(401).json({ message: "Sign in to upvote" });
    }

    const result = await toggleUpvote(req.actor.userId, req.params.id);
    res.json(result);
  } catch (error) {
    console.error("Error toggling upvote:", error);
    res.status(500).json({ message: "Failed to toggle upvote" });
  }
});

feedUserRouter.get("/user/preferences", async (req: IdentityRequest, res) => {
  try {
    if (!req.actor?.userId) {
      return res.json({ preferredTowns: [] });
    }

    const user = await getUserById(req.actor.userId);
    res.json({ preferredTowns: (user?.preferredTowns as string[]) || [] });
  } catch (error) {
    console.error("Error fetching preferences:", error);
    res.status(500).json({ message: "Failed to fetch preferences" });
  }
});

feedUserRouter.put("/user/preferences", async (req: IdentityRequest, res) => {
  try {
    if (!req.actor?.userId) {
      return res.status(401).json({ message: "Sign in to save preferences" });
    }

    const { preferredTowns } = z.object({
      preferredTowns: z.array(z.string()),
    }).parse(req.body);

    await updateUser(req.actor.userId, { preferredTowns } as any);
    res.json({ preferredTowns });
  } catch (error) {
    console.error("Error updating preferences:", error);
    res.status(500).json({ message: "Failed to update preferences" });
  }
});

export default feedUserRouter;
