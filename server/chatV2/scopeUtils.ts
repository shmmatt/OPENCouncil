export function generateStatewideDisclaimer(): string {
  return "\n\n---\n**Source scope:** This answer is based on general knowledge of New Hampshire law and is not based on OpenCouncil-indexed municipal documents. This is informational only, not legal advice. For precise legal language, please consult the official RSA text or your municipal counsel.";
}

export function generateNoDocsFoundMessage(isRSA: boolean): string {
  if (isRSA) {
    return "I was unable to find relevant information in the OpenCouncil municipal document archive for this RSA/state law question. However, I can provide general guidance based on my knowledge of New Hampshire statutes.";
  }
  
  return "I was unable to find relevant information in the OpenCouncil municipal document archive for this question. You may want to:\n\n1. Rephrase your question with more specific terms\n2. Check if the relevant documents have been uploaded to the system\n3. Consult your municipal attorney or contact NHMA for guidance";
}

export function isStatewideScope(scopeHint: string | null): boolean {
  return scopeHint === "statewide" || scopeHint === "mixed";
}
