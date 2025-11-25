import { drizzle } from "drizzle-orm/neon-serverless";
import { eq, desc } from "drizzle-orm";
import { Pool, neonConfig } from "@neondatabase/serverless";
import ws from "ws";
import * as schema from "@shared/schema";
import type { 
  Admin,
  InsertAdmin,
  Document, 
  InsertDocument, 
  ChatSession, 
  InsertChatSession,
  ChatMessage,
  InsertChatMessage,
  TempUpload,
  InsertTempUpload
} from "@shared/schema";

// Configure WebSocket for Neon
neonConfig.webSocketConstructor = ws;

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const db = drizzle({ client: pool, schema });

export interface IStorage {
  // Admin operations
  createAdmin(admin: InsertAdmin): Promise<Admin>;
  getAdminByEmail(email: string): Promise<Admin | undefined>;

  // Document operations
  createDocument(doc: InsertDocument): Promise<Document>;
  getDocuments(): Promise<Document[]>;
  getDocumentById(id: string): Promise<Document | undefined>;
  deleteDocument(id: string): Promise<void>;

  // Chat session operations
  createChatSession(session: InsertChatSession): Promise<ChatSession>;
  getChatSessions(): Promise<ChatSession[]>;
  getChatSessionById(id: string): Promise<ChatSession | undefined>;
  updateChatSession(id: string, data: Partial<InsertChatSession>): Promise<void>;

  // Chat message operations
  createChatMessage(message: InsertChatMessage): Promise<ChatMessage>;
  getMessagesBySessionId(sessionId: string): Promise<ChatMessage[]>;

  // Temp upload operations
  createTempUpload(upload: InsertTempUpload): Promise<TempUpload>;
  getTempUploadById(id: string): Promise<TempUpload | undefined>;
  deleteTempUpload(id: string): Promise<void>;
}

export class DatabaseStorage implements IStorage {
  async createAdmin(admin: InsertAdmin): Promise<Admin> {
    const [result] = await db.insert(schema.admins).values(admin).returning();
    return result;
  }

  async getAdminByEmail(email: string): Promise<Admin | undefined> {
    const [result] = await db
      .select()
      .from(schema.admins)
      .where(eq(schema.admins.email, email));
    return result;
  }

  async createDocument(doc: InsertDocument): Promise<Document> {
    const [result] = await db.insert(schema.documents).values(doc).returning();
    return result;
  }

  async getDocuments(): Promise<Document[]> {
    return await db.select().from(schema.documents);
  }

  async getDocumentById(id: string): Promise<Document | undefined> {
    const [result] = await db
      .select()
      .from(schema.documents)
      .where(eq(schema.documents.id, id));
    return result;
  }

  async deleteDocument(id: string): Promise<void> {
    await db.delete(schema.documents).where(eq(schema.documents.id, id));
  }

  async createChatSession(session: InsertChatSession): Promise<ChatSession> {
    const [result] = await db.insert(schema.chatSessions).values(session).returning();
    return result;
  }

  async getChatSessions(): Promise<ChatSession[]> {
    return await db.select().from(schema.chatSessions).orderBy(desc(schema.chatSessions.updatedAt));
  }

  async getChatSessionById(id: string): Promise<ChatSession | undefined> {
    const [result] = await db
      .select()
      .from(schema.chatSessions)
      .where(eq(schema.chatSessions.id, id));
    return result;
  }

  async updateChatSession(id: string, data: Partial<InsertChatSession>): Promise<void> {
    await db
      .update(schema.chatSessions)
      .set({ ...data, updatedAt: new Date() })
      .where(eq(schema.chatSessions.id, id));
  }

  async createChatMessage(message: InsertChatMessage): Promise<ChatMessage> {
    const [result] = await db.insert(schema.chatMessages).values(message).returning();
    return result;
  }

  async getMessagesBySessionId(sessionId: string): Promise<ChatMessage[]> {
    return await db
      .select()
      .from(schema.chatMessages)
      .where(eq(schema.chatMessages.sessionId, sessionId));
  }

  async createTempUpload(upload: InsertTempUpload): Promise<TempUpload> {
    const [result] = await db.insert(schema.tempUploads).values(upload).returning();
    return result;
  }

  async getTempUploadById(id: string): Promise<TempUpload | undefined> {
    const [result] = await db
      .select()
      .from(schema.tempUploads)
      .where(eq(schema.tempUploads.id, id));
    return result;
  }

  async deleteTempUpload(id: string): Promise<void> {
    await db.delete(schema.tempUploads).where(eq(schema.tempUploads.id, id));
  }
}

export const storage = new DatabaseStorage();
