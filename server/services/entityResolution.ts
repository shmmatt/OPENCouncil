import type { SitePlanApplication } from "../../shared/schema";

const STREET_ABBREVIATIONS: Record<string, string> = {
  "rd": "road", "rd.": "road", "st": "street", "st.": "street",
  "ave": "avenue", "ave.": "avenue", "dr": "drive", "dr.": "drive",
  "ln": "lane", "ln.": "lane", "ct": "court", "ct.": "court",
  "blvd": "boulevard", "blvd.": "boulevard", "cir": "circle", "cir.": "circle",
  "pl": "place", "pl.": "place", "pkwy": "parkway", "hwy": "highway",
  "rte": "route", "rt": "route", "rt.": "route",
};

function normalizeAddress(raw: string | undefined): string | null {
  if (!raw || raw.trim() === "" || raw.toLowerCase() === "null") return null;

  let addr = raw.toLowerCase().trim();

  addr = addr.replace(/\s*tax\s*map[:\s]*\d+[\s,]*lot[:\s]*\d+.*/i, "");
  addr = addr.replace(/\s*\(?\s*map\s*\d+[\s,]*lot\s*\d+\s*\)?/i, "");
  addr = addr.replace(/\s*map\s*\d+.*/i, "");

  addr = addr.replace(/[.,;()]/g, " ").replace(/\s+/g, " ").trim();

  const words = addr.split(" ");
  const normalized = words.map(w => STREET_ABBREVIATIONS[w] || w);
  addr = normalized.join(" ");

  const GENERIC_ADDRESSES = [
    "unknown", "n/a", "na", "none", "town-wide", "townwide",
    "route 16", "route 28", "route 25", "route 171", "route 153",
    "various", "multiple", "tbd",
  ];
  if (GENERIC_ADDRESSES.includes(addr) || addr.length < 3) {
    return null;
  }

  return addr;
}

function normalizeApplicant(raw: string | undefined): string | null {
  if (!raw || raw.trim() === "" || raw.toLowerCase() === "null") return null;

  let name = raw.toLowerCase().trim();
  name = name.replace(/\b(llc|inc|corp|ltd|l\.l\.c\.|incorporated|corporation)\b/gi, "");
  name = name.replace(/[.,;'"()]/g, " ").replace(/\s+/g, " ").trim();

  if (name === "unknown" || name === "n/a" || name.length < 2) return null;
  return name;
}

const FRICTION_CATEGORY_MAP: Record<string, string> = {
  "procedural": "Procedural/Incomplete",
  "zoning_dimensional": "Zoning/Dimensional",
  "environmental": "Environmental/Drainage",
  "abutter_pushback": "Abutter Pushback",
  "state_local_clash": "State vs. Local Clash",
  "traffic_access": "Traffic/Access",
  "infrastructure": "Infrastructure",
  "unknown": "Other",
  "none": "Other",
  "legal": "Other",
  "legal_interpretation": "Other",
  "legal_ownership": "Other",
  "legal_issues": "Other",
  "financial": "Other",
  "financial_hardship": "Other",
  "regulatory": "Other",
  "regulatory_compliance": "Other",
  "regulatory_interpretation": "Other",
  "safety": "Other",
  "public_safety": "Other",
  "site_design": "Other",
  "market_conditions": "Other",
  "public_opinion": "Abutter Pushback",
  "community_character": "Abutter Pushback",
  "noise": "Environmental/Drainage",
  "noise_pollution": "Environmental/Drainage",
  "documentation": "Procedural/Incomplete",
  "conflict_of_interest": "Procedural/Incomplete",
  "zoning_use": "Zoning/Dimensional",
  "personal_hardship": "Other",
  "regional_impact": "Other",
};

export function normalizeFrictionCategory(raw: string): string {
  const lower = raw.toLowerCase().trim();
  return FRICTION_CATEGORY_MAP[lower] || "Other";
}

export const CANONICAL_FRICTION_CATEGORIES = [
  "Procedural/Incomplete",
  "Zoning/Dimensional",
  "Environmental/Drainage",
  "Abutter Pushback",
  "State vs. Local Clash",
  "Traffic/Access",
  "Infrastructure",
  "Other",
];

function parseToISO(dateStr: string | undefined): string | null {
  if (!dateStr || dateStr === "null" || dateStr === "unknown" || dateStr === "N/A") return null;
  const mmddyyyy = dateStr.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (mmddyyyy) {
    return `${mmddyyyy[3]}-${mmddyyyy[1].padStart(2, "0")}-${mmddyyyy[2].padStart(2, "0")}`;
  }
  const iso = dateStr.match(/^\d{4}-\d{2}-\d{2}/);
  if (iso) return iso[0];
  const d = new Date(dateStr);
  if (!isNaN(d.getTime())) return d.toISOString().split("T")[0];
  return null;
}

function mergeGroup(group: SitePlanApplication[]): SitePlanApplication {
  if (group.length === 1) return group[0];

  const allDates = group
    .flatMap(a => [parseToISO(a.initialAppearanceDate), parseToISO(a.lastAppearanceDate)])
    .filter((d): d is string => d !== null)
    .sort();

  const allRefs = [...new Set(group.flatMap(a => a.meetingReferences))];
  const allConditions = [...new Set(group.flatMap(a => a.conditions || []))];
  const allFrictionCats = [...new Set(group.flatMap(a => a.frictionCategories || []))];

  const sortedByDate = [...group].sort((a, b) => {
    const da = parseToISO(a.lastAppearanceDate) || parseToISO(a.initialAppearanceDate) || "";
    const db = parseToISO(b.lastAppearanceDate) || parseToISO(b.initialAppearanceDate) || "";
    return da.localeCompare(db);
  });

  let finalOutcome: SitePlanApplication["outcome"] = "pending";
  for (let i = sortedByDate.length - 1; i >= 0; i--) {
    const o = sortedByDate[i].outcome;
    if (o !== "pending" && o !== "unknown") {
      finalOutcome = o;
      break;
    }
  }

  let appealPath: SitePlanApplication["appealPath"] = "none";
  let appealOutcome: string | undefined;
  for (const app of group) {
    if (app.appealPath && app.appealPath !== "none" && app.appealPath !== "unknown") {
      appealPath = app.appealPath;
      appealOutcome = app.appealOutcome;
    }
  }

  const bestName = group.reduce((best, app) =>
    app.entityName.length > best.entityName.length ? app : best
  , group[0]);

  const bestAddress = group.find(a => {
    const addr = a.address;
    return addr && addr !== "unknown" && addr.length > 5;
  })?.address || group[0].address;

  const frictionReasons = group
    .map(a => a.primaryFrictionReason)
    .filter((r): r is string => !!r && r !== "unknown" && r !== "none" && r !== "N/A");
  const bestFriction = frictionReasons.length > 0
    ? frictionReasons.reduce((best, r) => r.length > best.length ? r : best)
    : undefined;

  return {
    entityName: bestName.entityName,
    address: bestAddress,
    applicant: bestName.applicant || group.find(a => a.applicant)?.applicant,
    initialAppearanceDate: allDates[0] || undefined,
    lastAppearanceDate: allDates[allDates.length - 1] || undefined,
    totalContinuances: allRefs.length > 1 ? allRefs.length - 1 : Math.max(...group.map(a => a.totalContinuances)),
    outcome: finalOutcome,
    conditions: allConditions,
    primaryFrictionReason: bestFriction,
    frictionCategories: allFrictionCats,
    appealPath,
    appealOutcome,
    meetingReferences: allRefs,
  };
}

function extractDatesFromRefs(refs: string[]): string[] {
  const dates: string[] = [];
  for (const ref of refs) {
    const mmddyyyy = ref.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
    if (mmddyyyy) {
      const iso = `${mmddyyyy[3]}-${mmddyyyy[1].padStart(2, "0")}-${mmddyyyy[2].padStart(2, "0")}`;
      dates.push(iso);
      continue;
    }
    const isoMatch = ref.match(/(\d{4}-\d{2}-\d{2})/);
    if (isoMatch) {
      dates.push(isoMatch[1]);
      continue;
    }
    const monthNames: Record<string, string> = {
      january: "01", february: "02", march: "03", april: "04",
      may: "05", june: "06", july: "07", august: "08",
      september: "09", october: "10", november: "11", december: "12",
    };
    const written = ref.match(/(\w+)\s+(\d{1,2}),?\s+(\d{4})/i);
    if (written) {
      const m = monthNames[written[1].toLowerCase()];
      if (m) dates.push(`${written[3]}-${m}-${written[2].padStart(2, "0")}`);
    }
  }
  return dates.sort();
}

export function normalizeDatesOnApps(applications: SitePlanApplication[]): SitePlanApplication[] {
  return applications.map(app => {
    let initISO = parseToISO(app.initialAppearanceDate);
    let lastISO = parseToISO(app.lastAppearanceDate);

    if ((!initISO || !lastISO) && app.meetingReferences && app.meetingReferences.length > 0) {
      const refDates = extractDatesFromRefs(app.meetingReferences);
      if (refDates.length > 0) {
        if (!initISO) initISO = refDates[0];
        if (!lastISO) lastISO = refDates[refDates.length - 1];
      }
    }

    return {
      ...app,
      initialAppearanceDate: initISO || app.initialAppearanceDate,
      lastAppearanceDate: lastISO || app.lastAppearanceDate,
    };
  });
}

export function resolveEntities(applications: SitePlanApplication[]): SitePlanApplication[] {
  const addressGroups = new Map<string, SitePlanApplication[]>();
  const noAddressApps: SitePlanApplication[] = [];

  for (const app of applications) {
    const normAddr = normalizeAddress(app.address);
    if (normAddr) {
      const existing = addressGroups.get(normAddr);
      if (existing) {
        existing.push(app);
      } else {
        addressGroups.set(normAddr, [app]);
      }
    } else {
      noAddressApps.push(app);
    }
  }

  const applicantGroups = new Map<string, SitePlanApplication[]>();
  const ungrouped: SitePlanApplication[] = [];

  for (const app of noAddressApps) {
    const normApplicant = normalizeApplicant(app.applicant);
    if (normApplicant) {
      const existing = applicantGroups.get(normApplicant);
      if (existing) {
        existing.push(app);
      } else {
        applicantGroups.set(normApplicant, [app]);
      }
    } else {
      ungrouped.push(app);
    }
  }

  const merged: SitePlanApplication[] = [];

  for (const group of addressGroups.values()) {
    merged.push(mergeGroup(group));
  }

  for (const group of applicantGroups.values()) {
    merged.push(mergeGroup(group));
  }

  for (const app of ungrouped) {
    merged.push(app);
  }

  return merged.sort((a, b) => {
    const da = a.initialAppearanceDate || "9999";
    const db = b.initialAppearanceDate || "9999";
    return da.localeCompare(db);
  });
}

export interface TimeToDecisionStats {
  overall: {
    avgDays: number;
    medianDays: number;
    avgContinuances: number;
  };
  byCategory: Array<{
    category: string;
    avgDays: number;
    count: number;
  }>;
}

export interface FrequentFlyer {
  entityName: string;
  address?: string;
  meetingCount: number;
  totalContinuances: number;
  daysElapsed: number;
  outcome: string;
  frictionCategories: string[];
}

function daysBetween(start: string, end: string): number | null {
  const isoStart = parseToISO(start);
  const isoEnd = parseToISO(end);
  if (!isoStart || !isoEnd) return null;
  const s = new Date(isoStart);
  const e = new Date(isoEnd);
  if (isNaN(s.getTime()) || isNaN(e.getTime())) return null;
  return Math.round((e.getTime() - s.getTime()) / (1000 * 60 * 60 * 24));
}

export function computeTimeToDecision(apps: SitePlanApplication[]): TimeToDecisionStats {
  const durations: { days: number; categories: string[]; continuances: number }[] = [];

  for (const app of apps) {
    if (app.initialAppearanceDate && app.lastAppearanceDate) {
      const days = daysBetween(app.initialAppearanceDate, app.lastAppearanceDate);
      if (days !== null && days >= 0) {
        durations.push({
          days,
          categories: (app.frictionCategories || []).map(normalizeFrictionCategory),
          continuances: app.totalContinuances,
        });
      }
    }
  }

  if (durations.length === 0) {
    return {
      overall: { avgDays: 0, medianDays: 0, avgContinuances: 0 },
      byCategory: [],
    };
  }

  const allDays = durations.map(d => d.days).sort((a, b) => a - b);
  const avgDays = Math.round(allDays.reduce((s, d) => s + d, 0) / allDays.length);
  const mid = Math.floor(allDays.length / 2);
  const medianDays = allDays.length % 2 === 0
    ? Math.round((allDays[mid - 1] + allDays[mid]) / 2)
    : allDays[mid];
  const avgContinuances = Math.round(
    (durations.reduce((s, d) => s + d.continuances, 0) / durations.length) * 10
  ) / 10;

  const catDays = new Map<string, number[]>();
  for (const d of durations) {
    const cats = d.categories.length > 0 ? d.categories : ["No Friction"];
    for (const cat of cats) {
      const existing = catDays.get(cat);
      if (existing) existing.push(d.days);
      else catDays.set(cat, [d.days]);
    }
  }

  const byCategory = Array.from(catDays.entries())
    .map(([category, days]) => ({
      category,
      avgDays: Math.round(days.reduce((s, d) => s + d, 0) / days.length),
      count: days.length,
    }))
    .filter(c => c.category !== "Other" || c.count > 2)
    .sort((a, b) => b.avgDays - a.avgDays);

  return { overall: { avgDays, medianDays, avgContinuances }, byCategory };
}

export function computeFrequentFlyers(apps: SitePlanApplication[], limit = 10): FrequentFlyer[] {
  return apps
    .map(app => {
      const days = (app.initialAppearanceDate && app.lastAppearanceDate)
        ? daysBetween(app.initialAppearanceDate, app.lastAppearanceDate) || 0
        : 0;
      return {
        entityName: app.entityName,
        address: app.address,
        meetingCount: app.meetingReferences.length,
        totalContinuances: app.totalContinuances,
        daysElapsed: days,
        outcome: app.outcome,
        frictionCategories: (app.frictionCategories || []).map(normalizeFrictionCategory),
      };
    })
    .filter(f => f.meetingCount >= 3 || f.totalContinuances >= 2)
    .sort((a, b) => b.meetingCount - a.meetingCount || b.totalContinuances - a.totalContinuances)
    .slice(0, limit);
}

export interface FrictionAggregation {
  category: string;
  count: number;
  percentage: number;
  examples: string[];
}

export function aggregateFrictionMatrix(apps: SitePlanApplication[]): FrictionAggregation[] {
  const catCounts = new Map<string, { count: number; examples: string[] }>();

  for (const app of apps) {
    const cats = (app.frictionCategories || []).map(normalizeFrictionCategory);
    const uniqueCats = [...new Set(cats)];
    for (const cat of uniqueCats) {
      const existing = catCounts.get(cat);
      if (existing) {
        existing.count++;
        if (existing.examples.length < 2) {
          existing.examples.push(app.entityName);
        }
      } else {
        catCounts.set(cat, { count: 1, examples: [app.entityName] });
      }
    }
  }

  const total = Array.from(catCounts.values()).reduce((s, c) => s + c.count, 0);

  return CANONICAL_FRICTION_CATEGORIES
    .map(cat => {
      const data = catCounts.get(cat);
      if (!data || data.count === 0) return null;
      return {
        category: cat,
        count: data.count,
        percentage: total > 0 ? Math.round((data.count / total) * 100) : 0,
        examples: data.examples,
      };
    })
    .filter((c): c is FrictionAggregation => c !== null);
}

export interface ComputedStats {
  totalApps: number;
  rawAppCount: number;
  approvalRate: number;
  denialRate: number;
  approvedClean: number;
  approvedWithConditions: number;
  denied: number;
  pending: number;
  withdrawn: number;
  delayed: number;
  appealed: number;
  appealWon: number;
  frictionDistribution: FrictionAggregation[];
  timeToDecision: TimeToDecisionStats;
  frequentFlyers: FrequentFlyer[];
  yearlyTrend: Array<{ year: number; total: number; approved: number; denied: number }>;
}

export function computeAllStats(
  deduplicatedApps: SitePlanApplication[],
  rawAppCount: number
): ComputedStats {
  const total = deduplicatedApps.length;
  const approvedClean = deduplicatedApps.filter(a => a.outcome === "approved").length;
  const approvedCond = deduplicatedApps.filter(a => a.outcome === "approved_with_conditions").length;
  const denied = deduplicatedApps.filter(a => a.outcome === "denied").length;
  const pending = deduplicatedApps.filter(a => a.outcome === "pending" || a.outcome === "unknown").length;
  const withdrawn = deduplicatedApps.filter(a => a.outcome === "withdrawn").length;
  const delayed = deduplicatedApps.filter(a => a.totalContinuances >= 2).length;
  const appealed = deduplicatedApps.filter(a => a.appealPath !== "none" && a.appealPath !== "unknown").length;
  const appealWon = deduplicatedApps.filter(
    a => a.appealPath !== "none" && a.appealOutcome?.toLowerCase().includes("approved")
  ).length;

  const yearMap = new Map<number, { total: number; approved: number; denied: number }>();
  for (const app of deduplicatedApps) {
    const isoDate = parseToISO(app.initialAppearanceDate);
    if (isoDate) {
      const year = parseInt(isoDate.slice(0, 4));
      if (!isNaN(year) && year >= 1990 && year <= 2100) {
        const entry = yearMap.get(year) || { total: 0, approved: 0, denied: 0 };
        entry.total++;
        if (app.outcome === "approved" || app.outcome === "approved_with_conditions") entry.approved++;
        if (app.outcome === "denied") entry.denied++;
        yearMap.set(year, entry);
      }
    }
  }
  const yearlyTrend = Array.from(yearMap.entries())
    .map(([year, data]) => ({ year, ...data }))
    .sort((a, b) => a.year - b.year);

  return {
    totalApps: total,
    rawAppCount,
    approvalRate: total > 0 ? Math.round(((approvedClean + approvedCond) / total) * 100) : 0,
    denialRate: total > 0 ? Math.round((denied / total) * 100) : 0,
    approvedClean,
    approvedWithConditions: approvedCond,
    denied,
    pending,
    withdrawn,
    delayed,
    appealed,
    appealWon,
    frictionDistribution: aggregateFrictionMatrix(deduplicatedApps),
    timeToDecision: computeTimeToDecision(deduplicatedApps),
    frequentFlyers: computeFrequentFlyers(deduplicatedApps),
    yearlyTrend,
  };
}

export function buildInsightPromptData(stats: ComputedStats): string {
  const lines: string[] = [];
  lines.push(`Town Friction Report Summary (${stats.totalApps} unique projects from ${stats.rawAppCount} meeting appearances):`);
  lines.push(`- Approval Rate: ${stats.approvalRate}% (${stats.approvedClean} clean + ${stats.approvedWithConditions} with conditions)`);
  lines.push(`- Denial Rate: ${stats.denialRate}% (${stats.denied} denied)`);
  lines.push(`- Pending/Unknown: ${stats.pending}, Withdrawn: ${stats.withdrawn}`);
  lines.push(`- Delayed (2+ continuances): ${stats.delayed} (${stats.totalApps > 0 ? Math.round((stats.delayed / stats.totalApps) * 100) : 0}%)`);
  lines.push(`- Appeals Filed: ${stats.appealed}, Appeal Successes: ${stats.appealWon}`);
  lines.push("");
  lines.push("Time-to-Decision:");
  lines.push(`- Overall: avg ${stats.timeToDecision.overall.avgDays} days, median ${stats.timeToDecision.overall.medianDays} days, avg ${stats.timeToDecision.overall.avgContinuances} continuances`);
  for (const cat of stats.timeToDecision.byCategory.slice(0, 8)) {
    lines.push(`- ${cat.category}: avg ${cat.avgDays} days (${cat.count} apps)`);
  }
  lines.push("");
  lines.push("Friction Distribution:");
  for (const f of stats.frictionDistribution) {
    lines.push(`- ${f.category}: ${f.count} apps (${f.percentage}%), examples: ${f.examples.join(", ")}`);
  }
  lines.push("");
  lines.push("Top Bottleneck Projects:");
  for (const f of stats.frequentFlyers.slice(0, 5)) {
    lines.push(`- "${f.entityName}" at ${f.address || "unknown address"}: ${f.meetingCount} meetings, ${f.daysElapsed} days, outcome: ${f.outcome}, friction: ${f.frictionCategories.join(", ")}`);
  }
  if (stats.yearlyTrend.length > 1) {
    lines.push("");
    lines.push("Year-over-Year:");
    for (const y of stats.yearlyTrend) {
      lines.push(`- ${y.year}: ${y.total} apps, ${y.approved} approved, ${y.denied} denied`);
    }
  }
  return lines.join("\n");
}
