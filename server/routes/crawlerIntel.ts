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
import {
  startStateCrawl,
  getCrawlProgress,
  getActiveCrawls,
  abortCrawl,
} from "../services/crawlerEngine";
import { startCourtListenerCrawl } from "../services/courtListenerCrawl";
import { FAILURE_LABELS, type FailureType } from "../../shared/crawler-schema";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import * as schema from "../../shared/schema";
import jwt from "jsonwebtoken";

const router = Router();

router.get("/spec", (_req, res) => {
  const specPath = path.resolve(process.cwd(), "crawler/CRAWLER-INTEL-API.md");
  try {
    const content = fs.readFileSync(specPath, "utf-8");
    res.setHeader("Content-Type", "text/markdown; charset=utf-8");
    res.send(content);
  } catch {
    res.status(404).json({ error: { code: "SPEC_NOT_FOUND", message: "API spec file not found", retryable: false } });
  }
});

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

function isBotAuth(req: any): boolean {
  const authHeader = req.headers.authorization;
  const expectedKey = process.env.CRAWLER_BOT_API_KEY;
  if (!expectedKey) return true;
  if (!authHeader || !authHeader.startsWith("Bearer ")) return false;
  return authHeader.slice(7) === expectedKey;
}

function isAdminAuth(req: any): boolean {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) return false;
  const token = authHeader.slice(7);
  try {
    const jwtSecret = process.env.JWT_SECRET;
    if (!jwtSecret) return false;
    jwt.verify(token, jwtSecret);
    return true;
  } catch {
    return false;
  }
}

function requireBotAuth(req: any, res: any, next: any) {
  if (isBotAuth(req)) return next();
  return apiError(res, 401, "AUTH_MISSING", "Missing or invalid Authorization header. Use Bearer <CRAWLER_BOT_API_KEY>");
}

function requireBotOrAdminAuth(req: any, res: any, next: any) {
  if (isBotAuth(req) || isAdminAuth(req)) return next();
  return apiError(res, 401, "AUTH_MISSING", "Missing or invalid Authorization. Use bot API key or admin JWT.");
}

router.use(requireBotOrAdminAuth);

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

// ============================================================
// STATE SOURCE ENDPOINTS
// ============================================================

async function resolveStateSource(slugOrId: string) {
  let source = await crawlerStorage.getStateSourceBySlug(slugOrId.toLowerCase());
  if (!source) {
    source = await crawlerStorage.getStateSourceById(slugOrId);
  }
  return source;
}

router.get("/state-sources", async (_req, res) => {
  try {
    const sources = await crawlerStorage.getStateSourceOverviews();
    res.json({
      sources: sources.map((s) => ({
        id: s.id,
        name: s.name,
        slug: s.slug,
        agency: s.agency,
        agencyAbbrev: s.agencyAbbrev,
        state: s.state,
        baseUrl: s.baseUrl,
        description: s.description,
        docCategories: s.docCategories,
        targetPaths: s.targetPaths,
        linkPatterns: s.linkPatterns,
        excludePatterns: s.excludePatterns,
        updateCadence: s.updateCadence,
        scope: s.scope,
        status: s.status,
        totalDocuments: s.totalDocuments,
        totalUploaded: s.totalUploaded,
        consecutiveFailures: s.consecutiveFailures,
        lastRunStatus: s.lastRunStatus,
        lastRunDate: s.lastRunDate,
        lastCrawlDate: s.lastCrawlDate,
        notes: s.notes,
        documentsByStatus: s.documentsByStatus,
      })),
    });
  } catch (error: any) {
    apiError(res, 500, "INTERNAL_ERROR", error.message, true, 30);
  }
});

const registerStateSourceSchema = z.object({
  name: z.string().min(1).max(200),
  agency: z.string().min(1).max(200),
  agencyAbbrev: z.string().max(20).optional(),
  state: z.string().length(2).default("NH"),
  baseUrl: z.string().url(),
  description: z.string().optional(),
  docCategories: z.array(z.string()).default([]),
  targetPaths: z.array(z.string()).default([]),
  linkPatterns: z.array(z.string()).default([]),
  excludePatterns: z.array(z.string()).default([]),
  updateCadence: z.enum(["annual", "semi_annual", "quarterly", "monthly", "weekly", "as_needed"]).default("quarterly"),
  maxPages: z.number().int().positive().optional(),
  notes: z.string().optional(),
});

router.post("/state-sources", async (req, res) => {
  try {
    const parsed = registerStateSourceSchema.safeParse(req.body);
    if (!parsed.success) {
      return apiError(res, 400, "INVALID_INPUT", `Invalid input: ${JSON.stringify(parsed.error.flatten().fieldErrors)}`);
    }

    const data = parsed.data;
    const slug = data.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

    const existing = await crawlerStorage.getStateSourceBySlug(slug);
    if (existing) {
      return apiError(res, 409, "SOURCE_EXISTS", `State source '${data.name}' already registered with slug '${slug}'`);
    }

    const [source] = await db
      .insert(crawlerSchema.crawlerStateSources)
      .values({
        name: data.name,
        slug,
        agency: data.agency,
        agencyAbbrev: data.agencyAbbrev || null,
        state: data.state,
        baseUrl: data.baseUrl.replace(/\/$/, ""),
        description: data.description || null,
        docCategories: data.docCategories as any,
        targetPaths: data.targetPaths as any,
        linkPatterns: data.linkPatterns as any,
        excludePatterns: data.excludePatterns as any,
        updateCadence: data.updateCadence,
        maxPages: data.maxPages || null,
        notes: data.notes || null,
        status: "active",
      })
      .returning();

    res.status(201).json({
      message: `State source '${data.name}' registered successfully`,
      source: {
        id: source.id,
        name: source.name,
        slug: source.slug,
        agency: source.agency,
        agencyAbbrev: source.agencyAbbrev,
        state: source.state,
        baseUrl: source.baseUrl,
        docCategories: source.docCategories,
        status: source.status,
      },
    });
  } catch (error: any) {
    if (error.message?.includes("unique") || error.code === "23505") {
      return apiError(res, 409, "SOURCE_EXISTS", "A state source with that name already exists");
    }
    apiError(res, 500, "INTERNAL_ERROR", error.message, true, 30);
  }
});

router.get("/state-sources/:sourceSlug", async (req, res) => {
  try {
    const source = await resolveStateSource(req.params.sourceSlug);
    if (!source) {
      return apiError(res, 404, "SOURCE_NOT_FOUND", `State source '${req.params.sourceSlug}' not found`);
    }

    const [runsResult, docsResult] = await Promise.all([
      crawlerStorage.getStateSourceRuns(source.id, 10, 0),
      crawlerStorage.getStateDocuments(source.id, undefined, 1, 0),
    ]);

    const docsByCategory = await db.execute(sql`
      SELECT category, COUNT(*) as count
      FROM crawler_state_documents
      WHERE source_id = ${source.id}
      GROUP BY category
    `);
    const categoryBreakdown: Record<string, number> = {};
    for (const row of docsByCategory.rows as any[]) {
      categoryBreakdown[row.category || "uncategorized"] = parseInt(row.count);
    }

    res.json({
      source: {
        id: source.id,
        name: source.name,
        slug: source.slug,
        agency: source.agency,
        agencyAbbrev: source.agencyAbbrev,
        state: source.state,
        baseUrl: source.baseUrl,
        description: source.description,
        docCategories: source.docCategories,
        targetPaths: source.targetPaths,
        linkPatterns: source.linkPatterns,
        excludePatterns: source.excludePatterns,
        updateCadence: source.updateCadence,
        maxPages: source.maxPages,
        scope: source.scope,
        crawlMethod: (source as any).crawlMethod || 'crawl',
        status: source.status,
        totalDocuments: source.totalDocuments,
        totalUploaded: source.totalUploaded,
        consecutiveFailures: source.consecutiveFailures,
        lastCrawlDate: source.lastCrawlDate,
        notes: source.notes,
      },
      documentStats: {
        totalTracked: docsResult.total,
        byCategory: categoryBreakdown,
      },
      recentRuns: runsResult.runs.map((run) => ({
        id: run.id,
        mode: run.mode,
        triggerType: run.triggerType,
        status: run.status,
        startedAt: run.startedAt,
        completedAt: run.completedAt,
        pagesVisited: run.pagesVisited,
        documentsDiscovered: run.documentsDiscovered,
        documentsUploaded: run.documentsUploaded,
        documentsFailed: run.documentsFailed,
        errorMessage: run.errorMessage,
      })),
    });
  } catch (error: any) {
    apiError(res, 500, "INTERNAL_ERROR", error.message, true, 30);
  }
});

router.patch("/state-sources/:sourceSlug", async (req, res) => {
  try {
    const source = await resolveStateSource(req.params.sourceSlug);
    if (!source) {
      return apiError(res, 404, "SOURCE_NOT_FOUND", `State source '${req.params.sourceSlug}' not found`);
    }

    const allowedFields = [
      "name", "agency", "agencyAbbrev", "baseUrl", "description",
      "docCategories", "targetPaths", "linkPatterns", "excludePatterns",
      "updateCadence", "maxPages", "status", "notes", "crawlMethod",
    ];
    const updates: Record<string, any> = {};
    for (const field of allowedFields) {
      if (req.body[field] !== undefined) {
        updates[field] = req.body[field];
      }
    }

    if (Object.keys(updates).length === 0) {
      return apiError(res, 400, "NO_UPDATES", "No valid fields provided to update");
    }

    const updated = await crawlerStorage.updateStateSource(source.id, updates as any);
    res.json({
      message: `State source '${source.name}' updated`,
      source: updated,
    });
  } catch (error: any) {
    apiError(res, 500, "INTERNAL_ERROR", error.message, true, 30);
  }
});

router.get("/state-sources/:sourceSlug/documents", async (req, res) => {
  try {
    const source = await resolveStateSource(req.params.sourceSlug);
    if (!source) {
      return apiError(res, 404, "SOURCE_NOT_FOUND", `State source '${req.params.sourceSlug}' not found`);
    }

    const limit = Math.min(parseInt(req.query.limit as string) || 100, 500);
    const offset = parseInt(req.query.offset as string) || 0;
    const status = req.query.status as string | undefined;
    const search = req.query.search as string | undefined;

    const result = await crawlerStorage.getStateDocuments(source.id, status, limit, offset, search);

    res.json({
      documents: result.documents,
      total: result.total,
    });
  } catch (error: any) {
    apiError(res, 500, "INTERNAL_ERROR", error.message, true, 30);
  }
});

router.get("/state-sources/:sourceSlug/runs", async (req, res) => {
  try {
    const source = await resolveStateSource(req.params.sourceSlug);
    if (!source) {
      return apiError(res, 404, "SOURCE_NOT_FOUND", `State source '${req.params.sourceSlug}' not found`);
    }

    const limit = Math.min(parseInt(req.query.limit as string) || 20, 100);
    const offset = parseInt(req.query.offset as string) || 0;

    const result = await crawlerStorage.getStateSourceRuns(source.id, limit, offset);

    res.json({
      runs: result.runs,
      total: result.total,
    });
  } catch (error: any) {
    apiError(res, 500, "INTERNAL_ERROR", error.message, true, 30);
  }
});

const stateSourceCrawlSchema = z.object({
  mode: z.enum(["full", "incremental", "manual"]).default("full"),
  maxPages: z.number().int().positive().optional(),
  targetPaths: z.array(z.string()).optional(),
  linkPatterns: z.array(z.string()).optional(),
  callbackUrl: z.string().url().optional(),
});

router.post("/state-sources/:sourceSlug/crawl", async (req, res) => {
  try {
    const source = await resolveStateSource(req.params.sourceSlug);
    if (!source) {
      return apiError(res, 404, "SOURCE_NOT_FOUND", `State source '${req.params.sourceSlug}' not found`);
    }

    if (source.status === "disabled") {
      return apiError(res, 409, "SOURCE_DISABLED", `State source '${source.name}' is disabled`);
    }

    const existingActive = getActiveCrawls().find(c => c.townId === source.id && c.status === 'running');
    if (existingActive) {
      return apiError(res, 409, "CRAWL_ALREADY_RUNNING", `Crawl already running for ${source.name}`, false);
    }

    const parsed = stateSourceCrawlSchema.safeParse(req.body || {});
    if (!parsed.success) {
      return apiError(res, 400, "INVALID_INPUT", `Invalid input: ${JSON.stringify(parsed.error.flatten().fieldErrors)}`);
    }

    const { mode, maxPages, targetPaths, linkPatterns, callbackUrl } = parsed.data;

    const effectiveTargetPaths = targetPaths && targetPaths.length > 0
      ? targetPaths
      : (source.targetPaths as string[]) || [];

    const effectiveLinkPatterns = linkPatterns && linkPatterns.length > 0
      ? linkPatterns
      : (source.linkPatterns as string[]) || [];

    const effectiveExcludePatterns = (source.excludePatterns as string[]) || [];

    const run = await crawlerStorage.createStateSourceRun(
      source.id,
      mode,
      "bot",
      maxPages || source.maxPages || undefined
    );

    let runId: string;
    const crawlMethod = (source as any).crawlMethod || 'crawl';

    if (crawlMethod === 'courtlistener') {
      runId = await startCourtListenerCrawl(source, run, {
        dateFiledAfter: mode === 'incremental' && source.lastCrawlDate
          ? source.lastCrawlDate.toISOString().split('T')[0]
          : undefined,
      });
    } else {
      runId = await startStateCrawl(source, run, {
        maxPages: maxPages || source.maxPages || undefined,
        mode,
        targetPaths: effectiveTargetPaths,
        linkPatterns: effectiveLinkPatterns,
        excludePatterns: effectiveExcludePatterns,
      });
    }

    res.json({
      message: `State source crawl started for ${source.name} (${source.agency})`,
      runId,
      sourceId: source.id,
      mode,
      crawlMethod,
      maxPages: maxPages || source.maxPages || "default",
      triggerType: "bot",
      targetPaths: effectiveTargetPaths,
      linkPatterns: effectiveLinkPatterns,
      excludePatterns: effectiveExcludePatterns,
      scope: source.scope,
      hint: `Poll GET /state-sources/${source.slug}/progress for real-time status`,
      ...(callbackUrl ? { callbackUrl } : {}),
    });
  } catch (error: any) {
    apiError(res, 500, "CRAWL_START_FAILED", error.message, true, 60);
  }
});

router.get("/state-sources/:sourceSlug/progress", async (req, res) => {
  try {
    const source = await resolveStateSource(req.params.sourceSlug);
    if (!source) {
      return apiError(res, 404, "SOURCE_NOT_FOUND", `State source '${req.params.sourceSlug}' not found`);
    }

    const activeCrawl = getActiveCrawls().find(c => c.townId === source.id && c.status === 'running');
    if (!activeCrawl) {
      return res.json({ active: false, message: "No active crawl for this source" });
    }

    const progress = getCrawlProgress(activeCrawl.runId);
    if (!progress) {
      return res.json({ active: false, message: "Crawl progress not found" });
    }

    res.json({
      active: true,
      runId: progress.runId,
      status: progress.status,
      pagesVisited: progress.pagesVisited,
      pagesQueued: progress.pagesQueued,
      documentsDiscovered: progress.documentsDiscovered,
      documentsDownloaded: progress.documentsDownloaded,
      documentsFailed: progress.documentsFailed,
      duplicatesSkipped: progress.duplicatesSkipped,
      currentUrl: progress.currentUrl,
      startedAt: progress.startedAt,
      recentLogs: (progress.log || []).slice(-20),
    });
  } catch (error: any) {
    apiError(res, 500, "PROGRESS_FETCH_FAILED", error.message);
  }
});

router.post("/state-sources/:sourceSlug/abort", async (req, res) => {
  try {
    const source = await resolveStateSource(req.params.sourceSlug);
    if (!source) {
      return apiError(res, 404, "SOURCE_NOT_FOUND", `State source '${req.params.sourceSlug}' not found`);
    }

    const activeCrawl = getActiveCrawls().find(c => c.townId === source.id && c.status === 'running');
    if (!activeCrawl) {
      return apiError(res, 404, "NO_ACTIVE_CRAWL", "No active crawl found for this source");
    }

    const aborted = abortCrawl(activeCrawl.runId);
    if (aborted) {
      res.json({ message: `Crawl aborted for ${source.name}`, runId: activeCrawl.runId });
    } else {
      apiError(res, 500, "ABORT_FAILED", "Failed to abort crawl");
    }
  } catch (error: any) {
    apiError(res, 500, "ABORT_FAILED", error.message);
  }
});

// ============================================================
// FLEET ENDPOINTS (Towns + State Sources)
// ============================================================

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

    const stateSourceStats = await crawlerStorage.getStateSourceStats();

    res.json({
      overview: {
        totalTowns: stats.totalTowns,
        totalDocuments: stats.totalDocuments,
        totalUploaded: stats.totalUploaded,
        totalFailed: stats.totalFailed,
        totalUrls: stats.totalUrls,
        activeRuns: stats.activeRuns,
      },
      stateSources: {
        totalSources: stateSourceStats.totalSources,
        totalDocuments: stateSourceStats.totalDocuments,
        totalUploaded: stateSourceStats.totalUploaded,
        totalFailed: stateSourceStats.totalFailed,
        activeRuns: stateSourceStats.activeRuns,
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

// ============================================================
// BOT INTEGRATION ENDPOINTS
// S3 upload, document registration, run reporting
// ============================================================

const S3_BUCKET = process.env.S3_BUCKET || "opencouncil-municipal-docs";
const S3_REGION = process.env.AWS_REGION || "us-east-1";

function getS3Client(): S3Client | null {
  if (!process.env.AWS_ACCESS_KEY_ID || !process.env.AWS_SECRET_ACCESS_KEY) {
    return null;
  }
  return new S3Client({
    region: S3_REGION,
    credentials: {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID!,
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!,
    },
  });
}

async function ensureFileBlobForBotDoc(opts: {
  s3Key: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
}): Promise<string> {
  const rawHash = `s3:${opts.s3Key}`;
  const existing = await db.execute(
    sql`SELECT id FROM file_blobs WHERE raw_hash = ${rawHash}`
  );
  if (existing.rows.length > 0) {
    return (existing.rows[0] as any).id;
  }

  const storagePath = `s3://${S3_BUCKET}/${opts.s3Key}`;
  const [blob] = await db
    .insert(schema.fileBlobs)
    .values({
      rawHash,
      sizeBytes: opts.sizeBytes || 0,
      mimeType: opts.mimeType || "application/pdf",
      originalFilename: opts.filename || opts.s3Key.split("/").pop() || "unknown.pdf",
      storagePath,
      s3Bucket: S3_BUCKET,
      s3Key: opts.s3Key,
      needsOcr: true,
      ocrStatus: "none",
      extractedTextCharCount: 0,
      embeddingStatus: "none",
    })
    .returning();

  return blob.id;
}

const uploadUrlSchema = z.object({
  filename: z.string().min(1).max(500),
  contentType: z.string().default("application/pdf"),
  category: z.string().optional(),
  board: z.string().optional(),
  year: z.string().optional(),
  s3KeyOverride: z.string().optional(),
});

router.post("/:townSlug/upload-url", async (req, res) => {
  try {
    const town = await resolveTown(req.params.townSlug);
    if (!town) {
      return apiError(res, 404, "TOWN_NOT_FOUND", `Town '${req.params.townSlug}' not found`);
    }

    const s3 = getS3Client();
    if (!s3) {
      return apiError(res, 503, "S3_NOT_CONFIGURED", "AWS credentials not configured", true, 60);
    }

    const parsed = uploadUrlSchema.safeParse(req.body);
    if (!parsed.success) {
      return apiError(res, 400, "INVALID_INPUT", `Invalid input: ${JSON.stringify(parsed.error.flatten().fieldErrors)}`);
    }

    const { filename, contentType, category, board, year, s3KeyOverride } = parsed.data;

    let s3Key: string;
    if (s3KeyOverride) {
      const sanitizedOverride = s3KeyOverride.replace(/\.\.\//g, "").replace(/^\//, "");
      if (!sanitizedOverride.startsWith(`${town.slug}/`)) {
        return apiError(res, 400, "INVALID_S3_KEY", `s3KeyOverride must start with '${town.slug}/'`);
      }
      s3Key = sanitizedOverride;
    } else {
      const parts = [town.slug];
      if (category) parts.push(category);
      if (board) parts.push(board);
      if (year) parts.push(year);
      const sanitized = filename.replace(/[^a-zA-Z0-9._-]/g, "_");
      parts.push(sanitized);
      s3Key = parts.join("/");
    }

    const command = new PutObjectCommand({
      Bucket: S3_BUCKET,
      Key: s3Key,
      ContentType: contentType,
    });

    const presignedUrl = await getSignedUrl(s3, command, { expiresIn: 3600 });

    res.json({
      uploadUrl: presignedUrl,
      s3Key,
      bucket: S3_BUCKET,
      expiresIn: 3600,
      method: "PUT",
      headers: {
        "Content-Type": contentType,
      },
    });
  } catch (error: any) {
    apiError(res, 500, "INTERNAL_ERROR", error.message, true, 30);
  }
});

const registerDocSchema = z.object({
  url: z.string().min(1),
  filename: z.string().min(1),
  s3Key: z.string().min(1),
  category: z.string().optional(),
  board: z.string().optional(),
  year: z.string().optional(),
  title: z.string().optional(),
  sizeBytes: z.number().int().positive().optional(),
  mimeType: z.string().optional(),
  discoveredFrom: z.string().optional(),
  contentHash: z.string().optional(),
});

router.post("/:townSlug/documents", async (req, res) => {
  try {
    const town = await resolveTown(req.params.townSlug);
    if (!town) {
      return apiError(res, 404, "TOWN_NOT_FOUND", `Town '${req.params.townSlug}' not found`);
    }

    const parsed = registerDocSchema.safeParse(req.body);
    if (!parsed.success) {
      return apiError(res, 400, "INVALID_INPUT", `Invalid input: ${JSON.stringify(parsed.error.flatten().fieldErrors)}`);
    }

    const data = parsed.data;
    const urlHash = crypto.createHash("sha256").update(data.url).digest("hex");

    const existing = await db.execute(
      sql`SELECT id FROM crawler_documents WHERE url_hash = ${urlHash}`
    );
    if (existing.rows.length > 0) {
      return res.status(200).json({
        message: "Document already registered",
        documentId: (existing.rows[0] as any).id,
        duplicate: true,
      });
    }

    const [doc] = await db
      .insert(crawlerSchema.crawlerDocuments)
      .values({
        townId: town.id,
        url: data.url,
        urlHash,
        filename: data.filename,
        category: data.category || null,
        board: data.board || null,
        year: data.year || null,
        sizeBytes: data.sizeBytes || null,
        mimeType: data.mimeType || "application/pdf",
        s3Key: data.s3Key,
        s3UploadedAt: new Date(),
        discoveredFrom: data.discoveredFrom || null,
        status: "uploaded",
      })
      .returning();

    const fileBlobId = await ensureFileBlobForBotDoc({
      s3Key: data.s3Key,
      filename: data.filename,
      mimeType: data.mimeType || "application/pdf",
      sizeBytes: data.sizeBytes || 0,
    });

    await db.execute(sql`
      UPDATE crawler_documents SET file_blob_id = ${fileBlobId} WHERE id = ${doc.id}
    `);

    await db.execute(sql`
      UPDATE crawler_towns 
      SET total_documents = total_documents + 1,
          total_uploaded = total_uploaded + 1,
          updated_at = NOW()
      WHERE id = ${town.id}
    `);

    res.status(201).json({
      message: "Document registered successfully",
      documentId: doc.id,
      fileBlobId,
      s3Key: data.s3Key,
      duplicate: false,
    });
  } catch (error: any) {
    apiError(res, 500, "INTERNAL_ERROR", error.message, true, 30);
  }
});

const batchRegisterDocsSchema = z.object({
  documents: z.array(registerDocSchema).min(1).max(100),
});

router.post("/:townSlug/documents/batch", async (req, res) => {
  try {
    const town = await resolveTown(req.params.townSlug);
    if (!town) {
      return apiError(res, 404, "TOWN_NOT_FOUND", `Town '${req.params.townSlug}' not found`);
    }

    const parsed = batchRegisterDocsSchema.safeParse(req.body);
    if (!parsed.success) {
      return apiError(res, 400, "INVALID_INPUT", `Invalid input: ${JSON.stringify(parsed.error.flatten().fieldErrors)}`);
    }

    const results: Array<{ url: string; documentId: string; duplicate: boolean; error?: string }> = [];
    let newCount = 0;

    for (const docData of parsed.data.documents) {
      try {
        const urlHash = crypto.createHash("sha256").update(docData.url).digest("hex");

        const existing = await db.execute(
          sql`SELECT id FROM crawler_documents WHERE url_hash = ${urlHash}`
        );

        if (existing.rows.length > 0) {
          results.push({
            url: docData.url,
            documentId: (existing.rows[0] as any).id,
            duplicate: true,
          });
          continue;
        }

        const [doc] = await db
          .insert(crawlerSchema.crawlerDocuments)
          .values({
            townId: town.id,
            url: docData.url,
            urlHash,
            filename: docData.filename,
            category: docData.category || null,
            board: docData.board || null,
            year: docData.year || null,
            sizeBytes: docData.sizeBytes || null,
            mimeType: docData.mimeType || "application/pdf",
            s3Key: docData.s3Key,
            s3UploadedAt: new Date(),
            discoveredFrom: docData.discoveredFrom || null,
            status: "uploaded",
          })
          .returning();

        const fileBlobId = await ensureFileBlobForBotDoc({
          s3Key: docData.s3Key,
          filename: docData.filename,
          mimeType: docData.mimeType || "application/pdf",
          sizeBytes: docData.sizeBytes || 0,
        });

        await db.execute(sql`
          UPDATE crawler_documents SET file_blob_id = ${fileBlobId} WHERE id = ${doc.id}
        `);

        results.push({
          url: docData.url,
          documentId: doc.id,
          duplicate: false,
        });
        newCount++;
      } catch (err: any) {
        results.push({
          url: docData.url,
          documentId: "",
          duplicate: false,
          error: err.message,
        });
      }
    }

    if (newCount > 0) {
      await db.execute(sql`
        UPDATE crawler_towns 
        SET total_documents = total_documents + ${newCount},
            total_uploaded = total_uploaded + ${newCount},
            updated_at = NOW()
        WHERE id = ${town.id}
      `);
    }

    res.status(201).json({
      message: `Batch registration complete: ${newCount} new, ${results.filter(r => r.duplicate).length} duplicates, ${results.filter(r => r.error).length} errors`,
      total: parsed.data.documents.length,
      registered: newCount,
      duplicates: results.filter(r => r.duplicate).length,
      errors: results.filter(r => r.error).length,
      results,
    });
  } catch (error: any) {
    apiError(res, 500, "INTERNAL_ERROR", error.message, true, 30);
  }
});

const runReportSchema = z.object({
  mode: z.enum(["full", "incremental", "manual"]).default("full"),
  status: z.enum(["completed", "failed", "timeout"]).default("completed"),
  pagesVisited: z.number().int().min(0).default(0),
  documentsDiscovered: z.number().int().min(0).default(0),
  documentsDownloaded: z.number().int().min(0).default(0),
  documentsUploaded: z.number().int().min(0).default(0),
  documentsFailed: z.number().int().min(0).default(0),
  startedAt: z.string().datetime().optional(),
  completedAt: z.string().datetime().optional(),
  durationSeconds: z.number().int().min(0).optional(),
  maxPagesLimit: z.number().int().positive().optional(),
  errorMessage: z.string().optional(),
  summary: z.record(z.any()).optional(),
  errors: z.array(z.object({
    url: z.string(),
    error: z.string(),
    failureType: z.string().optional(),
  })).optional(),
});

router.post("/:townSlug/runs/report", async (req, res) => {
  try {
    const town = await resolveTown(req.params.townSlug);
    if (!town) {
      return apiError(res, 404, "TOWN_NOT_FOUND", `Town '${req.params.townSlug}' not found`);
    }

    const parsed = runReportSchema.safeParse(req.body);
    if (!parsed.success) {
      return apiError(res, 400, "INVALID_INPUT", `Invalid input: ${JSON.stringify(parsed.error.flatten().fieldErrors)}`);
    }

    const data = parsed.data;

    const startedAt = data.startedAt ? new Date(data.startedAt) : (
      data.durationSeconds && data.completedAt
        ? new Date(new Date(data.completedAt).getTime() - data.durationSeconds * 1000)
        : new Date()
    );
    const completedAt = data.completedAt ? new Date(data.completedAt) : new Date();

    const summaryData = {
      ...(data.summary || {}),
      ...(data.errors?.length ? {
        errors: data.errors,
        failuresByType: data.errors.reduce((acc: Record<string, number>, e) => {
          const ft = e.failureType || "unknown";
          acc[ft] = (acc[ft] || 0) + 1;
          return acc;
        }, {}),
      } : {}),
      reportedBy: "bot",
    };

    const [run] = await db
      .insert(crawlerSchema.crawlerRuns)
      .values({
        townId: town.id,
        mode: data.mode,
        triggerType: "bot",
        startedAt,
        completedAt,
        status: data.status,
        pagesVisited: data.pagesVisited,
        documentsDiscovered: data.documentsDiscovered,
        documentsDownloaded: data.documentsDownloaded,
        documentsUploaded: data.documentsUploaded,
        documentsFailed: data.documentsFailed,
        maxPagesLimit: data.maxPagesLimit || null,
        errorMessage: data.errorMessage || null,
        summary: summaryData,
      })
      .returning();

    if (data.status === "completed") {
      const updateParts = [
        sql`consecutive_failures = 0`,
        sql`last_crawl_docs_found = ${data.documentsDiscovered}`,
        sql`updated_at = NOW()`,
      ];
      if (data.mode === "full") {
        updateParts.push(sql`last_full_crawl = ${completedAt}`);
      } else {
        updateParts.push(sql`last_incremental_crawl = ${completedAt}`);
      }
      await db.execute(sql`
        UPDATE crawler_towns 
        SET ${sql.join(updateParts, sql`, `)}
        WHERE id = ${town.id}
      `);
    } else if (data.status === "failed") {
      await db.execute(sql`
        UPDATE crawler_towns 
        SET consecutive_failures = consecutive_failures + 1,
            updated_at = NOW()
        WHERE id = ${town.id}
      `);
    }

    res.status(201).json({
      message: "Run report recorded",
      runId: run.id,
      townSlug: town.slug,
      status: data.status,
      documentsUploaded: data.documentsUploaded,
      documentsFailed: data.documentsFailed,
    });
  } catch (error: any) {
    apiError(res, 500, "INTERNAL_ERROR", error.message, true, 30);
  }
});

// ============================================================
// STATE SOURCE BOT INTEGRATION ENDPOINTS
// ============================================================

router.post("/state-sources/:sourceSlug/upload-url", async (req, res) => {
  try {
    const source = await resolveStateSource(req.params.sourceSlug);
    if (!source) {
      return apiError(res, 404, "SOURCE_NOT_FOUND", `State source '${req.params.sourceSlug}' not found`);
    }

    const s3 = getS3Client();
    if (!s3) {
      return apiError(res, 503, "S3_NOT_CONFIGURED", "AWS credentials not configured", true, 60);
    }

    const parsed = uploadUrlSchema.safeParse(req.body);
    if (!parsed.success) {
      return apiError(res, 400, "INVALID_INPUT", `Invalid input: ${JSON.stringify(parsed.error.flatten().fieldErrors)}`);
    }

    const { filename, contentType, category, s3KeyOverride } = parsed.data;

    let s3Key: string;
    if (s3KeyOverride) {
      const sanitizedOverride = s3KeyOverride.replace(/\.\.\//g, "").replace(/^\//, "");
      if (!sanitizedOverride.startsWith(`statewide/${source.slug}/`)) {
        return apiError(res, 400, "INVALID_S3_KEY", `s3KeyOverride must start with 'statewide/${source.slug}/'`);
      }
      s3Key = sanitizedOverride;
    } else {
      const parts = ["statewide", source.slug];
      if (category) parts.push(category);
      const sanitized = filename.replace(/[^a-zA-Z0-9._-]/g, "_");
      parts.push(sanitized);
      s3Key = parts.join("/");
    }

    const command = new PutObjectCommand({
      Bucket: S3_BUCKET,
      Key: s3Key,
      ContentType: contentType,
    });

    const presignedUrl = await getSignedUrl(s3, command, { expiresIn: 3600 });

    res.json({
      uploadUrl: presignedUrl,
      s3Key,
      bucket: S3_BUCKET,
      expiresIn: 3600,
      method: "PUT",
      headers: {
        "Content-Type": contentType,
      },
    });
  } catch (error: any) {
    apiError(res, 500, "INTERNAL_ERROR", error.message, true, 30);
  }
});

const registerStateDocSchema = z.object({
  url: z.string().min(1),
  filename: z.string().min(1),
  s3Key: z.string().min(1),
  category: z.string().optional(),
  subcategory: z.string().optional(),
  title: z.string().optional(),
  rsaChapter: z.string().optional(),
  sizeBytes: z.number().int().positive().optional(),
  mimeType: z.string().optional(),
  discoveredFrom: z.string().optional(),
});

router.post("/state-sources/:sourceSlug/documents", async (req, res) => {
  try {
    const source = await resolveStateSource(req.params.sourceSlug);
    if (!source) {
      return apiError(res, 404, "SOURCE_NOT_FOUND", `State source '${req.params.sourceSlug}' not found`);
    }

    const parsed = registerStateDocSchema.safeParse(req.body);
    if (!parsed.success) {
      return apiError(res, 400, "INVALID_INPUT", `Invalid input: ${JSON.stringify(parsed.error.flatten().fieldErrors)}`);
    }

    const data = parsed.data;
    const urlHash = crypto.createHash("sha256").update(data.url).digest("hex");

    const existing = await db.execute(
      sql`SELECT id FROM crawler_state_documents WHERE url_hash = ${urlHash}`
    );
    if (existing.rows.length > 0) {
      return res.status(200).json({
        message: "Document already registered",
        documentId: (existing.rows[0] as any).id,
        duplicate: true,
      });
    }

    const [doc] = await db
      .insert(crawlerSchema.crawlerStateDocuments)
      .values({
        sourceId: source.id,
        url: data.url,
        urlHash,
        filename: data.filename,
        category: data.category || null,
        subcategory: data.subcategory || null,
        title: data.title || null,
        rsaChapter: data.rsaChapter || null,
        sizeBytes: data.sizeBytes || null,
        mimeType: data.mimeType || "application/pdf",
        s3Key: data.s3Key,
        s3UploadedAt: new Date(),
        discoveredFrom: data.discoveredFrom || null,
        status: "uploaded",
      })
      .returning();

    const fileBlobId = await ensureFileBlobForBotDoc({
      s3Key: data.s3Key,
      filename: data.filename,
      mimeType: data.mimeType || "application/pdf",
      sizeBytes: data.sizeBytes || 0,
    });

    await db.execute(sql`
      UPDATE crawler_state_documents SET file_blob_id = ${fileBlobId} WHERE id = ${doc.id}
    `);

    await db.execute(sql`
      UPDATE crawler_state_sources 
      SET total_documents = total_documents + 1,
          total_uploaded = total_uploaded + 1,
          updated_at = NOW()
      WHERE id = ${source.id}
    `);

    res.status(201).json({
      message: "State document registered successfully",
      documentId: doc.id,
      fileBlobId,
      s3Key: data.s3Key,
      duplicate: false,
    });
  } catch (error: any) {
    apiError(res, 500, "INTERNAL_ERROR", error.message, true, 30);
  }
});

const batchRegisterStateDocsSchema = z.object({
  documents: z.array(registerStateDocSchema).min(1).max(100),
});

router.post("/state-sources/:sourceSlug/documents/batch", async (req, res) => {
  try {
    const source = await resolveStateSource(req.params.sourceSlug);
    if (!source) {
      return apiError(res, 404, "SOURCE_NOT_FOUND", `State source '${req.params.sourceSlug}' not found`);
    }

    const parsed = batchRegisterStateDocsSchema.safeParse(req.body);
    if (!parsed.success) {
      return apiError(res, 400, "INVALID_INPUT", `Invalid input: ${JSON.stringify(parsed.error.flatten().fieldErrors)}`);
    }

    const results: Array<{ url: string; documentId: string; duplicate: boolean; error?: string }> = [];
    let newCount = 0;

    for (const docData of parsed.data.documents) {
      try {
        const urlHash = crypto.createHash("sha256").update(docData.url).digest("hex");

        const existing = await db.execute(
          sql`SELECT id FROM crawler_state_documents WHERE url_hash = ${urlHash}`
        );

        if (existing.rows.length > 0) {
          results.push({
            url: docData.url,
            documentId: (existing.rows[0] as any).id,
            duplicate: true,
          });
          continue;
        }

        const [doc] = await db
          .insert(crawlerSchema.crawlerStateDocuments)
          .values({
            sourceId: source.id,
            url: docData.url,
            urlHash,
            filename: docData.filename,
            category: docData.category || null,
            subcategory: docData.subcategory || null,
            title: docData.title || null,
            rsaChapter: docData.rsaChapter || null,
            sizeBytes: docData.sizeBytes || null,
            mimeType: docData.mimeType || "application/pdf",
            s3Key: docData.s3Key,
            s3UploadedAt: new Date(),
            discoveredFrom: docData.discoveredFrom || null,
            status: "uploaded",
          })
          .returning();

        const fileBlobId = await ensureFileBlobForBotDoc({
          s3Key: docData.s3Key,
          filename: docData.filename,
          mimeType: docData.mimeType || "application/pdf",
          sizeBytes: docData.sizeBytes || 0,
        });

        await db.execute(sql`
          UPDATE crawler_state_documents SET file_blob_id = ${fileBlobId} WHERE id = ${doc.id}
        `);

        results.push({
          url: docData.url,
          documentId: doc.id,
          duplicate: false,
        });
        newCount++;
      } catch (err: any) {
        results.push({
          url: docData.url,
          documentId: "",
          duplicate: false,
          error: err.message,
        });
      }
    }

    if (newCount > 0) {
      await db.execute(sql`
        UPDATE crawler_state_sources 
        SET total_documents = total_documents + ${newCount},
            total_uploaded = total_uploaded + ${newCount},
            updated_at = NOW()
        WHERE id = ${source.id}
      `);
    }

    res.status(201).json({
      message: `Batch registration complete: ${newCount} new, ${results.filter(r => r.duplicate).length} duplicates, ${results.filter(r => r.error).length} errors`,
      total: parsed.data.documents.length,
      registered: newCount,
      duplicates: results.filter(r => r.duplicate).length,
      errors: results.filter(r => r.error).length,
      results,
    });
  } catch (error: any) {
    apiError(res, 500, "INTERNAL_ERROR", error.message, true, 30);
  }
});

const stateRunReportSchema = z.object({
  mode: z.enum(["full", "incremental", "manual"]).default("full"),
  status: z.enum(["completed", "failed", "timeout"]).default("completed"),
  pagesVisited: z.number().int().min(0).default(0),
  documentsDiscovered: z.number().int().min(0).default(0),
  documentsDownloaded: z.number().int().min(0).default(0),
  documentsUploaded: z.number().int().min(0).default(0),
  documentsFailed: z.number().int().min(0).default(0),
  startedAt: z.string().datetime().optional(),
  completedAt: z.string().datetime().optional(),
  durationSeconds: z.number().int().min(0).optional(),
  maxPagesLimit: z.number().int().positive().optional(),
  errorMessage: z.string().optional(),
  summary: z.record(z.any()).optional(),
  errors: z.array(z.object({
    url: z.string(),
    error: z.string(),
    failureType: z.string().optional(),
  })).optional(),
});

router.post("/state-sources/:sourceSlug/runs/report", async (req, res) => {
  try {
    const source = await resolveStateSource(req.params.sourceSlug);
    if (!source) {
      return apiError(res, 404, "SOURCE_NOT_FOUND", `State source '${req.params.sourceSlug}' not found`);
    }

    const parsed = stateRunReportSchema.safeParse(req.body);
    if (!parsed.success) {
      return apiError(res, 400, "INVALID_INPUT", `Invalid input: ${JSON.stringify(parsed.error.flatten().fieldErrors)}`);
    }

    const data = parsed.data;

    const startedAt = data.startedAt ? new Date(data.startedAt) : (
      data.durationSeconds && data.completedAt
        ? new Date(new Date(data.completedAt).getTime() - data.durationSeconds * 1000)
        : new Date()
    );
    const completedAt = data.completedAt ? new Date(data.completedAt) : new Date();

    const summaryData = {
      ...(data.summary || {}),
      ...(data.errors?.length ? {
        errors: data.errors,
        failuresByType: data.errors.reduce((acc: Record<string, number>, e) => {
          const ft = e.failureType || "unknown";
          acc[ft] = (acc[ft] || 0) + 1;
          return acc;
        }, {}),
      } : {}),
      reportedBy: "bot",
    };

    const [run] = await db
      .insert(crawlerSchema.crawlerStateSourceRuns)
      .values({
        sourceId: source.id,
        mode: data.mode,
        triggerType: "bot",
        startedAt,
        completedAt,
        status: data.status,
        pagesVisited: data.pagesVisited,
        documentsDiscovered: data.documentsDiscovered,
        documentsDownloaded: data.documentsDownloaded,
        documentsUploaded: data.documentsUploaded,
        documentsFailed: data.documentsFailed,
        maxPagesLimit: data.maxPagesLimit || null,
        errorMessage: data.errorMessage || null,
        summary: summaryData,
      })
      .returning();

    if (data.status === "completed") {
      await db.execute(sql`
        UPDATE crawler_state_sources 
        SET last_crawl_date = ${completedAt},
            consecutive_failures = 0,
            updated_at = NOW()
        WHERE id = ${source.id}
      `);
    } else if (data.status === "failed") {
      await db.execute(sql`
        UPDATE crawler_state_sources 
        SET consecutive_failures = consecutive_failures + 1,
            updated_at = NOW()
        WHERE id = ${source.id}
      `);
    }

    res.status(201).json({
      message: "Run report recorded",
      runId: run.id,
      sourceSlug: source.slug,
      status: data.status,
      documentsUploaded: data.documentsUploaded,
      documentsFailed: data.documentsFailed,
    });
  } catch (error: any) {
    apiError(res, 500, "INTERNAL_ERROR", error.message, true, 30);
  }
});

const S3_BUCKET_BACKFILL = process.env.S3_BUCKET || "opencouncil-municipal-docs";

router.post("/backfill-blobs", async (req, res) => {
  try {
    const { townSlug, limit: batchLimit, dryRun } = req.body || {};
    const maxDocs = Math.min(Number(batchLimit) || 10000, 50000);
    const BATCH_SIZE = 50;

    const whereClause = townSlug
      ? sql`cd.status = 'uploaded' AND cd.file_blob_id IS NULL AND cd.s3_key IS NOT NULL AND ct.slug = ${townSlug}`
      : sql`cd.status = 'uploaded' AND cd.file_blob_id IS NULL AND cd.s3_key IS NOT NULL`;

    const countResult = await db.execute(sql`
      SELECT COUNT(*) as total
      FROM crawler_documents cd
      JOIN crawler_towns ct ON cd.town_id = ct.id
      WHERE ${whereClause}
    `);
    const totalUnbridged = Number((countResult.rows[0] as any)?.total || 0);

    if (dryRun) {
      return res.json({
        dryRun: true,
        totalUnbridged,
        wouldProcess: Math.min(totalUnbridged, maxDocs),
        message: `Found ${totalUnbridged} uploaded docs without file_blob_id${townSlug ? ` for ${townSlug}` : ''}`,
      });
    }

    const docs = await db.execute(sql`
      SELECT cd.id, cd.s3_key, cd.filename, cd.mime_type, cd.size_bytes
      FROM crawler_documents cd
      JOIN crawler_towns ct ON cd.town_id = ct.id
      WHERE ${whereClause}
      ORDER BY cd.s3_uploaded_at ASC
      LIMIT ${maxDocs}
    `);

    let created = 0;
    let linked = 0;
    let skipped = 0;
    let errors = 0;

    for (let i = 0; i < docs.rows.length; i += BATCH_SIZE) {
      const batch = docs.rows.slice(i, i + BATCH_SIZE) as any[];

      for (const doc of batch) {
        try {
          const rawHash = `s3:${doc.s3_key}`;
          const existingBlob = await db.execute(
            sql`SELECT id FROM file_blobs WHERE raw_hash = ${rawHash}`
          );

          let fileBlobId: string;
          if (existingBlob.rows.length > 0) {
            fileBlobId = (existingBlob.rows[0] as any).id;
            skipped++;
          } else {
            const storagePath = `s3://${S3_BUCKET_BACKFILL}/${doc.s3_key}`;
            const [blob] = await db
              .insert(schema.fileBlobs)
              .values({
                rawHash,
                sizeBytes: doc.size_bytes || 0,
                mimeType: doc.mime_type || "application/pdf",
                originalFilename: doc.filename || doc.s3_key.split("/").pop() || "unknown.pdf",
                storagePath,
                s3Bucket: S3_BUCKET_BACKFILL,
                s3Key: doc.s3_key,
                needsOcr: false,
                ocrStatus: "none",
                extractedTextCharCount: 0,
                embeddingStatus: "none",
              })
              .returning();
            fileBlobId = blob.id;
            created++;
          }

          await db.execute(sql`
            UPDATE crawler_documents SET file_blob_id = ${fileBlobId} WHERE id = ${doc.id} AND file_blob_id IS NULL
          `);
          linked++;
        } catch (e: any) {
          errors++;
          if (errors <= 5) {
            console.error(`[Backfill] Error for doc ${doc.id}: ${e.message}`);
          }
        }
      }

      if (i + BATCH_SIZE < docs.rows.length) {
        await new Promise(r => setTimeout(r, 50));
      }
    }

    res.json({
      message: `Backfill complete${townSlug ? ` for ${townSlug}` : ''}`,
      totalUnbridged,
      processed: docs.rows.length,
      created,
      linked,
      skipped,
      errors,
    });
  } catch (error: any) {
    apiError(res, 500, "INTERNAL_ERROR", error.message, true, 30);
  }
});

export default router;
