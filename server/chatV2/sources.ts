import { storage } from "../storage";
import type { SourceCitation } from "./types";
import type { GroundingChunk } from "./simpleAnswer";

/**
 * Known NH town names for content-based document matching.
 */
const KNOWN_NH_TOWNS = [
  "Acworth", "Albany", "Alexandria", "Allenstown", "Alstead", "Alton", "Amherst",
  "Andover", "Antrim", "Ashland", "Atkinson", "Auburn", "Barnstead", "Barrington",
  "Bartlett", "Bath", "Bedford", "Belmont", "Bennington", "Benton", "Berlin",
  "Bethlehem", "Boscawen", "Bow", "Bradford", "Brentwood", "Bridgewater", "Bristol",
  "Brookfield", "Brookline", "Campton", "Canaan", "Candia", "Canterbury", "Carroll",
  "Center Harbor", "Charlestown", "Chatham", "Chester", "Chesterfield", "Chichester",
  "Claremont", "Clarksville", "Colebrook", "Columbia", "Concord", "Conway", "Cornish",
  "Croydon", "Dalton", "Danbury", "Danville", "Deerfield", "Deering", "Derry",
  "Dorchester", "Dover", "Dublin", "Dummer", "Dunbarton", "Durham", "East Kingston",
  "Easton", "Eaton", "Effingham", "Ellsworth", "Enfield", "Epping", "Epsom", "Errol",
  "Exeter", "Farmington", "Fitzwilliam", "Francestown", "Franconia", "Franklin",
  "Freedom", "Fremont", "Gilford", "Gilmanton", "Gilsum", "Goffstown", "Gorham",
  "Goshen", "Grafton", "Grantham", "Greenfield", "Greenland", "Greenville", "Groton",
  "Hampstead", "Hampton", "Hampton Falls", "Hancock", "Hanover", "Harrisville", "Hart's Location",
  "Haverhill", "Hebron", "Henniker", "Hill", "Hillsborough", "Hinsdale", "Holderness",
  "Hollis", "Hooksett", "Hopkinton", "Hudson", "Jackson", "Jaffrey", "Jefferson",
  "Keene", "Kensington", "Kingston", "Laconia", "Lancaster", "Landaff", "Langdon",
  "Lebanon", "Lee", "Lempster", "Lincoln", "Lisbon", "Litchfield", "Littleton",
  "Londonderry", "Loudon", "Lyman", "Lyme", "Lyndeborough", "Madbury", "Madison",
  "Manchester", "Marlborough", "Marlow", "Mason", "Meredith", "Merrimack", "Middleton",
  "Milan", "Milford", "Milton", "Monroe", "Mont Vernon", "Moultonborough", "Nashua",
  "Nelson", "New Boston", "New Castle", "New Durham", "New Hampton", "New Ipswich",
  "New London", "Newbury", "Newfields", "Newington", "Newmarket", "Newport", "Newton",
  "North Hampton", "Northfield", "Northumberland", "Northwood", "Nottingham", "Orange",
  "Orford", "Ossipee", "Pelham", "Pembroke", "Peterborough", "Piermont", "Pittsburg",
  "Pittsfield", "Plainfield", "Plaistow", "Plymouth", "Portsmouth", "Randolph", "Raymond",
  "Richmond", "Rindge", "Rochester", "Rollinsford", "Roxbury", "Rumney", "Rye",
  "Salem", "Salisbury", "Sanbornton", "Sandown", "Sandwich", "Seabrook", "Sharon",
  "Shelburne", "Somersworth", "South Hampton", "Springfield", "Stark", "Stewartstown",
  "Stoddard", "Strafford", "Stratford", "Stratham", "Sugar Hill", "Sullivan", "Sunapee",
  "Surry", "Sutton", "Swanzey", "Tamworth", "Temple", "Thornton", "Tilton", "Troy",
  "Tuftonboro", "Unity", "Wakefield", "Walpole", "Warner", "Warren", "Washington",
  "Waterville Valley", "Weare", "Webster", "Wentworth", "Westmoreland", "Whitefield",
  "Wilmot", "Wilton", "Winchester", "Windham", "Windsor", "Wolfeboro", "Woodstock"
];

/**
 * Board name patterns for content matching.
 */
const BOARD_PATTERNS: { pattern: RegExp; normalizedName: string }[] = [
  { pattern: /planning\s*board/i, normalizedName: "Planning Board" },
  { pattern: /board\s*of\s*select(?:men|persons|women)?/i, normalizedName: "Board of Selectmen" },
  { pattern: /\bBOS\b/i, normalizedName: "Board of Selectmen" },
  { pattern: /zoning\s*board(?:\s*of\s*adjustment)?/i, normalizedName: "Zoning Board of Adjustment" },
  { pattern: /\bZBA\b/i, normalizedName: "Zoning Board of Adjustment" },
  { pattern: /budget\s*committee/i, normalizedName: "Budget Committee" },
  { pattern: /conservation\s*commission/i, normalizedName: "Conservation Commission" },
  { pattern: /school\s*board/i, normalizedName: "School Board" },
  { pattern: /library\s*trustees?/i, normalizedName: "Library Trustees" },
];

/**
 * Parse a content snippet to extract document metadata for matching.
 */
function parseSnippetMetadata(snippet: string): {
  town: string | null;
  board: string | null;
  meetingDate: string | null;
} {
  let town: string | null = null;
  let board: string | null = null;
  let meetingDate: string | null = null;

  const upperSnippet = snippet.toUpperCase();
  
  // Find town name (check uppercase version for all-caps headers)
  for (const townName of KNOWN_NH_TOWNS) {
    const regex = new RegExp(`\\b${townName}\\b`, 'i');
    if (regex.test(snippet)) {
      town = townName;
      break;
    }
  }
  
  // Find board name
  for (const { pattern, normalizedName } of BOARD_PATTERNS) {
    if (pattern.test(snippet)) {
      board = normalizedName;
      break;
    }
  }
  
  // Find meeting date - multiple patterns
  const datePatterns = [
    // "September 16, 2025" or "September 16 2025"
    /\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2}),?\s+(\d{4})\b/i,
    // "09/16/2025" or "9/16/2025"
    /\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/,
    // "2025-09-16"
    /\b(\d{4})-(\d{2})-(\d{2})\b/,
  ];
  
  for (const pattern of datePatterns) {
    const match = snippet.match(pattern);
    if (match) {
      try {
        let dateStr: string;
        if (match[0].includes('/')) {
          // MM/DD/YYYY format
          const [, month, day, year] = match;
          dateStr = `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
        } else if (match[0].includes('-')) {
          // Already ISO format
          dateStr = match[0];
        } else {
          // Month DD, YYYY format
          const months: { [key: string]: string } = {
            january: '01', february: '02', march: '03', april: '04',
            may: '05', june: '06', july: '07', august: '08',
            september: '09', october: '10', november: '11', december: '12'
          };
          const monthNum = months[match[1].toLowerCase()];
          const day = match[2].padStart(2, '0');
          const year = match[3];
          dateStr = `${year}-${monthNum}-${day}`;
        }
        // Validate the date
        const parsed = new Date(dateStr);
        if (!isNaN(parsed.getTime())) {
          meetingDate = dateStr;
          break;
        }
      } catch {
        // Continue to next pattern
      }
    }
  }
  
  return { town, board, meetingDate };
}

/**
 * Resolve grounding chunks to SourceCitations using content-based matching.
 * 
 * Since Gemini returns content hashes (not our document IDs) in grounding metadata,
 * we extract text snippets and match them against our database using:
 * - Town name
 * - Board name  
 * - Meeting date
 */
export async function mapFileSearchDocumentsToCitations(
  chunks: GroundingChunk[]
): Promise<SourceCitation[]> {
  if (!chunks || chunks.length === 0) {
    return [];
  }

  const citations: SourceCitation[] = [];
  const seenIds = new Set<string>();
  let resolvedCount = 0;
  const unresolvedSample: string[] = [];

  for (const chunk of chunks) {
    try {
      let resolved: { documentVersionId: string; label: string; logicalDocumentId: string } | null = null;
      let town: string | null = null;
      let board: string | null = null;
      let meetingDate: string | null = null;
      
      // If snippet is empty (complex path), try ID-based matching first
      if (!chunk.snippet || chunk.snippet.trim() === "") {
        // Fall back to legacy ID-based matching for complex path
        const idResolved = await storage.getDocumentVersionByGeminiInternalId(chunk.contentHash);
        if (idResolved) {
          resolved = {
            documentVersionId: idResolved.documentVersionId,
            logicalDocumentId: idResolved.logicalDocumentId,
            label: idResolved.label,
          };
        }
        console.log("[sources_id_fallback]", {
          contentHash: chunk.contentHash.slice(0, 20) + "...",
          resolved: !!resolved,
        });
      } else {
        // Parse metadata from the snippet content
        const parsed = parseSnippetMetadata(chunk.snippet);
        town = parsed.town;
        board = parsed.board;
        meetingDate = parsed.meetingDate;
        
        console.log("[sources_content_match]", {
          contentHash: chunk.contentHash.slice(0, 16) + "...",
          snippetPreview: chunk.snippet.slice(0, 60) + "...",
          parsedTown: town,
          parsedBoard: board,
          parsedDate: meetingDate,
        });

        // Try to find matching document in database
        if (town && board && meetingDate) {
          // Best case: have all three fields for precise matching
          resolved = await storage.getDocumentVersionByContentMatch(town, board, meetingDate);
        } else if (town && meetingDate) {
          // Fallback: town + date
          resolved = await storage.getDocumentVersionByContentMatch(town, null, meetingDate);
        } else if (town && board) {
          // Fallback: town + board (will get most recent)
          resolved = await storage.getDocumentVersionByContentMatch(town, board, null);
        }
      }

      if (resolved) {
        if (seenIds.has(resolved.documentVersionId)) continue;
        seenIds.add(resolved.documentVersionId);
        resolvedCount++;

        // Get additional metadata
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
        // Unresolved - create a readable fallback from parsed metadata
        if (unresolvedSample.length < 3) {
          unresolvedSample.push(chunk.contentHash.slice(0, 16));
        }
        
        // Build a readable label from parsed metadata
        let fallbackLabel = "Source document";
        if (town && board) {
          fallbackLabel = `${town} ${board}`;
          if (meetingDate) {
            fallbackLabel += ` (${meetingDate})`;
          }
        } else if (town) {
          fallbackLabel = `${town} document`;
        }
        
        const fallbackId = chunk.contentHash;
        if (!seenIds.has(fallbackId)) {
          seenIds.add(fallbackId);
          citations.push({
            id: fallbackId,
            title: fallbackLabel,
            town: town || undefined,
            board: board || undefined,
            meetingDate: meetingDate || undefined,
          });
        }
      }
    } catch (error) {
      console.error(`[mapFileSearchDocumentsToCitations] Error processing chunk:`, error);
      const fallbackId = chunk.contentHash;
      if (!seenIds.has(fallbackId)) {
        seenIds.add(fallbackId);
        citations.push({
          id: fallbackId,
          title: "Source document",
        });
      }
    }
  }

  // Debug log
  console.log("[sources_resolution_debug]", {
    chunkCount: chunks.length,
    resolvedCount,
    unresolvedSample,
    citationLabels: citations.slice(0, 5).map(c => c.title),
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
