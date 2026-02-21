import { Router } from "express";
import { z } from "zod";
import { db } from "../storage/db";
import { sql, eq, desc, asc } from "drizzle-orm";
import * as crawlerSchema from "../../shared/crawler-schema";
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

interface ApiError {
  error: {
    code: string;
    message: string;
    retryable: boolean;
    retryAfterSeconds?: number;
  };
}

function apiError(
  res: any,
  status: number,
  code: string,
  message: string,
  retryable = false,
  retryAfterSeconds?: number
): void {
  const body: ApiError = {
    error: { code, message, retryable },
  };
  if (retryAfterSeconds !== undefined) {
    body.error.retryAfterSeconds = retryAfterSeconds;
  }
  res.status(status).json(body);
}

function requireBotAuth(req: any, res: any, next: any) {
  const authHeader = req.headers.authorization;
  const expectedKey = process.env.CRAWLER_BOT_API_KEY;

  if (!expectedKey) {
    return next();
  }

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return apiError(res, 401, "AUTH_MISSING", "Missing Authorization header. Use Bearer <CRAWLER_BOT_API_KEY>");
  }

  const token = authHeader.slice(7);
  if (token !== expectedKey) {
    return apiError(res, 403, "AUTH_INVALID", "Invalid API key");
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
        state: (t as any).state || "NH",
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
    apiError(res, 500, "INTERNAL_ERROR", error.message, true, 30);
  }
});

router.get("/:townSlug/briefing", async (req, res) => {
  try {
    const town = await resolveTown(req.params.townSlug);
    if (!town) {
      return apiError(res, 404, "TOWN_NOT_FOUND", `Town '${req.params.townSlug}' not found. Use GET /api/crawler-intel/towns to list available towns.`);
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

    const daysSinceLastCrawl = town.lastFullCrawl
      ? Math.round((Date.now() - new Date(town.lastFullCrawl).getTime()) / (1000 * 60 * 60 * 24))
      : null;

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
        daysSinceLastCrawl,
        hint: "Use POST /:townSlug/assess to refresh coverage assessment, POST /:townSlug/crawl to trigger a crawl",
      },
    });
  } catch (error: any) {
    apiError(res, 500, "INTERNAL_ERROR", error.message, true, 30);
  }
});

router.post("/:townSlug/assess", async (req, res) => {
  try {
    const town = await resolveTown(req.params.townSlug);
    if (!town) {
      return apiError(res, 404, "TOWN_NOT_FOUND", `Town '${req.params.townSlug}' not found`);
    }

    req.setTimeout(300_000);
    const assessment = await runAssessment(town.id);
    res.json({
      message: `Coverage assessment completed for ${town.name}`,
      assessment,
    });
  } catch (error: any) {
    apiError(res, 500, "ASSESSMENT_FAILED", error.message, true, 60);
  }
});

router.get("/:townSlug/gaps", async (req, res) => {
  try {
    const town = await resolveTown(req.params.townSlug);
    if (!town) {
      return apiError(res, 404, "TOWN_NOT_FOUND", `Town '${req.params.townSlug}' not found`);
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
    if (error.message?.includes("No coverage assessment")) {
      return apiError(res, 404, "ASSESSMENT_REQUIRED", "No coverage assessment found. Run POST /:townSlug/assess first.", false);
    }
    apiError(res, 500, "INTERNAL_ERROR", error.message, true, 30);
  }
});

router.get("/:townSlug/quick-check", async (req, res) => {
  try {
    const town = await resolveTown(req.params.townSlug);
    if (!town) {
      return apiError(res, 404, "TOWN_NOT_FOUND", `Town '${req.params.townSlug}' not found`);
    }

    const [assessment, docsResult] = await Promise.all([
      getLatestAssessment(town.id).catch(() => null),
      crawlerStorage.getCrawlerDocuments(town.id, undefined, 1, 0),
    ]);

    const currentDocCount = docsResult.total;
    const assessmentDocCount = assessment?.totalFilesAnalyzed || 0;
    const docCountDelta = currentDocCount - assessmentDocCount;
    const assessmentAgeHours = assessment
      ? Math.round((Date.now() - new Date(assessment.assessedAt).getTime()) / (1000 * 60 * 60))
      : null;

    const significantChange = Math.abs(docCountDelta) > Math.max(10, assessmentDocCount * 0.05);
    const assessmentStale = !assessment || (assessmentAgeHours !== null && assessmentAgeHours > 168);
    const reassessmentRecommended = significantChange || assessmentStale;

    res.json({
      townId: town.id,
      townName: town.name,
      currentDocCount,
      lastAssessment: assessment
        ? {
            docCountAtAssessment: assessmentDocCount,
            overallScore: assessment.overallScore,
            assessedAt: assessment.assessedAt,
            ageHours: assessmentAgeHours,
          }
        : null,
      docCountDelta,
      significantChange,
      assessmentStale,
      reassessmentRecommended,
      reason: !assessment
        ? "No assessment exists yet"
        : assessmentStale
          ? `Assessment is ${assessmentAgeHours}h old (>168h threshold)`
          : significantChange
            ? `Document count changed by ${docCountDelta} since last assessment`
            : "Assessment is current and doc count is stable",
    });
  } catch (error: any) {
    apiError(res, 500, "INTERNAL_ERROR", error.message, true, 30);
  }
});

const crawlTriggerSchema = z.object({
  mode: z.enum(["full", "incremental", "manual"]).default("full"),
  maxPages: z.number().int().positive().optional(),
  targetPaths: z.array(z.string()).optional(),
  linkPatterns: z.array(z.string()).optional(),
  callbackUrl: z.string().url().optional(),
});

router.post("/:townSlug/crawl", async (req, res) => {
  try {
    const town = await resolveTown(req.params.townSlug);
    if (!town) {
      return apiError(res, 404, "TOWN_NOT_FOUND", `Town '${req.params.townSlug}' not found`);
    }

    const parsed = crawlTriggerSchema.safeParse(req.body || {});
    if (!parsed.success) {
      return apiError(res, 400, "INVALID_INPUT", `Invalid input: ${parsed.error.flatten().formErrors.join(", ") || JSON.stringify(parsed.error.flatten().fieldErrors)}`);
    }

    const { mode, maxPages, targetPaths, linkPatterns, callbackUrl } = parsed.data;

    const run = await crawlerStorage.createCrawlerRun(
      town.id,
      mode,
      "bot",
      maxPages || town.maxPages || undefined
    );

    const args = [
      "tsx",
      "crawler/scripts/crawler-v3.ts",
      "--town", town.name,
      "--url", town.url,
      "--mode", mode,
      "--run-id", run.id,
      ...(maxPages || town.maxPages ? ["--max-pages", String(maxPages || town.maxPages)] : []),
    ];

    if (targetPaths && targetPaths.length > 0) {
      args.push("--target-paths", targetPaths.join(","));
    }
    if (linkPatterns && linkPatterns.length > 0) {
      args.push("--link-patterns", linkPatterns.join(","));
    }
    if (callbackUrl) {
      args.push("--callback-url", callbackUrl);
    }

    const { spawn } = await import("child_process");
    const child = spawn("npx", args, {
      cwd: process.cwd(),
      stdio: "ignore",
      detached: true,
      env: { ...process.env },
    });
    child.unref();

    res.json({
      message: `Crawl started for ${town.name}`,
      runId: run.id,
      mode,
      maxPages: maxPages || town.maxPages || "default",
      triggerType: "bot",
      ...(targetPaths && targetPaths.length > 0 ? { targetPaths } : {}),
      ...(linkPatterns && linkPatterns.length > 0 ? { linkPatterns } : {}),
      ...(callbackUrl ? { callbackUrl } : {}),
      hint: `Poll GET /:townSlug/runs/${run.id} for status updates`,
    });
  } catch (error: any) {
    apiError(res, 500, "CRAWL_START_FAILED", error.message, true, 60);
  }
});

router.get("/:townSlug/runs", async (req, res) => {
  try {
    const town = await resolveTown(req.params.townSlug);
    if (!town) {
      return apiError(res, 404, "TOWN_NOT_FOUND", `Town '${req.params.townSlug}' not found`);
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
    apiError(res, 500, "INTERNAL_ERROR", error.message, true, 30);
  }
});

router.get("/:townSlug/runs/:runId", async (req, res) => {
  try {
    const run = await crawlerStorage.getCrawlerRunById(req.params.runId);
    if (!run) {
      return apiError(res, 404, "RUN_NOT_FOUND", "Run not found");
    }
    const comparison = await crawlerStorage.getRunComparison(req.params.runId);
    res.json({ ...run, comparison });
  } catch (error: any) {
    apiError(res, 500, "INTERNAL_ERROR", error.message, true, 30);
  }
});

router.get("/:townSlug/documents", async (req, res) => {
  try {
    const town = await resolveTown(req.params.townSlug);
    if (!town) {
      return apiError(res, 404, "TOWN_NOT_FOUND", `Town '${req.params.townSlug}' not found`);
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
    apiError(res, 500, "INTERNAL_ERROR", error.message, true, 30);
  }
});

const registerTownSchema = z.object({
  name: z.string().min(1).max(100),
  url: z.string().url(),
  state: z.string().length(2).default("NH"),
  population: z.number().int().positive().optional(),
  county: z.string().optional(),
  cms: z.string().optional(),
  maxPages: z.number().int().positive().optional(),
});

router.post("/towns", async (req, res) => {
  try {
    const parsed = registerTownSchema.safeParse(req.body);
    if (!parsed.success) {
      return apiError(res, 400, "INVALID_INPUT", `Invalid input: ${JSON.stringify(parsed.error.flatten().fieldErrors)}`);
    }

    const { name, url, state, population, county, cms, maxPages } = parsed.data;
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

    const existing = await crawlerStorage.getCrawlerTownBySlug(slug);
    if (existing) {
      return apiError(res, 409, "TOWN_EXISTS", `Town '${name}' already registered with slug '${slug}'`);
    }

    const [town] = await db
      .insert(crawlerSchema.crawlerTowns)
      .values({
        name,
        slug,
        url: url.replace(/\/$/, ""),
        state,
        population: population || null,
        county: county || null,
        cms: cms || null,
        maxPages: maxPages || null,
        status: "active",
      })
      .returning();

    res.status(201).json({
      message: `Town '${name}' registered successfully`,
      town: {
        id: town.id,
        name: town.name,
        slug: town.slug,
        url: town.url,
        state: town.state,
        population: town.population,
        county: town.county,
        cms: town.cms,
        status: town.status,
      },
    });
  } catch (error: any) {
    if (error.message?.includes("unique") || error.code === "23505") {
      return apiError(res, 409, "TOWN_EXISTS", `A town with that name or URL already exists`);
    }
    apiError(res, 500, "INTERNAL_ERROR", error.message, true, 30);
  }
});

router.get("/fleet/status", async (_req, res) => {
  try {
    const towns = await crawlerStorage.getTownOverviews();

    const assessments = await db
      .select()
      .from(crawlerSchema.crawlAssessments)
      .orderBy(desc(crawlerSchema.crawlAssessments.assessedAt));
    const assessmentMap = new Map<string, typeof assessments[0]>();
    for (const a of assessments) {
      if (!assessmentMap.has(a.townId)) assessmentMap.set(a.townId, a);
    }

    const now = Date.now();

    const statusList = towns.map((town) => {
      const assessment = assessmentMap.get(town.id);
      const lastCrawlDate = town.lastRunDate ? new Date(town.lastRunDate).getTime() : 0;
      const daysSinceLastCrawl = lastCrawlDate ? Math.round((now - lastCrawlDate) / (1000 * 60 * 60 * 24)) : null;
      const assessmentAgeHours = assessment
        ? Math.round((now - new Date(assessment.assessedAt).getTime()) / (1000 * 60 * 60))
        : null;

      let stalenessScore = 0;
      if (!lastCrawlDate) stalenessScore += 100;
      else stalenessScore += Math.min(daysSinceLastCrawl! * 3, 60);
      if (!assessment) stalenessScore += 30;
      else if (assessmentAgeHours! > 168) stalenessScore += 15;
      if (town.consecutiveFailures > 0) stalenessScore += town.consecutiveFailures * 5;
      const coverageScore = assessment ? Number(assessment.overallScore) : 0;
      if (coverageScore < 50) stalenessScore += 20;
      else if (coverageScore < 70) stalenessScore += 10;

      return {
        id: town.id,
        name: town.name,
        slug: town.slug,
        status: town.status,
        coverageScore: assessment ? Number(assessment.overallScore) : null,
        daysSinceLastCrawl,
        assessmentAgeHours,
        consecutiveFailures: town.consecutiveFailures,
        totalDocuments: town.totalDocuments,
        totalUploaded: town.totalUploaded,
        lastRunStatus: town.lastRunStatus,
        activeRunId: town.activeRunId,
        stalenessScore: Math.round(stalenessScore),
      };
    });

    statusList.sort((a, b) => b.stalenessScore - a.stalenessScore);

    res.json({
      towns: statusList,
      total: statusList.length,
      generatedAt: new Date().toISOString(),
    });
  } catch (error: any) {
    apiError(res, 500, "INTERNAL_ERROR", error.message, true, 30);
  }
});

router.get("/fleet/summary", async (_req, res) => {
  try {
    const stats = await crawlerStorage.getCrawlerStats();

    const assessments = await db
      .select()
      .from(crawlerSchema.crawlAssessments)
      .orderBy(desc(crawlerSchema.crawlAssessments.assessedAt));
    const latestPerTown = new Map<string, typeof assessments[0]>();
    for (const a of assessments) {
      if (!latestPerTown.has(a.townId)) latestPerTown.set(a.townId, a);
    }

    const scores = Array.from(latestPerTown.values()).map((a) => Number(a.overallScore));
    const avgCoverage = scores.length > 0 ? Math.round(scores.reduce((s, v) => s + v, 0) / scores.length * 100) / 100 : null;
    const townsAssessed = scores.length;
    const excellentCoverage = scores.filter((s) => s >= 80).length;
    const poorCoverage = scores.filter((s) => s < 40).length;

    const recentFailures = await db.execute(sql`
      SELECT cr.town_id, ct.name as town_name, cr.status, cr.error_message, cr.started_at
      FROM crawler_runs cr
      JOIN crawler_towns ct ON ct.id = cr.town_id
      WHERE cr.status = 'failed'
      ORDER BY cr.started_at DESC
      LIMIT 10
    `);

    res.json({
      overview: {
        totalTowns: stats.totalTowns,
        totalDocuments: stats.totalDocuments,
        totalUploaded: stats.totalUploaded,
        totalFailed: stats.totalFailed,
        totalUrls: stats.totalUrls,
        activeRuns: stats.activeRuns,
      },
      coverage: {
        townsAssessed,
        averageScore: avgCoverage,
        excellentCoverage,
        poorCoverage,
        unassessed: stats.totalTowns - townsAssessed,
      },
      recentFailures: (recentFailures.rows as any[]).map((r) => ({
        townId: r.town_id,
        townName: r.town_name,
        status: r.status,
        errorMessage: r.error_message,
        startedAt: r.started_at,
      })),
      generatedAt: new Date().toISOString(),
    });
  } catch (error: any) {
    apiError(res, 500, "INTERNAL_ERROR", error.message, true, 30);
  }
});

router.get("/fleet/next-batch", async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit as string) || 10, 50);

    const towns = await crawlerStorage.getTownOverviews();

    const assessments = await db
      .select()
      .from(crawlerSchema.crawlAssessments)
      .orderBy(desc(crawlerSchema.crawlAssessments.assessedAt));
    const assessmentMap = new Map<string, typeof assessments[0]>();
    for (const a of assessments) {
      if (!assessmentMap.has(a.townId)) assessmentMap.set(a.townId, a);
    }

    const now = Date.now();
    const candidates = towns
      .filter((t) => t.status === "active" && !t.activeRunId)
      .map((town) => {
        const assessment = assessmentMap.get(town.id);
        const lastCrawlDate = town.lastRunDate ? new Date(town.lastRunDate).getTime() : 0;
        const daysSinceLastCrawl = lastCrawlDate ? Math.round((now - lastCrawlDate) / (1000 * 60 * 60 * 24)) : null;

        let urgency = 0;
        if (!lastCrawlDate) urgency += 100;
        else urgency += Math.min(daysSinceLastCrawl! * 3, 60);
        if (!assessment) urgency += 30;
        const coverageScore = assessment ? Number(assessment.overallScore) : 0;
        if (coverageScore < 50) urgency += 25;
        else if (coverageScore < 70) urgency += 12;
        if (town.consecutiveFailures >= 3) urgency -= 20;

        return {
          id: town.id,
          name: town.name,
          slug: town.slug,
          url: town.url,
          cms: town.cms,
          population: town.population,
          coverageScore: assessment ? Number(assessment.overallScore) : null,
          daysSinceLastCrawl,
          consecutiveFailures: town.consecutiveFailures,
          urgencyScore: Math.max(0, Math.round(urgency)),
          recommendedMode: !lastCrawlDate ? "full" as const : (daysSinceLastCrawl! > 14 ? "full" as const : "incremental" as const),
          recommendedMaxPages: town.maxPages || (town.population && town.population > 5000 ? 500 : 300),
        };
      });

    candidates.sort((a, b) => b.urgencyScore - a.urgencyScore);

    res.json({
      batch: candidates.slice(0, limit),
      totalCandidates: candidates.length,
      limit,
      generatedAt: new Date().toISOString(),
    });
  } catch (error: any) {
    apiError(res, 500, "INTERNAL_ERROR", error.message, true, 30);
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
