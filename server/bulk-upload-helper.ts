import { GoogleGenAI } from "@google/genai";
import * as fs from "fs/promises";
import * as path from "path";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const pdfParse = require("pdf-parse");

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY || "" });

const ALLOWED_CATEGORIES = [
  "budget", "zoning", "meeting_minutes", "town_report", "warrant_article",
  "ordinance", "policy", "planning_board_docs", "zba_docs", "licensing_permits",
  "cip", "elections", "misc_other"
] as const;

export interface SuggestedMetadata {
  category: string;
  town: string;
  board: string;
  year: string;
  notes: string;
}

export async function extractPreviewText(filePath: string, filename: string): Promise<string> {
  const ext = path.extname(filename).toLowerCase();
  
  try {
    if (ext === ".pdf") {
      const dataBuffer = await fs.readFile(filePath);
      const pdfData = await pdfParse(dataBuffer, {
        max: 5,
      });
      const text = pdfData.text.slice(0, 15000);
      return text;
    } else if (ext === ".txt") {
      const text = await fs.readFile(filePath, "utf-8");
      return text.slice(0, 15000);
    } else if (ext === ".docx") {
      return "";
    }
    
    return "";
  } catch (error) {
    console.error(`Error extracting text from ${filename}:`, error);
    return "";
  }
}

export async function suggestMetadataFromContent(
  filename: string, 
  preview: string
): Promise<SuggestedMetadata> {
  const categoryList = ALLOWED_CATEGORIES.join(", ");
  
  const prompt = `You classify municipal government documents from New Hampshire.
Read the filename and text below and respond with ONLY valid JSON (no markdown, no code blocks, just pure JSON):

{
  "category": "...",
  "town": "...",
  "board": "...",
  "year": "...",
  "notes": "..."
}

category MUST be one of:
${categoryList}

Rules:
- If document is statewide (laws, handbooks, state guidance) use: "town": "statewide"
- Keep notes very short (under 100 characters)
- If you cannot determine a field, use an empty string ""
- Year should be a 4-digit year if detectable, otherwise ""
- Board should be the name of the board/department if mentioned (e.g., "Planning Board", "Zoning Board", "School Board")

Filename: ${filename}

Document Preview Text:
${preview.slice(0, 10000)}`;

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
      
      return {
        category: validCategory,
        town: typeof parsed.town === "string" ? parsed.town : "",
        board: typeof parsed.board === "string" ? parsed.board : "",
        year: typeof parsed.year === "string" ? parsed.year : "",
        notes: typeof parsed.notes === "string" ? parsed.notes.slice(0, 200) : "",
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

function inferMetadataFromFilename(filename: string): SuggestedMetadata {
  const lower = filename.toLowerCase();
  let category = "misc_other";
  let year = "";
  let town = "";
  let board = "";
  
  if (lower.includes("budget")) category = "budget";
  else if (lower.includes("zoning")) category = "zoning";
  else if (lower.includes("minutes") || lower.includes("meeting")) category = "meeting_minutes";
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
  
  return {
    category,
    town,
    board,
    year,
    notes: "",
  };
}
