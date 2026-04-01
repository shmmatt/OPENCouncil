/**
 * Municipal Concept Dictionary (Semantic Ontology)
 *
 * A single, purely declarative configuration file that maps citizen-facing
 * civic concepts to their bureaucratic component terms. This is the ONLY place
 * municipal domain knowledge should live. The retrieval pipeline is completely
 * agnostic — it just calls expandConceptsFromQuery() and passes results as
 * dynamic hints to the planner LLM.
 *
 * To extend: add a new entry to CONCEPT_GROUPS. No code changes needed anywhere else.
 * To support a new state: add state-specific synonyms as additional entries.
 *
 * Initial seed covers NH core concepts. Additional entries (warrant_article,
 * zoning, right_to_know) are included deliberately as foundational concepts
 * that appear frequently across all NH municipalities — not scope creep.
 */

export interface ConceptGroup {
  triggers: RegExp[];
  expansions: string[];
  label: string;
}

/**
 * The concept dictionary.
 *
 * Each entry defines:
 * - label: stable key used in logs and tests (snake_case)
 * - triggers: patterns matched against the user's query (case-insensitive)
 * - expansions: bureaucratic synonym terms to inject into the retrieval plan
 *
 * Order matters only for logging — all matching groups are returned.
 */
export const CONCEPT_GROUPS: ConceptGroup[] = [
  {
    label: "town_meeting",
    triggers: [
      /\btown\s+meeting\b/i,
      /\bannual\s+meeting\b/i,
      /\bannual\s+town\s+meeting\b/i,
      /\bATM\b/,
      /\bspecial\s+town\s+meeting\b/i,
    ],
    expansions: [
      "business session minutes",
      "election day ballot tallies",
      "official ballot results",
      "warrant articles voted",
      "town election results",
    ],
  },
  {
    label: "election",
    triggers: [
      /\btown\s+election\b/i,
      /\bofficial\s+ballot\b/i,
      /\belection\s+day\b/i,
      /\bballot\s+results?\b/i,
      /\belection\s+results?\b/i,
      /\bvoting\s+tallies?\b/i,
    ],
    expansions: [
      "town meeting warrant articles",
      "business session vote results",
      "annual meeting minutes",
      "official ballot election results",
    ],
  },
  {
    label: "selectboard",
    triggers: [
      /\bselect\s*board\b/i,
      /\bselectmen\b/i,
      /\bboard\s+of\s+selectmen\b/i,
      /\btown\s+council\b/i,
      /\baldermen\b/i,
    ],
    expansions: [
      "board of selectmen",
      "selectboard",
      "town council",
      "select board minutes",
      "selectmen meeting",
    ],
  },
  {
    label: "budget",
    triggers: [
      /\bdefault\s+budget\b/i,
      /\boperating\s+budget\b/i,
      /\bcapital\s+reserve\b/i,
      /\bappropriat/i,
      /\btax\s+rate\b/i,
      /\bms-737\b/i,
      /\bms\s*737\b/i,
    ],
    expansions: [
      "operating budget appropriations",
      "default budget RSA 40:13",
      "capital reserve fund",
      "warrant article budget",
      "town meeting budget vote",
      "tax rate calculation",
    ],
  },
  {
    label: "warrant_article",
    triggers: [
      /\bwarrant\s+article\b/i,
      /\bwarrant\s+articles\b/i,
      /\bpetition\s+article\b/i,
      /\bpetitioned\s+article\b/i,
    ],
    expansions: [
      "town meeting warrant vote",
      "election day ballot article",
      "official ballot warrant article",
      "annual town meeting results",
      "passed failed adopted defeated",
    ],
  },
  {
    label: "zoning",
    triggers: [
      /\bmaster\s+plan\b/i,
      /\bcomprehensive\s+plan\b/i,
      /\bland\s+use\s+plan\b/i,
    ],
    expansions: [
      "master plan comprehensive plan",
      "land use ordinance",
      "zoning regulations",
      "planning board master plan",
    ],
  },
  {
    label: "right_to_know",
    triggers: [
      /\bright[\s-]to[\s-]know\b/i,
      /\bRSA\s+91-A\b/i,
      /\bpublic\s+records?\s+request\b/i,
      /\bfreedom\s+of\s+information\b/i,
    ],
    expansions: [
      "right to know RSA 91-A",
      "public records request",
      "governmental records disclosure",
      "open meeting law",
    ],
  },
];

/**
 * Scan the user's query against all concept groups.
 * Returns matched expansion terms AND matched group labels (for logging).
 *
 * Use this in the orchestrator where you need both pieces of information.
 */
export function detectConceptMatches(query: string): {
  expansions: string[];
  matchedGroups: string[];
} {
  const expansions = new Set<string>();
  const matchedGroups: string[] = [];

  for (const group of CONCEPT_GROUPS) {
    const matched = group.triggers.some(trigger => trigger.test(query));
    if (matched) {
      matchedGroups.push(group.label);
      for (const term of group.expansions) {
        expansions.add(term);
      }
    }
  }

  return {
    expansions: Array.from(expansions),
    matchedGroups,
  };
}

/**
 * Scan the user's query against all concept groups.
 * Returns only the deduplicated expansion terms.
 *
 * Public API — use when you only need the expanded terms (e.g. direct injection).
 */
export function expandConceptsFromQuery(query: string): string[] {
  return detectConceptMatches(query).expansions;
}
