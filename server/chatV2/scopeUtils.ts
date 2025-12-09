import type { DocSourceType } from "./types";

export const LOCAL_SCOPE_NOTE = 
  "\n\n---\n**Source scope:** Based on documents available in the OpenCouncil archive for this municipality. " +
  "These materials include meeting minutes, budgets, warrant articles, town reports, or policy records where available. " +
  "Details may be incomplete depending on what municipalities have published or digitized. " +
  "This information is informational only and is not legal advice.";

export const STATEWIDE_SCOPE_NOTE =
  "\n\n---\n**Source scope:** Informed primarily by New Hampshire statutory and regulatory context. " +
  "This summary is not based on a specific municipality's OpenCouncil-indexed documents. " +
  "For exact legal language or application, consult the official RSA text or municipal counsel. " +
  "This information is informational only and is not legal advice.";

export const NO_DOC_SCOPE_NOTE =
  "\n\n---\n**Source scope:** No directly relevant material was found in the OpenCouncil archive for this question. " +
  "Where possible, this response reflects general New Hampshire municipal practice. " +
  "Local procedures may differ, and consulting municipal records or counsel may provide more specific guidance. " +
  "This information is informational only and is not legal advice.";

export const MIXED_SCOPE_NOTE =
  "\n\n---\n**Source scope:** Based on both local municipal documents and statewide New Hampshire statutory context. " +
  "These materials include local meeting minutes, budgets, and policy records, as well as RSA references. " +
  "Local procedures may vary. This information is informational only and is not legal advice.";

export function generateStatewideDisclaimer(): string {
  return STATEWIDE_SCOPE_NOTE;
}

export function generateNoDocsFoundMessage(isRSA: boolean): string {
  if (isRSA) {
    return "No directly relevant material was found in the OpenCouncil archive for this RSA/state law question. " +
      "The following general guidance may still be helpful, but local procedures can differ.";
  }
  
  return "No directly relevant material was found in the OpenCouncil archive for this question. " +
    "The following general guidance may still be helpful, but local procedures can differ.";
}

export function generateLocalScopeNote(): string {
  return LOCAL_SCOPE_NOTE;
}

export function isStatewideScope(scopeHint: string | null): boolean {
  return scopeHint === "statewide" || scopeHint === "mixed";
}

/**
 * Generate a local scope note with the town name included.
 */
function localScopeNote(town: string | null): string {
  if (town) {
    return `\n\n---\n**Source scope:** Based on documents from the Town of ${town} in the OpenCouncil archive. ` +
      "These materials include meeting minutes, budgets, warrant articles, town reports, or policy records where available. " +
      "Details may be incomplete depending on what the municipality has published or digitized. " +
      "This information is informational only and is not legal advice.";
  }
  return LOCAL_SCOPE_NOTE;
}

/**
 * Generate a mixed scope note with the town name included.
 */
function mixedScopeNote(town: string | null): string {
  if (town) {
    return `\n\n---\n**Source scope:** Based on documents from the Town of ${town} and statewide New Hampshire statutory context. ` +
      "These materials include local meeting minutes, budgets, and policy records, as well as RSA references. " +
      "Local procedures may vary. This information is informational only and is not legal advice.";
  }
  return MIXED_SCOPE_NOTE;
}

/**
 * Select the appropriate scope note based on explicit DocSourceType tracking.
 * This is the primary function for scope note selection and should be used
 * instead of heuristic-based approaches.
 */
export function selectScopeNote(options: {
  docSourceType: DocSourceType;
  docSourceTown: string | null;
}): string {
  const { docSourceType, docSourceTown } = options;

  switch (docSourceType) {
    case "local":
      return localScopeNote(docSourceTown);
    case "statewide":
      return STATEWIDE_SCOPE_NOTE;
    case "mixed":
      return mixedScopeNote(docSourceTown);
    case "none":
    default:
      return NO_DOC_SCOPE_NOTE;
  }
}

/**
 * @deprecated Use selectScopeNote with DocSourceType instead.
 * Legacy function kept for backwards compatibility during migration.
 */
export function selectScopeNoteLegacy(options: {
  hasDocResults: boolean;
  isRSAQuestion: boolean;
  scopeHint: string | null;
  townPreference?: string;
}): string {
  const { hasDocResults, isRSAQuestion, scopeHint, townPreference } = options;
  
  if (hasDocResults && townPreference) {
    return LOCAL_SCOPE_NOTE;
  }
  
  if (isRSAQuestion || scopeHint === "statewide") {
    return STATEWIDE_SCOPE_NOTE;
  }
  
  if (!hasDocResults) {
    return NO_DOC_SCOPE_NOTE;
  }
  
  return LOCAL_SCOPE_NOTE;
}
