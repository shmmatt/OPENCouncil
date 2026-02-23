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
import {
  analyzeGaps,
  getTargetPathsForGaps,
  getLinkTextPatternsForGaps,
} from "../services/gapAnalysis";
import {
  startCrawl,
  getCrawlProgress,
  getActiveCrawls,
  abortCrawl,
} from "../services/crawlerEngine";

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

router.get("/runs/:id/logs", async (req, res) => {
  try {
    const run = await crawlerStorage.getCrawlerRunById(req.params.id);
    if (!run) return res.status(404).json({ message: "Run not found" });
    res.json({ logs: run.logs || [], summary: run.summary });
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

    const existingActive = getActiveCrawls().find(c => c.townId === townId && c.status === 'running');
    if (existingActive) {
      return res.status(409).json({ message: `Crawl already running for ${town.name}`, runId: existingActive.runId });
    }

    const run = await crawlerStorage.createCrawlerRun(
      townId,
      mode,
      "manual",
      maxPages || town.maxPages || undefined
    );

    const runId = await startCrawl(town, run, {
      maxPages: maxPages || town.maxPages || undefined,
      mode,
    });

    res.json({
      message: `Crawl started for ${town.name}`,
      runId,
    });
  } catch (error: any) {
    res.status(500).json({ message: error.message });
  }
});

router.post("/trigger-all", async (req, res) => {
  try {
    const { maxPages, mode = 'full', delayBetweenTowns = 5000 } = req.body || {};
    const towns = await crawlerStorage.getCrawlerTowns();
    const activeTowns = towns.filter(t => t.status === 'active');
    
    if (activeTowns.length === 0) {
      return res.json({ message: "No active towns to crawl", started: 0 });
    }

    const activeCrawls = getActiveCrawls();
    const results: Array<{ townId: string; townName: string; runId?: string; status: string }> = [];

    for (const town of activeTowns) {
      const existing = activeCrawls.find(c => c.townId === town.id && c.status === 'running');
      if (existing) {
        results.push({ townId: town.id, townName: town.name, runId: existing.runId, status: 'already_running' });
        continue;
      }

      try {
        const run = await crawlerStorage.createCrawlerRun(
          town.id,
          mode,
          "manual",
          maxPages || town.maxPages || undefined
        );
        const runId = await startCrawl(town, run, {
          maxPages: maxPages || town.maxPages || undefined,
          mode,
        });
        results.push({ townId: town.id, townName: town.name, runId, status: 'started' });
        
        if (delayBetweenTowns > 0) {
          await new Promise(r => setTimeout(r, delayBetweenTowns));
        }
      } catch (err: any) {
        results.push({ townId: town.id, townName: town.name, status: 'error: ' + err.message });
      }
    }

    const started = results.filter(r => r.status === 'started').length;
    res.json({ 
      message: `Started ${started} crawls out of ${activeTowns.length} active towns`,
      results,
      started,
      total: activeTowns.length,
    });
  } catch (error: any) {
    res.status(500).json({ message: error.message });
  }
});

router.get("/runs/:id/progress", async (req, res) => {
  try {
    const progress = getCrawlProgress(req.params.id);
    if (progress) {
      return res.json(progress);
    }
    const run = await crawlerStorage.getCrawlerRunById(req.params.id);
    if (!run) return res.status(404).json({ message: "Run not found" });
    res.json({
      runId: run.id,
      townId: run.townId,
      townName: '',
      status: run.status,
      pagesVisited: run.pagesVisited,
      pagesQueued: 0,
      documentsDiscovered: run.documentsDiscovered,
      documentsDownloaded: run.documentsUploaded,
      documentsFailed: run.documentsFailed,
      duplicatesSkipped: 0,
      currentUrl: '',
      log: [],
      startedAt: run.startedAt,
      completedAt: run.completedAt,
      errorMessage: run.errorMessage,
    });
  } catch (error: any) {
    res.status(500).json({ message: error.message });
  }
});

router.get("/active-crawls", async (_req, res) => {
  try {
    const crawls = getActiveCrawls();
    res.json(crawls);
  } catch (error: any) {
    res.status(500).json({ message: error.message });
  }
});

router.post("/runs/:id/abort", async (req, res) => {
  try {
    const aborted = abortCrawl(req.params.id);
    if (aborted) {
      res.json({ message: "Crawl aborted" });
    } else {
      res.status(404).json({ message: "No active crawl found with this ID" });
    }
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
  req.setTimeout(300_000);
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

router.get("/gaps/:townId", async (req, res) => {
  try {
    const result = await analyzeGaps(req.params.townId);
    const town = await crawlerStorage.getCrawlerTownById(req.params.townId);
    if (town) {
      const targetPaths = getTargetPathsForGaps(result.gaps, town.url);
      const linkPatterns = getLinkTextPatternsForGaps(result.gaps);
      res.json({ ...result, targetPaths, linkPatterns });
    } else {
      res.json(result);
    }
  } catch (error: any) {
    const status = error.message?.includes("not found") || error.message?.includes("No coverage assessment") ? 404 : 500;
    res.status(status).json({ message: error.message });
  }
});

export default router;
