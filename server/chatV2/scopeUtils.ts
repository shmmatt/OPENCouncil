import type { DocSourceType } from "./types";
import type { ChatNotice } from "@shared/chatNotices";
import { NOTICE_CODES } from "@shared/chatNotices";

const LOCAL_SCOPE_MESSAGE = 
  "Based on documents available in the OpenCouncil archive for this municipality. " +
  "These materials include meeting minutes, budgets, warrant articles, town reports, or policy records where available. " +
  "Details may be incomplete depending on what municipalities have published or digitized. " +
  "This information is informational only and is not legal advice.";

const STATEWIDE_SCOPE_MESSAGE =
  "Informed primarily by New Hampshire statutory and regulatory context. " +
  "This summary is not based on a specific municipality's OpenCouncil-indexed documents. " +
  "For exact legal language or application, consult the official RSA text or municipal counsel. " +
  "This information is informational only and is not legal advice.";

const NO_DOC_SCOPE_MESSAGE =
  "No directly relevant material was found in the OpenCouncil archive for this question. " +
  "Where possible, this response reflects general New Hampshire municipal practice. " +
  "Local procedures may differ, and consulting municipal records or counsel may provide more specific guidance. " +
  "This information is informational only and is not legal advice.";

const MIXED_SCOPE_MESSAGE =
  "Based on both local municipal documents and statewide New Hampshire statutory context. " +
  "These materials include local meeting minutes, budgets, and policy records, as well as RSA references. " +
  "Local procedures may vary. This information is informational only and is not legal advice.";

export function localScopeNotice(town: string | null): ChatNotice {
  const label = town ? `Local: ${town}` : "Local docs";
  const message = town
    ? `Based on documents from the Town of ${town} in the OpenCouncil archive. ` +
      "These materials include meeting minutes, budgets, warrant articles, town reports, or policy records where available. " +
      "Details may be incomplete depending on what the municipality has published or digitized. " +
      "This information is informational only and is not legal advice."
    : LOCAL_SCOPE_MESSAGE;

  return {
    kind: "scope",
    code: NOTICE_CODES.LOCAL_SCOPE,
    label,
    message,
    severity: "info",
  };
}

export function statewideScopeNotice(): ChatNotice {
  return {
    kind: "scope",
    code: NOTICE_CODES.STATEWIDE_SCOPE,
    label: "NH law",
    message: STATEWIDE_SCOPE_MESSAGE,
    severity: "info",
  };
}

export function noDocsScopeNotice(): ChatNotice {
  return {
    kind: "scope",
    code: NOTICE_CODES.NO_DOCS,
    label: "No docs found",
    message: NO_DOC_SCOPE_MESSAGE,
    severity: "warning",
  };
}

export function mixedScopeNotice(town: string | null): ChatNotice {
  const label = town ? `Mixed: ${town} + NH law` : "Mixed sources";
  const message = town
    ? `Based on documents from the Town of ${town} and statewide New Hampshire statutory context. ` +
      "These materials include local meeting minutes, budgets, and policy records, as well as RSA references. " +
      "Local procedures may vary. This information is informational only and is not legal advice."
    : MIXED_SCOPE_MESSAGE;

  return {
    kind: "scope",
    code: NOTICE_CODES.MIXED_SCOPE,
    label,
    message,
    severity: "info",
  };
}

export function infoOnlyNotice(): ChatNotice {
  return {
    kind: "disclaimer",
    code: NOTICE_CODES.INFO_ONLY,
    label: "Info only",
    message: "This is informational only, not legal advice. For specific legal questions, please consult your municipal attorney or NHMA.",
    severity: "info",
  };
}

export function archiveNotConfiguredNotice(): ChatNotice {
  return {
    kind: "system",
    code: NOTICE_CODES.ARCHIVE_NOT_CONFIGURED,
    label: "Archive unavailable",
    message: "The OpenCouncil archive is not yet configured. Please contact your administrator to set up document indexing.",
    severity: "warning",
  };
}

export function highDemandNotice(): ChatNotice {
  return {
    kind: "error",
    code: NOTICE_CODES.HIGH_DEMAND,
    label: "High demand",
    message: "We're temporarily experiencing high demand. Please try again in a moment.",
    severity: "warning",
  };
}

export function processingErrorNotice(): ChatNotice {
  return {
    kind: "error",
    code: NOTICE_CODES.PROCESSING_ERROR,
    label: "Error",
    message: "An error occurred while processing your request. Please try again.",
    severity: "error",
  };
}

export function isStatewideScope(scopeHint: string | null): boolean {
  return scopeHint === "statewide" || scopeHint === "mixed";
}

/**
 * Select the appropriate scope notice based on DocSourceType.
 * 
 * PRECEDENCE RULES:
 * - If docs were found (local/mixed), never return STATEWIDE or NO_DOCS
 * - STATEWIDE only when no docs AND it's an RSA question
 * - NO_DOCS only when no docs AND not RSA
 */
export function selectScopeNotice(options: {
  docSourceType: DocSourceType;
  docSourceTown: string | null;
  sourceCount?: number;
  isRSAQuestion?: boolean;
}): ChatNotice {
  const { docSourceType, docSourceTown, sourceCount = 0, isRSAQuestion = false } = options;

  if (sourceCount > 0) {
    if (docSourceType === "mixed" || (docSourceType === "statewide" && docSourceTown)) {
      return mixedScopeNotice(docSourceTown);
    }
    return localScopeNotice(docSourceTown);
  }

  if (isRSAQuestion) {
    return statewideScopeNotice();
  }

  switch (docSourceType) {
    case "local":
      return localScopeNotice(docSourceTown);
    case "statewide":
      return statewideScopeNotice();
    case "mixed":
      return mixedScopeNotice(docSourceTown);
    case "none":
    default:
      return noDocsScopeNotice();
  }
}

// ============================================================================
// LEGACY EXPORTS - Keep for backwards compatibility during migration
// These will be removed after full migration to notice-based system
// ============================================================================

/** @deprecated Use localScopeNotice instead */
export const LOCAL_SCOPE_NOTE = "\n\n---\n**Source scope:** " + LOCAL_SCOPE_MESSAGE;

/** @deprecated Use statewideScopeNotice instead */
export const STATEWIDE_SCOPE_NOTE = "\n\n---\n**Source scope:** " + STATEWIDE_SCOPE_MESSAGE;

/** @deprecated Use noDocsScopeNotice instead */
export const NO_DOC_SCOPE_NOTE = "\n\n---\n**Source scope:** " + NO_DOC_SCOPE_MESSAGE;

/** @deprecated Use mixedScopeNotice instead */
export const MIXED_SCOPE_NOTE = "\n\n---\n**Source scope:** " + MIXED_SCOPE_MESSAGE;

/** @deprecated Use statewideScopeNotice instead */
export function generateStatewideDisclaimer(): string {
  return STATEWIDE_SCOPE_NOTE;
}

/** @deprecated No longer needed - notices handle this */
export function generateNoDocsFoundMessage(isRSA: boolean): string {
  if (isRSA) {
    return "No directly relevant material was found in the OpenCouncil archive for this RSA/state law question. " +
      "The following general guidance may still be helpful, but local procedures can differ.";
  }
  
  return "No directly relevant material was found in the OpenCouncil archive for this question. " +
    "The following general guidance may still be helpful, but local procedures can differ.";
}

/** @deprecated Use localScopeNotice instead */
export function generateLocalScopeNote(): string {
  return LOCAL_SCOPE_NOTE;
}

/** @deprecated Use selectScopeNotice instead */
export function selectScopeNote(options: {
  docSourceType: DocSourceType;
  docSourceTown: string | null;
}): string {
  const { docSourceType, docSourceTown } = options;

  switch (docSourceType) {
    case "local":
      if (docSourceTown) {
        return `\n\n---\n**Source scope:** Based on documents from the Town of ${docSourceTown} in the OpenCouncil archive. ` +
          "These materials include meeting minutes, budgets, warrant articles, town reports, or policy records where available. " +
          "Details may be incomplete depending on what the municipality has published or digitized. " +
          "This information is informational only and is not legal advice.";
      }
      return LOCAL_SCOPE_NOTE;
    case "statewide":
      return STATEWIDE_SCOPE_NOTE;
    case "mixed":
      if (docSourceTown) {
        return `\n\n---\n**Source scope:** Based on documents from the Town of ${docSourceTown} and statewide New Hampshire statutory context. ` +
          "These materials include local meeting minutes, budgets, and policy records, as well as RSA references. " +
          "Local procedures may vary. This information is informational only and is not legal advice.";
      }
      return MIXED_SCOPE_NOTE;
    case "none":
    default:
      return NO_DOC_SCOPE_NOTE;
  }
}

/** @deprecated Use selectScopeNotice instead */
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
