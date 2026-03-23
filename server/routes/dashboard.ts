import { Router } from "express";
import { z } from "zod";
import { requireUser, requireRole } from "../auth/middleware";
import type { IdentityRequest } from "../auth/types";
import {
  getUserKeywords,
  addUserKeyword,
  removeUserKeyword,
  searchDocumentsByKeywords,
  getRecentDocsByTowns,
  createFeatureRequest,
  getAllFeatureRequests,
  createMissingDocSuggestion,
  getAllMissingDocSuggestions,
} from "../storage/dashboard";
import { getUserById } from "../storage/users";

const dashboardRouter = Router();

// ============================================================
// NEW DOCS - uses preferredTowns from user profile
// ============================================================

dashboardRouter.get("/new-docs", requireUser, async (req: IdentityRequest, res) => {
  try {
    const userId = req.user!.id;
    const user = await getUserById(userId);
    const towns = (user?.preferredTowns as string[]) || [];
    if (user?.defaultTown && towns.length === 0) {
      towns.push(user.defaultTown);
    }

    const docs = await getRecentDocsByTowns(towns, 15);
    res.json({ docs, towns });
  } catch (error) {
    console.error("Error fetching new docs for dashboard:", error);
    res.status(500).json({ message: "Failed to fetch new docs" });
  }
});

// ============================================================
// KEYWORDS
// ============================================================

dashboardRouter.get("/keywords", requireUser, async (req: IdentityRequest, res) => {
  try {
    const keywords = await getUserKeywords(req.user!.id);
    res.json({ keywords });
  } catch (error) {
    console.error("Error fetching keywords:", error);
    res.status(500).json({ message: "Failed to fetch keywords" });
  }
});

dashboardRouter.post("/keywords", requireUser, async (req: IdentityRequest, res) => {
  try {
    const { keyword } = z.object({ keyword: z.string().min(1).max(100) }).parse(req.body);
    const created = await addUserKeyword({ userId: req.user!.id, keyword: keyword.trim() });
    res.json({ keyword: created });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ message: "Invalid keyword" });
    }
    console.error("Error adding keyword:", error);
    res.status(500).json({ message: "Failed to add keyword" });
  }
});

dashboardRouter.delete("/keywords/:id", requireUser, async (req: IdentityRequest, res) => {
  try {
    await removeUserKeyword(req.params.id, req.user!.id);
    res.json({ success: true });
  } catch (error) {
    console.error("Error removing keyword:", error);
    res.status(500).json({ message: "Failed to remove keyword" });
  }
});

dashboardRouter.get("/keywords/matches", requireUser, async (req: IdentityRequest, res) => {
  try {
    const keywords = await getUserKeywords(req.user!.id);
    const kwStrings = keywords.map((k) => k.keyword);
    const docs = await searchDocumentsByKeywords(kwStrings);
    res.json({ docs });
  } catch (error) {
    console.error("Error fetching keyword matches:", error);
    res.status(500).json({ message: "Failed to fetch keyword matches" });
  }
});

// ============================================================
// FEATURE REQUESTS
// ============================================================

dashboardRouter.post("/feature-requests", requireUser, async (req: IdentityRequest, res) => {
  try {
    const { text } = z.object({ text: z.string().min(1).max(2000) }).parse(req.body);
    const created = await createFeatureRequest({ userId: req.user!.id, text });
    res.json({ featureRequest: created });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ message: "Invalid request text" });
    }
    console.error("Error creating feature request:", error);
    res.status(500).json({ message: "Failed to submit feature request" });
  }
});

// ============================================================
// MISSING DOC SUGGESTIONS
// ============================================================

dashboardRouter.post("/missing-doc-suggestions", requireUser, async (req: IdentityRequest, res) => {
  try {
    const { text } = z.object({ text: z.string().min(1).max(2000) }).parse(req.body);
    const created = await createMissingDocSuggestion({ userId: req.user!.id, text });
    res.json({ suggestion: created });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ message: "Invalid suggestion text" });
    }
    console.error("Error creating missing doc suggestion:", error);
    res.status(500).json({ message: "Failed to submit suggestion" });
  }
});

// ============================================================
// ADMIN - Feedback list
// ============================================================

dashboardRouter.get(
  "/admin/feedback",
  requireRole("admin", "municipal_admin"),
  async (_req, res) => {
    try {
      const [featureRequestsList, missingDocsList] = await Promise.all([
        getAllFeatureRequests(),
        getAllMissingDocSuggestions(),
      ]);
      res.json({ featureRequests: featureRequestsList, missingDocSuggestions: missingDocsList });
    } catch (error) {
      console.error("Error fetching admin feedback:", error);
      res.status(500).json({ message: "Failed to fetch feedback" });
    }
  }
);

export default dashboardRouter;
