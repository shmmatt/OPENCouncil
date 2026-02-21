import { Router } from "express";
import { z } from "zod";
import * as crawlerStorage from "../storage/crawler";
import {
  runAssessment,
  getLatestAssessment,
  predictDocumentCounts,
} from "../services/crawlAssessment";
import {
  analyzeGaps,
  getTargetPathsForGaps,
  getLinkTextPatternsForGaps,
  type GapAnalysisResult,
} from "../services/gapAnalysis";
import { FAILURE_LABELS, type FailureType } from "../../shared/crawler-schema";

const router = Router();

function requireBotAuth(req: any, res: any, next: any) {
  const authHeader = req.headers.authorization;
  const expectedKey = process.env.CRAWLER_BOT_API_KEY;

  if (!expectedKey) {
    return next();
  }

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Missing Authorization header. Use Bearer <CRAWLER_BOT_API_KEY>" });
  }

  const token = authHeader.slice(7);
  if (token !== expectedKey) {
    return res.status(403).json({ error: "Invalid API key" });
  }

  next();
}

router.use(requireBotAuth);

async function resolveTown(slugOrName: string) {
  let town = await crawlerStorage.getCrawlerTownBySlug(slugOrName.toLowerCase());
  if (!town) {
    const allTowns = await crawlerStorage.getCrawlerTowns();
    town = allTowns.find(
      (t) => t.name.toLowerCase() === slugOrName.toLowerCase()
    );
  }
  return town;
}

router.get("/towns", async (_req, res) => {
  try {
    const towns = await crawlerStorage.getTownOverviews();
    res.json({
      towns: towns.map((t) => ({
        id: t.id,
        name: t.name,
        slug: t.slug,
        url: t.url,
        cms: t.cms,
        status: t.status,
        population: t.population,
        totalDocuments: t.totalDocuments,
        totalUploaded: t.totalUploaded,
        consecutiveFailures: t.consecutiveFailures,
        lastRunStatus: t.lastRunStatus,
        lastRunDate: t.lastRunDate,
        urlCount: t.urlCount,
        documentsByStatus: t.documentsByStatus,
      })),
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.get("/:townSlug/briefing", async (req, res) => {
  try {
    const town = await resolveTown(req.params.townSlug);
    if (!town) {
      return res.status(404).json({ error: `Town '${req.params.townSlug}' not found. Use GET /api/crawler-intel/towns to list available towns.` });
    }

    const [assessment, runsResult, docsResult] = await Promise.all([
      getLatestAssessment(town.id).catch(() => null),
      crawlerStorage.getCrawlerRuns(town.id, 10, 0),
      crawlerStorage.getCrawlerDocuments(town.id, undefined, 1, 0),
    ]);

    let gapAnalysis: GapAnalysisResult | null = null;
    let targetPaths: string[] = [];
    let linkPatterns: string[] = [];
    if (assessment) {
      try {
        gapAnalysis = await analyzeGaps(town.id);
        targetPaths = getTargetPathsForGaps(gapAnalysis.gaps, town.url);
        linkPatterns = getLinkTextPatternsForGaps(gapAnalysis.gaps);
      } catch {}
    }

    const failurePatterns = extractFailurePatterns(runsResult.runs);

    const populationBasedPrediction = predictDocumentCounts(town.population || 1000);

    res.json({
      town: {
        id: town.id,
        name: town.name,
        slug: town.slug,
        url: town.url,
        cms: town.cms,
        county: town.county,
        population: town.population,
        status: town.status,
        totalDocuments: town.totalDocuments,
        totalUploaded: town.totalUploaded,
        consecutiveFailures: town.consecutiveFailures,
        maxPages: town.maxPages,
        customPaths: town.customPaths,
        lastFullCrawl: town.lastFullCrawl,
        lastIncrementalCrawl: town.lastIncrementalCrawl,
      },
      documentStats: {
        totalTracked: docsResult.total,
        populationBasedPrediction,
      },
      coverage: assessment
        ? {
            overallScore: assessment.overallScore,
            assessedAt: assessment.assessedAt,
            estimated: assessment.estimated,
            predicted: assessment.predicted,
            categoryScores: assessment.categoryScores,
            totalFilesAnalyzed: assessment.totalFilesAnalyzed,
            notes: assessment.notes,
          }
        : null,
      gaps: gapAnalysis
        ? {
            overallScore: gapAnalysis.overallScore,
            topPriority: gapAnalysis.topPriority,
            gaps: gapAnalysis.gaps,
            targetPaths,
            linkPatterns,
          }
        : null,
      recentRuns: runsResult.runs.map((run) => ({
        id: run.id,
        mode: run.mode,
        triggerType: run.triggerType,
        status: run.status,
        startedAt: run.startedAt,
        completedAt: run.completedAt,
        pagesVisited: run.pagesVisited,
        documentsDiscovered: run.documentsDiscovered,
        documentsDownloaded: run.documentsDownloaded,
        documentsUploaded: run.documentsUploaded,
        documentsFailed: run.documentsFailed,
        maxPagesLimit: run.maxPagesLimit,
        errorMessage: run.errorMessage,
        summary: run.summary,
      })),
      failurePatterns,
      _meta: {
        briefingGeneratedAt: new Date().toISOString(),
        assessmentAge: assessment
          ? Math.round((Date.now() - new Date(assessment.assessedAt).getTime()) / (1000 * 60 * 60))
          : null,
        hint: "Use POST /:townSlug/assess to refresh coverage assessment, POST /:townSlug/crawl to trigger a crawl",
      },
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.post("/:townSlug/assess", async (req, res) => {
  try {
    const town = await resolveTown(req.params.townSlug);
    if (!town) {
      return res.status(404).json({ error: `Town '${req.params.townSlug}' not found` });
    }

    req.setTimeout(300_000);
    const assessment = await runAssessment(town.id);
    res.json({
      message: `Coverage assessment completed for ${town.name}`,
      assessment,
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.get("/:townSlug/gaps", async (req, res) => {
  try {
    const town = await resolveTown(req.params.townSlug);
    if (!town) {
      return res.status(404).json({ error: `Town '${req.params.townSlug}' not found` });
    }

    const result = await analyzeGaps(town.id);
    const targetPaths = getTargetPathsForGaps(result.gaps, town.url);
    const linkPatterns = getLinkTextPatternsForGaps(result.gaps);

    res.json({
      ...result,
      targetPaths,
      linkPatterns,
    });
  } catch (error: any) {
    const status = error.message?.includes("not found") || error.message?.includes("No coverage assessment") ? 404 : 500;
    res.status(status).json({ error: error.message });
  }
});

const crawlTriggerSchema = z.object({
  mode: z.enum(["full", "incremental", "manual"]).default("full"),
  maxPages: z.number().int().positive().optional(),
});

router.post("/:townSlug/crawl", async (req, res) => {
  try {
    const town = await resolveTown(req.params.townSlug);
    if (!town) {
      return res.status(404).json({ error: `Town '${req.params.townSlug}' not found` });
    }

    const parsed = crawlTriggerSchema.safeParse(req.body || {});
    if (!parsed.success) {
      return res.status(400).json({ error: "Invalid input", details: parsed.error.flatten() });
    }

    const { mode, maxPages } = parsed.data;

    const run = await crawlerStorage.createCrawlerRun(
      town.id,
      mode,
      "bot",
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
      mode,
      maxPages: maxPages || town.maxPages || "default",
      triggerType: "bot",
      hint: `Poll GET /:townSlug/runs/${run.id} for status updates`,
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.get("/:townSlug/runs", async (req, res) => {
  try {
    const town = await resolveTown(req.params.townSlug);
    if (!town) {
      return res.status(404).json({ error: `Town '${req.params.townSlug}' not found` });
    }

    const limit = Math.min(parseInt(req.query.limit as string) || 20, 100);
    const offset = parseInt(req.query.offset as string) || 0;

    const result = await crawlerStorage.getCrawlerRuns(town.id, limit, offset);

    res.json({
      runs: result.runs.map((run) => ({
        id: run.id,
        mode: run.mode,
        triggerType: run.triggerType,
        status: run.status,
        startedAt: run.startedAt,
        completedAt: run.completedAt,
        pagesVisited: run.pagesVisited,
        documentsDiscovered: run.documentsDiscovered,
        documentsDownloaded: run.documentsDownloaded,
        documentsUploaded: run.documentsUploaded,
        documentsFailed: run.documentsFailed,
        maxPagesLimit: run.maxPagesLimit,
        errorMessage: run.errorMessage,
        summary: run.summary,
      })),
      total: result.total,
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.get("/:townSlug/runs/:runId", async (req, res) => {
  try {
    const run = await crawlerStorage.getCrawlerRunById(req.params.runId);
    if (!run) {
      return res.status(404).json({ error: "Run not found" });
    }
    const comparison = await crawlerStorage.getRunComparison(req.params.runId);
    res.json({ ...run, comparison });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.get("/:townSlug/documents", async (req, res) => {
  try {
    const town = await resolveTown(req.params.townSlug);
    if (!town) {
      return res.status(404).json({ error: `Town '${req.params.townSlug}' not found` });
    }

    const limit = Math.min(parseInt(req.query.limit as string) || 100, 500);
    const offset = parseInt(req.query.offset as string) || 0;
    const status = req.query.status as string | undefined;
    const search = req.query.search as string | undefined;

    const result = await crawlerStorage.getCrawlerDocuments(
      town.id,
      status,
      limit,
      offset,
      search
    );

    res.json({
      documents: result.documents,
      total: result.total,
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

function extractFailurePatterns(runs: any[]) {
  const typeFrequency: Record<string, number> = {};
  const typeRunCount: Record<string, number> = {};
  const recentErrors: Array<{ url: string; error: string; failureType: string; runId: string }> = [];

  for (const run of runs) {
    if (!run.summary?.failuresByType) continue;
    const types = run.summary.failuresByType as Record<string, number>;
    for (const [type, count] of Object.entries(types)) {
      typeFrequency[type] = (typeFrequency[type] || 0) + (count as number);
      typeRunCount[type] = (typeRunCount[type] || 0) + 1;
    }
    if (run.summary?.errors) {
      for (const err of (run.summary.errors as any[]).slice(0, 5)) {
        recentErrors.push({ ...err, runId: run.id });
      }
    }
  }

  const patterns = Object.entries(typeFrequency)
    .sort(([, a], [, b]) => b - a)
    .map(([type, totalCount]) => ({
      type,
      label: (FAILURE_LABELS as Record<string, string>)[type] || type,
      totalOccurrences: totalCount,
      appearsInRuns: typeRunCount[type] || 0,
      isRecurring: (typeRunCount[type] || 0) >= 2,
    }));

  return {
    patterns,
    recentErrors: recentErrors.slice(0, 20),
    totalRunsAnalyzed: runs.length,
  };
}

export default router;
