import type { IssueMap } from "./types";

const TOWN_TO_SAU: Record<string, string> = {
  "Albany": "SAU 9",
  "Bartlett": "SAU 9",
  "Chatham": "SAU 9",
  "Conway": "SAU 9",
  "Eaton": "SAU 9",
  "Freedom": "SAU 9",
  "Hart's Location": "SAU 9",
  "Jackson": "SAU 9",
  "Madison": "SAU 9",
  "Tamworth": "SAU 9",

  "Berlin": "SAU 3",
  "Gorham": "SAU 20",
  "Milan": "SAU 20",
  "Dummer": "SAU 20",
  "Errol": "SAU 20",
  "Shelburne": "SAU 20",

  "Lancaster": "SAU 36",
  "Whitefield": "SAU 36",
  "Jefferson": "SAU 36",
  "Dalton": "SAU 36",

  "Littleton": "SAU 35",
  "Bethlehem": "SAU 35",
  "Lisbon": "SAU 35",
  "Franconia": "SAU 35",
  "Sugar Hill": "SAU 35",
  "Landaff": "SAU 35",

  "Haverhill": "SAU 23",
  "Warren": "SAU 23",
  "Piermont": "SAU 23",
  "Bath": "SAU 23",
  "Benton": "SAU 23",

  "Plymouth": "SAU 48",
  "Holderness": "SAU 48",
  "Wentworth": "SAU 48",
  "Rumney": "SAU 48",
  "Campton": "SAU 48",
  "Thornton": "SAU 48",
  "Ellsworth": "SAU 48",
  "Waterville Valley": "SAU 48",

  "Ossipee": "SAU 49",
  "Wolfeboro": "SAU 49",
  "Tuftonboro": "SAU 49",
  "Effingham": "SAU 49",
  "Brookfield": "SAU 49",
  "New Durham": "SAU 49",

  "Wakefield": "SAU 101",

  "Moultonborough": "SAU 45",

  "Laconia": "SAU 30",
  "Belmont": "SAU 30",
  "Gilford": "SAU 30",
  "Shaker Regional": "SAU 30",

  "Meredith": "SAU 2",
  "Ashland": "SAU 2",
  "New Hampton": "SAU 2",
  "Center Harbor": "SAU 2",
  "Sandwich": "SAU 2",

  "Gilmanton": "SAU 79",
  "Barnstead": "SAU 79",

  "Alton": "SAU 72",

  "Sanbornton": "SAU 18",
  "Tilton": "SAU 18",

  "Northfield": "SAU 59",
  "Franklin": "SAU 18",

  "Carroll": "SAU 9",
  "Pittsburg": "SAU 7",
  "Stewartstown": "SAU 7",
  "Clarksville": "SAU 7",
  "Colebrook": "SAU 7",
  "Columbia": "SAU 7",

  "Stark": "SAU 58",
  "Stratford": "SAU 58",
  "Northumberland": "SAU 58",

  "Woodstock": "SAU 48",
  "Lincoln": "SAU 48",

  "Groton": "SAU 4",
  "Hebron": "SAU 4",
  "Bridgewater": "SAU 4",
  "Bristol": "SAU 4",
  "Danbury": "SAU 4",
  "Grafton": "SAU 4",
  "Alexandria": "SAU 4",

  "Canaan": "SAU 4",
  "Enfield": "SAU 4",
  "Orange": "SAU 4",

  "Lyme": "SAU 76",
  "Hanover": "SAU 70",
  "Lebanon": "SAU 88",

  "Dorchester": "SAU 23",
  "Orford": "SAU 23",
};

const SAU_TO_TOWNS: Record<string, string[]> = {};

for (const [town, sau] of Object.entries(TOWN_TO_SAU)) {
  if (!SAU_TO_TOWNS[sau]) {
    SAU_TO_TOWNS[sau] = [];
  }
  if (!SAU_TO_TOWNS[sau].includes(town)) {
    SAU_TO_TOWNS[sau].push(town);
  }
}

export function getSauIdForTown(town: string): string | null {
  const normalized = town.trim();
  const direct = TOWN_TO_SAU[normalized];
  if (direct) return direct;

  const lower = normalized.toLowerCase();
  for (const [key, value] of Object.entries(TOWN_TO_SAU)) {
    if (key.toLowerCase() === lower) return value;
  }
  return null;
}

export function getTownsForSau(sauId: string): string[] {
  const normalized = sauId.trim().toUpperCase();
  for (const [key, towns] of Object.entries(SAU_TO_TOWNS)) {
    if (key.toUpperCase() === normalized) return [...towns];
  }
  return [];
}

const SAU_TRIGGER_KEYWORDS = [
  "budget",
  "tax",
  "taxes",
  "school",
  "education",
  "teachers",
  "teacher",
  "sau",
  "school district",
  "superintendent",
  "school board",
  "tuition",
  "school budget",
  "adequacy aid",
  "education funding",
  "school tax",
  "school warrant",
  "school meeting",
  "school report",
  "school spending",
  "default budget",
];

const SAU_TRIGGER_PATTERNS = [
  /\bschool\s+board\b/i,
  /\bschool\s+district\b/i,
  /\bschool\s+budget\b/i,
  /\bschool\s+tax\b/i,
  /\beducation\s+fund/i,
  /\bsau\s*\d+/i,
  /\bsuperintendent\b/i,
  /\btuition\b/i,
  /\badequacy\s+aid\b/i,
];

export function shouldTriggerSauLane(question: string, issueMap: IssueMap): boolean {
  const lower = question.toLowerCase();

  for (const keyword of SAU_TRIGGER_KEYWORDS) {
    if (lower.includes(keyword)) return true;
  }

  for (const pattern of SAU_TRIGGER_PATTERNS) {
    if (pattern.test(question)) return true;
  }

  if (issueMap.boards.some(b => b.toLowerCase().includes("school"))) {
    return true;
  }

  if (
    issueMap.queryFocus === "financial_exact" &&
    (lower.includes("school") || lower.includes("education"))
  ) {
    return true;
  }

  return false;
}

export function buildSauLaneQueries(
  userQuestion: string,
  sauId: string
): string[] {
  const queries: string[] = [];
  queries.push(`${userQuestion} ${sauId} school district budget education`);
  queries.push(`${sauId} annual report school budget warrant article education`);
  return queries;
}
