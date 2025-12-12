import { storage } from "../storage";
import type { SourceCitation } from "./types";

/**
 * Resolve geminiDocIds to SourceCitations using canonical exact-match resolution.
 * This is the primary path - uses gemini_internal_id exact match.
 */
export async function mapFileSearchDocumentsToCitations(
  geminiDocIds: string[]
): Promise<SourceCitation[]> {
  if (!geminiDocIds || geminiDocIds.length === 0) {
    return [];
  }

  const uniqueDocIds = Array.from(new Set(geminiDocIds));
  const citations: SourceCitation[] = [];
  const seenIds = new Set<string>();
  let resolvedCount = 0;
  const unresolvedSample: string[] = [];

  for (const docId of uniqueDocIds) {
    try {
      // Primary path: exact match on gemini_internal_id
      const resolved = await storage.getDocumentVersionByGeminiInternalId(docId);
      
      if (resolved) {
        if (seenIds.has(resolved.documentVersionId)) continue;
        seenIds.add(resolved.documentVersionId);
        resolvedCount++;

        // Get additional metadata from logical document
        const logicalDoc = await storage.getLogicalDocumentById(resolved.logicalDocumentId);
        const docVersion = await storage.getDocumentVersionById(resolved.documentVersionId);

        const meetingDateStr = docVersion?.meetingDate 
          ? (docVersion.meetingDate instanceof Date 
              ? docVersion.meetingDate.toISOString().split('T')[0] 
              : String(docVersion.meetingDate))
          : undefined;
          
        citations.push({
          id: resolved.documentVersionId,
          title: resolved.label,
          town: logicalDoc?.town || undefined,
          year: docVersion?.year || undefined,
          category: logicalDoc?.category || undefined,
          url: `/api/files/${resolved.documentVersionId}`,
          meetingDate: meetingDateStr,
          board: logicalDoc?.board || undefined,
        });
      } else {
        // Unresolved - log for debugging, use safe fallback label
        if (unresolvedSample.length < 3) {
          unresolvedSample.push(docId);
        }
        
        // Use "Source document" as fallback instead of showing hex
        const isHexString = /^[0-9a-f]{16,64}$/i.test(docId);
        const fallbackLabel = isHexString ? "Source document" : docId;
        
        if (!seenIds.has(docId)) {
          seenIds.add(docId);
          citations.push({
            id: docId,
            title: fallbackLabel,
            town: undefined,
            year: undefined,
            category: undefined,
            url: undefined,
          });
        }
      }
    } catch (error) {
      console.error(`[mapFileSearchDocumentsToCitations] Error resolving ${docId}:`, error);
      if (!seenIds.has(docId)) {
        seenIds.add(docId);
        citations.push({
          id: docId,
          title: "Source document",
        });
      }
    }
  }

  // Debug log
  console.log("[sources_resolution_debug]", {
    extractedCount: uniqueDocIds.length,
    resolvedCount,
    unresolvedSample,
  });

  return citations;
}

export function formatCitationsForDisplay(citations: SourceCitation[]): string {
  if (citations.length === 0) {
    return "";
  }

  const formatted = citations
    .map((c, i) => {
      let citation = `[${i + 1}] ${c.title}`;
      if (c.town && c.town !== "statewide") {
        citation += ` (${c.town})`;
      }
      if (c.meetingDate) {
        citation += ` - ${c.meetingDate}`;
      } else if (c.year) {
        citation += ` - ${c.year}`;
      }
      if (c.board) {
        citation += ` [${c.board}]`;
      }
      return citation;
    })
    .join("\n");

  return `\n\n**Sources:**\n${formatted}`;
}

export function formatSourcesForPrompt(citations: SourceCitation[]): string {
  if (citations.length === 0) {
    return "No sources explicitly labeled.";
  }

  return citations
    .map((s, idx) => {
      let line = `(${idx + 1}) [${s.title}]`;
      if (s.meetingDate) {
        line += ` - meeting date: ${s.meetingDate}`;
      } else if (s.year) {
        line += ` - year: ${s.year}`;
      }
      if (s.board) {
        line += ` [${s.board}]`;
      }
      return line;
    })
    .join("\n");
}
