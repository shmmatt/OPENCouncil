import { db } from "../storage/db";
import { sql, eq, desc } from "drizzle-orm";
import * as schema from "../../shared/crawler-schema";
import type {
  CategoryCounts,
  CategoryScores,
  DocumentCategory,
  CrawlAssessment,
} from "../../shared/crawler-schema";

export interface GapTarget {
  category: DocumentCategory;
  label: string;
  priority: "critical" | "high" | "medium" | "low";
  predicted: number;
  found: number;
  deficit: number;
  score: number;
  rating: string;
  searchHints: SearchHint[];
}

export interface SearchHint {
  strategy: "path_patterns" | "link_text" | "page_title" | "cms_api";
  patterns: string[];
  description: string;
}

export interface GapAnalysisResult {
  townId: string;
  townName: string;
  cms: string | null;
  overallScore: number;
  assessedAt: string;
  gaps: GapTarget[];
  topPriority: DocumentCategory | null;
}

const CATEGORY_URL_PATTERNS: Record<DocumentCategory, SearchHint[]> = {
  meeting_minutes: [
    {
      strategy: "path_patterns",
      patterns: [
        "/minutes", "/meeting-minutes", "/meetingminutes",
        "/agendacenter", "/AgendaCenter",
        "/boards-committees", "/boards-and-committees",
        "/selectmen/minutes", "/planning-board/minutes",
        "/zba/minutes", "/conservation/minutes",
        "/budget-committee/minutes",
      ],
      description: "Common paths where minutes are stored",
    },
    {
      strategy: "link_text",
      patterns: [
        "minutes", "meeting minutes", "past minutes",
        "meeting records", "board minutes",
      ],
      description: "Link text indicating minutes pages",
    },
    {
      strategy: "cms_api",
      patterns: [
        "/AgendaCenter/Search?term=&CIDs=all&startDate=&endDate=&dateRange=&dateSelector=",
      ],
      description: "CivicPlus AgendaCenter search API",
    },
  ],
  agendas: [
    {
      strategy: "path_patterns",
      patterns: [
        "/agendas", "/agenda", "/agendacenter", "/AgendaCenter",
        "/upcoming-meetings", "/meeting-schedule",
      ],
      description: "Common paths where agendas are posted",
    },
    {
      strategy: "link_text",
      patterns: ["agenda", "upcoming agenda", "meeting agenda", "agenda packet"],
      description: "Link text indicating agenda pages",
    },
  ],
  ordinances: [
    {
      strategy: "path_patterns",
      patterns: [
        "/ordinances", "/regulations", "/bylaws", "/code",
        "/town-ordinances", "/zoning-ordinance",
        "/documentcenter", "/DocumentCenter",
      ],
      description: "Common paths for ordinances and regulations",
    },
    {
      strategy: "link_text",
      patterns: ["ordinance", "regulation", "bylaw", "town code"],
      description: "Link text indicating ordinance pages",
    },
  ],
  budgets: [
    {
      strategy: "path_patterns",
      patterns: [
        "/budget", "/budgets", "/finance", "/financial",
        "/annual-budget", "/town-budget", "/budget-committee",
        "/audits", "/financial-reports", "/tax-rate",
        "/warrant", "/town-warrant",
      ],
      description: "Common paths for budget and financial documents",
    },
    {
      strategy: "link_text",
      patterns: [
        "budget", "financial report", "audit", "tax rate",
        "warrant", "annual budget", "proposed budget",
      ],
      description: "Link text indicating budget pages",
    },
  ],
  annual_reports: [
    {
      strategy: "path_patterns",
      patterns: [
        "/annual-report", "/annual-reports", "/town-report",
        "/town-reports", "/annualreport",
      ],
      description: "Common paths for annual/town reports",
    },
    {
      strategy: "link_text",
      patterns: ["annual report", "town report", "yearly report"],
      description: "Link text indicating annual report pages",
    },
  ],
  forms_applications: [
    {
      strategy: "path_patterns",
      patterns: [
        "/forms", "/applications", "/permits",
        "/formcenter", "/FormCenter",
        "/building-permits", "/dog-licenses",
        "/voter-registration",
      ],
      description: "Common paths for forms and applications",
    },
    {
      strategy: "link_text",
      patterns: ["form", "application", "permit", "license", "registration"],
      description: "Link text indicating form/application pages",
    },
  ],
  newsletters: [
    {
      strategy: "path_patterns",
      patterns: [
        "/newsletter", "/newsletters", "/bulletin",
        "/announcements", "/news", "/notices",
        "/public-notices",
      ],
      description: "Common paths for newsletters and notices",
    },
    {
      strategy: "link_text",
      patterns: ["newsletter", "bulletin", "notice", "announcement"],
      description: "Link text indicating newsletter pages",
    },
  ],
  zoning: [
    {
      strategy: "path_patterns",
      patterns: [
        "/zoning", "/zoning-map", "/land-use",
        "/zoning-ordinance", "/zoning-board",
        "/site-plans", "/subdivision",
      ],
      description: "Common paths for zoning documents",
    },
    {
      strategy: "link_text",
      patterns: ["zoning", "land use", "site plan", "subdivision", "zoning map"],
      description: "Link text indicating zoning pages",
    },
  ],
  plans_studies: [
    {
      strategy: "path_patterns",
      patterns: [
        "/master-plan", "/capital-improvement",
        "/hazard-mitigation", "/comprehensive-plan",
        "/studies", "/plans",
      ],
      description: "Common paths for plans and studies",
    },
    {
      strategy: "link_text",
      patterns: ["master plan", "capital improvement", "hazard mitigation", "study"],
      description: "Link text indicating plans/studies pages",
    },
  ],
  policies_procedures: [
    {
      strategy: "path_patterns",
      patterns: [
        "/policies", "/procedures", "/personnel",
        "/employee-handbook", "/guidelines",
        "/rules-procedures",
      ],
      description: "Common paths for policy documents",
    },
    {
      strategy: "link_text",
      patterns: ["policy", "procedure", "handbook", "guidelines"],
      description: "Link text indicating policy pages",
    },
  ],
  elections: [
    {
      strategy: "path_patterns",
      patterns: [
        "/elections", "/voting", "/ballot",
        "/town-meeting", "/voter-information",
        "/election-results", "/town-clerk",
      ],
      description: "Common paths for election documents",
    },
    {
      strategy: "link_text",
      patterns: [
        "election", "ballot", "voter", "town meeting",
        "election results", "sample ballot",
      ],
      description: "Link text indicating election pages",
    },
  ],
  other: [],
};

const CATEGORY_WEIGHTS: Record<DocumentCategory, number> = {
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

function getPriority(score: number, weight: number): "critical" | "high" | "medium" | "low" {
  if (score === 0 && weight >= 2) return "critical";
  if (score <= 10 && weight >= 2) return "critical";
  if (score <= 25 && weight >= 1.5) return "high";
  if (score <= 50) return "medium";
  return "low";
}

function filterHintsForCms(hints: SearchHint[], cms: string | null): SearchHint[] {
  if (!cms) return hints.filter(h => h.strategy !== "cms_api");

  const cmsLower = cms.toLowerCase();
  return hints.filter(h => {
    if (h.strategy === "cms_api") {
      if (cmsLower === "civicplus") return true;
      return false;
    }
    return true;
  });
}

export async function analyzeGaps(townId: string): Promise<GapAnalysisResult> {
  const [town] = await db
    .select()
    .from(schema.crawlerTowns)
    .where(eq(schema.crawlerTowns.id, townId));

  if (!town) throw new Error("Town not found");

  const [assessment] = await db
    .select()
    .from(schema.crawlAssessments)
    .where(eq(schema.crawlAssessments.townId, townId))
    .orderBy(desc(schema.crawlAssessments.assessedAt))
    .limit(1);

  if (!assessment) {
    throw new Error("No coverage assessment found. Run an assessment first.");
  }

  const categoryScores = assessment.categoryScores as CategoryScores;
  const gaps: GapTarget[] = [];

  for (const cat of schema.DOCUMENT_CATEGORIES) {
    const scores = categoryScores[cat];
    if (!scores) continue;

    if (cat === "other") continue;

    if (scores.score >= 80) continue;

    const weight = CATEGORY_WEIGHTS[cat];
    const priority = getPriority(scores.score, weight);
    const hints = filterHintsForCms(CATEGORY_URL_PATTERNS[cat] || [], town.cms);

    gaps.push({
      category: cat,
      label: schema.CATEGORY_LABELS[cat],
      priority,
      predicted: scores.predicted,
      found: scores.estimated,
      deficit: Math.max(0, scores.predicted - scores.estimated),
      score: scores.score,
      rating: scores.rating,
      searchHints: hints,
    });
  }

  gaps.sort((a, b) => {
    const priorityOrder = { critical: 0, high: 1, medium: 2, low: 3 };
    if (priorityOrder[a.priority] !== priorityOrder[b.priority]) {
      return priorityOrder[a.priority] - priorityOrder[b.priority];
    }
    return a.score - b.score;
  });

  return {
    townId,
    townName: town.name,
    cms: town.cms,
    overallScore: Number(assessment.overallScore),
    assessedAt: assessment.assessedAt?.toISOString() || new Date().toISOString(),
    gaps,
    topPriority: gaps.length > 0 ? gaps[0].category : null,
  };
}

export function getTargetPathsForGaps(
  gaps: GapTarget[],
  baseUrl: string
): string[] {
  const paths = new Set<string>();

  for (const gap of gaps) {
    if (gap.priority === "low") continue;

    for (const hint of gap.searchHints) {
      if (hint.strategy === "path_patterns") {
        for (const pattern of hint.patterns) {
          try {
            const url = new URL(pattern, baseUrl);
            paths.add(url.href);
          } catch {
            paths.add(`${baseUrl.replace(/\/$/, "")}${pattern}`);
          }
        }
      }
    }
  }

  return Array.from(paths);
}

export function getLinkTextPatternsForGaps(gaps: GapTarget[]): string[] {
  const patterns = new Set<string>();

  for (const gap of gaps) {
    if (gap.priority === "low") continue;

    for (const hint of gap.searchHints) {
      if (hint.strategy === "link_text") {
        for (const pattern of hint.patterns) {
          patterns.add(pattern.toLowerCase());
        }
      }
    }
  }

  return Array.from(patterns);
}
