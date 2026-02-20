import { GoogleGenAI } from "@google/genai";
import { db } from "../storage/db";
import { sql, eq, desc } from "drizzle-orm";
import * as schema from "../../shared/crawler-schema";
import type {
  CategoryCounts,
  CategoryScores,
  DocumentCategory,
  CrawlAssessment,
} from "../../shared/crawler-schema";

const ai = new GoogleGenAI({ apiKey: process.env.GEM_API_KEY || "" });

// ============================================================
// PRONG 1: PREDICTIVE MODEL
// ============================================================

interface TownTier {
  label: string;
  minPop: number;
  maxPop: number;
  boardMeetingsPerYear: number;
  planningMeetingsPerYear: number;
  zbaMeetingsPerYear: number;
  conservationMeetingsPerYear: number;
  budgetMeetingsPerYear: number;
  yearsOfHistory: number;
}

const TOWN_TIERS: TownTier[] = [
  {
    label: "micro",
    minPop: 0,
    maxPop: 500,
    boardMeetingsPerYear: 12,
    planningMeetingsPerYear: 6,
    zbaMeetingsPerYear: 4,
    conservationMeetingsPerYear: 4,
    budgetMeetingsPerYear: 3,
    yearsOfHistory: 5,
  },
  {
    label: "small",
    minPop: 500,
    maxPop: 2000,
    boardMeetingsPerYear: 24,
    planningMeetingsPerYear: 12,
    zbaMeetingsPerYear: 6,
    conservationMeetingsPerYear: 6,
    budgetMeetingsPerYear: 4,
    yearsOfHistory: 7,
  },
  {
    label: "medium",
    minPop: 2000,
    maxPop: 5000,
    boardMeetingsPerYear: 24,
    planningMeetingsPerYear: 12,
    zbaMeetingsPerYear: 12,
    conservationMeetingsPerYear: 10,
    budgetMeetingsPerYear: 6,
    yearsOfHistory: 8,
  },
  {
    label: "large",
    minPop: 5000,
    maxPop: Infinity,
    boardMeetingsPerYear: 24,
    planningMeetingsPerYear: 12,
    zbaMeetingsPerYear: 12,
    conservationMeetingsPerYear: 12,
    budgetMeetingsPerYear: 8,
    yearsOfHistory: 10,
  },
];

function getTier(population: number): TownTier {
  return TOWN_TIERS.find(
    (t) => population >= t.minPop && population < t.maxPop
  ) || TOWN_TIERS[0];
}

export function predictDocumentCounts(population: number): CategoryCounts {
  const tier = getTier(population);
  const y = tier.yearsOfHistory;

  const totalMeetings =
    tier.boardMeetingsPerYear +
    tier.planningMeetingsPerYear +
    tier.zbaMeetingsPerYear +
    tier.conservationMeetingsPerYear +
    tier.budgetMeetingsPerYear;

  return {
    meeting_minutes: totalMeetings * y,
    agendas: Math.round(totalMeetings * y * 0.7),
    ordinances: Math.round((population >= 2000 ? 15 : 8) + y * 2),
    budgets: y * (population >= 3000 ? 3 : 2),
    annual_reports: y,
    forms_applications: Math.round(population >= 2000 ? 25 : 12),
    newsletters: Math.round(population >= 3000 ? y * 6 : y * 2),
    zoning: Math.round(population >= 2000 ? 15 : 8),
    plans_studies: Math.round(population >= 3000 ? 12 : 5),
    policies_procedures: Math.round(population >= 2000 ? 10 : 5),
    elections: y * 2,
    other: Math.round(totalMeetings * y * 0.1),
  };
}

// ============================================================
// PRONG 2: LLM FILENAME ANALYSIS
// ============================================================

export async function analyzeFilenamesWithLLM(
  townName: string,
  filenames: string[]
): Promise<CategoryCounts> {
  if (filenames.length === 0) {
    return emptyCategories();
  }

  const BATCH_SIZE = 500;
  const batches: string[][] = [];
  for (let i = 0; i < filenames.length; i += BATCH_SIZE) {
    batches.push(filenames.slice(i, i + BATCH_SIZE));
  }

  const allCounts: CategoryCounts[] = [];

  for (const batch of batches) {
    const result = await analyzeBatch(townName, batch, filenames.length);
    allCounts.push(result);
  }

  const merged = emptyCategories();
  for (const counts of allCounts) {
    for (const cat of schema.DOCUMENT_CATEGORIES) {
      merged[cat] += counts[cat];
    }
  }

  return merged;
}

async function analyzeBatch(
  townName: string,
  filenames: string[],
  totalCount: number
): Promise<CategoryCounts> {
  const filenameList = filenames.join("\n");

  const prompt = `You are analyzing document filenames from a New Hampshire municipal town website (${townName}).
Classify each filename into exactly one of these categories and return the count per category.

Categories:
- meeting_minutes: Meeting minutes from any board (selectmen, planning, ZBA, conservation, budget committee, etc.)
- agendas: Meeting agendas (upcoming or past)
- ordinances: Town ordinances, regulations, bylaws, RSA references
- budgets: Budget documents, financial reports, audits, warrants, tax rate documents
- annual_reports: Annual town reports, town report booklets
- forms_applications: Application forms, permits, request forms, licenses, registrations
- newsletters: Town newsletters, bulletins, announcements, public notices
- zoning: Zoning maps, zoning regulations, land use documents, site plans
- plans_studies: Master plans, capital improvement plans, hazard mitigation, studies
- policies_procedures: Personnel policies, procedures, employee handbooks, guidelines
- elections: Voter information, ballot documents, election results, town meeting warrants
- other: Documents that don't clearly fit any above category

This batch has ${filenames.length} filenames out of ${totalCount} total for this town.

Here are the filenames:
${filenameList}

Return a JSON object with ONLY these keys, each with an integer count:
meeting_minutes, agendas, ordinances, budgets, annual_reports, forms_applications, newsletters, zoning, plans_studies, policies_procedures, elections, other`;

  try {
    const response = await ai.models.generateContent({
      model: "gemini-2.5-flash",
      contents: prompt,
      config: {
        responseMimeType: "application/json",
        responseSchema: {
          type: "object",
          properties: {
            meeting_minutes: { type: "number" },
            agendas: { type: "number" },
            ordinances: { type: "number" },
            budgets: { type: "number" },
            annual_reports: { type: "number" },
            forms_applications: { type: "number" },
            newsletters: { type: "number" },
            zoning: { type: "number" },
            plans_studies: { type: "number" },
            policies_procedures: { type: "number" },
            elections: { type: "number" },
            other: { type: "number" },
          },
          required: schema.DOCUMENT_CATEGORIES as unknown as string[],
        },
      },
    });

    const raw = response.text;
    if (!raw) throw new Error("Empty response from Gemini");

    const parsed = JSON.parse(raw);
    const result = emptyCategories();
    for (const cat of schema.DOCUMENT_CATEGORIES) {
      result[cat] = Math.round(Number(parsed[cat]) || 0);
    }
    return result;
  } catch (error) {
    console.error(`[CrawlAssessment] LLM analysis failed for ${townName}:`, error);
    throw error;
  }
}

// ============================================================
// SCORING
// ============================================================

function scoreCategory(predicted: number, estimated: number): {
  score: number;
  rating: "excellent" | "good" | "fair" | "poor" | "missing";
} {
  if (predicted === 0) {
    return { score: 100, rating: "excellent" };
  }

  const ratio = Math.min(estimated / predicted, 1.5);
  const score = Math.round(Math.min(ratio * 100, 100));

  let rating: "excellent" | "good" | "fair" | "poor" | "missing";
  if (estimated === 0) rating = "missing";
  else if (score >= 80) rating = "excellent";
  else if (score >= 50) rating = "good";
  else if (score >= 25) rating = "fair";
  else rating = "poor";

  return { score, rating };
}

export function computeScores(
  predicted: CategoryCounts,
  estimated: CategoryCounts
): { categoryScores: CategoryScores; overallScore: number } {
  const categoryScores = {} as CategoryScores;
  let totalWeight = 0;
  let weightedSum = 0;

  const weights: Record<DocumentCategory, number> = {
    meeting_minutes: 3,
    agendas: 2,
    ordinances: 2,
    budgets: 2.5,
    annual_reports: 2,
    forms_applications: 1.5,
    newsletters: 1,
    zoning: 1.5,
    plans_studies: 1,
    policies_procedures: 1,
    elections: 1,
    other: 0.5,
  };

  for (const cat of schema.DOCUMENT_CATEGORIES) {
    const { score, rating } = scoreCategory(predicted[cat], estimated[cat]);
    categoryScores[cat] = {
      predicted: predicted[cat],
      estimated: estimated[cat],
      score,
      rating,
    };
    const w = weights[cat];
    totalWeight += w;
    weightedSum += score * w;
  }

  const overallScore = Math.round((weightedSum / totalWeight) * 100) / 100;
  return { categoryScores, overallScore };
}

// ============================================================
// FULL ASSESSMENT WORKFLOW
// ============================================================

export async function runAssessment(townId: string): Promise<CrawlAssessment> {
  const [town] = await db
    .select()
    .from(schema.crawlerTowns)
    .where(eq(schema.crawlerTowns.id, townId));

  if (!town) throw new Error("Town not found");

  const population = town.population || 1000;

  const filenameRows = await db.execute(sql`
    SELECT filename FROM crawler_documents
    WHERE town_id = ${townId} AND status = 'uploaded'
    ORDER BY filename
  `);
  const filenames = (filenameRows.rows as any[]).map((r) => r.filename);

  const predicted = predictDocumentCounts(population);
  const estimated = await analyzeFilenamesWithLLM(town.name, filenames);
  const { categoryScores, overallScore } = computeScores(predicted, estimated);

  const [assessment] = await db
    .insert(schema.crawlAssessments)
    .values({
      townId,
      assessedAt: new Date(),
      population,
      predicted,
      estimated,
      categoryScores,
      overallScore: String(overallScore),
      totalFilesAnalyzed: filenames.length,
      llmModel: "gemini-2.5-flash",
    })
    .returning();

  return assessment;
}

export async function getLatestAssessment(
  townId: string
): Promise<CrawlAssessment | null> {
  const [assessment] = await db
    .select()
    .from(schema.crawlAssessments)
    .where(eq(schema.crawlAssessments.townId, townId))
    .orderBy(desc(schema.crawlAssessments.assessedAt))
    .limit(1);

  return assessment || null;
}

export async function getAssessmentHistory(
  townId: string
): Promise<CrawlAssessment[]> {
  return db
    .select()
    .from(schema.crawlAssessments)
    .where(eq(schema.crawlAssessments.townId, townId))
    .orderBy(desc(schema.crawlAssessments.assessedAt))
    .limit(10);
}

function emptyCategories(): CategoryCounts {
  const result = {} as CategoryCounts;
  for (const cat of schema.DOCUMENT_CATEGORIES) {
    result[cat] = 0;
  }
  return result;
}
