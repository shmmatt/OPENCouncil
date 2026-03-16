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
  DynamicReportPayload,
  ResearchBoardType,
} from "@shared/schema";
import {
  resolveEntities,
  normalizeDatesOnApps,
  splitOvermergedEntities,
  detectAbandonedProjects,
  computeAllStats,
  buildInsightPromptData,
  aggregateFrictionMatrix,
  computeTimeToDecision,
  computeFrequentFlyers,
  computeDaysAddedByConstraint,
} from "../services/entityResolution";
import { logInfo, logError } from "../utils/logger";

const router = Router();
router.use(authenticateAdmin);

import { RESEARCH_BOARD_TYPES } from "@shared/schema";
import { startPipeline, isRunning as isPipelineRunning, getProgress } from "../services/embeddingPipeline";

const ai = new GoogleGenAI({ apiKey: process.env.GEM_API_KEY || "" });
const GEMINI_MODEL = "gemini-2.5-flash";
const GEMINI_PRO_MODEL = "gemini-2.5-pro";

const frictionReportBodySchema = z.object({
  townName: z.string().min(1, "townName is required"),
});

interface MeetingDocument {
  fileBlobId: string;
  documentId: string;
  title: string;
  board: string | null;
  meetingDate: Date | null;
  year: string | null;
  fullText: string;
}

interface AgendaChunk {
  meetingDate: string | null;
  board: string | null;
  title: string;
  agendaLabel: string;
  content: string;
  sourceDocId: string;
}

const MAP_SYSTEM_PROMPT = `You are a municipal records analyst specializing in New Hampshire local governance. You are analyzing a single agenda item or discussion segment from Planning Board or Zoning Board of Adjustment (ZBA) meeting minutes.

Your task is to extract ALL site plan review applications, subdivision applications, variance requests, conditional use permits, and commercial/residential development proposals mentioned in this segment.

For each application/project you find, extract:
- entityName: The project or business name (e.g., "Main Street Retail Expansion", "Smith Subdivision")
- address: The property address or tax map/lot reference if available
- applicant: The applicant or representative name
- initialAppearanceDate: The date this project first appeared (from these minutes)
- lastAppearanceDate: The most recent date mentioned for this project
- totalContinuances: How many times the application was continued/tabled/postponed in THIS segment (0 if decided same meeting)
- outcome: One of "approved", "approved_with_conditions", "denied", "withdrawn", "pending", "unknown"
- conditions: Array of specific conditions imposed (if approved with conditions)
- primaryFrictionReason: The main issue causing delay or denial (e.g., "Parking setback violation", "Drainage concerns", "Abutter noise complaints")
- frictionCategories: Categories of friction like "abutter_pushback", "zoning_dimensional", "state_local_clash", "environmental", "traffic_access", "procedural", "infrastructure"
- appealPath: "zba" if appealed to ZBA, "superior_court" if appealed to Superior Court, "none" if no appeal, "unknown" if unclear
- appealOutcome: Result of any appeal
- meetingReferences: Array of meeting dates/descriptions where this project was discussed

Be thorough. Extract EVERY project mentioned, even briefly. If information is unclear, use "unknown" rather than guessing. This text represents the COMPLETE discussion of this agenda item, so you have full context for the outcome and reasoning.`;

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

const AGENDA_SPLIT_SYSTEM_PROMPT = `You are parsing New Hampshire municipal meeting minutes. Your task is to identify the boundaries of each distinct agenda item, application, or topic discussed in these minutes.

Return an array of agenda items. For each item, provide:
- label: A short descriptive label (e.g., "Case #2024-01: Smith Variance Request", "Public Hearing: Main St Development", "Old Business: Jones Subdivision")
- startPhrase: The EXACT text (first 60-80 characters) that begins this agenda item in the document. This must be a verbatim quote from the document text.
- isApplicationRelated: true if this item involves a site plan, subdivision, variance, conditional use permit, or development application. false for procedural items (roll call, minutes approval, adjournment).

Focus on identifying clear topic transitions. Common boundary markers include:
- Case numbers or application numbers
- "Public Hearing" headers
- "New Business" / "Old Business" sections
- Applicant names in headers
- Roman numerals (I., II., III.)
- Numbered items (1., 2., 3.)
- Bold or ALL CAPS headers`;

const AGENDA_SPLIT_RESPONSE_SCHEMA = {
  type: "object" as const,
  properties: {
    agendaItems: {
      type: "array" as const,
      items: {
        type: "object" as const,
        properties: {
          label: { type: "string" as const },
          startPhrase: { type: "string" as const },
          isApplicationRelated: { type: "boolean" as const },
        },
        required: ["label", "startPhrase", "isApplicationRelated"],
      },
    },
  },
  required: ["agendaItems"],
};


// ============================================================
// ROUTES
// ============================================================

router.get("/towns", async (_req, res) => {
  try {
    const results = await db.execute(sql`
      SELECT 
        initcap(lower(ld.town)) as town_name,
        COUNT(DISTINCT dv.id) as total_doc_count,
        COUNT(DISTINCT CASE 
          WHEN COALESCE(fb.ocr_text, fb.preview_text) IS NOT NULL 
               AND length(COALESCE(fb.ocr_text, fb.preview_text)) > 200 
          THEN dv.id END) as analyzable_doc_count,
        COUNT(DISTINCT CASE 
          WHEN fb.ocr_status = 'failed' 
               OR (COALESCE(fb.ocr_text, fb.preview_text) IS NULL 
                   AND fb.extracted_text_s3_key IS NULL)
          THEN dv.id END) as failed_ocr_count,
        MIN(dv.meeting_date) as earliest_date,
        MAX(dv.meeting_date) as latest_date
      FROM logical_documents ld
      JOIN document_versions dv ON ld.id = dv.document_id
      JOIN file_blobs fb ON dv.file_blob_id = fb.id
      WHERE ld.town IS NOT NULL
        AND lower(ld.town) != 'statewide'
        AND (
          ld.category IN ('meeting_minutes', 'minutes')
          OR dv.is_minutes = true
        )
        AND (
          lower(ld.board) LIKE '%planning%'
          OR lower(ld.board) LIKE '%zba%'
          OR lower(ld.board) LIKE '%zoning%'
          OR lower(ld.canonical_title) LIKE '%planning board%'
          OR lower(ld.canonical_title) LIKE '%zoning board%'
          OR lower(ld.canonical_title) LIKE '%zba%'
        )
      GROUP BY initcap(lower(ld.town))
      ORDER BY COUNT(DISTINCT dv.id) DESC
    `);

    const towns = (results.rows as any[]).map((r) => ({
      name: r.town_name,
      docCount: parseInt(r.total_doc_count, 10),
      analyzableCount: parseInt(r.analyzable_doc_count, 10),
      failedOcrCount: parseInt(r.failed_ocr_count, 10),
      dateRange: r.earliest_date && r.latest_date
        ? `${new Date(r.earliest_date).toLocaleDateString("en-US", { month: "short", year: "numeric" })} – ${new Date(r.latest_date).toLocaleDateString("en-US", { month: "short", year: "numeric" })}`
        : null,
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

router.post("/friction-report/:id/reanalyze", async (req, res) => {
  try {
    const report = await db
      .select()
      .from(schema.researchReports)
      .where(eq(schema.researchReports.id, req.params.id))
      .limit(1);

    if (report.length === 0) {
      return res.status(404).json({ message: "Report not found" });
    }

    const existing = report[0];
    const existingData = existing.reportData as FrictionReportData | null;
    if (!existingData || !existingData.applications || existingData.applications.length === 0) {
      return res.status(400).json({ message: "Report has no application data to re-analyze" });
    }

    await db
      .update(schema.researchReports)
      .set({ status: "processing" })
      .where(eq(schema.researchReports.id, req.params.id));

    res.json({ success: true, message: "Re-analysis started" });

    const rawApps = existingData.applications;
    const rawCount = existingData.rawApplicationCount || rawApps.length;

    try {
      const normalized = normalizeDatesOnApps(rawApps);
      const split = splitOvermergedEntities(normalized);
      const resolved = resolveEntities(split);
      const deduped = detectAbandonedProjects(resolved);
      logInfo(`Reanalyze: ${rawApps.length} apps → ${split.length} split → ${deduped.length} after entity resolution`, { stage: "research" });

      const reportData = await buildReportData(
        deduped,
        rawCount,
        existing.townName,
        existingData.chunksAnalyzed,
        existingData.documentsAnalyzed || existingData.batchesProcessed
      );

      reportData.dateRangeStart = existingData.dateRangeStart;
      reportData.dateRangeEnd = existingData.dateRangeEnd;

      await db
        .update(schema.researchReports)
        .set({
          status: "completed",
          reportData,
          completedAt: new Date(),
        })
        .where(eq(schema.researchReports.id, req.params.id));

      logInfo(`Reanalyze complete for ${existing.townName}: ${deduped.length} apps`, { stage: "research" });
    } catch (error) {
      logError("Reanalyze failed", { error: String(error), stage: "research" });
      await db
        .update(schema.researchReports)
        .set({
          status: "completed",
          reportData: existingData,
        })
        .where(eq(schema.researchReports.id, req.params.id));
    }
  } catch (error) {
    logError("Reanalyze route error", { error: String(error) });
    res.status(500).json({ message: "Failed to start re-analysis" });
  }
});

// ============================================================
// UNIVERSAL MUNICIPAL INTELLIGENCE ENGINE - BOARD FILTER HELPER
// ============================================================

function boardFilterSql(boardType: ResearchBoardType): string {
  switch (boardType) {
    case "planning":
      return `(lower(ld.board) LIKE '%planning%' OR lower(ld.canonical_title) LIKE '%planning board%')`;
    case "zoning":
      return `(lower(ld.board) LIKE '%zba%' OR lower(ld.board) LIKE '%zoning%' OR lower(ld.canonical_title) LIKE '%zoning board%' OR lower(ld.canonical_title) LIKE '%zba%')`;
    case "selectboard":
      return `(lower(ld.board) LIKE '%select%' OR lower(ld.board) LIKE '%selectmen%' OR lower(ld.canonical_title) LIKE '%select board%' OR lower(ld.canonical_title) LIKE '%board of selectmen%')`;
    case "budget":
      return `(lower(ld.board) LIKE '%budget%' OR lower(ld.canonical_title) LIKE '%budget committee%' OR lower(ld.canonical_title) LIKE '%budget%')`;
    default:
      return `1=1`;
  }
}

// ============================================================
// CORPUS PREP ENDPOINT
// ============================================================

const prepareCorpusSchema = z.object({
  townName: z.string().min(1),
  boardType: z.enum(RESEARCH_BOARD_TYPES),
});

router.post("/prepare-corpus", async (req, res) => {
  try {
    const parsed = prepareCorpusSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ message: parsed.error.errors[0]?.message || "Invalid request" });
    }
    const { townName, boardType } = parsed.data;
    const boardFilter = boardFilterSql(boardType);

    const result = await db.execute(sql`
      SELECT
        COUNT(DISTINCT fb.id) as total_documents,
        COUNT(DISTINCT CASE WHEN fb.embedding_status = 'indexed' THEN fb.id END) as embedded_count,
        COUNT(DISTINCT CASE WHEN fb.embedding_status != 'indexed' THEN fb.id END) as pending_count
      FROM logical_documents ld
      JOIN document_versions dv ON ld.id = dv.document_id
      JOIN file_blobs fb ON dv.file_blob_id = fb.id
      WHERE lower(ld.town) = ${townName.toLowerCase()}
        AND (
          ld.category IN ('meeting_minutes', 'minutes')
          OR dv.is_minutes = true
        )
        AND ${sql.raw(boardFilter)}
        AND (fb.ocr_text IS NOT NULL OR fb.preview_text IS NOT NULL)
        AND (COALESCE(char_length(fb.ocr_text), 0) + COALESCE(char_length(fb.preview_text), 0)) > 100
    `);

    const row = (result.rows as any[])[0] || {};
    const totalDocuments = parseInt(row.total_documents || "0", 10);
    const embeddedCount = parseInt(row.embedded_count || "0", 10);
    const pendingCount = parseInt(row.pending_count || "0", 10);

    const ready = pendingCount === 0 && totalDocuments > 0;
    const pipelineRunning = isPipelineRunning();
    res.json({ totalDocuments, embeddedCount, pendingCount, ready, pipelineRunning });
  } catch (error) {
    logError("Failed to check corpus status", { error: String(error) });
    res.status(500).json({ message: "Failed to check corpus status" });
  }
});

router.post("/prepare-corpus/trigger", async (req, res) => {
  try {
    const parsed = prepareCorpusSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ message: parsed.error.errors[0]?.message || "Invalid request" });
    }

    if (isPipelineRunning()) {
      const progress = getProgress();
      return res.json({
        status: "already_running",
        message: "Embedding pipeline is already running",
        progress: { processed: progress.processedDocuments, total: progress.totalDocuments },
      });
    }

    const { townName } = parsed.data;

    startPipeline({ town: townName }).catch((err) => {
      logError("Corpus embedding pipeline failed", { error: String(err) });
    });

    res.json({ status: "started", message: `Embedding pipeline started for ${townName}` });
  } catch (error) {
    logError("Failed to trigger corpus preparation", { error: String(error) });
    res.status(500).json({ message: "Failed to trigger corpus preparation" });
  }
});

// ============================================================
// DYNAMIC REPORT GENERATION (MapReduce Engine)
// ============================================================

const ISO_DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;

const dynamicGenerateSchema = z.object({
  townName: z.string().min(1),
  boardType: z.enum(RESEARCH_BOARD_TYPES),
  dateRange: z.object({
    start: z.string().regex(ISO_DATE_REGEX, "Date must be YYYY-MM-DD").optional(),
    end: z.string().regex(ISO_DATE_REGEX, "Date must be YYYY-MM-DD").optional(),
  }).optional(),
  prompt: z.string().min(1).max(2000),
});

router.post("/dynamic-generate", async (req, res) => {
  try {
    const parsed = dynamicGenerateSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ message: parsed.error.errors[0]?.message || "Invalid request" });
    }

    if (!process.env.GEM_API_KEY) {
      return res.status(500).json({ message: "GEM_API_KEY is not configured" });
    }

    const { townName, boardType, dateRange, prompt } = parsed.data;

    res.json({ status: "processing" });

    runDynamicPipeline(townName, boardType, dateRange, prompt).catch((err) => {
      logError("Dynamic pipeline failed", { error: String(err) });
    });
  } catch (error) {
    logError("Dynamic generate route error", { error: String(error) });
    res.status(500).json({ message: "Failed to start dynamic report generation" });
  }
});

router.post("/dynamic-generate-sync", async (req, res) => {
  try {
    const parsed = dynamicGenerateSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ message: parsed.error.errors[0]?.message || "Invalid request" });
    }

    if (!process.env.GEM_API_KEY) {
      return res.status(500).json({ message: "GEM_API_KEY is not configured" });
    }

    const { townName, boardType, dateRange, prompt } = parsed.data;

    const payload = await runDynamicPipeline(townName, boardType, dateRange, prompt);
    res.json({ status: "completed", payload });
  } catch (error) {
    logError("Dynamic generate sync error", { error: String(error) });
    res.status(500).json({ message: "Dynamic report generation failed", error: String(error) });
  }
});

async function runDynamicPipeline(
  townName: string,
  boardType: ResearchBoardType,
  dateRange: { start?: string; end?: string } | undefined,
  userPrompt: string
): Promise<DynamicReportPayload> {
  const boardFilter = boardFilterSql(boardType);

  // Phase 1: Fetch full document text
  logInfo(`[DynamicPipeline] Phase 1: Fetching documents for ${townName} / ${boardType}`, { stage: "research" });

  const dateConditions: ReturnType<typeof sql>[] = [];
  if (dateRange?.start) {
    dateConditions.push(sql`AND dv.meeting_date >= ${dateRange.start}::date`);
  }
  if (dateRange?.end) {
    dateConditions.push(sql`AND dv.meeting_date <= ${dateRange.end}::date`);
  }
  const dateFilterSql = dateConditions.length > 0
    ? sql.join(dateConditions, sql` `)
    : sql``;

  const docsResult = await db.execute(sql`
    SELECT
      fb.id as file_blob_id,
      ld.canonical_title as title,
      ld.board,
      dv.meeting_date,
      dv.year,
      COALESCE(fb.ocr_text, fb.preview_text) as full_text
    FROM logical_documents ld
    JOIN document_versions dv ON ld.id = dv.document_id
    JOIN file_blobs fb ON dv.file_blob_id = fb.id
    WHERE lower(ld.town) = ${townName.toLowerCase()}
      AND (
        ld.category IN ('meeting_minutes', 'minutes')
        OR dv.is_minutes = true
      )
      AND ${sql.raw(boardFilter)}
      AND COALESCE(fb.ocr_text, fb.preview_text) IS NOT NULL
      AND length(COALESCE(fb.ocr_text, fb.preview_text)) > 200
      ${dateFilterSql}
    ORDER BY dv.meeting_date ASC NULLS LAST
  `);

  const documents = (docsResult.rows as any[]).map(r => ({
    fileBlobId: r.file_blob_id as string,
    title: r.title as string || "Unknown",
    board: r.board as string | null,
    meetingDate: r.meeting_date ? new Date(r.meeting_date).toISOString().split("T")[0] : null,
    year: r.year as string | null,
    fullText: r.full_text as string,
  }));

  logInfo(`[DynamicPipeline] Phase 1 complete: ${documents.length} documents retrieved`, { stage: "research" });

  if (documents.length === 0) {
    return {
      reportTitle: `${boardType.charAt(0).toUpperCase() + boardType.slice(1)} Analysis: ${townName}`,
      executiveSummary: "No documents were found matching the selected criteria. Try adjusting the board type or date range, or ensure documents have been uploaded and processed for this town.",
      widgets: [],
    };
  }

  // Phase 0: Dynamic Schema Generation
  logInfo(`[DynamicPipeline] Phase 0: Generating extraction schema for prompt`, { stage: "research" });

  const schemaGenPrompt = `Given this user query about municipal ${boardType} documents: "${userPrompt}"

Generate a JSON extraction schema that defines what structured fields should be extracted from each document to answer this query. Return a JSON object with:
- "fields": an array of objects, each with "name" (camelCase string), "type" ("string" | "number" | "boolean" | "array"), and "description" (what to extract).

Keep it focused — 4-8 fields maximum. Include a "meetingDate" and "summary" field always.`;

  let extractionFields: Array<{ name: string; type: string; description: string }>;
  try {
    const schemaResponse = await ai.models.generateContent({
      model: GEMINI_MODEL,
      contents: schemaGenPrompt,
      config: {
        responseMimeType: "application/json",
        responseSchema: {
          type: "object" as const,
          properties: {
            fields: {
              type: "array" as const,
              items: {
                type: "object" as const,
                properties: {
                  name: { type: "string" as const },
                  type: { type: "string" as const },
                  description: { type: "string" as const },
                },
                required: ["name", "type", "description"],
              },
            },
          },
          required: ["fields"],
        },
        temperature: 0.2,
      },
    });
    const schemaParsed = JSON.parse(schemaResponse.text || "{}");
    extractionFields = schemaParsed.fields || [
      { name: "meetingDate", type: "string", description: "Date of the meeting" },
      { name: "summary", type: "string", description: "Key discussion points" },
    ];
  } catch (err) {
    logError("[DynamicPipeline] Phase 0 schema generation failed, using defaults", { error: String(err) });
    extractionFields = [
      { name: "meetingDate", type: "string", description: "Date of the meeting" },
      { name: "summary", type: "string", description: "Key relevant points from the document" },
      { name: "keyFacts", type: "array", description: "Array of key facts or data points" },
    ];
  }

  logInfo(`[DynamicPipeline] Phase 0 complete: ${extractionFields.length} extraction fields defined`, { stage: "research" });

  // Phase 2: Map/Harvest with concurrency limiting
  logInfo(`[DynamicPipeline] Phase 2: Extracting facts from ${documents.length} documents (concurrency: 5)`, { stage: "research" });

  const fieldDescriptions = extractionFields.map(f => `- ${f.name} (${f.type}): ${f.description}`).join("\n");

  const extractionSystemPrompt = `You are analyzing municipal ${boardType} meeting minutes from ${townName}, NH.
The user wants to know: "${userPrompt}"

Extract structured data from the provided document text. For each document, extract these fields:
${fieldDescriptions}

Return a JSON object with an "extractions" array containing one object per distinct topic/item found. If the document has no relevant information for the query, return an empty extractions array.`;

  const extractionResponseSchema = {
    type: "object" as const,
    properties: {
      extractions: {
        type: "array" as const,
        items: {
          type: "object" as const,
          properties: Object.fromEntries(
            extractionFields.map(f => [f.name, {
              type: (f.type === "array" ? "array" : f.type === "number" ? "number" : f.type === "boolean" ? "boolean" : "string") as any,
              ...(f.type === "array" ? { items: { type: "string" as const } } : {}),
            }])
          ),
        },
      },
    },
    required: ["extractions"],
  };

  const allExtractions: any[] = [];
  const BATCH_SIZE = 5;
  const MAX_DOC_CHARS = 900000; // Flash context limit safety margin

  for (let i = 0; i < documents.length; i += BATCH_SIZE) {
    const batch = documents.slice(i, i + BATCH_SIZE);
    const promises = batch.map(async (doc) => {
      const docText = doc.fullText.length > MAX_DOC_CHARS
        ? doc.fullText.slice(0, MAX_DOC_CHARS) + "\n[...truncated]"
        : doc.fullText;

      const header = `Document: ${doc.title} | Date: ${doc.meetingDate || doc.year || "unknown"} | Board: ${doc.board || boardType}`;
      const prompt = `${header}\n\n--- BEGIN DOCUMENT ---\n${docText}\n--- END DOCUMENT ---`;

      try {
        const response = await ai.models.generateContent({
          model: GEMINI_MODEL,
          contents: prompt,
          config: {
            systemInstruction: extractionSystemPrompt,
            responseMimeType: "application/json",
            responseSchema: extractionResponseSchema,
            temperature: 0.1,
          },
        });
        const parsed = JSON.parse(response.text || "{}");
        const items = parsed.extractions || [];
        return items.map((item: any) => ({
          ...item,
          _sourceTitle: doc.title,
          _sourceDate: doc.meetingDate || doc.year,
        }));
      } catch (err) {
        logError(`[DynamicPipeline] Extraction failed for ${doc.title}`, { error: String(err) });
        return [];
      }
    });

    const results = await Promise.allSettled(promises);
    for (const result of results) {
      if (result.status === "fulfilled") {
        allExtractions.push(...result.value);
      }
    }

    if (i + BATCH_SIZE < documents.length) {
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  }

  logInfo(`[DynamicPipeline] Phase 2 complete: ${allExtractions.length} extractions from ${documents.length} documents`, { stage: "research" });

  // Phase 3: Reduce/Synthesize
  logInfo(`[DynamicPipeline] Phase 3: Synthesizing report with ${GEMINI_PRO_MODEL}`, { stage: "research" });

  const synthesisSystemPrompt = `You are an elite municipal data analyst. Analyze the provided structured municipal data and answer the user's query by constructing a dynamic dashboard interface.
You MUST respond with a strictly typed JSON object matching this schema: { "reportTitle": "string", "executiveSummary": "string (BLUF style)", "widgets": [ { "type": "summary_text" | "stat_card" | "bar_chart", ... } ] }

Widget type definitions:
- summary_text: { "type": "summary_text", "content": "string (markdown formatted)" }
- stat_card: { "type": "stat_card", "label": "string", "value": "string or number", "trend": "up" | "down" | "neutral" (optional) }
- bar_chart: { "type": "bar_chart", "title": "string", "xAxisLabel": "string", "data": [{ "name": "string", "value": number }] }

DESIGN RULES:
1. Compare numbers/years using a bar_chart widget.
2. Highlight 2-4 critical metrics using stat_card widgets.
3. Use Axios Smart Brevity for summary_text (punchy, bullet points, bold text).
4. Do not output empty charts if data is missing; explain the gap in summary_text.`;

  const synthesisPrompt = `User query: "${userPrompt}"
Board type: ${boardType}
Town: ${townName}
Documents analyzed: ${documents.length}
Date range: ${documents[0]?.meetingDate || "unknown"} to ${documents[documents.length - 1]?.meetingDate || "unknown"}

Extracted data (${allExtractions.length} items):
${JSON.stringify(allExtractions.slice(0, 500), null, 1)}`;

  const reduceResponseSchema = {
    type: "object" as const,
    properties: {
      reportTitle: { type: "string" as const },
      executiveSummary: { type: "string" as const },
      widgets: {
        type: "array" as const,
        items: {
          type: "object" as const,
          properties: {
            type: { type: "string" as const },
            content: { type: "string" as const },
            label: { type: "string" as const },
            value: { type: "string" as const },
            trend: { type: "string" as const },
            title: { type: "string" as const },
            xAxisLabel: { type: "string" as const },
            data: {
              type: "array" as const,
              items: {
                type: "object" as const,
                properties: {
                  name: { type: "string" as const },
                  value: { type: "number" as const },
                },
              },
            },
          },
          required: ["type"],
        },
      },
    },
    required: ["reportTitle", "executiveSummary", "widgets"],
  };

  try {
    const synthesisResponse = await ai.models.generateContent({
      model: GEMINI_PRO_MODEL,
      contents: synthesisPrompt,
      config: {
        systemInstruction: synthesisSystemPrompt,
        responseMimeType: "application/json",
        responseSchema: reduceResponseSchema,
        temperature: 0.3,
      },
    });

    const payload = JSON.parse(synthesisResponse.text || "{}") as DynamicReportPayload;
    logInfo(`[DynamicPipeline] Phase 3 complete: ${payload.widgets?.length || 0} widgets generated`, { stage: "research" });

    if (!payload.reportTitle) payload.reportTitle = `${boardType} Analysis: ${townName}`;
    if (!payload.executiveSummary) payload.executiveSummary = "Report generated but no summary was produced.";
    if (!Array.isArray(payload.widgets)) payload.widgets = [];

    payload.widgets = payload.widgets.filter((w: any) => {
      if (!w || !w.type) return false;
      if (w.type === "summary_text") return typeof w.content === "string";
      if (w.type === "stat_card") return w.label && w.value !== undefined;
      if (w.type === "bar_chart") return w.title && Array.isArray(w.data) && w.data.length > 0;
      return false;
    });

    return payload;
  } catch (err) {
    logError("[DynamicPipeline] Phase 3 synthesis failed", { error: String(err) });
    return {
      reportTitle: `${boardType.charAt(0).toUpperCase() + boardType.slice(1)} Analysis: ${townName}`,
      executiveSummary: `Analysis failed during synthesis. ${allExtractions.length} data points were extracted from ${documents.length} documents but could not be synthesized into a report. Error: ${String(err)}`,
      widgets: [{
        type: "summary_text",
        content: `**Raw extraction summary:** ${allExtractions.length} data points extracted from ${documents.length} documents covering ${boardType} board proceedings.`,
      }],
    };
  }
}

// ============================================================
// FRICTION REPORT - PHASE 1: FULL DOCUMENT RETRIEVAL
// ============================================================

async function retrieveMeetingDocuments(townName: string): Promise<MeetingDocument[]> {
  const results = await db.execute(sql`
    SELECT
      fb.id as file_blob_id,
      ld.id as document_id,
      ld.canonical_title as title,
      ld.board,
      dv.meeting_date,
      dv.year,
      COALESCE(fb.ocr_text, fb.preview_text) as full_text
    FROM logical_documents ld
    JOIN document_versions dv ON ld.id = dv.document_id
    JOIN file_blobs fb ON dv.file_blob_id = fb.id
    WHERE lower(ld.town) = ${townName.toLowerCase()}
      AND (
        ld.category IN ('meeting_minutes', 'minutes')
        OR dv.is_minutes = true
      )
      AND (
        lower(ld.board) LIKE '%planning%'
        OR lower(ld.board) LIKE '%zba%'
        OR lower(ld.board) LIKE '%zoning%'
        OR lower(ld.canonical_title) LIKE '%planning board%'
        OR lower(ld.canonical_title) LIKE '%zoning board%'
        OR lower(ld.canonical_title) LIKE '%zba%'
      )
      AND COALESCE(fb.ocr_text, fb.preview_text) IS NOT NULL
      AND length(COALESCE(fb.ocr_text, fb.preview_text)) > 200
    ORDER BY dv.meeting_date ASC NULLS LAST, dv.year ASC NULLS LAST
  `);

  return (results.rows as any[]).map((r) => ({
    fileBlobId: r.file_blob_id,
    documentId: r.document_id,
    title: r.title || "Unknown Meeting",
    board: r.board,
    meetingDate: r.meeting_date ? new Date(r.meeting_date) : null,
    year: r.year,
    fullText: r.full_text,
  }));
}

// ============================================================
// PHASE 2: AGENDA BOUNDARY DETECTION
// ============================================================

function heuristicAgendaSplit(text: string): string[] {
  const patterns = [
    /\n\s*(?:(?:I{1,3}V?|VI{0,3}|IX|X)\.\s)/,
    /\n\s*(?:Case\s*(?:#|No\.?|Number)\s*\d)/i,
    /\n\s*(?:Public\s+Hearing\s*[:\-])/i,
    /\n\s*(?:(?:New|Old|Other)\s+Business\s*[:\-])/i,
    /\n\s*(?:Application\s*(?:#|No\.?))/i,
    /\n\s*(?:\d+\.\s+[A-Z])/,
    /\n\s*(?:[A-Z][A-Z\s]{5,}(?:LLC|INC|CORP|TRUST|REALTY)?[:\-\s]*\n)/,
  ];

  const combinedPattern = new RegExp(
    patterns.map((p) => p.source).join("|"),
    "gim"
  );

  const matches: number[] = [0];
  let match;
  while ((match = combinedPattern.exec(text)) !== null) {
    if (match.index > 0) {
      matches.push(match.index);
    }
  }

  if (matches.length <= 1) {
    return [text];
  }

  const segments: string[] = [];
  for (let i = 0; i < matches.length; i++) {
    const start = matches[i];
    const end = i < matches.length - 1 ? matches[i + 1] : text.length;
    const segment = text.slice(start, end).trim();
    if (segment.length > 100) {
      segments.push(segment);
    }
  }

  return segments;
}

async function llmAgendaSplit(
  text: string,
  meetingInfo: string
): Promise<{ label: string; content: string; isApplicationRelated: boolean }[]> {
  const truncatedText = text.length > 120000 ? text.slice(0, 120000) + "\n[...truncated]" : text;

  const prompt = `Identify all distinct agenda items/topics in these ${meetingInfo} meeting minutes.

${truncatedText}`;

  try {
    const response = await ai.models.generateContent({
      model: GEMINI_MODEL,
      contents: prompt,
      config: {
        systemInstruction: AGENDA_SPLIT_SYSTEM_PROMPT,
        responseMimeType: "application/json",
        responseSchema: AGENDA_SPLIT_RESPONSE_SCHEMA,
        temperature: 0.1,
      },
    });

    const parsed = JSON.parse(response.text || "{}");
    const items = parsed.agendaItems || [];

    if (items.length === 0) {
      return [{ label: "Full Meeting", content: text, isApplicationRelated: true }];
    }

    const result: { label: string; content: string; isApplicationRelated: boolean }[] = [];

    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const startPhrase = item.startPhrase || "";

      let startIdx = -1;
      if (startPhrase.length > 10) {
        startIdx = text.indexOf(startPhrase);
        if (startIdx === -1) {
          const shortPhrase = startPhrase.slice(0, 40);
          startIdx = text.indexOf(shortPhrase);
        }
        if (startIdx === -1) {
          const words = startPhrase.split(/\s+/).slice(0, 5).join("\\s+");
          const regex = new RegExp(words, "i");
          const match = regex.exec(text);
          if (match) startIdx = match.index;
        }
      }

      let endIdx = text.length;
      if (i < items.length - 1) {
        const nextPhrase = items[i + 1].startPhrase || "";
        if (nextPhrase.length > 10) {
          const nextStart = text.indexOf(nextPhrase, startIdx > 0 ? startIdx + 1 : 0);
          if (nextStart > 0) endIdx = nextStart;
        }
      }

      if (startIdx >= 0 && endIdx > startIdx) {
        const content = text.slice(startIdx, endIdx).trim();
        if (content.length > 50) {
          result.push({
            label: item.label || `Item ${i + 1}`,
            content,
            isApplicationRelated: item.isApplicationRelated !== false,
          });
        }
      }
    }

    if (result.length === 0) {
      return [{ label: "Full Meeting", content: text, isApplicationRelated: true }];
    }

    return result;
  } catch (error) {
    logError("LLM agenda split failed, falling back to heuristic", { error: String(error), stage: "research" });
    return heuristicAgendaSplit(text).map((content, i) => ({
      label: `Section ${i + 1}`,
      content,
      isApplicationRelated: true,
    }));
  }
}

async function splitDocumentIntoAgendaChunks(doc: MeetingDocument): Promise<AgendaChunk[]> {
  const dateStr = doc.meetingDate
    ? doc.meetingDate.toISOString().split("T")[0]
    : doc.year || "unknown date";
  const meetingInfo = `${doc.board || "Board"} (${dateStr})`;

  const MIN_TEXT_FOR_LLM_SPLIT = 2000;

  let segments: { label: string; content: string; isApplicationRelated: boolean }[];

  if (doc.fullText.length < MIN_TEXT_FOR_LLM_SPLIT) {
    segments = [{ label: "Full Meeting", content: doc.fullText, isApplicationRelated: true }];
  } else {
    segments = await llmAgendaSplit(doc.fullText, meetingInfo);
  }

  const applicationChunks = segments.filter((s) => s.isApplicationRelated);

  if (applicationChunks.length === 0) {
    return [{
      meetingDate: dateStr,
      board: doc.board,
      title: doc.title,
      agendaLabel: "Full Meeting",
      content: doc.fullText,
      sourceDocId: doc.documentId,
    }];
  }

  return applicationChunks.map((s) => ({
    meetingDate: dateStr,
    board: doc.board,
    title: doc.title,
    agendaLabel: s.label,
    content: s.content,
    sourceDocId: doc.documentId,
  }));
}

// ============================================================
// PHASE 3: TARGETED EXTRACTION
// ============================================================

const OVERSIZED_CHUNK_THRESHOLD = 15000;
const OVERLAP_CHARS = 500;

function splitOversizedChunk(content: string): string[] {
  if (content.length <= OVERSIZED_CHUNK_THRESHOLD) {
    return [content];
  }

  const windows: string[] = [];
  let start = 0;
  while (start < content.length) {
    const end = Math.min(start + OVERSIZED_CHUNK_THRESHOLD, content.length);
    windows.push(content.slice(start, end));
    if (end >= content.length) break;
    start = end - OVERLAP_CHARS;
  }
  return windows;
}

async function extractFromAgendaChunk(
  chunk: AgendaChunk,
  chunkIndex: number,
  totalChunks: number,
  townName: string
): Promise<SitePlanApplication[]> {
  const windows = splitOversizedChunk(chunk.content);
  let allApps: SitePlanApplication[] = [];

  for (let wi = 0; wi < windows.length; wi++) {
    const windowText = windows[wi];
    const header = [
      `Meeting: ${chunk.meetingDate || "unknown date"}`,
      chunk.board ? `Board: ${chunk.board}` : null,
      `Agenda Item: ${chunk.agendaLabel}`,
      windows.length > 1 ? `(Window ${wi + 1}/${windows.length})` : null,
    ].filter(Boolean).join(" | ");

    const prompt = `Analyze this agenda item from ${townName}, NH meeting minutes (item ${chunkIndex + 1} of ${totalChunks}).

${header}

--- BEGIN AGENDA ITEM ---
${windowText}
--- END AGENDA ITEM ---`;

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
      const apps = (parsed.applications || []).map(normalizeApplication);
      allApps.push(...apps);
    } catch (error) {
      logError(`Agenda chunk extraction failed`, {
        chunkIndex,
        agendaLabel: chunk.agendaLabel,
        error: String(error),
        stage: "research",
      });
    }
  }

  if (windows.length > 1 && allApps.length > 1) {
    allApps = deduplicateLocally(allApps);
  }

  return allApps;
}

// ============================================================
// MAIN PIPELINE
// ============================================================

async function runFrictionPipeline(reportId: string, townName: string): Promise<void> {
  try {
    await db
      .update(schema.researchReports)
      .set({ status: "processing" })
      .where(eq(schema.researchReports.id, reportId));

    logInfo(`Friction pipeline starting for ${townName}`, { stage: "research" });

    const documents = await retrieveMeetingDocuments(townName);
    logInfo(`Phase 1: Retrieved ${documents.length} meeting documents for ${townName}`, { stage: "research" });

    if (documents.length === 0) {
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
            documentsAnalyzed: 0,
            funnelStages: [],
            frictionMatrix: [],
            predictiveInsights: ["No Planning Board or ZBA meeting minutes found for this town. Upload meeting minutes to generate a friction report."],
            applications: [],
          },
        })
        .where(eq(schema.researchReports.id, reportId));
      return;
    }

    logInfo(`Phase 2: Splitting ${documents.length} documents by agenda items...`, { stage: "research" });
    let allAgendaChunks: AgendaChunk[] = [];

    for (const doc of documents) {
      const chunks = await splitDocumentIntoAgendaChunks(doc);
      allAgendaChunks.push(...chunks);
      logInfo(`  ${doc.title}: ${chunks.length} agenda items extracted`, { stage: "research" });
    }

    logInfo(`Phase 2 complete: ${allAgendaChunks.length} total agenda chunks from ${documents.length} documents`, { stage: "research" });

    await db
      .update(schema.researchReports)
      .set({ chunksAnalyzed: allAgendaChunks.length })
      .where(eq(schema.researchReports.id, reportId));

    logInfo(`Phase 3: Extracting applications from ${allAgendaChunks.length} agenda chunks...`, { stage: "research" });

    const CONCURRENCY = 3;
    let allExtracted: SitePlanApplication[] = [];

    for (let i = 0; i < allAgendaChunks.length; i += CONCURRENCY) {
      const batch = allAgendaChunks.slice(i, i + CONCURRENCY);
      const results = await Promise.allSettled(
        batch.map((chunk, idx) =>
          extractFromAgendaChunk(chunk, i + idx, allAgendaChunks.length, townName)
        )
      );

      for (const result of results) {
        if (result.status === "fulfilled" && result.value) {
          allExtracted.push(...result.value);
        } else if (result.status === "rejected") {
          logError("Agenda chunk extraction failed", { error: String(result.reason), stage: "research" });
        }
      }
    }

    logInfo(`Phase 3 (MAP) complete: extracted ${allExtracted.length} raw applications`, { stage: "research" });

    let mergedApplications: SitePlanApplication[];
    if (allExtracted.length > 0) {
      const normalizedExtracted = normalizeDatesOnApps(allExtracted);
      mergedApplications = detectAbandonedProjects(resolveEntities(normalizedExtracted));
      logInfo(`REDUCE phase complete: ${allExtracted.length} raw → ${mergedApplications.length} deduplicated applications`, { stage: "research" });
    } else {
      mergedApplications = [];
    }

    let reportData: FrictionReportData;
    if (mergedApplications.length > 0) {
      reportData = await buildReportData(mergedApplications, allExtracted.length, townName, allAgendaChunks.length, documents.length);
    } else {
      reportData = {
        townName,
        chunksAnalyzed: allAgendaChunks.length,
        batchesProcessed: documents.length,
        documentsAnalyzed: documents.length,
        rawApplicationCount: 0,
        funnelStages: [],
        frictionMatrix: [],
        predictiveInsights: ["No site plan applications were identified in the meeting minutes. The documents may not contain Planning Board or ZBA proceedings, or the board metadata may need updating."],
        applications: [],
      };
    }

    const meetingDates = documents
      .map((d) => d.meetingDate?.toISOString().split("T")[0])
      .filter(Boolean)
      .sort();
    if (meetingDates.length > 0) {
      reportData.dateRangeStart = meetingDates[0];
      reportData.dateRangeEnd = meetingDates[meetingDates.length - 1];
    }

    await db
      .update(schema.researchReports)
      .set({
        status: "completed",
        reportData,
        completedAt: new Date(),
      })
      .where(eq(schema.researchReports.id, reportId));

    logInfo(`Friction report completed for ${townName}: ${documents.length} docs, ${allAgendaChunks.length} agenda items, ${mergedApplications.length} applications`, { stage: "research" });
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

// ============================================================
// SHARED UTILITIES
// ============================================================

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

async function buildReportData(
  deduplicatedApps: SitePlanApplication[],
  rawAppCount: number,
  townName: string,
  chunksAnalyzed: number,
  documentsAnalyzed: number
): Promise<FrictionReportData> {
  const stats = computeAllStats(deduplicatedApps, rawAppCount);

  const totalApproved = stats.approvedClean + stats.approvedWithConditions;
  const totalWithdrawnAbandoned = stats.withdrawn + stats.abandoned;
  const pct = (n: number) => (stats.totalApps > 0 ? Math.round((n / stats.totalApps) * 100) : 0);

  const funnelStages: FunnelStage[] = [
    { label: "Approved", count: totalApproved, percentage: pct(totalApproved), description: `${stats.approvedClean} without conditions + ${stats.approvedWithConditions} with conditions` },
    { label: "Denied", count: stats.denied, percentage: pct(stats.denied) },
    { label: "Withdrawn/Abandoned", count: totalWithdrawnAbandoned, percentage: pct(totalWithdrawnAbandoned), description: `${stats.withdrawn} withdrawn + ${stats.abandoned} abandoned` },
  ];
  if (stats.pending > 0) {
    funnelStages.push({ label: "Pending/Unknown", count: stats.pending, percentage: pct(stats.pending) });
  }

  const approvedAfterDelay = deduplicatedApps.filter(
    a => (a.outcome === "approved" || a.outcome === "approved_with_conditions") && a.totalContinuances >= 2
  ).length;

  const applicationModifiers = {
    approvedWithConditions: stats.approvedWithConditions,
    approvedAfterDelay,
    appealsFiled: stats.appealed,
    appealSuccesses: stats.appealWon,
  };

  let predictiveInsights: string[];
  try {
    predictiveInsights = await generateNarrativeInsights(stats, townName);
  } catch (error) {
    logError("Narrative insight generation failed", { error: String(error), stage: "research" });
    predictiveInsights = generateFallbackInsights(stats, townName);
  }

  return {
    townName,
    chunksAnalyzed,
    batchesProcessed: documentsAnalyzed,
    documentsAnalyzed,
    rawApplicationCount: rawAppCount,
    funnelStages,
    applicationModifiers,
    frictionMatrix: stats.frictionDistribution,
    predictiveInsights,
    applications: deduplicatedApps,
    timeToDecision: stats.timeToDecision,
    frequentFlyers: stats.frequentFlyers,
    ordinanceHitList: stats.ordinanceHitList,
    developerScorecard: stats.developerScorecard,
    temporalTrends: stats.temporalTrends,
    representationGap: stats.representationGap,
    projectTypeComparison: stats.projectTypeComparison,
    attritionCurve: stats.attritionCurve,
    daysAddedByConstraint: stats.daysAddedByConstraint,
  };
}

async function generateNarrativeInsights(stats: ReturnType<typeof computeAllStats>, townName: string): Promise<string[]> {
  const promptData = buildInsightPromptData(stats);

  const systemPrompt = `You are a municipal governance analyst writing a briefing for volunteer Planning Board members in ${townName}, NH. Given the pre-computed statistics below, write exactly 5 data-driven insight paragraphs. Each insight should:
- Reference specific numbers from the data (percentages, averages, counts)
- Explain what the numbers mean for the board's work
- Be actionable — suggest what the board should investigate, fix, or celebrate
- Be written in plain English, avoiding jargon

Focus areas: ordinance effectiveness, procedural bottlenecks, time-to-decision patterns, abutter friction patterns, and year-over-year trends.

Return a JSON array of exactly 5 strings, each 2-3 sentences long.`;

  const response = await ai.models.generateContent({
    model: GEMINI_MODEL,
    contents: promptData,
    config: {
      systemInstruction: systemPrompt,
      responseMimeType: "application/json",
      responseSchema: {
        type: "array" as const,
        items: { type: "string" as const },
      },
      temperature: 0.3,
    },
  });

  const text = response.text || "[]";
  const parsed = JSON.parse(text);
  if (Array.isArray(parsed) && parsed.length > 0) {
    return parsed;
  }
  return generateFallbackInsights(stats, townName);
}

function generateFallbackInsights(stats: ReturnType<typeof computeAllStats>, townName: string): string[] {
  const insights: string[] = [];

  insights.push(
    `${townName} processed ${stats.totalApps} unique development applications across ${stats.rawAppCount} meeting appearances. The overall approval rate is ${stats.approvalRate}%, with ${stats.approvedWithConditions} applications receiving conditional approval.`
  );

  if (stats.timeToDecision.overall.avgDays > 0) {
    insights.push(
      `The average time from initial submission to final decision is ${stats.timeToDecision.overall.avgDays} days (median: ${stats.timeToDecision.overall.medianDays} days), with applications averaging ${stats.timeToDecision.overall.avgContinuances} continuances.`
    );
  }

  if (stats.frictionDistribution.length > 0) {
    const top = stats.frictionDistribution[0];
    insights.push(
      `The leading source of development friction is "${top.category}" at ${top.percentage}% of all friction events (${top.count} applications affected). This suggests the board should review whether current regulations in this area are achieving their intended purpose or creating unnecessary barriers.`
    );
  }

  if (stats.delayed > 0) {
    insights.push(
      `${Math.round((stats.delayed / stats.totalApps) * 100)}% of applications (${stats.delayed} total) experienced significant delays with 2 or more continuances. Reducing procedural friction at intake could shorten meeting agendas and reduce applicant frustration.`
    );
  }

  if (stats.frequentFlyers.length > 0) {
    const worst = stats.frequentFlyers[0];
    insights.push(
      `The most contested project was "${worst.entityName}" at ${worst.address || "unknown address"}, requiring ${worst.meetingCount} meeting appearances over ${worst.daysElapsed} days before reaching a "${worst.outcome}" outcome.`
    );
  }

  return insights.slice(0, 5);
}

export default router;
