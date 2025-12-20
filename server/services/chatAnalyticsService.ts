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

  const prompt = `You are analyzing a chat conversation between a user and OPENCouncil, an AI assistant for New Hampshire municipal government officials.

Analyze this conversation transcript and provide:

1. **Summary** (2-3 sentences): A brief summary of what the user was asking about and the main topics discussed.

2. **Critique** (2-4 sentences): Evaluate the quality of OPENCouncil's responses. Were they helpful? Accurate? Did they properly cite sources? Were there any issues with the responses?

3. **Missing Documents Suggestions**: If the AI seemed to lack relevant information or gave generic answers, suggest what types of documents we should find and ingest to improve future responses. Be specific (e.g., "Conway Zoning Ordinance 2024", "Ossipee Planning Board meeting minutes from 2023"). If the responses were adequate, say "None identified."

4. **Document Quality Score** (1-10): Rate how well the AI used available documents. 10 = excellent citations and document use, 1 = no documents referenced or documents were irrelevant.

5. **Answer Quality Score** (1-10): Rate the overall quality of OPENCouncil's answers. 10 = perfectly helpful, accurate, well-cited, 1 = unhelpful, inaccurate, or potentially misleading.

TRANSCRIPT:
${transcript}

Respond in this exact JSON format:
{
  "summary": "...",
  "critique": "...",
  "missingDocsSuggestions": "...",
  "documentQualityScore": 7,
  "answerQualityScore": 8
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
