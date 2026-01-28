/**
 * Analytics, events, and cost logging storage operations
 */

import { db, schema, eq, and, gte, sql } from "./db";
import type { 
  LlmCostLog, 
  InsertLlmCostLog,
  Event,
  InsertEvent,
  ChatAnalytics,
  InsertChatAnalytics,
} from "@shared/schema";

// ============================================================
// LLM COST LOGGING
// ============================================================

export async function createLlmCostLog(log: InsertLlmCostLog): Promise<LlmCostLog> {
  const [result] = await db.insert(schema.llmCostLogs).values(log).returning();
  return result;
}

export async function getDailyCostByUser(userId: string): Promise<number> {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  
  const result = await db
    .select({ total: sql<string>`COALESCE(SUM(cost_usd), 0)` })
    .from(schema.llmCostLogs)
    .where(and(
      eq(schema.llmCostLogs.userId, userId),
      gte(schema.llmCostLogs.createdAt, today)
    ));
  
  return parseFloat(result[0]?.total || '0');
}

export async function getDailyCostByAnon(anonId: string): Promise<number> {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  
  const result = await db
    .select({ total: sql<string>`COALESCE(SUM(cost_usd), 0)` })
    .from(schema.llmCostLogs)
    .where(and(
      eq(schema.llmCostLogs.anonId, anonId),
      gte(schema.llmCostLogs.createdAt, today)
    ));
  
  return parseFloat(result[0]?.total || '0');
}

// ============================================================
// EVENTS
// ============================================================

export async function createEvent(event: InsertEvent): Promise<Event> {
  const [result] = await db.insert(schema.events).values(event).returning();
  return result;
}

// ============================================================
// CHAT ANALYTICS
// ============================================================

export async function createChatAnalytics(analytics: InsertChatAnalytics): Promise<ChatAnalytics> {
  const [result] = await db.insert(schema.chatAnalytics).values(analytics).returning();
  return result;
}

export async function getChatAnalyticsBySessionId(sessionId: string): Promise<ChatAnalytics | undefined> {
  const [result] = await db
    .select()
    .from(schema.chatAnalytics)
    .where(eq(schema.chatAnalytics.sessionId, sessionId));
  return result;
}

export async function upsertChatAnalytics(analytics: InsertChatAnalytics): Promise<ChatAnalytics> {
  const existing = await getChatAnalyticsBySessionId(analytics.sessionId);
  
  if (existing) {
    await db
      .update(schema.chatAnalytics)
      .set({
        summary: analytics.summary,
        critique: analytics.critique,
        missingDocsSuggestions: analytics.missingDocsSuggestions,
        documentQualityScore: analytics.documentQualityScore,
        answerQualityScore: analytics.answerQualityScore,
        analyzedAt: new Date(),
      })
      .where(eq(schema.chatAnalytics.sessionId, analytics.sessionId));
    
    return (await getChatAnalyticsBySessionId(analytics.sessionId))!;
  } else {
    return createChatAnalytics(analytics);
  }
}
