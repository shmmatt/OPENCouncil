import type { SitePlanApplication, YearlyBreakdown, YoYDeltas } from "../../shared/schema";

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

export function detectAbandonedProjects(applications: SitePlanApplication[]): SitePlanApplication[] {
  const now = new Date();
  const cutoffMs = 365 * 24 * 60 * 60 * 1000;

  return applications.map(app => {
    if (app.outcome === "pending" || app.outcome === "unknown") {
      const lastDate = parseToISO(app.lastAppearanceDate) || parseToISO(app.initialAppearanceDate);
      if (lastDate) {
        const lastMs = new Date(lastDate).getTime();
        if (!isNaN(lastMs) && (now.getTime() - lastMs) > cutoffMs) {
          return { ...app, outcome: "abandoned" as const };
        }
      }
    }
    return app;
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

export interface OrdinanceHitListEntry {
  keyword: string;
  count: number;
  percentage: number;
  exampleProjects: string[];
}

const ORDINANCE_KEYWORDS: Array<{ term: string; regex: RegExp }> = [
  { term: "parking", regex: /\bparking\b/i },
  { term: "setback", regex: /\bsetbacks?\b/i },
  { term: "signage", regex: /\bsignage?\b|signs?\b/i },
  { term: "drainage", regex: /\bdrainage?\b/i },
  { term: "lighting", regex: /\blighting\b/i },
  { term: "fee", regex: /\bfees?\b/i },
  { term: "lot size", regex: /\blot\s*size\b/i },
  { term: "frontage", regex: /\bfrontage\b/i },
  { term: "buffer", regex: /\bbuffer\b/i },
  { term: "septic", regex: /\bseptic\b/i },
  { term: "impervious", regex: /\bimpervious\b/i },
  { term: "driveway", regex: /\bdriveways?\b/i },
  { term: "height", regex: /\bheight\b/i },
  { term: "density", regex: /\bdensity\b/i },
  { term: "wetland", regex: /\bwetlands?\b/i },
  { term: "variance", regex: /\bvariance\b/i },
  { term: "waiver", regex: /\bwaivers?\b/i },
  { term: "stormwater", regex: /\bstormwater\b/i },
  { term: "access", regex: /\baccess\b/i },
  { term: "screening", regex: /\bscreening\b/i },
  { term: "landscaping", regex: /\blandscaping\b/i },
  { term: "abutter", regex: /\babutter\b/i },
  { term: "conditional use", regex: /\bconditional\s*use\b/i },
  { term: "site plan", regex: /\bsite\s*plan\b/i },
  { term: "subdivision", regex: /\bsubdivision\b/i },
];

export function computeOrdinanceHitList(apps: SitePlanApplication[], limit = 8): OrdinanceHitListEntry[] {
  const relevantApps = apps.filter(app => {
    const cats = (app.frictionCategories || []).map(normalizeFrictionCategory);
    return cats.includes("Procedural/Incomplete") || cats.includes("Zoning/Dimensional");
  });

  if (relevantApps.length === 0) return [];

  const hits = new Map<string, { count: number; examples: string[] }>();

  for (const app of relevantApps) {
    const reason = app.primaryFrictionReason;
    if (!reason || reason === "unknown" || reason === "N/A" || reason === "none") continue;

    for (const { term, regex } of ORDINANCE_KEYWORDS) {
      if (regex.test(reason)) {
        const entry = hits.get(term) || { count: 0, examples: [] };
        entry.count++;
        if (entry.examples.length < 2 && !entry.examples.includes(app.entityName)) {
          entry.examples.push(app.entityName);
        }
        hits.set(term, entry);
      }
    }
  }

  return Array.from(hits.entries())
    .map(([keyword, data]) => ({
      keyword,
      count: data.count,
      percentage: Math.round((data.count / relevantApps.length) * 100),
      exampleProjects: data.examples,
    }))
    .filter(e => e.count >= 2)
    .sort((a, b) => b.count - a.count)
    .slice(0, limit);
}

export interface DeveloperScorecardEntry {
  applicantName: string;
  projectCount: number;
  avgContinuances: number;
  avgDaysToDecision: number;
  approvalRate: number;
  topFrictionCategories: string[];
}

export function computeDeveloperScorecard(apps: SitePlanApplication[], limit = 5): DeveloperScorecardEntry[] {
  const applicantGroups = new Map<string, SitePlanApplication[]>();

  for (const app of apps) {
    if (!app.applicant || app.applicant.trim() === "" || app.applicant.toLowerCase() === "unknown") continue;
    let name = app.applicant.toLowerCase().trim()
      .replace(/,?\s*(llc|inc|corp|ltd|co|company|enterprises?|associates?|partners?|group)\b\.?/gi, "")
      .replace(/\s+/g, " ")
      .trim();
    if (name.length < 2) continue;
    const existing = applicantGroups.get(name);
    if (existing) existing.push(app);
    else applicantGroups.set(name, [app]);
  }

  const entries: DeveloperScorecardEntry[] = [];

  for (const [normalizedName, group] of applicantGroups) {
    if (group.length <= 2) continue;

    const displayName = group.reduce((best, app) =>
      (app.applicant || "").length > best.length ? (app.applicant || "") : best, "");

    const totalCont = group.reduce((s, a) => s + a.totalContinuances, 0);
    const avgCont = Math.round((totalCont / group.length) * 10) / 10;

    const daysArr: number[] = [];
    for (const app of group) {
      const d = daysBetween(app.initialAppearanceDate || "", app.lastAppearanceDate || "");
      if (d !== null && d >= 0) daysArr.push(d);
    }
    const avgDays = daysArr.length > 0
      ? Math.round(daysArr.reduce((s, d) => s + d, 0) / daysArr.length)
      : 0;

    const approved = group.filter(a => a.outcome === "approved" || a.outcome === "approved_with_conditions").length;
    const rate = Math.round((approved / group.length) * 100);

    const catCounts = new Map<string, number>();
    for (const app of group) {
      for (const cat of (app.frictionCategories || []).map(normalizeFrictionCategory)) {
        catCounts.set(cat, (catCounts.get(cat) || 0) + 1);
      }
    }
    const topCats = Array.from(catCounts.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([cat]) => cat);

    entries.push({
      applicantName: displayName || normalizedName,
      projectCount: group.length,
      avgContinuances: avgCont,
      avgDaysToDecision: avgDays,
      approvalRate: rate,
      topFrictionCategories: topCats,
    });
  }

  return entries
    .sort((a, b) => b.avgContinuances - a.avgContinuances || b.avgDaysToDecision - a.avgDaysToDecision)
    .slice(0, limit);
}

export interface TemporalTrendsResult {
  yearlyBreakdown: YearlyBreakdown[];
  yoyDeltas: YoYDeltas | null;
}

export function computeTemporalTrends(apps: SitePlanApplication[]): TemporalTrendsResult {
  const yearMap = new Map<number, {
    total: number; approved: number; denied: number; withdrawn: number; abandoned: number;
    daysArr: number[]; contArr: number[];
  }>();

  for (const app of apps) {
    const isoDate = parseToISO(app.initialAppearanceDate);
    if (!isoDate) continue;
    const year = parseInt(isoDate.slice(0, 4));
    if (isNaN(year) || year < 1990 || year > 2100) continue;

    const entry = yearMap.get(year) || {
      total: 0, approved: 0, denied: 0, withdrawn: 0, abandoned: 0,
      daysArr: [], contArr: [],
    };
    entry.total++;
    if (app.outcome === "approved" || app.outcome === "approved_with_conditions") entry.approved++;
    if (app.outcome === "denied") entry.denied++;
    if (app.outcome === "withdrawn") entry.withdrawn++;
    if (app.outcome === "abandoned") entry.abandoned++;

    entry.contArr.push(app.totalContinuances);
    const initISO = parseToISO(app.initialAppearanceDate);
    const lastISO = parseToISO(app.lastAppearanceDate);
    if (initISO && lastISO) {
      const days = daysBetween(initISO, lastISO);
      if (days !== null && days >= 0) entry.daysArr.push(days);
    }
    yearMap.set(year, entry);
  }

  const yearlyBreakdown: YearlyBreakdown[] = Array.from(yearMap.entries())
    .map(([year, d]) => ({
      year,
      total: d.total,
      approved: d.approved,
      denied: d.denied,
      withdrawn: d.withdrawn,
      abandoned: d.abandoned,
      avgDays: d.daysArr.length > 0 ? Math.round(d.daysArr.reduce((s, v) => s + v, 0) / d.daysArr.length) : 0,
      avgContinuances: d.contArr.length > 0
        ? Math.round((d.contArr.reduce((s, v) => s + v, 0) / d.contArr.length) * 10) / 10
        : 0,
    }))
    .sort((a, b) => a.year - b.year);

  let yoyDeltas: YoYDeltas | null = null;
  const currentYear = new Date().getFullYear();
  const completedYears = yearlyBreakdown.filter(y => y.year < currentYear);
  if (completedYears.length >= 2) {
    const recent = completedYears[completedYears.length - 1];
    const prev = completedYears[completedYears.length - 2];

    const pctChange = (curr: number, prior: number) =>
      prior > 0 ? Math.round(((curr - prior) / prior) * 100) : 0;

    yoyDeltas = {
      volumePct: pctChange(recent.total, prev.total),
      ttdPct: pctChange(recent.avgDays, prev.avgDays),
      continuancesPct: pctChange(recent.avgContinuances, prev.avgContinuances),
    };
  }

  return { yearlyBreakdown, yoyDeltas };
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
  abandoned: number;
  delayed: number;
  appealed: number;
  appealWon: number;
  frictionDistribution: FrictionAggregation[];
  timeToDecision: TimeToDecisionStats;
  frequentFlyers: FrequentFlyer[];
  ordinanceHitList: OrdinanceHitListEntry[];
  developerScorecard: DeveloperScorecardEntry[];
  temporalTrends: TemporalTrendsResult;
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
  const abandoned = deduplicatedApps.filter(a => a.outcome === "abandoned").length;
  const delayed = deduplicatedApps.filter(a => a.totalContinuances >= 2).length;
  const appealed = deduplicatedApps.filter(a => a.appealPath !== "none" && a.appealPath !== "unknown").length;
  const appealWon = deduplicatedApps.filter(
    a => a.appealPath !== "none" && a.appealOutcome?.toLowerCase().includes("approved")
  ).length;

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
    abandoned,
    delayed,
    appealed,
    appealWon,
    frictionDistribution: aggregateFrictionMatrix(deduplicatedApps),
    timeToDecision: computeTimeToDecision(deduplicatedApps),
    frequentFlyers: computeFrequentFlyers(deduplicatedApps),
    ordinanceHitList: computeOrdinanceHitList(deduplicatedApps),
    developerScorecard: computeDeveloperScorecard(deduplicatedApps),
    temporalTrends: computeTemporalTrends(deduplicatedApps),
  };
}

export function buildInsightPromptData(stats: ComputedStats): string {
  const lines: string[] = [];
  lines.push(`Town Friction Report Summary (${stats.totalApps} unique projects from ${stats.rawAppCount} meeting appearances):`);
  lines.push(`- Approval Rate: ${stats.approvalRate}% (${stats.approvedClean} clean + ${stats.approvedWithConditions} with conditions)`);
  lines.push(`- Denial Rate: ${stats.denialRate}% (${stats.denied} denied)`);
  lines.push(`- Pending/Unknown: ${stats.pending}, Withdrawn: ${stats.withdrawn}, Abandoned (Ghost Projects >365 days stale): ${stats.abandoned}`);
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
  if (stats.ordinanceHitList.length > 0) {
    lines.push("");
    lines.push("Ordinance Hit List (specific rules causing friction):");
    for (const h of stats.ordinanceHitList.slice(0, 5)) {
      lines.push(`- "${h.keyword}": ${h.count} apps (${h.percentage}%), e.g. ${h.exampleProjects.join(", ")}`);
    }
  }
  if (stats.developerScorecard.length > 0) {
    lines.push("");
    lines.push("Developer Scorecard (applicants with most friction):");
    for (const d of stats.developerScorecard.slice(0, 5)) {
      lines.push(`- ${d.applicantName}: ${d.projectCount} projects, avg ${d.avgContinuances} continuances, avg ${d.avgDaysToDecision} days, ${d.approvalRate}% approval, friction: ${d.topFrictionCategories.join(", ")}`);
    }
  }
  if (stats.temporalTrends.yearlyBreakdown.length > 1) {
    lines.push("");
    lines.push("Year-over-Year Trends:");
    for (const y of stats.temporalTrends.yearlyBreakdown) {
      lines.push(`- ${y.year}: ${y.total} apps, ${y.approved} approved, ${y.denied} denied, ${y.withdrawn} withdrawn, ${y.abandoned} abandoned, avg ${y.avgDays} days, avg ${y.avgContinuances} continuances`);
    }
    if (stats.temporalTrends.yoyDeltas) {
      const d = stats.temporalTrends.yoyDeltas;
      lines.push(`YoY Changes (most recent vs prior year): Volume ${d.volumePct >= 0 ? "+" : ""}${d.volumePct}%, Time-to-Decision ${d.ttdPct >= 0 ? "+" : ""}${d.ttdPct}%, Continuances ${d.continuancesPct >= 0 ? "+" : ""}${d.continuancesPct}%`);
    }
  }
  const totalGhosts = stats.withdrawn + stats.abandoned;
  if (totalGhosts > 0) {
    lines.push("");
    lines.push(`Ghost Projects: ${totalGhosts} total (${stats.withdrawn} withdrawn + ${stats.abandoned} abandoned). Shadow denial rate: ${stats.totalApps > 0 ? Math.round((totalGhosts / stats.totalApps) * 100) : 0}% of all projects never reached a formal decision.`);
  }
  return lines.join("\n");
}
