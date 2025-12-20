import { GoogleGenAI } from "@google/genai";
import { drizzle } from "drizzle-orm/neon-serverless";
import { Pool, neonConfig } from "@neondatabase/serverless";
import ws from "ws";
import { storage } from "../storage";
import { eq, desc, asc, sql } from "drizzle-orm";
import * as schema from "@shared/schema";
import type { ChatAnalytics } from "@shared/schema";

neonConfig.webSocketConstructor = ws;

let _db: ReturnType<typeof drizzle> | null = null;
function getDb() {
  if (!_db) {
    const pool = new Pool({ connectionString: process.env.DATABASE_URL });
    _db = drizzle({ client: pool, schema });
  }
  return _db;
}

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY || "" });

export interface ChatAnalyticsListItem {
  sessionId: string;
  title: string;
  userId: string | null;
  anonId: string | null;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  totalCost: number;
  costPerMessage: number;
  isAnalyzed: boolean;
  summary: string | null;
  critique: string | null;
  missingDocsSuggestions: string | null;
  documentQualityScore: number | null;
  answerQualityScore: number | null;
  analyzedAt: string | null;
}

export interface ChatAnalyticsListResult {
  items: ChatAnalyticsListItem[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

interface ListParams {
  page: number;
  pageSize: number;
  sortField: string;
  sortOrder: "asc" | "desc";
  search: string;
  filterAnalyzed?: boolean;
  filterMinDocScore: number;
  filterMaxDocScore: number;
  filterMinAnswerScore: number;
  filterMaxAnswerScore: number;
}

export async function getChatAnalyticsList(params: ListParams): Promise<ChatAnalyticsListResult> {
  const {
    page,
    pageSize,
    sortField,
    sortOrder,
    search,
    filterAnalyzed,
    filterMinDocScore,
    filterMaxDocScore,
    filterMinAnswerScore,
    filterMaxAnswerScore,
  } = params;

  const offset = (page - 1) * pageSize;

  const db = getDb();
  
  const sessionsWithStats = await db
    .select({
      session: schema.chatSessions,
      messageCount: sql<number>`(SELECT COUNT(*) FROM chat_messages WHERE session_id = ${schema.chatSessions.id})`.as('message_count'),
      totalCost: sql<number>`COALESCE((SELECT SUM(CAST(cost_usd AS FLOAT)) FROM llm_cost_logs WHERE session_id = ${schema.chatSessions.id}), 0)`.as('total_cost'),
    })
    .from(schema.chatSessions)
    .orderBy(sortOrder === "desc" ? desc(schema.chatSessions.updatedAt) : asc(schema.chatSessions.updatedAt))
    .execute();

  const allAnalytics = await db
    .select()
    .from(schema.chatAnalytics)
    .execute();

  const analyticsMap = new Map<string, typeof allAnalytics[0]>();
  for (const a of allAnalytics) {
    analyticsMap.set(a.sessionId, a);
  }

  let items: ChatAnalyticsListItem[] = sessionsWithStats.map(row => {
    const analytics = analyticsMap.get(row.session.id);
    const messageCount = Number(row.messageCount) || 0;
    const totalCost = Number(row.totalCost) || 0;
    return {
      sessionId: row.session.id,
      title: row.session.title,
      userId: row.session.userId,
      anonId: row.session.anonId,
      createdAt: row.session.createdAt.toISOString(),
      updatedAt: row.session.updatedAt.toISOString(),
      messageCount,
      totalCost,
      costPerMessage: messageCount > 0 ? totalCost / messageCount : 0,
      isAnalyzed: !!analytics,
      summary: analytics?.summary || null,
      critique: analytics?.critique || null,
      missingDocsSuggestions: analytics?.missingDocsSuggestions || null,
      documentQualityScore: analytics?.documentQualityScore || null,
      answerQualityScore: analytics?.answerQualityScore || null,
      analyzedAt: analytics?.analyzedAt?.toISOString() || null,
    };
  });

  if (search) {
    const lowerSearch = search.toLowerCase();
    items = items.filter(item =>
      item.title.toLowerCase().includes(lowerSearch) ||
      (item.summary && item.summary.toLowerCase().includes(lowerSearch)) ||
      (item.critique && item.critique.toLowerCase().includes(lowerSearch))
    );
  }

  if (filterAnalyzed !== undefined) {
    items = items.filter(item => item.isAnalyzed === filterAnalyzed);
  }

  items = items.filter(item => {
    if (item.documentQualityScore !== null) {
      if (item.documentQualityScore < filterMinDocScore || item.documentQualityScore > filterMaxDocScore) {
        return false;
      }
    }
    if (item.answerQualityScore !== null) {
      if (item.answerQualityScore < filterMinAnswerScore || item.answerQualityScore > filterMaxAnswerScore) {
        return false;
      }
    }
    return true;
  });

  const sortFn = (a: ChatAnalyticsListItem, b: ChatAnalyticsListItem) => {
    let aVal: any, bVal: any;
    switch (sortField) {
      case "date":
        aVal = new Date(a.updatedAt).getTime();
        bVal = new Date(b.updatedAt).getTime();
        break;
      case "cost":
        aVal = a.totalCost;
        bVal = b.totalCost;
        break;
      case "messages":
        aVal = a.messageCount;
        bVal = b.messageCount;
        break;
      case "docScore":
        aVal = a.documentQualityScore ?? -1;
        bVal = b.documentQualityScore ?? -1;
        break;
      case "answerScore":
        aVal = a.answerQualityScore ?? -1;
        bVal = b.answerQualityScore ?? -1;
        break;
      default:
        aVal = new Date(a.updatedAt).getTime();
        bVal = new Date(b.updatedAt).getTime();
    }
    if (sortOrder === "desc") {
      return bVal - aVal;
    }
    return aVal - bVal;
  };

  items.sort(sortFn);

  const total = items.length;
  const paginatedItems = items.slice(offset, offset + pageSize);

  return {
    items: paginatedItems,
    total,
    page,
    pageSize,
    totalPages: Math.ceil(total / pageSize),
  };
}

export async function analyzeChatSession(sessionId: string): Promise<ChatAnalytics> {
  const session = await storage.getChatSessionById(sessionId);
  if (!session) {
    throw new Error("Session not found");
  }

  const messages = await storage.getMessagesBySessionId(sessionId);
  if (messages.length === 0) {
    throw new Error("No messages in session");
  }

  const transcript = messages
    .map(m => `[${m.role.toUpperCase()}]: ${m.content}`)
    .join("\n\n");

  const prompt = `You are a HARSH CRITIC analyzing chat conversations between users and OPENCouncil, an AI assistant for New Hampshire municipal officials. Your job is to ruthlessly identify failures and gaps.

BE BRUTALLY HONEST. Do NOT sugarcoat or make excuses. If the AI failed, say so clearly.

SCORING GUIDELINES - BE STRICT:
- Score 1-3: FAILURE - AI couldn't answer, gave wrong info, no citations, or said "I don't have that document"
- Score 4-5: POOR - Generic advice without specific citations, vague responses, missing key details
- Score 6-7: ACCEPTABLE - Answered with some citations but incomplete or could be better
- Score 8-9: GOOD - Solid answer with proper citations and specific information
- Score 10: EXCEPTIONAL - Perfect response with comprehensive citations (rare)

AUTOMATIC LOW SCORES (1-3):
- If AI said "I don't have access to" or "I couldn't find" specific documents = Score 2-3 max
- If AI gave generic legal advice without citing specific NH RSAs or town ordinances = Score 3-4 max
- If AI failed to answer the user's actual question = Score 1-2
- If user asked for specific town info and AI gave general info = Score 3-4 max
- If response lacks ANY citations = Score 4 max for document quality

Analyze this conversation:

1. **Summary**: What did the user ask for? Did they get it? Be direct.

2. **Critique**: Be HARSH. What went wrong? What was missing? Don't praise mediocre responses. If the AI said it lacked documents, that's a FAILURE. If citations were missing, say so. If the answer was vague or generic, call it out. Only praise genuinely excellent responses.

3. **Missing Documents Suggestions**: CRITICAL - If the AI failed to provide specific information, LIST EXACTLY what documents we need to ingest. Be specific:
   - Town name + document type + year (e.g., "Ossipee Zoning Ordinance 2024")
   - Specific RSA chapters if legal questions went unanswered
   - Board meeting minutes with date ranges
   - Master plans, budgets, or other municipal documents
   DO NOT say "None identified" unless the response was truly complete and well-cited.

4. **Document Quality Score**: How well did the AI cite and use source documents? Remember: NO citations = max score of 4. Said "I don't have this document" = max score of 3.

5. **Answer Quality Score**: Did the user get what they actually needed? Generic advice = low score. Missing the user's actual question = very low score.

TRANSCRIPT:
${transcript}

Respond in this exact JSON format:
{
  "summary": "...",
  "critique": "...",
  "missingDocsSuggestions": "...",
  "documentQualityScore": 5,
  "answerQualityScore": 4
}`;

  try {
    const response = await ai.models.generateContent({
      model: "gemini-2.5-flash",
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      config: {
        responseMimeType: "application/json",
      },
    });

    const text = response.text || "";
    
    let parsed: {
      summary: string;
      critique: string;
      missingDocsSuggestions: string;
      documentQualityScore: number;
      answerQualityScore: number;
    };

    try {
      parsed = JSON.parse(text);
    } catch {
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        parsed = JSON.parse(jsonMatch[0]);
      } else {
        throw new Error("Failed to parse LLM response as JSON");
      }
    }

    const analytics = await storage.upsertChatAnalytics({
      sessionId,
      summary: parsed.summary,
      critique: parsed.critique,
      missingDocsSuggestions: parsed.missingDocsSuggestions || null,
      documentQualityScore: Math.min(10, Math.max(1, Math.round(parsed.documentQualityScore))),
      answerQualityScore: Math.min(10, Math.max(1, Math.round(parsed.answerQualityScore))),
    });

    return analytics;
  } catch (error) {
    console.error("Error analyzing chat session:", error);
    throw error;
  }
}

export async function batchAnalyzeSessions(sessionIds: string[]): Promise<{ sessionId: string; success: boolean; error?: string }[]> {
  const results: { sessionId: string; success: boolean; error?: string }[] = [];

  for (const sessionId of sessionIds) {
    try {
      await analyzeChatSession(sessionId);
      results.push({ sessionId, success: true });
    } catch (error) {
      results.push({
        sessionId,
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      });
    }
  }

  return results;
}
