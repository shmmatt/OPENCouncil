import { Router } from "express";
import { GoogleGenAI } from "@google/genai";
import { z } from "zod";
import { authenticateAdmin } from "../middleware/auth";
import { db, schema, eq, desc, sql } from "../storage/db";
import type {
  SitePlanApplication,
  FrictionReportData,
  FunnelStage,
  FrictionCategory,
} from "@shared/schema";
import { logInfo, logError } from "../utils/logger";

const router = Router();
router.use(authenticateAdmin);

const ai = new GoogleGenAI({ apiKey: process.env.GEM_API_KEY || "" });
const GEMINI_MODEL = "gemini-2.5-flash";

const frictionReportBodySchema = z.object({
  townName: z.string().min(1, "townName is required"),
});

const MAP_SYSTEM_PROMPT = `You are a municipal records analyst specializing in New Hampshire local governance. You are analyzing meeting minutes from Planning Board and Zoning Board of Adjustment (ZBA) meetings.

Your task is to extract ALL site plan review applications, subdivision applications, and commercial/residential development proposals mentioned in these meeting minutes.

For each application/project you find, extract:
- entityName: The project or business name (e.g., "Main Street Retail Expansion", "Smith Subdivision")
- address: The property address or tax map/lot reference if available
- applicant: The applicant or representative name
- initialAppearanceDate: The date this project first appeared (from these minutes)
- lastAppearanceDate: The most recent date mentioned for this project
- totalContinuances: How many times the application was continued/tabled/postponed (0 if approved same meeting)
- outcome: One of "approved", "approved_with_conditions", "denied", "withdrawn", "pending", "unknown"
- conditions: Array of specific conditions imposed (if approved with conditions)
- primaryFrictionReason: The main issue causing delay or denial (e.g., "Parking setback violation", "Drainage concerns", "Abutter noise complaints")
- frictionCategories: Categories of friction like "abutter_pushback", "zoning_dimensional", "state_local_clash", "environmental", "traffic_access", "procedural", "infrastructure"
- appealPath: "zba" if appealed to ZBA, "superior_court" if appealed to Superior Court, "none" if no appeal, "unknown" if unclear
- appealOutcome: Result of any appeal
- meetingReferences: Array of meeting dates/descriptions where this project was discussed

Be thorough. Extract EVERY project mentioned, even if only briefly discussed. If information is unclear, use "unknown" rather than guessing.`;

const MAP_RESPONSE_SCHEMA = {
  type: "object" as const,
  properties: {
    applications: {
      type: "array" as const,
      items: {
        type: "object" as const,
        properties: {
          entityName: { type: "string" as const },
          address: { type: "string" as const },
          applicant: { type: "string" as const },
          initialAppearanceDate: { type: "string" as const },
          lastAppearanceDate: { type: "string" as const },
          totalContinuances: { type: "number" as const },
          outcome: { type: "string" as const },
          conditions: { type: "array" as const, items: { type: "string" as const } },
          primaryFrictionReason: { type: "string" as const },
          frictionCategories: { type: "array" as const, items: { type: "string" as const } },
          appealPath: { type: "string" as const },
          appealOutcome: { type: "string" as const },
          meetingReferences: { type: "array" as const, items: { type: "string" as const } },
        },
        required: ["entityName", "totalContinuances", "outcome", "appealPath", "meetingReferences"],
      },
    },
  },
  required: ["applications"],
};

const REDUCE_SYSTEM_PROMPT = `You are a data analyst merging extracted site plan application records. You have received multiple batches of extracted applications from different meeting minutes for the same town.

Many projects span multiple meetings. Your job is to:
1. MERGE duplicate projects into a single unified record. Match by entity name, address, and applicant (use fuzzy matching — "Smith's Gas Station Expansion" and "Smith Gas Station" are likely the same project).
2. For merged records, combine the timeline: use the earliest initialAppearanceDate, the latest lastAppearanceDate, aggregate totalContinuances, use the FINAL outcome, and merge all meetingReferences.
3. Combine all conditions and friction reasons from the full timeline.
4. If one batch says "pending" and a later batch says "approved", the final outcome is "approved".

Return the deduplicated, merged list of applications.`;

const ANALYSIS_SYSTEM_PROMPT = `You are a municipal development analytics expert. Given a list of deduplicated site plan applications for a town, produce:

1. funnelStages: An array of funnel stages showing the attrition of applications through the approval process:
   - "Total Applications" (100%)
   - "Delayed (2+ Continuances)" — applications requiring more than 2 continuances
   - "Approved Without Conditions" — clean approvals
   - "Approved With Conditions" — approvals that had conditions imposed
   - "Denied" — outright denials
   - "Appeals Filed" — applications that went to ZBA or Superior Court
   - "Appeal Successes" — denied applications that won on appeal
   Each stage needs: label, count, percentage (relative to total), and a brief description.

2. frictionMatrix: Categorize the primary reasons for friction/delays/denials:
   - "Abutter Pushback" (traffic, noise, property value concerns from neighbors)
   - "Zoning Dimensional Constraints" (setbacks, parking, lot coverage)
   - "State vs. Local Regulatory Clash" (NH DOT vs. local requirements)
   - "Environmental/Drainage" (stormwater, wetlands, erosion)
   - "Traffic/Access" (driveway permits, traffic studies, road impact)
   - "Procedural/Incomplete" (missing documents, incomplete applications)
   - "Infrastructure" (water, sewer, utilities)
   - "Other"
   Each category needs: category name, count, percentage of total friction events, and 1-2 example project names.

3. predictiveInsights: 3-5 data-driven insights in plain English. Examples:
   - "Projects involving new commercial driveways are X times more likely to face continuances than change-of-use applications."
   - "X% of applications that receive abutter complaints are eventually approved, but with an average delay of Y meetings."
   - "The average site plan takes X meetings from initial submission to final decision."
   Make these specific to the actual data — reference real numbers and project types from the applications list.`;

const ANALYSIS_RESPONSE_SCHEMA = {
  type: "object" as const,
  properties: {
    funnelStages: {
      type: "array" as const,
      items: {
        type: "object" as const,
        properties: {
          label: { type: "string" as const },
          count: { type: "number" as const },
          percentage: { type: "number" as const },
          description: { type: "string" as const },
        },
        required: ["label", "count", "percentage"],
      },
    },
    frictionMatrix: {
      type: "array" as const,
      items: {
        type: "object" as const,
        properties: {
          category: { type: "string" as const },
          count: { type: "number" as const },
          percentage: { type: "number" as const },
          examples: { type: "array" as const, items: { type: "string" as const } },
        },
        required: ["category", "count", "percentage"],
      },
    },
    predictiveInsights: {
      type: "array" as const,
      items: { type: "string" as const },
    },
  },
  required: ["funnelStages", "frictionMatrix", "predictiveInsights"],
};

router.get("/towns", async (_req, res) => {
  try {
    const results = await db.execute(sql`
      SELECT 
        metadata->>'town' as town_name,
        COUNT(*) as chunk_count
      FROM document_chunks
      WHERE metadata->>'town' IS NOT NULL
        AND lower(metadata->>'town') != 'statewide'
      GROUP BY metadata->>'town'
      ORDER BY COUNT(*) DESC
    `);

    const towns = results.rows.map((r: any) => ({
      name: r.town_name,
      chunkCount: parseInt(r.chunk_count, 10),
    }));

    res.json({ towns });
  } catch (error) {
    logError("Failed to fetch research towns", { error: String(error) });
    res.status(500).json({ message: "Failed to fetch towns" });
  }
});

router.post("/friction-report", async (req, res) => {
  try {
    const parsed = frictionReportBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ message: parsed.error.errors[0]?.message || "Invalid request body" });
    }
    const { townName } = parsed.data;

    if (!process.env.GEM_API_KEY) {
      return res.status(500).json({ message: "GEM_API_KEY environment variable is not configured" });
    }

    const [report] = await db
      .insert(schema.researchReports)
      .values({
        townName,
        reportType: "friction",
        status: "pending",
        chunksAnalyzed: 0,
      })
      .returning();

    runFrictionPipeline(report.id, townName).catch((err) => {
      logError("Friction pipeline failed", { reportId: report.id, error: String(err) });
    });

    res.json({ reportId: report.id, status: "pending" });
  } catch (error) {
    logError("Failed to create friction report", { error: String(error) });
    res.status(500).json({ message: "Failed to create report" });
  }
});

router.get("/friction-report/:id", async (req, res) => {
  try {
    const [report] = await db
      .select()
      .from(schema.researchReports)
      .where(eq(schema.researchReports.id, req.params.id));

    if (!report) {
      return res.status(404).json({ message: "Report not found" });
    }

    res.json(report);
  } catch (error) {
    logError("Failed to fetch report", { error: String(error) });
    res.status(500).json({ message: "Failed to fetch report" });
  }
});

router.get("/friction-reports", async (_req, res) => {
  try {
    const reports = await db
      .select()
      .from(schema.researchReports)
      .orderBy(desc(schema.researchReports.createdAt));

    res.json({ reports });
  } catch (error) {
    logError("Failed to fetch reports", { error: String(error) });
    res.status(500).json({ message: "Failed to fetch reports" });
  }
});

router.delete("/friction-report/:id", async (req, res) => {
  try {
    await db
      .delete(schema.researchReports)
      .where(eq(schema.researchReports.id, req.params.id));

    res.json({ success: true });
  } catch (error) {
    logError("Failed to delete report", { error: String(error) });
    res.status(500).json({ message: "Failed to delete report" });
  }
});

async function runFrictionPipeline(reportId: string, townName: string): Promise<void> {
  try {
    await db
      .update(schema.researchReports)
      .set({ status: "processing" })
      .where(eq(schema.researchReports.id, reportId));

    const chunks = await db.execute(sql`
      SELECT id, content, metadata
      FROM document_chunks
      WHERE lower(metadata->>'town') = ${townName.toLowerCase()}
        AND (
          lower(metadata->>'board') LIKE '%planning%'
          OR lower(metadata->>'board') LIKE '%zba%'
          OR lower(metadata->>'board') LIKE '%zoning%'
          OR lower(metadata->>'documentType') LIKE '%meeting_minutes%'
          OR lower(metadata->>'documentType') LIKE '%minutes%'
          OR lower(content) LIKE '%planning board%'
          OR lower(content) LIKE '%site plan%'
          OR lower(content) LIKE '%zoning board%'
        )
      ORDER BY metadata->>'date' ASC NULLS LAST, id ASC
    `);

    const allChunks = chunks.rows as any[];
    logInfo(`Friction pipeline: found ${allChunks.length} relevant chunks for ${townName}`, { stage: "research" });

    if (allChunks.length === 0) {
      await db
        .update(schema.researchReports)
        .set({
          status: "completed",
          chunksAnalyzed: 0,
          completedAt: new Date(),
          reportData: {
            townName,
            chunksAnalyzed: 0,
            batchesProcessed: 0,
            funnelStages: [],
            frictionMatrix: [],
            predictiveInsights: ["No Planning Board or ZBA meeting minutes found for this town. Upload meeting minutes to generate a friction report."],
            applications: [],
          },
        })
        .where(eq(schema.researchReports.id, reportId));
      return;
    }

    await db
      .update(schema.researchReports)
      .set({ chunksAnalyzed: allChunks.length })
      .where(eq(schema.researchReports.id, reportId));

    const BATCH_SIZE = 8;
    const batches: any[][] = [];
    for (let i = 0; i < allChunks.length; i += BATCH_SIZE) {
      batches.push(allChunks.slice(i, i + BATCH_SIZE));
    }

    logInfo(`Friction pipeline: processing ${batches.length} batches`, { stage: "research" });

    const CONCURRENCY = 3;
    let allExtracted: SitePlanApplication[] = [];

    for (let i = 0; i < batches.length; i += CONCURRENCY) {
      const batchSlice = batches.slice(i, i + CONCURRENCY);
      const results = await Promise.allSettled(
        batchSlice.map((batch, idx) => extractFromBatch(batch, i + idx, batches.length, townName))
      );

      for (const result of results) {
        if (result.status === "fulfilled" && result.value) {
          allExtracted.push(...result.value);
        } else if (result.status === "rejected") {
          logError("Batch extraction failed", { error: String(result.reason), stage: "research" });
        }
      }
    }

    logInfo(`MAP phase complete: extracted ${allExtracted.length} raw applications`, { stage: "research" });

    let mergedApplications: SitePlanApplication[];
    if (allExtracted.length > 0) {
      mergedApplications = await reduceApplications(allExtracted);
      logInfo(`REDUCE phase complete: ${mergedApplications.length} deduplicated applications`, { stage: "research" });
    } else {
      mergedApplications = [];
    }

    let reportData: FrictionReportData;
    if (mergedApplications.length > 0) {
      const analysis = await analyzeApplications(mergedApplications, townName);
      reportData = {
        townName,
        chunksAnalyzed: allChunks.length,
        batchesProcessed: batches.length,
        funnelStages: analysis.funnelStages,
        frictionMatrix: analysis.frictionMatrix,
        predictiveInsights: analysis.predictiveInsights,
        applications: mergedApplications,
      };
    } else {
      reportData = {
        townName,
        chunksAnalyzed: allChunks.length,
        batchesProcessed: batches.length,
        funnelStages: [],
        frictionMatrix: [],
        predictiveInsights: ["No site plan applications were identified in the meeting minutes. The documents may not contain Planning Board or ZBA proceedings, or may require more specific board metadata."],
        applications: [],
      };
    }

    const dates = mergedApplications
      .flatMap((a) => [a.initialAppearanceDate, a.lastAppearanceDate])
      .filter(Boolean)
      .sort();
    if (dates.length > 0) {
      reportData.dateRangeStart = dates[0];
      reportData.dateRangeEnd = dates[dates.length - 1];
    }

    await db
      .update(schema.researchReports)
      .set({
        status: "completed",
        reportData,
        completedAt: new Date(),
      })
      .where(eq(schema.researchReports.id, reportId));

    logInfo(`Friction report completed for ${townName}: ${mergedApplications.length} applications`, { stage: "research" });
  } catch (error) {
    logError("Friction pipeline error", { reportId, error: String(error), stage: "research" });
    await db
      .update(schema.researchReports)
      .set({
        status: "failed",
        error: String(error),
        completedAt: new Date(),
      })
      .where(eq(schema.researchReports.id, reportId));
  }
}

async function extractFromBatch(
  chunks: any[],
  batchIndex: number,
  totalBatches: number,
  townName: string
): Promise<SitePlanApplication[]> {
  const batchText = chunks
    .map((c, i) => {
      const meta = c.metadata || {};
      const header = [
        meta.date ? `Date: ${meta.date}` : null,
        meta.board ? `Board: ${meta.board}` : null,
        meta.filename ? `Source: ${meta.filename}` : null,
      ]
        .filter(Boolean)
        .join(" | ");
      return `--- Chunk ${i + 1} ${header ? `(${header})` : ""} ---\n${c.content}`;
    })
    .join("\n\n");

  const prompt = `Analyze these meeting minutes chunks from ${townName}, NH (batch ${batchIndex + 1} of ${totalBatches}).

Extract ALL site plan applications, subdivision requests, and development proposals mentioned.

${batchText}`;

  try {
    const response = await ai.models.generateContent({
      model: GEMINI_MODEL,
      contents: prompt,
      config: {
        systemInstruction: MAP_SYSTEM_PROMPT,
        responseMimeType: "application/json",
        responseSchema: MAP_RESPONSE_SCHEMA,
        temperature: 0.1,
      },
    });

    const text = response.text || "";
    const parsed = JSON.parse(text);
    return (parsed.applications || []).map(normalizeApplication);
  } catch (error) {
    logError(`Batch ${batchIndex + 1} extraction failed`, { error: String(error), stage: "research" });
    return [];
  }
}

function normalizeApplication(raw: any): SitePlanApplication {
  const validOutcomes = ["approved", "approved_with_conditions", "denied", "withdrawn", "pending", "unknown"];
  const validAppeals = ["zba", "superior_court", "none", "unknown"];

  return {
    entityName: raw.entityName || "Unknown Project",
    address: raw.address || undefined,
    applicant: raw.applicant || undefined,
    initialAppearanceDate: raw.initialAppearanceDate || undefined,
    lastAppearanceDate: raw.lastAppearanceDate || undefined,
    totalContinuances: typeof raw.totalContinuances === "number" ? raw.totalContinuances : 0,
    outcome: validOutcomes.includes(raw.outcome?.toLowerCase()) ? raw.outcome.toLowerCase() : "unknown",
    conditions: Array.isArray(raw.conditions) ? raw.conditions : undefined,
    primaryFrictionReason: raw.primaryFrictionReason || undefined,
    frictionCategories: Array.isArray(raw.frictionCategories) ? raw.frictionCategories : undefined,
    appealPath: validAppeals.includes(raw.appealPath?.toLowerCase()) ? raw.appealPath.toLowerCase() : "none",
    appealOutcome: raw.appealOutcome || undefined,
    meetingReferences: Array.isArray(raw.meetingReferences) ? raw.meetingReferences : [],
  };
}

async function reduceApplications(applications: SitePlanApplication[]): Promise<SitePlanApplication[]> {
  if (applications.length <= 5) {
    return applications;
  }

  const appSummary = JSON.stringify(applications, null, 1);
  const MAX_CHARS = 900000;
  const truncated = appSummary.length > MAX_CHARS ? appSummary.slice(0, MAX_CHARS) + "\n...]" : appSummary;

  const prompt = `Here are ${applications.length} extracted site plan application records from multiple meeting minutes batches. Many are duplicate references to the same project across different meetings.

Merge and deduplicate them into a unified list. Each unique project should appear exactly once with its full timeline merged.

${truncated}`;

  try {
    const response = await ai.models.generateContent({
      model: GEMINI_MODEL,
      contents: prompt,
      config: {
        systemInstruction: REDUCE_SYSTEM_PROMPT,
        responseMimeType: "application/json",
        responseSchema: MAP_RESPONSE_SCHEMA,
        temperature: 0.1,
      },
    });

    const text = response.text || "";
    const parsed = JSON.parse(text);
    return (parsed.applications || []).map(normalizeApplication);
  } catch (error) {
    logError("Reduce phase failed, using raw applications", { error: String(error), stage: "research" });
    return deduplicateLocally(applications);
  }
}

function deduplicateLocally(applications: SitePlanApplication[]): SitePlanApplication[] {
  const groups = new Map<string, SitePlanApplication[]>();

  for (const app of applications) {
    const key = app.entityName.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 30);
    const existing = groups.get(key);
    if (existing) {
      existing.push(app);
    } else {
      groups.set(key, [app]);
    }
  }

  const merged: SitePlanApplication[] = [];
  for (const group of groups.values()) {
    if (group.length === 1) {
      merged.push(group[0]);
      continue;
    }

    const allRefs = group.flatMap((a) => a.meetingReferences);
    const allConditions = group.flatMap((a) => a.conditions || []);
    const allFriction = group.flatMap((a) => a.frictionCategories || []);
    const dates = group
      .flatMap((a) => [a.initialAppearanceDate, a.lastAppearanceDate])
      .filter(Boolean)
      .sort();

    const finalApp = group.reduce((best, app) => {
      if (app.outcome !== "unknown" && app.outcome !== "pending") return app;
      return best;
    }, group[0]);

    merged.push({
      ...finalApp,
      initialAppearanceDate: dates[0] || finalApp.initialAppearanceDate,
      lastAppearanceDate: dates[dates.length - 1] || finalApp.lastAppearanceDate,
      totalContinuances: Math.max(...group.map((a) => a.totalContinuances)),
      meetingReferences: [...new Set(allRefs)],
      conditions: [...new Set(allConditions)],
      frictionCategories: [...new Set(allFriction)],
    });
  }

  return merged;
}

async function analyzeApplications(
  applications: SitePlanApplication[],
  townName: string
): Promise<{
  funnelStages: FunnelStage[];
  frictionMatrix: FrictionCategory[];
  predictiveInsights: string[];
}> {
  const appSummary = JSON.stringify(applications, null, 1);
  const MAX_CHARS = 900000;
  const truncated = appSummary.length > MAX_CHARS ? appSummary.slice(0, MAX_CHARS) + "\n...]" : appSummary;

  const prompt = `Analyze these ${applications.length} deduplicated site plan applications from ${townName}, NH.

Produce the funnel stages, friction matrix, and predictive insights.

${truncated}`;

  try {
    const response = await ai.models.generateContent({
      model: GEMINI_MODEL,
      contents: prompt,
      config: {
        systemInstruction: ANALYSIS_SYSTEM_PROMPT,
        responseMimeType: "application/json",
        responseSchema: ANALYSIS_RESPONSE_SCHEMA,
        temperature: 0.2,
      },
    });

    const text = response.text || "";
    return JSON.parse(text);
  } catch (error) {
    logError("Analysis phase failed, computing locally", { error: String(error), stage: "research" });
    return computeAnalysisLocally(applications);
  }
}

function computeAnalysisLocally(applications: SitePlanApplication[]): {
  funnelStages: FunnelStage[];
  frictionMatrix: FrictionCategory[];
  predictiveInsights: string[];
} {
  const total = applications.length;
  const delayed = applications.filter((a) => a.totalContinuances >= 2).length;
  const approvedClean = applications.filter((a) => a.outcome === "approved").length;
  const approvedCond = applications.filter((a) => a.outcome === "approved_with_conditions").length;
  const denied = applications.filter((a) => a.outcome === "denied").length;
  const appealed = applications.filter((a) => a.appealPath !== "none" && a.appealPath !== "unknown").length;
  const appealWon = applications.filter(
    (a) => a.appealPath !== "none" && a.appealOutcome?.toLowerCase().includes("approved")
  ).length;

  const pct = (n: number) => (total > 0 ? Math.round((n / total) * 100) : 0);

  const funnelStages: FunnelStage[] = [
    { label: "Total Applications", count: total, percentage: 100 },
    { label: "Delayed (2+ Continuances)", count: delayed, percentage: pct(delayed) },
    { label: "Approved Without Conditions", count: approvedClean, percentage: pct(approvedClean) },
    { label: "Approved With Conditions", count: approvedCond, percentage: pct(approvedCond) },
    { label: "Denied", count: denied, percentage: pct(denied) },
    { label: "Appeals Filed", count: appealed, percentage: pct(appealed) },
    { label: "Appeal Successes", count: appealWon, percentage: pct(appealWon) },
  ];

  const frictionCounts = new Map<string, number>();
  for (const app of applications) {
    if (app.primaryFrictionReason) {
      const cat = app.primaryFrictionReason;
      frictionCounts.set(cat, (frictionCounts.get(cat) || 0) + 1);
    }
  }

  const frictionTotal = Array.from(frictionCounts.values()).reduce((s, c) => s + c, 0);
  const frictionMatrix: FrictionCategory[] = Array.from(frictionCounts.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([category, count]) => ({
      category,
      count,
      percentage: frictionTotal > 0 ? Math.round((count / frictionTotal) * 100) : 0,
    }));

  return {
    funnelStages,
    frictionMatrix,
    predictiveInsights: [
      `${total} site plan applications were analyzed across the available meeting minutes.`,
      `${pct(delayed)}% of applications experienced significant delays (2+ continuances).`,
      `The overall approval rate is ${pct(approvedClean + approvedCond)}%.`,
    ],
  };
}

export default router;
