import { storage } from "../storage";
import type { SourceCitation } from "./types";

const BLOB_PREFIX_REGEX = /^\[blob:([^\]]+)\]\s*(.+)$/;
const FILE_PREFIX_REGEX = /^\[file:([^:]+):([^\]]+)\]\s*(.+)$/;

interface ParsedDocName {
  fileBlobId: string | null;
  filenameTown: { town: string; filename: string } | null;
  title: string;
}

function parseBlobPrefix(docName: string): ParsedDocName {
  const blobMatch = docName.match(BLOB_PREFIX_REGEX);
  if (blobMatch) {
    return { fileBlobId: blobMatch[1], filenameTown: null, title: blobMatch[2] };
  }
  const fileMatch = docName.match(FILE_PREFIX_REGEX);
  if (fileMatch) {
    return { fileBlobId: null, filenameTown: { town: fileMatch[1], filename: fileMatch[2] }, title: fileMatch[3] };
  }
  return { fileBlobId: null, filenameTown: null, title: docName };
}

function internalViewerUrl(fileBlobId: string): string {
  return `/api/documents/view/${fileBlobId}`;
}

const BOARD_ABBREVIATIONS: Record<string, string> = {
  "planning board": "PB",
  "zoning board of adjustment": "ZBA",
  "board of selectmen": "BOS",
  "select board": "BOS",
  "selectboard": "BOS",
  "board of selectman": "BOS",
  "conservation commission": "CC",
  "budget committee": "Budget Comm.",
  "school board": "School Board",
  "library trustees": "Library Trustees",
  "trustees of trust funds": "Trust Fund Trustees",
  "cemetery trustees": "Cemetery Trustees",
  "fire department": "Fire Dept.",
  "police department": "Police Dept.",
  "parks and recreation": "Parks & Rec",
  "heritage commission": "Heritage Comm.",
  "economic development": "Econ. Dev.",
};

const CATEGORY_LABELS: Record<string, string> = {
  "meeting_minutes": "Minutes",
  "minutes": "Minutes",
  "agendas": "Agenda",
  "agenda": "Agenda",
  "budget": "Budget",
  "financials": "Financials",
  "ordinance": "Ordinance",
  "ordinances": "Ordinance",
  "zoning": "Zoning Regulations",
  "reports": "Report",
  "policy": "Policy",
  "policies": "Policy",
  "warrant_article": "Warrant Article",
  "warrants": "Warrant Article",
  "annual-reports": "Annual Report",
  "town_report": "Town Report",
  "planning_board_docs": "PB Document",
  "zba_docs": "ZBA Document",
};

const OMIT_CATEGORIES = new Set(["misc", "document", "documents", "other"]);

const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function formatDate(dateStr: string | undefined | null): string | null {
  if (!dateStr) return null;
  const cleaned = String(dateStr).split(" ")[0];
  const parts = cleaned.split("-");
  if (parts.length !== 3) return null;
  const year = parseInt(parts[0], 10);
  const month = parseInt(parts[1], 10);
  const day = parseInt(parts[2], 10);
  if (isNaN(year) || isNaN(month) || isNaN(day)) return null;
  if (month < 1 || month > 12) return null;
  return `${MONTH_NAMES[month - 1]} ${day}, ${year}`;
}

function normalizeBoard(board: string | undefined | null): string | null {
  if (!board || board === "Unknown" || board === "unknown") return null;
  let cleaned = board.replace(/_/g, " ").trim();
  cleaned = cleaned.replace(/^the\s+/i, "");
  const lower = cleaned.toLowerCase();
  if (BOARD_ABBREVIATIONS[lower]) {
    return BOARD_ABBREVIATIONS[lower];
  }
  return cleaned;
}

function getCategoryLabel(category: string | undefined | null): string | null {
  if (!category) return null;
  const lower = category.toLowerCase().trim();
  if (OMIT_CATEGORIES.has(lower)) return null;
  return CATEGORY_LABELS[lower] || titleCase(category.replace(/_/g, " "));
}

function isMinutesCategory(category: string | undefined | null): boolean {
  if (!category) return false;
  const lower = category.toLowerCase().trim();
  return lower === "meeting_minutes" || lower === "minutes";
}

function isAgendaCategory(category: string | undefined | null): boolean {
  if (!category) return false;
  const lower = category.toLowerCase().trim();
  return lower === "agendas" || lower === "agenda";
}

function titleCase(str: string): string {
  const SMALL_WORDS = new Set(["a", "an", "the", "and", "but", "or", "for", "nor", "on", "at", "to", "by", "in", "of", "up", "as"]);
  return str
    .split(/\s+/)
    .map((word, i) => {
      if (word === word.toUpperCase() && word.length >= 2 && /^[A-Z]+$/.test(word)) return word;
      const lower = word.toLowerCase();
      if (i > 0 && SMALL_WORDS.has(lower)) return lower;
      return lower.charAt(0).toUpperCase() + lower.slice(1);
    })
    .join(" ");
}

function cleanRawTitle(raw: string): string {
  let cleaned = raw;
  cleaned = cleaned.replace(/^\[[^\]]*\]\s*/, "");
  cleaned = cleaned.replace(/\s*\(OCR\)\s*$/i, "");
  cleaned = cleaned.replace(/\.[a-zA-Z0-9]{2,5}$/, "");
  cleaned = cleaned.replace(/[-_]+/g, " ");
  cleaned = cleaned.replace(/\s+/g, " ").trim();
  if (!cleaned) return raw;
  return titleCase(cleaned);
}

interface CitationTitleInput {
  rawTitle?: string;
  board?: string | null;
  category?: string | null;
  meetingDate?: string | null;
  year?: string | null;
  town?: string | null;
}

export function formatCitationTitle(input: CitationTitleInput): string {
  const board = normalizeBoard(input.board);
  const catLabel = getCategoryLabel(input.category);
  const formattedDate = formatDate(input.meetingDate);
  const year = input.year || null;

  if (board && isMinutesCategory(input.category)) {
    if (formattedDate) {
      return `${board} Minutes - ${formattedDate}`;
    }
    if (year) {
      return `${board} Minutes (${year})`;
    }
    return `${board} Minutes`;
  }

  if (board && isAgendaCategory(input.category)) {
    if (formattedDate) {
      return `${board} Agenda - ${formattedDate}`;
    }
    if (year) {
      return `${board} Agenda (${year})`;
    }
    return `${board} Agenda`;
  }

  if (board && catLabel) {
    if (year) {
      return `${board} ${catLabel} (${year})`;
    }
    return `${board} ${catLabel}`;
  }

  if (catLabel && year) {
    const town = normalizeTown(input.town);
    if (town && (catLabel === "Annual Report" || catLabel === "Town Report")) {
      return `${town} ${catLabel} (${year})`;
    }
    return `${catLabel} (${year})`;
  }

  if (catLabel) {
    const town = normalizeTown(input.town);
    if (town && (catLabel === "Annual Report" || catLabel === "Town Report")) {
      return `${town} ${catLabel}`;
    }
    return catLabel;
  }

  if (board && formattedDate) {
    return `${board} - ${formattedDate}`;
  }

  if (board && year) {
    return `${board} (${year})`;
  }

  if (input.rawTitle) {
    return cleanRawTitle(input.rawTitle);
  }

  return "Document";
}

function normalizeTown(town: string | undefined | null): string | null {
  if (!town || town === "statewide" || town === "unknown") return null;
  return titleCase(town);
}

function disambiguateDuplicateTitles(citations: SourceCitation[]): void {
  const titleCounts = new Map<string, number>();
  const titleIndices = new Map<string, number[]>();

  for (let i = 0; i < citations.length; i++) {
    const t = citations[i].title;
    titleCounts.set(t, (titleCounts.get(t) || 0) + 1);
    if (!titleIndices.has(t)) titleIndices.set(t, []);
    titleIndices.get(t)!.push(i);
  }

  for (const [title, indices] of titleIndices) {
    if (indices.length <= 1) continue;
    for (let j = 0; j < indices.length; j++) {
      const idx = indices[j];
      const c = citations[idx];
      const suffix = c.id ? c.id.slice(-4) : String(j + 1);
      citations[idx] = { ...c, title: `${title} (${suffix})` };
    }
  }
}

export async function mapFileSearchDocumentsToCitations(
  documentNames: string[]
): Promise<SourceCitation[]> {
  if (!documentNames || documentNames.length === 0) {
    return [];
  }

  const uniqueNames = Array.from(new Set(documentNames));
  const citations: SourceCitation[] = [];
  const seenIds = new Set<string>();

  for (const docName of uniqueNames) {
    try {
      const { fileBlobId: parsedBlobId, filenameTown, title: parsedTitle } = parseBlobPrefix(docName);

      if (parsedBlobId) {
        if (seenIds.has(parsedBlobId)) continue;
        seenIds.add(parsedBlobId);

        let sourceUrl: string | undefined = undefined;
        let isInternal = false;
        try {
          const crawledUrl = await storage.getCrawledUrlByFileBlobId(parsedBlobId);
          if (crawledUrl) {
            sourceUrl = crawledUrl;
          }
        } catch {}

        if (!sourceUrl) {
          sourceUrl = internalViewerUrl(parsedBlobId);
          isInternal = true;
        }

        let meta: { canonicalTitle?: string; town?: string; board?: string; year?: string; category?: string; meetingDate?: string } | null = null;
        try {
          meta = await storage.getDocumentMetadataByFileBlobId(parsedBlobId);
        } catch {}

        const displayTitle = formatCitationTitle({
          rawTitle: meta?.canonicalTitle || parsedTitle,
          board: meta?.board,
          category: meta?.category,
          meetingDate: meta?.meetingDate,
          year: meta?.year,
          town: meta?.town,
        });

        citations.push({
          id: parsedBlobId,
          title: displayTitle,
          url: sourceUrl,
          isInternal,
          town: meta?.town,
          board: meta?.board,
          year: meta?.year,
          category: meta?.category,
          meetingDate: meta?.meetingDate,
        });
        continue;
      }

      if (filenameTown) {
        const dedupeKey = `${filenameTown.town}:${filenameTown.filename}`;
        if (seenIds.has(dedupeKey)) continue;
        seenIds.add(dedupeKey);

        let sourceUrl: string | undefined = undefined;
        let isInternal = false;
        try {
          const crawledUrl = await storage.getCrawledUrlByFilenameAndTown(filenameTown.filename, filenameTown.town);
          if (crawledUrl) {
            sourceUrl = crawledUrl;
          }
        } catch {}

        if (!sourceUrl) {
          try {
            const fileBlobId = await storage.getFileBlobIdByFilenameAndTown(filenameTown.filename, filenameTown.town);
            if (fileBlobId) {
              sourceUrl = internalViewerUrl(fileBlobId);
              isInternal = true;
            }
          } catch {}
        }

        const displayTitle = formatCitationTitle({
          rawTitle: parsedTitle,
          town: filenameTown.town,
        });

        citations.push({
          id: dedupeKey,
          title: displayTitle,
          url: sourceUrl,
          isInternal,
          town: filenameTown.town,
        });
        continue;
      }

      const docVersion = await storage.getDocumentVersionByFileSearchName(docName);

      if (docVersion) {
        if (seenIds.has(docVersion.id)) continue;
        seenIds.add(docVersion.id);

        const logicalDoc = await storage.getLogicalDocumentById(docVersion.documentId);

        const meetingDateStr = docVersion.meetingDate 
          ? (docVersion.meetingDate instanceof Date 
              ? docVersion.meetingDate.toISOString().split('T')[0] 
              : String(docVersion.meetingDate))
          : undefined;
          
        let sourceUrl: string | undefined = undefined;
        let isInternal = false;
        if (docVersion.fileBlobId) {
          try {
            const crawledUrl = await storage.getCrawledUrlByFileBlobId(docVersion.fileBlobId);
            if (crawledUrl) {
              sourceUrl = crawledUrl;
            }
          } catch {
          }

          if (!sourceUrl) {
            sourceUrl = internalViewerUrl(docVersion.fileBlobId);
            isInternal = true;
          }
        }

        const displayTitle = formatCitationTitle({
          rawTitle: logicalDoc?.canonicalTitle || extractTitleFromName(docName),
          board: logicalDoc?.board,
          category: logicalDoc?.category,
          meetingDate: meetingDateStr,
          year: docVersion.year,
          town: logicalDoc?.town,
        });

        citations.push({
          id: docVersion.id,
          title: displayTitle,
          town: logicalDoc?.town || undefined,
          year: docVersion.year || undefined,
          category: logicalDoc?.category || undefined,
          url: sourceUrl,
          isInternal,
          meetingDate: meetingDateStr,
          board: logicalDoc?.board || undefined,
        });
      } else {
        const rawTitle = extractTitleFromName(docName);
        const displayTitle = formatCitationTitle({ rawTitle });
        if (!seenIds.has(rawTitle)) {
          seenIds.add(rawTitle);
          citations.push({
            id: docName,
            title: displayTitle,
            town: undefined,
            year: undefined,
            category: undefined,
            url: undefined,
          });
        }
      }
    } catch (error) {
      console.error(`Error mapping document ${docName}:`, error);
      const rawTitle = extractTitleFromName(docName);
      const displayTitle = formatCitationTitle({ rawTitle });
      if (!seenIds.has(rawTitle)) {
        seenIds.add(rawTitle);
        citations.push({
          id: docName,
          title: displayTitle,
        });
      }
    }
  }

  disambiguateDuplicateTitles(citations);

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
      const titleLower = c.title.toLowerCase();
      if (c.town && c.town !== "statewide" && !titleLower.includes(c.town.toLowerCase())) {
        citation += ` (${c.town})`;
      }
      if (c.meetingDate && !c.title.includes(c.meetingDate)) {
        const formatted = formatDate(c.meetingDate);
        if (formatted && !c.title.includes(formatted)) {
          citation += ` - ${formatted}`;
        }
      } else if (c.year && !c.title.includes(c.year)) {
        citation += ` - ${c.year}`;
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
      if (s.meetingDate && !s.title.includes(s.meetingDate)) {
        const formatted = formatDate(s.meetingDate);
        if (formatted && !s.title.includes(formatted)) {
          line += ` - ${formatted}`;
        }
      } else if (s.year && !s.title.includes(s.year)) {
        line += ` - ${s.year}`;
      }
      return line;
    })
    .join("\n");
}
