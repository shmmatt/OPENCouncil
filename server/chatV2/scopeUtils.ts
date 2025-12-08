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

export function selectScopeNote(options: {
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
