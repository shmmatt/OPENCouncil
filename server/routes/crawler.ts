import { Router } from "express";
import { z } from "zod";
import { authenticateAdmin } from "../middleware/auth";
import * as crawlerStorage from "../storage/crawler";
import {
  runAssessment,
  getLatestAssessment,
  getAssessmentHistory,
  predictDocumentCounts,
} from "../services/crawlAssessment";

const router = Router();

router.use(authenticateAdmin);

const triggerSchema = z.object({
  townId: z.string().min(1, "townId is required"),
  mode: z.enum(["full", "incremental", "manual"]).default("full"),
  maxPages: z.number().int().positive().optional(),
});

const updateTownSchema = z.object({
  cms: z.string().nullable().optional(),
  maxPages: z.number().int().positive().nullable().optional(),
  customPaths: z.array(z.string()).nullable().optional(),
  status: z.enum(["active", "paused", "disabled"]).optional(),
  url: z.string().url().optional(),
});

const paginationSchema = z.object({
  limit: z.coerce.number().int().min(1).max(500).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

router.get("/stats", async (req, res) => {
  try {
    const stats = await crawlerStorage.getCrawlerStats();
    res.json(stats);
  } catch (error: any) {
    res.status(500).json({ message: error.message });
  }
});

router.get("/towns", async (req, res) => {
  try {
    const towns = await crawlerStorage.getTownOverviews();
    res.json(towns);
  } catch (error: any) {
    res.status(500).json({ message: error.message });
  }
});

router.get("/towns/:id", async (req, res) => {
  try {
    const town = await crawlerStorage.getCrawlerTownById(req.params.id);
    if (!town) return res.status(404).json({ message: "Town not found" });
    res.json(town);
  } catch (error: any) {
    res.status(500).json({ message: error.message });
  }
});

router.patch("/towns/:id", async (req, res) => {
  try {
    const parsed = updateTownSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ message: "Invalid input", errors: parsed.error.flatten() });
    }
    const updated = await crawlerStorage.updateCrawlerTown(req.params.id, parsed.data);
    if (!updated) return res.status(404).json({ message: "Town not found" });
    res.json(updated);
  } catch (error: any) {
    res.status(500).json({ message: error.message });
  }
});

router.get("/runs", async (req, res) => {
  try {
    const { townId } = req.query;
    const { limit, offset } = paginationSchema.parse(req.query);
    const result = await crawlerStorage.getCrawlerRuns(
      townId as string | undefined,
      limit,
      offset
    );
    res.json(result);
  } catch (error: any) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ message: "Invalid pagination params" });
    }
    res.status(500).json({ message: error.message });
  }
});

router.get("/runs/:id", async (req, res) => {
  try {
    const run = await crawlerStorage.getCrawlerRunById(req.params.id);
    if (!run) return res.status(404).json({ message: "Run not found" });
    const comparison = await crawlerStorage.getRunComparison(req.params.id);
    res.json({ ...run, comparison });
  } catch (error: any) {
    res.status(500).json({ message: error.message });
  }
});

router.get("/documents", async (req, res) => {
  try {
    const { townId, status, search } = req.query;
    const { limit, offset } = paginationSchema.parse(req.query);
    const result = await crawlerStorage.getCrawlerDocuments(
      townId as string | undefined,
      status as string | undefined,
      limit,
      offset,
      search as string | undefined
    );
    res.json(result);
  } catch (error: any) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ message: "Invalid pagination params" });
    }
    res.status(500).json({ message: error.message });
  }
});

router.get("/urls", async (req, res) => {
  try {
    const { townId, status } = req.query;
    if (!townId) return res.status(400).json({ message: "townId is required" });
    const { limit, offset } = paginationSchema.parse(req.query);
    const result = await crawlerStorage.getCrawlerUrls(
      townId as string,
      status as string | undefined,
      limit,
      offset
    );
    res.json(result);
  } catch (error: any) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ message: "Invalid pagination params" });
    }
    res.status(500).json({ message: error.message });
  }
});

router.post("/reset-orphaned", async (req, res) => {
  try {
    const count = await crawlerStorage.resetOrphanedRuns();
    res.json({ message: `Reset ${count} orphaned runs`, count });
  } catch (error: any) {
    res.status(500).json({ message: error.message });
  }
});

router.post("/trigger", async (req, res) => {
  try {
    const parsed = triggerSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ message: "Invalid input", errors: parsed.error.flatten() });
    }
    const { townId, mode, maxPages } = parsed.data;

    const town = await crawlerStorage.getCrawlerTownById(townId);
    if (!town) return res.status(404).json({ message: "Town not found" });

    const run = await crawlerStorage.createCrawlerRun(
      townId,
      mode,
      "manual",
      maxPages || town.maxPages || undefined
    );

    const { spawn } = await import("child_process");
    const child = spawn(
      "npx",
      [
        "tsx",
        "crawler/scripts/crawler-v3.ts",
        "--town", town.name,
        "--url", town.url,
        "--mode", mode,
        "--run-id", run.id,
        ...(maxPages || town.maxPages ? ["--max-pages", String(maxPages || town.maxPages)] : []),
      ],
      {
        cwd: process.cwd(),
        stdio: "ignore",
        detached: true,
        env: { ...process.env },
      }
    );
    child.unref();

    res.json({
      message: `Crawl started for ${town.name}`,
      runId: run.id,
      pid: child.pid,
    });
  } catch (error: any) {
    res.status(500).json({ message: error.message });
  }
});

router.get("/assessments/:townId", async (req, res) => {
  try {
    const assessment = await getLatestAssessment(req.params.townId);
    if (!assessment) return res.json(null);
    res.json(assessment);
  } catch (error: any) {
    res.status(500).json({ message: error.message });
  }
});

router.get("/assessments/:townId/history", async (req, res) => {
  try {
    const history = await getAssessmentHistory(req.params.townId);
    res.json(history);
  } catch (error: any) {
    res.status(500).json({ message: error.message });
  }
});

router.post("/assessments/:townId/run", async (req, res) => {
  try {
    const town = await crawlerStorage.getCrawlerTownById(req.params.townId);
    if (!town) return res.status(404).json({ message: "Town not found" });
    const assessment = await runAssessment(req.params.townId);
    res.json(assessment);
  } catch (error: any) {
    res.status(500).json({ message: error.message });
  }
});

router.get("/assessments/:townId/preview", async (req, res) => {
  try {
    const town = await crawlerStorage.getCrawlerTownById(req.params.townId);
    if (!town) return res.status(404).json({ message: "Town not found" });
    const population = town.population || 1000;
    const predicted = predictDocumentCounts(population);
    res.json({ population, predicted });
  } catch (error: any) {
    res.status(500).json({ message: error.message });
  }
});

export default router;
