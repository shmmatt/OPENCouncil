/**
 * Chat sessions and messages storage operations
 */

import { db, schema, eq, desc, or } from "./db";
import type { 
  ChatSession, 
  InsertChatSession, 
  ChatMessage, 
  InsertChatMessage,
  ActorIdentifier,
  SituationContext,
  SessionSource,
} from "@shared/schema";

// ============================================================
// CHAT SESSIONS
// ============================================================

export async function createChatSession(session: InsertChatSession): Promise<ChatSession> {
  const [result] = await db.insert(schema.chatSessions).values(session).returning();
  return result;
}

export async function getChatSessions(actor?: ActorIdentifier): Promise<ChatSession[]> {
  if (!actor) {
    return [];
  }
  
  const conditions = [];
  
  if (actor.type === 'user' && actor.userId) {
    conditions.push(eq(schema.chatSessions.userId, actor.userId));
  }
  
  if (actor.anonId) {
    conditions.push(eq(schema.chatSessions.anonId, actor.anonId));
  }
  
  if (conditions.length === 0) {
    return [];
  }
  
  const whereClause = conditions.length === 1 ? conditions[0] : or(...conditions);
  
  return await db
    .select()
    .from(schema.chatSessions)
    .where(whereClause)
    .orderBy(desc(schema.chatSessions.updatedAt));
}

export async function getChatSessionById(id: string): Promise<ChatSession | undefined> {
  const [result] = await db
    .select()
    .from(schema.chatSessions)
    .where(eq(schema.chatSessions.id, id));
  return result;
}

export async function updateChatSession(id: string, data: Partial<InsertChatSession>): Promise<void> {
  await db
    .update(schema.chatSessions)
    .set({ ...data, updatedAt: new Date() })
    .where(eq(schema.chatSessions.id, id));
}

export async function getAllChatSessions(): Promise<ChatSession[]> {
  return await db
    .select()
    .from(schema.chatSessions)
    .orderBy(desc(schema.chatSessions.updatedAt));
}

// ============================================================
// CHAT MESSAGES
// ============================================================

export async function createChatMessage(message: InsertChatMessage): Promise<ChatMessage> {
  const [result] = await db.insert(schema.chatMessages).values(message).returning();
  
  // Update session's updatedAt timestamp
  await db
    .update(schema.chatSessions)
    .set({ updatedAt: new Date() })
    .where(eq(schema.chatSessions.id, message.sessionId));
  
  return result;
}

export async function getMessagesBySessionId(sessionId: string): Promise<ChatMessage[]> {
  return await db
    .select()
    .from(schema.chatMessages)
    .where(eq(schema.chatMessages.sessionId, sessionId))
    .orderBy(schema.chatMessages.createdAt);
}

// ============================================================
// SITUATION CONTEXT (topic continuity)
// ============================================================

export async function setSessionSituationContext(sessionId: string, context: SituationContext): Promise<void> {
  await db
    .update(schema.chatSessions)
    .set({ 
      situationContext: context,
      updatedAt: new Date(),
    })
    .where(eq(schema.chatSessions.id, sessionId));
}

export async function getSessionSituationContext(sessionId: string): Promise<SituationContext | null> {
  const [result] = await db
    .select({ situationContext: schema.chatSessions.situationContext })
    .from(schema.chatSessions)
    .where(eq(schema.chatSessions.id, sessionId));
  return result?.situationContext || null;
}

// ============================================================
// SESSION SOURCES (ephemeral user-provided content)
// ============================================================

export async function addSessionSource(sessionId: string, source: SessionSource, maxSources = 5): Promise<void> {
  const session = await getChatSessionById(sessionId);
  if (!session) return;
  
  const existingSources = session.sessionSources || [];
  const updatedSources = [...existingSources, source].slice(-maxSources);
  
  await db
    .update(schema.chatSessions)
    .set({ 
      sessionSources: updatedSources,
      updatedAt: new Date(),
    })
    .where(eq(schema.chatSessions.id, sessionId));
}

export async function getSessionSources(sessionId: string): Promise<SessionSource[]> {
  const [result] = await db
    .select({ sessionSources: schema.chatSessions.sessionSources })
    .from(schema.chatSessions)
    .where(eq(schema.chatSessions.id, sessionId));
  return result?.sessionSources || [];
}

export async function clearSessionSources(sessionId: string): Promise<void> {
  await db
    .update(schema.chatSessions)
    .set({ 
      sessionSources: [],
      updatedAt: new Date(),
    })
    .where(eq(schema.chatSessions.id, sessionId));
}

// ============================================================
// TOWN PREFERENCES (session-level)
// ============================================================

export async function setSessionTownPreference(sessionId: string, town: string): Promise<void> {
  await db
    .update(schema.chatSessions)
    .set({ 
      townPreference: town,
      updatedAt: new Date(),
    })
    .where(eq(schema.chatSessions.id, sessionId));
}

export async function getSessionTownPreference(sessionId: string): Promise<string | null> {
  const [result] = await db
    .select({ townPreference: schema.chatSessions.townPreference })
    .from(schema.chatSessions)
    .where(eq(schema.chatSessions.id, sessionId));
  return result?.townPreference || null;
}
