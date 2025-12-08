import { GoogleGenAI } from "@google/genai";
import type { DocumentMetadata, MetadataHints } from "@shared/schema";
import { ALLOWED_CATEGORIES, NH_TOWNS } from "@shared/schema";

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

// Enhanced town extraction from document text using multiple patterns
export function extractTownFromText(previewText: string): string | undefined {
  const lines = previewText.split(/\r?\n/).slice(0, 40);
  
  // Pattern 1: "TOWN OF OSSIPEE" format (most common in minutes)
  for (const line of lines) {
    const upper = line.toUpperCase();
    const m = upper.match(/TOWN\s+OF\s+([A-Z][A-Z\s]+)/);
    if (m) {
      let raw = m[1].trim();
      // Clean up - remove "NH", "NEW HAMPSHIRE", punctuation
      raw = raw
        .replace(/\bNEW\s*HAMPSHIRE\b/g, "")
        .replace(/\bNH\b/g, "")
        .replace(/[,\.\:]+$/g, "")
        .trim();
      
      // Title case
      const town = raw.toLowerCase().replace(/\s+/g, " ")
        .replace(/\b\w/g, (c) => c.toUpperCase());
      
      if (town && town.length > 2) {
        return town;
      }
    }
  }
  
  // Pattern 2: Known NH towns with context patterns
  const textLower = lines.join(" ").toLowerCase();
  
  for (const town of NH_TOWNS) {
    if (town === "statewide") continue;
    
    const townLower = town.toLowerCase();
    const patterns = [
      `town of ${townLower}`,
      `${townLower}, nh`,
      `${townLower}, new hampshire`,
      `${townLower} town hall`,
      `${townLower} planning board`,
      `${townLower} board of selectmen`,
      `${townLower} select board`,
      `${townLower} zoning board`,
      `${townLower} conservation`,
    ];
    
    for (const pattern of patterns) {
      if (textLower.includes(pattern)) {
        return town;
      }
    }
  }
  
  // Pattern 3: Check for state-level documents
  const statePatterns = [
    /state\s+of\s+new\s+hampshire/i,
    /new\s+hampshire\s+legislature/i,
    /nh\s+rsa/i,
    /new\s+hampshire\s+department/i,
    /state\s+agency/i,
  ];
  
  for (const pattern of statePatterns) {
    if (pattern.test(textLower)) {
      return "statewide";
    }
  }
  
  return undefined;
}

// Finalize town using fallback logic: LLM result > heuristic > default hint
export function finalizeTown(
  llmTown: string | undefined,
  hints: { defaultTown?: string; possibleTown?: string }
): string | undefined {
  const cleaned = llmTown?.trim();
  
  // If LLM gave us a valid town, use it
  if (cleaned && cleaned.length > 0) {
    return cleaned;
  }
  
  // Fall back to heuristic-detected town
  if (hints.possibleTown) {
    return hints.possibleTown;
  }
  
  // Fall back to admin-provided default
  if (hints.defaultTown) {
    return hints.defaultTown;
  }
  
  return undefined;
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
  const firstPageText = previewText.slice(0, 3000);
  
  let likelyMinutes = false;
  let confidence: "high" | "medium" | "low" = "low";
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

  // Use enhanced town extraction instead of basic patterns
  const possibleTown = extractTownFromText(previewText);

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
  previewText: string,
  metadataHints?: MetadataHints
): Promise<SuggestedMetadata> {
  const categoryList = ALLOWED_CATEGORIES.join(", ");
  
  // Run heuristic pre-pass for minutes detection
  const minutesHints = detectMinutesHeuristics(filename, previewText);
  
  // Build hints section for the LLM prompt
  const hintsSection = [];
  if (minutesHints.likelyMinutes) {
    hintsSection.push(`HINT: This document appears to be meeting minutes based on filename/text patterns.`);
  }
  if (minutesHints.possibleTown) {
    hintsSection.push(`HINT: Heuristic town detected from document text: "${minutesHints.possibleTown}" - USE THIS UNLESS TEXT CLEARLY CONTRADICTS IT.`);
  }
  if (metadataHints?.defaultTown) {
    hintsSection.push(`HINT: Admin-provided default town: "${metadataHints.defaultTown}" - USE THIS IF NO OTHER TOWN IS CLEARLY INDICATED IN THE DOCUMENT.`);
  }
  if (minutesHints.possibleBoard) {
    hintsSection.push(`HINT: Possible board detected: "${minutesHints.possibleBoard}"`);
  }
  if (metadataHints?.defaultBoard) {
    hintsSection.push(`HINT: Admin-provided default board: "${metadataHints.defaultBoard}" - USE THIS IF NO OTHER BOARD IS CLEARLY INDICATED.`);
  }
  if (minutesHints.possibleDateText) {
    hintsSection.push(`HINT: Possible meeting date detected: "${minutesHints.possibleDateText}"`);
  }
  
  const prompt = `You are extracting canonical metadata for New Hampshire municipal documents.

You are given:
- filename
- preview_text (first part of the document)
- hints.possibleTown (town name heuristically detected from the text, if any)
- hints.defaultTown (town chosen by the admin during upload, if any)

Respond with ONLY valid JSON (no markdown, no code blocks, just pure JSON):

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

**CRITICAL RULES FOR town:**
- If the document text contains phrases like "TOWN OF OSSIPEE", "Town of Ossipee, NH", "Ossipee, New Hampshire", you MUST set town to exactly "Ossipee" (just the town name, no "Town of" prefix).
- If hints.possibleTown is present (from heuristic detection), you MUST use that unless the document text clearly indicates a DIFFERENT town.
- If hints.defaultTown is present (from admin), and the text does not clearly indicate a different town name, you MUST set town to hints.defaultTown.
- Only use "statewide" if the document is clearly statewide (e.g., issued by the State of New Hampshire, NH RSA, state agency) and no specific town is indicated.
- Do NOT leave town empty if hints.defaultTown exists and there is no conflicting town name in the text.
- For NH towns, extract ONLY the town name (e.g., "Ossipee", "Conway", "Madison") - never include "Town of".

Other rules:
- Keep notes very short (under 100 characters)
- Year should be a 4-digit year if detectable, otherwise ""
- Board should be the name of the board/department (e.g., "Planning Board", "Board of Selectmen", "Zoning Board of Adjustment")

SPECIAL RULES FOR MEETING MINUTES:
- If this document appears to be official meeting minutes, set isMinutes: true AND category: "meeting_minutes"
- Meeting minutes typically have: "Meeting Minutes" in header, "Call to Order", "Roll Call", "Members Present", dates in header
- For minutes, extract the EXACT meeting date as meetingDate in ISO format (YYYY-MM-DD)
- Set rawDateText to the original date text you found (e.g., "March 5, 2024")
- meetingType: "regular" for regular meetings, "special" for special meetings, "work_session" for work sessions

${hintsSection.join("\n")}

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
      
      // Finalize town using fallback logic: LLM result > heuristic > admin default
      const llmTown = typeof parsed.town === "string" ? parsed.town.trim() : "";
      const finalTown = finalizeTown(llmTown, {
        possibleTown: minutesHints.possibleTown,
        defaultTown: metadataHints?.defaultTown,
      }) || "";
      
      // Finalize board similarly
      const llmBoard = typeof parsed.board === "string" ? parsed.board.trim() : "";
      const finalBoard = llmBoard || minutesHints.possibleBoard || metadataHints?.defaultBoard || "";
      
      return {
        category: finalCategory as typeof ALLOWED_CATEGORIES[number],
        town: finalTown,
        board: finalBoard,
        year: typeof parsed.year === "string" ? parsed.year : "",
        notes: typeof parsed.notes === "string" ? parsed.notes.slice(0, 200) : "",
        isMinutes,
        meetingDate,
        meetingType: typeof parsed.meetingType === "string" ? parsed.meetingType : null,
        rawDateText: typeof parsed.rawDateText === "string" ? parsed.rawDateText : null,
      };
    } catch (parseError) {
      console.error("Failed to parse LLM response:", cleanedText);
      // Even on parse failure, apply hints if available
      const fallback = inferMetadataFromFilename(filename);
      fallback.town = finalizeTown(fallback.town, {
        possibleTown: minutesHints.possibleTown,
        defaultTown: metadataHints?.defaultTown,
      }) || "";
      fallback.board = fallback.board || minutesHints.possibleBoard || metadataHints?.defaultBoard || "";
      return fallback;
    }
  } catch (error) {
    console.error("Error calling Gemini for metadata suggestion:", error);
    // Even on error, apply hints if available
    const fallback = inferMetadataFromFilename(filename);
    fallback.town = finalizeTown(fallback.town, {
      possibleTown: minutesHints.possibleTown,
      defaultTown: metadataHints?.defaultTown,
    }) || "";
    fallback.board = fallback.board || minutesHints.possibleBoard || metadataHints?.defaultBoard || "";
    return fallback;
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
