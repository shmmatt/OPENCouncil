import { drizzle } from "drizzle-orm/neon-serverless";
import { eq, desc, and, or } from "drizzle-orm";
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
  InsertTempUpload,
  FileBlob,
  InsertFileBlob,
  LogicalDocument,
  InsertLogicalDocument,
  DocumentVersion,
  InsertDocumentVersion,
  IngestionJob,
  InsertIngestionJob,
  IngestionJobStatus,
  IngestionJobWithBlob,
  DocumentVersionWithBlob,
  LogicalDocumentWithVersions
} from "@shared/schema";

neonConfig.webSocketConstructor = ws;

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const db = drizzle({ client: pool, schema });

export interface IStorage {
  // Admin operations
  createAdmin(admin: InsertAdmin): Promise<Admin>;
  getAdminByEmail(email: string): Promise<Admin | undefined>;

  // Legacy document operations (backwards compatibility)
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

  // v2 Pipeline: FileBlob operations
  createFileBlob(blob: InsertFileBlob): Promise<FileBlob>;
  getFileBlobById(id: string): Promise<FileBlob | undefined>;
  getFileBlobByRawHash(rawHash: string): Promise<FileBlob | undefined>;
  getFileBlobByPreviewHash(previewHash: string): Promise<FileBlob | undefined>;
  findDuplicateBlobs(rawHash: string, previewHash?: string): Promise<{ exact: FileBlob | null; preview: FileBlob | null }>;

  // v2 Pipeline: LogicalDocument operations
  createLogicalDocument(doc: InsertLogicalDocument): Promise<LogicalDocument>;
  getLogicalDocuments(): Promise<LogicalDocument[]>;
  getLogicalDocumentById(id: string): Promise<LogicalDocument | undefined>;
  getLogicalDocumentWithVersions(id: string): Promise<LogicalDocumentWithVersions | undefined>;
  updateLogicalDocument(id: string, data: Partial<InsertLogicalDocument>): Promise<void>;
  searchLogicalDocuments(query: { town?: string; category?: string; board?: string }): Promise<LogicalDocument[]>;

  // v2 Pipeline: DocumentVersion operations
  createDocumentVersion(version: InsertDocumentVersion): Promise<DocumentVersion>;
  getDocumentVersionById(id: string): Promise<DocumentVersion | undefined>;
  getDocumentVersionsByDocumentId(documentId: string): Promise<DocumentVersionWithBlob[]>;
  getCurrentVersionForDocument(documentId: string): Promise<DocumentVersionWithBlob | undefined>;
  setCurrentVersion(documentId: string, versionId: string): Promise<void>;
  getDocumentVersionByFileSearchName(fileSearchDocumentName: string): Promise<DocumentVersion | undefined>;

  // v2 Pipeline: IngestionJob operations
  createIngestionJob(job: InsertIngestionJob): Promise<IngestionJob>;
  getIngestionJobById(id: string): Promise<IngestionJob | undefined>;
  getIngestionJobWithBlob(id: string): Promise<IngestionJobWithBlob | undefined>;
  getIngestionJobsByStatus(status: IngestionJobStatus): Promise<IngestionJobWithBlob[]>;
  getAllIngestionJobs(): Promise<IngestionJobWithBlob[]>;
  updateIngestionJob(id: string, data: Partial<InsertIngestionJob>): Promise<void>;
  deleteIngestionJob(id: string): Promise<void>;
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
    return await db.select().from(schema.documents).orderBy(desc(schema.documents.createdAt));
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

  // v2 Pipeline: FileBlob operations
  async createFileBlob(blob: InsertFileBlob): Promise<FileBlob> {
    const [result] = await db.insert(schema.fileBlobs).values(blob).returning();
    return result;
  }

  async getFileBlobById(id: string): Promise<FileBlob | undefined> {
    const [result] = await db
      .select()
      .from(schema.fileBlobs)
      .where(eq(schema.fileBlobs.id, id));
    return result;
  }

  async getFileBlobByRawHash(rawHash: string): Promise<FileBlob | undefined> {
    const [result] = await db
      .select()
      .from(schema.fileBlobs)
      .where(eq(schema.fileBlobs.rawHash, rawHash));
    return result;
  }

  async getFileBlobByPreviewHash(previewHash: string): Promise<FileBlob | undefined> {
    const [result] = await db
      .select()
      .from(schema.fileBlobs)
      .where(eq(schema.fileBlobs.previewHash, previewHash));
    return result;
  }

  async findDuplicateBlobs(rawHash: string, previewHash?: string): Promise<{ exact: FileBlob | null; preview: FileBlob | null }> {
    const exactMatch = await this.getFileBlobByRawHash(rawHash);
    let previewMatch: FileBlob | undefined;
    
    if (previewHash && !exactMatch) {
      previewMatch = await this.getFileBlobByPreviewHash(previewHash);
    }
    
    return {
      exact: exactMatch || null,
      preview: previewMatch || null,
    };
  }

  // v2 Pipeline: LogicalDocument operations
  async createLogicalDocument(doc: InsertLogicalDocument): Promise<LogicalDocument> {
    const [result] = await db.insert(schema.logicalDocuments).values(doc).returning();
    return result;
  }

  async getLogicalDocuments(): Promise<LogicalDocument[]> {
    return await db.select().from(schema.logicalDocuments).orderBy(desc(schema.logicalDocuments.updatedAt));
  }

  async getLogicalDocumentById(id: string): Promise<LogicalDocument | undefined> {
    const [result] = await db
      .select()
      .from(schema.logicalDocuments)
      .where(eq(schema.logicalDocuments.id, id));
    return result;
  }

  async getLogicalDocumentWithVersions(id: string): Promise<LogicalDocumentWithVersions | undefined> {
    const doc = await this.getLogicalDocumentById(id);
    if (!doc) return undefined;

    const versions = await this.getDocumentVersionsByDocumentId(id);
    const currentVersion = versions.find(v => v.isCurrent);

    return {
      ...doc,
      versions,
      currentVersion,
    };
  }

  async updateLogicalDocument(id: string, data: Partial<InsertLogicalDocument>): Promise<void> {
    await db
      .update(schema.logicalDocuments)
      .set({ ...data, updatedAt: new Date() })
      .where(eq(schema.logicalDocuments.id, id));
  }

  async searchLogicalDocuments(query: { town?: string; category?: string; board?: string }): Promise<LogicalDocument[]> {
    let conditions = [];
    
    if (query.town) {
      conditions.push(eq(schema.logicalDocuments.town, query.town));
    }
    if (query.category) {
      conditions.push(eq(schema.logicalDocuments.category, query.category));
    }
    if (query.board) {
      conditions.push(eq(schema.logicalDocuments.board, query.board));
    }

    if (conditions.length === 0) {
      return this.getLogicalDocuments();
    }

    return await db
      .select()
      .from(schema.logicalDocuments)
      .where(and(...conditions))
      .orderBy(desc(schema.logicalDocuments.updatedAt));
  }

  // v2 Pipeline: DocumentVersion operations
  async createDocumentVersion(version: InsertDocumentVersion): Promise<DocumentVersion> {
    const [result] = await db.insert(schema.documentVersions).values(version).returning();
    return result;
  }

  async getDocumentVersionById(id: string): Promise<DocumentVersion | undefined> {
    const [result] = await db
      .select()
      .from(schema.documentVersions)
      .where(eq(schema.documentVersions.id, id));
    return result;
  }

  async getDocumentVersionsByDocumentId(documentId: string): Promise<DocumentVersionWithBlob[]> {
    const versions = await db
      .select()
      .from(schema.documentVersions)
      .where(eq(schema.documentVersions.documentId, documentId))
      .orderBy(desc(schema.documentVersions.createdAt));

    const result: DocumentVersionWithBlob[] = [];
    for (const version of versions) {
      const blob = await this.getFileBlobById(version.fileBlobId);
      if (blob) {
        result.push({ ...version, fileBlob: blob });
      }
    }
    return result;
  }

  async getCurrentVersionForDocument(documentId: string): Promise<DocumentVersionWithBlob | undefined> {
    const [version] = await db
      .select()
      .from(schema.documentVersions)
      .where(and(
        eq(schema.documentVersions.documentId, documentId),
        eq(schema.documentVersions.isCurrent, true)
      ));

    if (!version) return undefined;

    const blob = await this.getFileBlobById(version.fileBlobId);
    if (!blob) return undefined;

    return { ...version, fileBlob: blob };
  }

  async setCurrentVersion(documentId: string, versionId: string): Promise<void> {
    // First, unset current flag on all versions for this document
    await db
      .update(schema.documentVersions)
      .set({ isCurrent: false })
      .where(eq(schema.documentVersions.documentId, documentId));

    // Then set the new current version
    await db
      .update(schema.documentVersions)
      .set({ isCurrent: true })
      .where(eq(schema.documentVersions.id, versionId));

    // Update the logical document's currentVersionId
    await db
      .update(schema.logicalDocuments)
      .set({ currentVersionId: versionId, updatedAt: new Date() })
      .where(eq(schema.logicalDocuments.id, documentId));
  }

  async getDocumentVersionByFileSearchName(fileSearchDocumentName: string): Promise<DocumentVersion | undefined> {
    const [result] = await db
      .select()
      .from(schema.documentVersions)
      .where(eq(schema.documentVersions.fileSearchDocumentName, fileSearchDocumentName));
    return result;
  }

  // v2 Pipeline: IngestionJob operations
  async createIngestionJob(job: InsertIngestionJob): Promise<IngestionJob> {
    const [result] = await db.insert(schema.ingestionJobs).values(job).returning();
    return result;
  }

  async getIngestionJobById(id: string): Promise<IngestionJob | undefined> {
    const [result] = await db
      .select()
      .from(schema.ingestionJobs)
      .where(eq(schema.ingestionJobs.id, id));
    return result;
  }

  async getIngestionJobWithBlob(id: string): Promise<IngestionJobWithBlob | undefined> {
    const job = await this.getIngestionJobById(id);
    if (!job) return undefined;

    const blob = await this.getFileBlobById(job.fileBlobId);
    if (!blob) return undefined;

    return { ...job, fileBlob: blob };
  }

  async getIngestionJobsByStatus(status: IngestionJobStatus): Promise<IngestionJobWithBlob[]> {
    const jobs = await db
      .select()
      .from(schema.ingestionJobs)
      .where(eq(schema.ingestionJobs.status, status))
      .orderBy(desc(schema.ingestionJobs.createdAt));

    const result: IngestionJobWithBlob[] = [];
    for (const job of jobs) {
      const blob = await this.getFileBlobById(job.fileBlobId);
      if (blob) {
        result.push({ ...job, fileBlob: blob });
      }
    }
    return result;
  }

  async getAllIngestionJobs(): Promise<IngestionJobWithBlob[]> {
    const jobs = await db
      .select()
      .from(schema.ingestionJobs)
      .orderBy(desc(schema.ingestionJobs.createdAt));

    const result: IngestionJobWithBlob[] = [];
    for (const job of jobs) {
      const blob = await this.getFileBlobById(job.fileBlobId);
      if (blob) {
        result.push({ ...job, fileBlob: blob });
      }
    }
    return result;
  }

  async updateIngestionJob(id: string, data: Partial<InsertIngestionJob>): Promise<void> {
    await db
      .update(schema.ingestionJobs)
      .set({ ...data, updatedAt: new Date() })
      .where(eq(schema.ingestionJobs.id, id));
  }

  async deleteIngestionJob(id: string): Promise<void> {
    await db.delete(schema.ingestionJobs).where(eq(schema.ingestionJobs.id, id));
  }
}

export const storage = new DatabaseStorage();
