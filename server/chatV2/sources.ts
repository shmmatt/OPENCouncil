import { storage } from "../storage";
import type { SourceCitation } from "./types";

export async function mapFileSearchDocumentsToCitations(
  documentNames: string[]
): Promise<SourceCitation[]> {
  if (!documentNames || documentNames.length === 0) {
    return [];
  }

  const uniqueNames = Array.from(new Set(documentNames));
  const citations: SourceCitation[] = [];
  const seenIds = new Set<string>();

  console.log(`[mapFileSearchDocumentsToCitations] Processing ${uniqueNames.length} unique document names:`, uniqueNames);

  for (const docName of uniqueNames) {
    try {
      console.log(`[mapFileSearchDocumentsToCitations] Looking up docName: "${docName}"`);
      // Strategy 1: Try to find by fileSearchDocumentName (full path or ID)
      let docVersion = await storage.getDocumentVersionByFileSearchName(docName);
      console.log(`[mapFileSearchDocumentsToCitations] getDocumentVersionByFileSearchName result:`, docVersion ? `Found ${docVersion.id}` : 'null');
      let logicalDoc = docVersion 
        ? await storage.getLogicalDocumentById(docVersion.documentId)
        : null;
      console.log(`[mapFileSearchDocumentsToCitations] logicalDoc result:`, logicalDoc ? logicalDoc.canonicalTitle : 'null');

      // Strategy 2: If not found by fileSearchName, try to find by title
      // Gemini may return the displayName we set as retrievedContext.title
      if (!docVersion && !logicalDoc) {
        logicalDoc = await storage.getLogicalDocumentByTitle(docName);
        if (logicalDoc) {
          console.log(`[mapFileSearchDocumentsToCitations] Found by title: "${docName}" -> ${logicalDoc.id}`);
          // Get the current version for this logical document
          const currentVersion = await storage.getCurrentVersionForDocument(logicalDoc.id);
          if (currentVersion) {
            docVersion = currentVersion;
          }
        }
      }

      if (docVersion && logicalDoc) {
        if (seenIds.has(docVersion.id)) continue;
        seenIds.add(docVersion.id);

        const meetingDateStr = docVersion.meetingDate 
          ? (docVersion.meetingDate instanceof Date 
              ? docVersion.meetingDate.toISOString().split('T')[0] 
              : String(docVersion.meetingDate))
          : undefined;
          
        citations.push({
          id: docVersion.id,
          title: logicalDoc.canonicalTitle || extractTitleFromName(docName),
          town: logicalDoc.town || undefined,
          year: docVersion.year || undefined,
          category: logicalDoc.category || undefined,
          url: `/api/files/${docVersion.id}`,
          meetingDate: meetingDateStr,
          board: logicalDoc.board || undefined,
        });
      } else if (docVersion) {
        // Have version but no logical doc
        if (seenIds.has(docVersion.id)) continue;
        seenIds.add(docVersion.id);

        const meetingDateStr = docVersion.meetingDate 
          ? (docVersion.meetingDate instanceof Date 
              ? docVersion.meetingDate.toISOString().split('T')[0] 
              : String(docVersion.meetingDate))
          : undefined;
          
        citations.push({
          id: docVersion.id,
          title: extractTitleFromName(docName),
          town: undefined,
          year: docVersion.year || undefined,
          category: undefined,
          url: `/api/files/${docVersion.id}`,
          meetingDate: meetingDateStr,
          board: undefined,
        });
      } else if (logicalDoc) {
        // Have logical doc but no version
        if (seenIds.has(logicalDoc.id)) continue;
        seenIds.add(logicalDoc.id);
          
        citations.push({
          id: logicalDoc.id,
          title: logicalDoc.canonicalTitle || extractTitleFromName(docName),
          town: logicalDoc.town || undefined,
          year: undefined,
          category: logicalDoc.category || undefined,
          url: undefined,
          board: logicalDoc.board || undefined,
        });
      } else {
        // No match found - use extracted title
        const title = extractTitleFromName(docName);
        if (!seenIds.has(title)) {
          seenIds.add(title);
          citations.push({
            id: docName,
            title: title,
            town: undefined,
            year: undefined,
            category: undefined,
            url: undefined,
          });
        }
      }
    } catch (error) {
      console.error(`Error mapping document ${docName}:`, error);
      const title = extractTitleFromName(docName);
      if (!seenIds.has(title)) {
        seenIds.add(title);
        citations.push({
          id: docName,
          title: title,
        });
      }
    }
  }

  return citations;
}

function extractTitleFromName(docName: string): string {
  if (docName.includes("/documents/")) {
    const parts = docName.split("/");
    return parts[parts.length - 1] || docName;
  }

  const bracketMatch = docName.match(/\[([^\]]+)\]\s*(.+)/);
  if (bracketMatch) {
    return bracketMatch[2] || docName;
  }

  return docName;
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
