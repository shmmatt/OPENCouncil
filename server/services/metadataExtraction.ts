import { GoogleGenAI } from "@google/genai";
import type { DocumentMetadata, MetadataHints } from "@shared/schema";
import { ALLOWED_CATEGORIES, NH_TOWNS } from "@shared/schema";

const ai = new GoogleGenAI({ apiKey: process.env.GEM_API_KEY || "" });

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
// Special handling: "statewide" from LLM should NOT override specific town hints
export function finalizeTown(
  llmTown: string | undefined,
  hints: { defaultTown?: string; possibleTown?: string }
): string | undefined {
  const cleaned = llmTown?.trim().toLowerCase();
  
  // Special case: If LLM returns "statewide" but we have specific town hints,
  // prefer the hints (statewide is often a fallback guess)
  if (cleaned === "statewide") {
    // Check if we have more specific hints
    if (hints.possibleTown && hints.possibleTown !== "statewide") {
      return hints.possibleTown;
    }
    if (hints.defaultTown && hints.defaultTown !== "statewide") {
      return hints.defaultTown;
    }
    // No better hints, use statewide
    return "statewide";
  }
  
  // If LLM gave us a valid specific town, use it
  if (cleaned && cleaned.length > 0) {
    // Title case the town name
    return llmTown!.trim().split(/\s+/)
      .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
      .join(" ");
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

// Validate town name against NH_TOWNS list
export function isValidNHTown(town: string | undefined): boolean {
  if (!town) return false;
  const normalized = town.trim().toLowerCase();
  return NH_TOWNS.some(t => t.toLowerCase() === normalized);
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
    // Weekday-prefixed: "Monday, March 5, 2024" or "Monday March 5, 2024"
    /(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday),?\s+(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2}(?:st|nd|rd|th)?,?\s+\d{4}/i,
    // Full month name: March 5, 2024 or March 5th, 2024
    /(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2}(?:st|nd|rd|th)?,?\s+\d{4}/i,
    // Short month format: Mar 5, 2024
    /(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\.?\s+\d{1,2}(?:st|nd|rd|th)?,?\s+\d{4}/i,
    // European: 5 March 2024 or 5th March, 2024
    /\b\d{1,2}(?:st|nd|rd|th)?\s+(?:January|February|March|April|May|June|July|August|September|October|November|December),?\s+\d{4}\b/i,
    // MM/DD/YYYY or MM-DD-YYYY
    /\b\d{1,2}[\/\-]\d{1,2}[\/\-]\d{4}\b/,
    // YYYY-MM-DD (ISO format)
    /\b\d{4}-\d{2}-\d{2}\b/,
  ];

  // Approval/acceptance context: if any of these appear in the ~120 chars
  // immediately BEFORE a date match, the date is the approval date — not the
  // meeting date.  Skip it and look for the next date in the document.
  const APPROVAL_CONTEXT_RE = /approv|accept|ratif|minutes\s+were\s+(approved|accepted|ratified|adopted)|at\s+the\s+following|at\s+a\s+subsequent/i;

  // Search in first ~3000 chars, skipping dates that follow approval language
  const headerText = previewText.slice(0, 3000);
  let foundDate = false;
  for (let pi = 0; pi < datePatterns.length && !foundDate; pi++) {
    // Make pattern global so exec() iterates every occurrence, not just the first
    const globalPattern = new RegExp(datePatterns[pi].source, "gi");
    let match: RegExpExecArray | null;
    while ((match = globalPattern.exec(headerText)) !== null) {
      const matchStart = match.index;
      const contextWindow = headerText.slice(Math.max(0, matchStart - 120), matchStart);
      if (APPROVAL_CONTEXT_RE.test(contextWindow)) {
        // This date is preceded by approval/acceptance language — skip it
        continue;
      }
      possibleDateText = match[0];
      foundDate = true;
      break;
    }
    // If all occurrences of this pattern were in approval context, try the
    // next pattern.  If no pattern yields a clean date, possibleDateText
    // stays undefined and the LLM handles it.
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

  // Strip leading weekday prefix: "Monday, " or "Monday " before the month
  const weekdayStripped = dateText.trim().replace(
    /^(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday),?\s+/i, ""
  );
  const cleanedText = weekdayStripped.replace(/\./g, "");

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

  // Try "Month DD, YYYY" or "Month DD YYYY" format (with optional ordinal suffix)
  const monthNameMatch = cleanedText.match(/^([A-Za-z]+)\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})$/i);
  if (monthNameMatch) {
    const [, monthName, day, year] = monthNameMatch;
    const month = monthMap[monthName.toLowerCase()];
    if (month) {
      return `${year}-${month}-${day.padStart(2, "0")}`;
    }
  }

  // Try European "DD Month YYYY" or "DDth Month, YYYY" format
  const europeanMatch = cleanedText.match(/^(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]+),?\s+(\d{4})$/i);
  if (europeanMatch) {
    const [, day, monthName, year] = europeanMatch;
    const month = monthMap[monthName.toLowerCase()];
    if (month) {
      return `${year}-${month}-${day.padStart(2, "0")}`;
    }
  }

  return null;
}

/**
 * Check if heuristics are confident enough to skip LLM call
 */
function canSkipLlm(
  minutesHints: MinutesHeuristics,
  metadataHints: MetadataHints | undefined,
  filename: string
): boolean {
  // Need at least a town (from heuristics or admin hint)
  const hasTown = !!(minutesHints.possibleTown || metadataHints?.defaultTown);
  if (!hasTown) return false;
  
  // For meeting minutes with high confidence + town + board + date, skip LLM
  if (minutesHints.likelyMinutes && minutesHints.confidence === "high") {
    const hasBoard = !!(minutesHints.possibleBoard || metadataHints?.defaultBoard);
    const hasDate = !!minutesHints.possibleDateText;
    if (hasBoard && hasDate) {
      console.log(`[MetadataExtraction] Skipping LLM for ${filename} - high confidence heuristics`);
      return true;
    }
  }
  
  // For non-minutes, if we can infer category from filename and have town, skip
  const filenameCategory = inferMetadataFromFilename(filename);
  if (filenameCategory.category !== "misc_other" && hasTown) {
    // Categories that are obvious from filename
    const obviousCategories = ["budget", "zoning", "town_report", "warrant_article", "ordinance", "cip", "elections"];
    if (obviousCategories.includes(filenameCategory.category)) {
      console.log(`[MetadataExtraction] Skipping LLM for ${filename} - obvious category from filename`);
      return true;
    }
  }
  
  return false;
}

/**
 * Build metadata from heuristics only (no LLM call)
 */
function buildMetadataFromHeuristics(
  filename: string,
  minutesHints: MinutesHeuristics,
  metadataHints: MetadataHints | undefined
): SuggestedMetadata {
  const filenameMeta = inferMetadataFromFilename(filename);
  
  // Determine category
  let category = filenameMeta.category;
  if (minutesHints.likelyMinutes) {
    category = "meeting_minutes";
  }
  
  // Finalize town
  const town = minutesHints.possibleTown || metadataHints?.defaultTown || "";
  
  // Finalize board
  const board = minutesHints.possibleBoard || metadataHints?.defaultBoard || filenameMeta.board || "";
  
  // Parse date if available
  let meetingDate: string | null = null;
  if (minutesHints.possibleDateText) {
    meetingDate = parseDateToISO(minutesHints.possibleDateText);
  }
  
  return {
    category: category as typeof ALLOWED_CATEGORIES[number],
    town,
    board,
    year: filenameMeta.year,
    notes: "",
    isMinutes: minutesHints.likelyMinutes,
    meetingDate,
    meetingType: null, // Could enhance heuristics to detect this
    rawDateText: minutesHints.possibleDateText || null,
  };
}

export async function suggestMetadataFromPreview(
  filename: string,
  previewText: string,
  metadataHints?: MetadataHints
): Promise<SuggestedMetadata> {
  const categoryList = ALLOWED_CATEGORIES.join(", ");
  
  // Run heuristic pre-pass for minutes detection
  const minutesHints = detectMinutesHeuristics(filename, previewText);
  
  // Fast path: skip LLM if heuristics are confident enough
  if (canSkipLlm(minutesHints, metadataHints, filename)) {
    return buildMetadataFromHeuristics(filename, minutesHints, metadataHints);
  }
  
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
  
  const prompt = `You are an expert in New Hampshire municipal government documents.
Analyze the provided text, which represents the first ~1000 characters (the header and title area) of a municipal document.

Respond with ONLY valid JSON (no markdown, no code blocks, just pure JSON):

{
  "category": "...",
  "town": "...",
  "board": "...",
  "year": "...",
  "notes": "",
  "isMinutes": true/false,
  "meetingDate": "YYYY-MM-DD" or null,
  "meetingType": "regular" | "special" | "work_session" or null,
  "rawDateText": "original date text from document" or null
}

category MUST be one of:
${categoryList}

**BOARD — read only the document's main title or letterhead (first 1-3 lines):**
- The authoritative board name is whatever appears in the document title or letterhead at the very top.
- Choose from this standard list if it matches the intent: "Select Board", "Board of Selectmen", "Planning Board", "Zoning Board of Adjustment", "Conservation Commission", "Budget Committee", "School Board", "Library Board of Trustees", "Historic District Commission", "Recreation Commission", "Water & Sewer Commission".
- If the board is unlisted but clearly named, output that name cleanly.
- IGNORE any other board names mentioned in the text — ex-officio members, appeal notices ("The Selectmen have a right to appeal..."), or references to other boards' meetings do NOT identify this document's board.
- Do NOT return "Unknown", "Needs Review", or null if any board name appears in the title area.

**MEETING DATE — identify the date the meeting actually took place:**
- Look for the date immediately following the board title or "Meeting Minutes" heading.
- Any date that appears in an approval or acceptance context is NOT the meeting date. Common patterns to reject include: "Minutes Approved:", "Approved:", "Accepted:", "These minutes were approved at the [date] meeting", "approved/accepted at a subsequent meeting", "ratified at the [date] meeting", "at the following meeting", or "adopted at the [date] meeting". All of these indicate when a later meeting endorsed these minutes — ignore them entirely.
- Look past any approval or acceptance language to find the date this specific meeting was convened.
- Set rawDateText to the original date string you found (e.g., "March 3, 2026").
- meetingType: "regular", "special", or "work_session" based on any label in the header.

**TOWN — extract from the document title or letterhead:**
- Output only the town name (e.g., "Ossipee", "Conway") — never include "Town of".
- If hints provide a town and the header does not contradict it, use the hint.

**isMinutes:** true if the header contains "Meeting Minutes", "Minutes of", "Call to Order", or similar meeting records language.

${hintsSection.join("\n")}

Filename: ${filename}

Document Header Text (first ~1000 characters):
${previewText.slice(0, 1000)}`;

  try {
    const response = await ai.models.generateContent({
      model: "gemini-2.5-flash",
      contents: [{ role: "user", parts: [{ text: prompt }] }],
    });

    const responseText = response.text || "";
    
    // First, try to extract JSON object from the response
    // This handles cases where the LLM returns HTML, markdown, or other wrapper content
    let cleanedText = responseText
      .replace(/```json\n?/g, "")
      .replace(/```\n?/g, "")
      .trim();
    
    // If the response starts with HTML tags, try to extract JSON from it
    if (cleanedText.startsWith("<") || cleanedText.includes("<html") || cleanedText.includes("<ht")) {
      console.warn("LLM returned HTML-like content, attempting to extract JSON:", cleanedText.slice(0, 200));
      // Try to find a JSON object in the response
      const jsonMatch = cleanedText.match(/\{[\s\S]*?\}(?=\s*$|\s*<)/);
      if (jsonMatch) {
        cleanedText = jsonMatch[0];
      } else {
        // Strip all HTML tags and try again
        cleanedText = cleanedText.replace(/<[^>]*>/g, "").trim();
      }
    }
    
    // Try to find JSON object boundaries if there's extra content
    if (!cleanedText.startsWith("{")) {
      const jsonStart = cleanedText.indexOf("{");
      const jsonEnd = cleanedText.lastIndexOf("}");
      if (jsonStart !== -1 && jsonEnd !== -1 && jsonEnd > jsonStart) {
        cleanedText = cleanedText.slice(jsonStart, jsonEnd + 1);
      }
    }
    
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
      console.error("Failed to parse LLM response. Error:", parseError);
      console.error("Raw response text (first 500 chars):", responseText.slice(0, 500));
      console.error("Cleaned text (first 500 chars):", cleanedText.slice(0, 500));
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
