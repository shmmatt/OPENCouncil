import { GoogleGenAI } from "@google/genai";
import type { DocumentMetadata } from "@shared/schema";
import { ALLOWED_CATEGORIES } from "@shared/schema";

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY || "" });

export interface SuggestedMetadata {
  category: typeof ALLOWED_CATEGORIES[number];
  town: string;
  board: string;
  year: string;
  notes: string;
  // Minutes-specific fields
  isMinutes?: boolean;
  meetingDate?: string | null;
  meetingType?: string | null;
  rawDateText?: string | null;
}

export interface MinutesHeuristics {
  likelyMinutes: boolean;
  possibleTown?: string;
  possibleBoard?: string;
  possibleDateText?: string;
  confidence: "high" | "medium" | "low";
}

// Heuristic pre-pass to detect meeting minutes before calling LLM
export function detectMinutesHeuristics(
  filename: string,
  previewText: string
): MinutesHeuristics {
  const lower = filename.toLowerCase();
  const textLower = previewText.toLowerCase();
  const firstPageText = previewText.slice(0, 3000); // Focus on first page
  
  let likelyMinutes = false;
  let confidence: "high" | "medium" | "low" = "low";
  let possibleTown: string | undefined;
  let possibleBoard: string | undefined;
  let possibleDateText: string | undefined;

  // Check filename patterns for minutes
  const filenameMinutesPatterns = [
    /minutes/i,
    /mtg[\s_-]?\d{4}/i,
    /meeting[\s_-]?\d{4}/i,
    /\b(pb|bos|zba|cc)[\s_-]?\d{1,2}[\s_-]?\d{1,2}[\s_-]?\d{2,4}/i,
    /selectmen.*\d{4}/i,
    /planning.*board.*\d{4}/i,
  ];
  
  for (const pattern of filenameMinutesPatterns) {
    if (pattern.test(lower)) {
      likelyMinutes = true;
      confidence = "medium";
      break;
    }
  }

  // Check first page text for minutes patterns
  const textMinutesPatterns = [
    /meeting\s+minutes/i,
    /minutes\s+of\s+(the\s+)?meeting/i,
    /board\s+of\s+selectmen\s+meeting\s*minutes/i,
    /planning\s+board\s+meeting\s*minutes/i,
    /zoning\s+board\s+of\s+adjustment\s+meeting\s*minutes/i,
    /budget\s+committee\s+meeting\s*minutes/i,
    /conservation\s+commission\s+meeting\s*minutes/i,
    /regular\s+meeting/i,
    /special\s+meeting/i,
    /work\s+session/i,
    /call\s+to\s+order/i,
    /roll\s+call/i,
    /members\s+present:/i,
    /meeting\s+called\s+to\s+order/i,
  ];

  for (const pattern of textMinutesPatterns) {
    if (pattern.test(firstPageText)) {
      likelyMinutes = true;
      confidence = "high";
      break;
    }
  }

  // Extract possible town from text
  const townPatterns = [
    /town\s+of\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)/i,
    /([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)\s+town\s+hall/i,
    /([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)\s+planning\s+board/i,
    /([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)\s+board\s+of\s+selectmen/i,
  ];

  for (const pattern of townPatterns) {
    const match = firstPageText.match(pattern);
    if (match && match[1]) {
      possibleTown = match[1].trim();
      break;
    }
  }

  // Extract possible board from text
  const boardPatterns: Array<{ pattern: RegExp; name: string }> = [
    { pattern: /planning\s+board/i, name: "Planning Board" },
    { pattern: /board\s+of\s+selectmen/i, name: "Board of Selectmen" },
    { pattern: /select\s*board/i, name: "Select Board" },
    { pattern: /zoning\s+board\s+of\s+adjustment/i, name: "Zoning Board of Adjustment" },
    { pattern: /\bzba\b/i, name: "Zoning Board of Adjustment" },
    { pattern: /budget\s+committee/i, name: "Budget Committee" },
    { pattern: /conservation\s+commission/i, name: "Conservation Commission" },
    { pattern: /school\s+board/i, name: "School Board" },
    { pattern: /heritage\s+commission/i, name: "Heritage Commission" },
    { pattern: /recreation\s+commission/i, name: "Recreation Commission" },
  ];

  for (const { pattern, name } of boardPatterns) {
    if (pattern.test(firstPageText)) {
      possibleBoard = name;
      break;
    }
  }

  // Extract possible date from text (check header area more closely)
  const datePatterns = [
    // Full date patterns: March 5, 2024 or March 5th, 2024
    /(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2}(?:st|nd|rd|th)?,?\s+\d{4}/i,
    // MM/DD/YYYY or MM-DD-YYYY
    /\b\d{1,2}[\/\-]\d{1,2}[\/\-]\d{4}\b/,
    // YYYY-MM-DD (ISO format)
    /\b\d{4}[\/\-]\d{1,2}[\/\-]\d{1,2}\b/,
    // Short month format: Mar 5, 2024
    /(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\.?\s+\d{1,2},?\s+\d{4}/i,
  ];

  // Search in first ~1500 chars (usually header area)
  const headerText = previewText.slice(0, 1500);
  for (const pattern of datePatterns) {
    const match = headerText.match(pattern);
    if (match) {
      possibleDateText = match[0];
      break;
    }
  }

  return {
    likelyMinutes,
    possibleTown,
    possibleBoard,
    possibleDateText,
    confidence,
  };
}

// Parse various date formats to ISO string (YYYY-MM-DD)
export function parseDateToISO(dateText: string): string | null {
  if (!dateText) return null;
  
  const monthMap: Record<string, string> = {
    january: "01", jan: "01",
    february: "02", feb: "02",
    march: "03", mar: "03",
    april: "04", apr: "04",
    may: "05",
    june: "06", jun: "06",
    july: "07", jul: "07",
    august: "08", aug: "08",
    september: "09", sep: "09", sept: "09",
    october: "10", oct: "10",
    november: "11", nov: "11",
    december: "12", dec: "12",
  };

  const cleanedText = dateText.trim().replace(/\./g, "");

  // Try YYYY-MM-DD format first
  const isoMatch = cleanedText.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (isoMatch) {
    const [, year, month, day] = isoMatch;
    return `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
  }

  // Try MM/DD/YYYY or MM-DD-YYYY format
  const slashMatch = cleanedText.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
  if (slashMatch) {
    const [, month, day, year] = slashMatch;
    return `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
  }

  // Try YYYY/MM/DD format
  const yearFirstMatch = cleanedText.match(/^(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})$/);
  if (yearFirstMatch) {
    const [, year, month, day] = yearFirstMatch;
    return `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
  }

  // Try Month DD, YYYY format
  const monthNameMatch = cleanedText.match(/^([A-Za-z]+)\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})$/i);
  if (monthNameMatch) {
    const [, monthName, day, year] = monthNameMatch;
    const month = monthMap[monthName.toLowerCase()];
    if (month) {
      return `${year}-${month}-${day.padStart(2, "0")}`;
    }
  }

  return null;
}

export async function suggestMetadataFromPreview(
  filename: string,
  previewText: string
): Promise<SuggestedMetadata> {
  const categoryList = ALLOWED_CATEGORIES.join(", ");
  
  // Run heuristic pre-pass for minutes detection
  const minutesHints = detectMinutesHeuristics(filename, previewText);
  
  const prompt = `You classify municipal government documents from New Hampshire.
Read the filename and text below and respond with ONLY valid JSON (no markdown, no code blocks, just pure JSON):

{
  "category": "...",
  "town": "...",
  "board": "...",
  "year": "...",
  "notes": "...",
  "isMinutes": true/false,
  "meetingDate": "YYYY-MM-DD" or null,
  "meetingType": "regular" | "special" | "work_session" or null,
  "rawDateText": "original date text from document" or null
}

category MUST be one of:
${categoryList}

Rules:
- If document is statewide (laws, handbooks, state guidance) use: "town": "statewide"
- Keep notes very short (under 100 characters)
- If you cannot determine a field, use an empty string "" for strings or null for nullable fields
- Year should be a 4-digit year if detectable, otherwise ""
- Board should be the name of the board/department if mentioned (e.g., "Planning Board", "Zoning Board", "School Board")

SPECIAL RULES FOR MEETING MINUTES:
- If this document appears to be official meeting minutes, set isMinutes: true AND category: "meeting_minutes"
- Meeting minutes typically have: "Meeting Minutes" in header, "Call to Order", "Roll Call", "Members Present", dates in header
- For minutes, extract the EXACT meeting date as meetingDate in ISO format (YYYY-MM-DD)
- Set rawDateText to the original date text you found (e.g., "March 5, 2024")
- meetingType: "regular" for regular meetings, "special" for special meetings, "work_session" for work sessions
- town: extract the exact town name (e.g., "Ossipee", "Conway") - do NOT include "Town of"
- board: exact board name like "Planning Board", "Board of Selectmen", "Zoning Board of Adjustment"

${minutesHints.likelyMinutes ? `HINT: This document appears to be meeting minutes based on filename/text patterns.` : ""}
${minutesHints.possibleTown ? `HINT: Possible town detected: "${minutesHints.possibleTown}"` : ""}
${minutesHints.possibleBoard ? `HINT: Possible board detected: "${minutesHints.possibleBoard}"` : ""}
${minutesHints.possibleDateText ? `HINT: Possible meeting date detected: "${minutesHints.possibleDateText}"` : ""}

Filename: ${filename}

Document Preview Text:
${previewText.slice(0, 10000)}`;

  try {
    const response = await ai.models.generateContent({
      model: "gemini-2.5-flash",
      contents: [{ role: "user", parts: [{ text: prompt }] }],
    });

    const responseText = response.text || "";
    
    const cleanedText = responseText
      .replace(/```json\n?/g, "")
      .replace(/```\n?/g, "")
      .trim();
    
    try {
      const parsed = JSON.parse(cleanedText);
      
      const validCategory = ALLOWED_CATEGORIES.includes(parsed.category as any) 
        ? parsed.category 
        : "misc_other";
      
      // If isMinutes is true, ensure category is meeting_minutes
      const isMinutes = Boolean(parsed.isMinutes);
      const finalCategory = isMinutes ? "meeting_minutes" : validCategory;
      
      // Normalize the meeting date to ISO format if present
      let meetingDate: string | null = null;
      if (parsed.meetingDate && typeof parsed.meetingDate === "string") {
        meetingDate = parseDateToISO(parsed.meetingDate) || parsed.meetingDate;
      } else if (parsed.rawDateText && typeof parsed.rawDateText === "string") {
        meetingDate = parseDateToISO(parsed.rawDateText);
      }
      
      return {
        category: finalCategory as typeof ALLOWED_CATEGORIES[number],
        town: typeof parsed.town === "string" ? parsed.town : "",
        board: typeof parsed.board === "string" ? parsed.board : "",
        year: typeof parsed.year === "string" ? parsed.year : "",
        notes: typeof parsed.notes === "string" ? parsed.notes.slice(0, 200) : "",
        isMinutes,
        meetingDate,
        meetingType: typeof parsed.meetingType === "string" ? parsed.meetingType : null,
        rawDateText: typeof parsed.rawDateText === "string" ? parsed.rawDateText : null,
      };
    } catch (parseError) {
      console.error("Failed to parse LLM response:", cleanedText);
      return inferMetadataFromFilename(filename);
    }
  } catch (error) {
    console.error("Error calling Gemini for metadata suggestion:", error);
    return inferMetadataFromFilename(filename);
  }
}

export function inferMetadataFromFilename(filename: string): SuggestedMetadata {
  const lower = filename.toLowerCase();
  let category: typeof ALLOWED_CATEGORIES[number] = "misc_other";
  let year = "";
  let town = "";
  let board = "";
  let isMinutes = false;
  
  if (lower.includes("budget")) category = "budget";
  else if (lower.includes("zoning")) category = "zoning";
  else if (lower.includes("minutes") || lower.includes("meeting")) {
    category = "meeting_minutes";
    isMinutes = true;
  }
  else if (lower.includes("town report") || lower.includes("annual report")) category = "town_report";
  else if (lower.includes("warrant")) category = "warrant_article";
  else if (lower.includes("ordinance")) category = "ordinance";
  else if (lower.includes("policy") || lower.includes("policies")) category = "policy";
  else if (lower.includes("planning board") || lower.includes("planning")) category = "planning_board_docs";
  else if (lower.includes("zba") || lower.includes("zoning board")) category = "zba_docs";
  else if (lower.includes("license") || lower.includes("permit")) category = "licensing_permits";
  else if (lower.includes("cip") || lower.includes("capital improvement")) category = "cip";
  else if (lower.includes("election") || lower.includes("ballot") || lower.includes("vote")) category = "elections";
  
  const yearMatch = filename.match(/20\d{2}|19\d{2}/);
  if (yearMatch) {
    year = yearMatch[0];
  }
  
  if (lower.includes("planning board")) board = "Planning Board";
  else if (lower.includes("school board")) board = "School Board";
  else if (lower.includes("select board") || lower.includes("selectboard")) board = "Select Board";
  else if (lower.includes("zoning board") || lower.includes("zba")) board = "Zoning Board of Adjustment";
  else if (lower.includes("conservation")) board = "Conservation Commission";
  else if (lower.includes("bos") || lower.includes("selectmen")) board = "Board of Selectmen";
  else if (lower.includes("budget committee")) board = "Budget Committee";
  
  // Try to extract date from filename for minutes
  let meetingDate: string | null = null;
  if (isMinutes) {
    const dateMatch = filename.match(/(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})/);
    if (dateMatch) {
      let [, month, day, yearPart] = dateMatch;
      if (yearPart.length === 2) {
        yearPart = yearPart.startsWith("9") ? `19${yearPart}` : `20${yearPart}`;
      }
      meetingDate = `${yearPart}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
    }
  }
  
  return {
    category,
    town,
    board,
    year,
    notes: "",
    isMinutes,
    meetingDate,
    meetingType: null,
    rawDateText: null,
  };
}

export function validateMetadata(metadata: Partial<SuggestedMetadata>): SuggestedMetadata {
  const category = ALLOWED_CATEGORIES.includes(metadata.category as any)
    ? metadata.category as typeof ALLOWED_CATEGORIES[number]
    : "misc_other";

  const isMinutes = Boolean(metadata.isMinutes);
  
  return {
    category: isMinutes ? "meeting_minutes" : category,
    town: typeof metadata.town === "string" ? metadata.town.trim() : "",
    board: typeof metadata.board === "string" ? metadata.board.trim() : "",
    year: typeof metadata.year === "string" ? metadata.year.trim() : "",
    notes: typeof metadata.notes === "string" ? metadata.notes.trim().slice(0, 200) : "",
    isMinutes,
    meetingDate: typeof metadata.meetingDate === "string" ? metadata.meetingDate : null,
    meetingType: typeof metadata.meetingType === "string" ? metadata.meetingType : null,
    rawDateText: typeof metadata.rawDateText === "string" ? metadata.rawDateText : null,
  };
}
