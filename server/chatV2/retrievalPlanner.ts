import { GoogleGenAI } from "@google/genai";
import type { RouterOutput, RetrievalPlan } from "./types";

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY || "" });

const PLANNER_SYSTEM_PROMPT = `You are a retrieval planner for a municipal governance Q&A assistant in New Hampshire.

Given a complex municipal governance question and routing information, decide which document types to search and what information is needed.

Document categories available:
- budget: Town budgets, financial reports
- zoning: Zoning ordinances, maps, regulations
- meeting_minutes: Board/committee meeting minutes
- town_report: Annual town reports
- warrant_article: Town meeting warrant articles
- ordinance: Local ordinances and bylaws
- policy: Policies and procedures
- planning_board_docs: Planning board materials, site plans
- zba_docs: Zoning Board of Adjustment materials, variances
- licensing_permits: Licenses and permit information
- cip: Capital Improvement Plans
- elections: Election materials
- misc_other: Other documents

You MUST respond with valid JSON only:
{
  "filters": {
    "townPreference": "Town Name or null",
    "allowStatewideFallback": true | false,
    "categories": ["array of relevant categories"],
    "boards": ["Planning Board", "Select Board", etc.],
    "rsaChapters": ["RSA chapter numbers if relevant, e.g., '91-A', '673', '32']
  },
  "infoNeeds": ["plain-language description of what info to look for"]
}`;

interface PlanRetrievalOptions {
  question: string;
  routerOutput: RouterOutput;
  userHints?: { town?: string; board?: string };
}

export async function planRetrieval(
  options: PlanRetrievalOptions
): Promise<RetrievalPlan> {
  const { question, routerOutput, userHints } = options;

  const userPrompt = `Create a retrieval plan for this complex question:

Question: "${routerOutput.rerankedQuestion || question}"

Detected domains: ${routerOutput.domains.join(", ")}
${userHints?.town ? `Town hint: ${userHints.town}` : "No town specified"}
${userHints?.board ? `Board hint: ${userHints.board}` : "No board specified"}

Respond with valid JSON only.`;

  try {
    const response = await ai.models.generateContent({
      model: "gemini-2.5-flash",
      contents: [{ role: "user", parts: [{ text: userPrompt }] }],
      config: {
        systemInstruction: PLANNER_SYSTEM_PROMPT,
        temperature: 0.2,
      },
    });

    const responseText = response.text || "";
    const cleanedText = responseText
      .replace(/```json\n?/g, "")
      .replace(/```\n?/g, "")
      .trim();

    try {
      const parsed = JSON.parse(cleanedText);
      return {
        filters: {
          townPreference: parsed.filters?.townPreference || userHints?.town || undefined,
          allowStatewideFallback: parsed.filters?.allowStatewideFallback !== false,
          categories: Array.isArray(parsed.filters?.categories)
            ? parsed.filters.categories
            : routerOutput.domains,
          boards: Array.isArray(parsed.filters?.boards)
            ? parsed.filters.boards
            : userHints?.board
              ? [userHints.board]
              : [],
          rsaChapters: Array.isArray(parsed.filters?.rsaChapters)
            ? parsed.filters.rsaChapters
            : [],
        },
        infoNeeds: Array.isArray(parsed.infoNeeds)
          ? parsed.infoNeeds
          : ["General information about the topic"],
      };
    } catch (parseError) {
      console.error("Failed to parse planner response:", cleanedText);
      return getDefaultRetrievalPlan(routerOutput, userHints);
    }
  } catch (error) {
    console.error("Retrieval planner error:", error);
    return getDefaultRetrievalPlan(routerOutput, userHints);
  }
}

function getDefaultRetrievalPlan(
  routerOutput: RouterOutput,
  userHints?: { town?: string; board?: string }
): RetrievalPlan {
  return {
    filters: {
      townPreference: userHints?.town,
      allowStatewideFallback: true,
      categories: routerOutput.domains.length > 0 ? routerOutput.domains : ["misc_other"],
      boards: userHints?.board ? [userHints.board] : [],
      rsaChapters: [],
    },
    infoNeeds: ["General information about the topic"],
  };
}
