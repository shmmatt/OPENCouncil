import { drizzle } from "drizzle-orm/neon-serverless";
import { eq, desc, asc, and, or, gte, sql } from "drizzle-orm";
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
  LogicalDocumentWithVersions,
  User,
  InsertUser,
  UserIdentity,
  InsertUserIdentity,
  AnonymousUser,
  InsertAnonymousUser,
  LlmCostLog,
  InsertLlmCostLog,
  Event,
  InsertEvent,
  MinutesUpdateItem,
  ActorIdentifier,
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
  getLogicalDocumentByTitle(title: string): Promise<LogicalDocument | undefined>;

  // v2 Pipeline: IngestionJob operations
  createIngestionJob(job: InsertIngestionJob): Promise<IngestionJob>;
  getIngestionJobById(id: string): Promise<IngestionJob | undefined>;
  getIngestionJobWithBlob(id: string): Promise<IngestionJobWithBlob | undefined>;
  getIngestionJobsByStatus(status: IngestionJobStatus): Promise<IngestionJobWithBlob[]>;
  getAllIngestionJobs(): Promise<IngestionJobWithBlob[]>;
  updateIngestionJob(id: string, data: Partial<InsertIngestionJob>): Promise<void>;
  deleteIngestionJob(id: string): Promise<void>;

  // Identity Spine: User operations
  createUser(user: InsertUser): Promise<User>;
  getUserById(id: string): Promise<User | undefined>;
  updateUser(id: string, data: Partial<InsertUser>): Promise<void>;
  updateUserLastLogin(id: string): Promise<void>;

  // Identity Spine: User Identity operations
  createUserIdentity(identity: InsertUserIdentity): Promise<UserIdentity>;
  getUserIdentityByProviderKey(provider: string, providerKey: string): Promise<UserIdentity | undefined>;
  getUserIdentitiesByUserId(userId: string): Promise<UserIdentity[]>;

  // Identity Spine: Anonymous User operations
  createAnonymousUser(anonUser: InsertAnonymousUser): Promise<AnonymousUser>;
  getAnonymousUserById(id: string): Promise<AnonymousUser | undefined>;
  updateAnonymousUserLastSeen(id: string): Promise<void>;
  linkAnonymousUserToUser(anonId: string, userId: string): Promise<void>;

  // LLM Cost Log operations
  createLlmCostLog(log: InsertLlmCostLog): Promise<LlmCostLog>;
  getDailyCostByUser(userId: string): Promise<number>;
  getDailyCostByAnon(anonId: string): Promise<number>;

  // Event operations
  createEvent(event: InsertEvent): Promise<Event>;

  // Town preference operations
  getAvailableTowns(): Promise<string[]>;
  setActorDefaultTown(actor: ActorIdentifier, town: string): Promise<void>;
  getActorDefaultTown(actor: ActorIdentifier): Promise<string | null>;
  setSessionTownPreference(sessionId: string, town: string): Promise<void>;
  getSessionTownPreference(sessionId: string): Promise<string | null>;

  // Recent minutes updates
  getRecentMinutesUpdates(params: { town: string; limit?: number }): Promise<MinutesUpdateItem[]>;
  getRecentMinutesUpdatesAdmin(params: { town?: string; board?: string; limit?: number }): Promise<MinutesUpdateItem[]>;
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
      .where(eq(schema.chatMessages.sessionId, sessionId))
      .orderBy(asc(schema.chatMessages.createdAt));
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
    console.log(`[getDocumentVersionByFileSearchName] Looking up: "${fileSearchDocumentName}"`);
    
    // Strategy 1: Try exact match on fileSearchDocumentName
    const [exactMatch] = await db
      .select()
      .from(schema.documentVersions)
      .where(eq(schema.documentVersions.fileSearchDocumentName, fileSearchDocumentName));
    if (exactMatch) {
      console.log(`[getDocumentVersionByFileSearchName] Found exact match on fileSearchDocumentName: ${exactMatch.id}`);
      return exactMatch;
    }

    // Strategy 2: Try exact match on geminiDisplayName (Gemini often returns displayName as title)
    const [displayNameMatch] = await db
      .select()
      .from(schema.documentVersions)
      .where(eq(schema.documentVersions.geminiDisplayName, fileSearchDocumentName));
    if (displayNameMatch) {
      console.log(`[getDocumentVersionByFileSearchName] Found exact match on geminiDisplayName: ${displayNameMatch.id}`);
      return displayNameMatch;
    }

    // Strategy 3: Try LIKE query - check if the passed ID is contained within fileSearchDocumentName
    const [likeMatch] = await db
      .select()
      .from(schema.documentVersions)
      .where(sql`${schema.documentVersions.fileSearchDocumentName} LIKE ${'%' + fileSearchDocumentName + '%'}`);
    if (likeMatch) {
      console.log(`[getDocumentVersionByFileSearchName] Found LIKE match on fileSearchDocumentName: ${likeMatch.id}`);
      return likeMatch;
    }

    // Strategy 4: Try LIKE match on geminiDisplayName (partial match)
    const [displayNameLikeMatch] = await db
      .select()
      .from(schema.documentVersions)
      .where(sql`${schema.documentVersions.geminiDisplayName} LIKE ${'%' + fileSearchDocumentName + '%'}`);
    if (displayNameLikeMatch) {
      console.log(`[getDocumentVersionByFileSearchName] Found LIKE match on geminiDisplayName: ${displayNameLikeMatch.id}`);
      return displayNameLikeMatch;
    }

    // Strategy 5: Try reverse LIKE - geminiDisplayName contains the search term
    const [reverseLikeMatch] = await db
      .select()
      .from(schema.documentVersions)
      .where(sql`${fileSearchDocumentName} LIKE '%' || ${schema.documentVersions.geminiDisplayName} || '%'`);
    if (reverseLikeMatch) {
      console.log(`[getDocumentVersionByFileSearchName] Found reverse LIKE match on geminiDisplayName: ${reverseLikeMatch.id}`);
      return reverseLikeMatch;
    }

    // Strategy 6: Try to extract hash from the passed ID and match partial
    const hashPart = fileSearchDocumentName.includes('/') 
      ? fileSearchDocumentName.split('/').pop() 
      : fileSearchDocumentName;
    
    if (hashPart && hashPart !== fileSearchDocumentName) {
      const [hashMatch] = await db
        .select()
        .from(schema.documentVersions)
        .where(sql`${schema.documentVersions.fileSearchDocumentName} LIKE ${'%' + hashPart + '%'}`);
      if (hashMatch) {
        console.log(`[getDocumentVersionByFileSearchName] Found hash match: ${hashMatch.id}`);
        return hashMatch;
      }
    }

    console.log(`[getDocumentVersionByFileSearchName] No match found for: "${fileSearchDocumentName}"`);
    return undefined;
  }

  async getLogicalDocumentByTitle(title: string): Promise<LogicalDocument | undefined> {
    // Try exact match first
    const [exactMatch] = await db
      .select()
      .from(schema.logicalDocuments)
      .where(eq(schema.logicalDocuments.canonicalTitle, title));
    if (exactMatch) return exactMatch;

    // Try LIKE match for partial title matching (displayName may have prefix like [Ossipee - Board])
    const [likeMatch] = await db
      .select()
      .from(schema.logicalDocuments)
      .where(sql`${schema.logicalDocuments.canonicalTitle} LIKE ${'%' + title + '%'}`);
    if (likeMatch) return likeMatch;

    // Try reverse LIKE - title contains the canonicalTitle
    const [reverseLikeMatch] = await db
      .select()
      .from(schema.logicalDocuments)
      .where(sql`${title} LIKE '%' || ${schema.logicalDocuments.canonicalTitle} || '%'`);
    if (reverseLikeMatch) return reverseLikeMatch;

    return undefined;
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

  // Identity Spine: User operations
  async createUser(user: InsertUser): Promise<User> {
    const [result] = await db.insert(schema.users).values(user).returning();
    return result;
  }

  async getUserById(id: string): Promise<User | undefined> {
    const [result] = await db
      .select()
      .from(schema.users)
      .where(eq(schema.users.id, id));
    return result;
  }

  async updateUser(id: string, data: Partial<InsertUser>): Promise<void> {
    await db
      .update(schema.users)
      .set(data)
      .where(eq(schema.users.id, id));
  }

  async updateUserLastLogin(id: string): Promise<void> {
    await db
      .update(schema.users)
      .set({ lastLoginAt: new Date() })
      .where(eq(schema.users.id, id));
  }

  // Identity Spine: User Identity operations
  async createUserIdentity(identity: InsertUserIdentity): Promise<UserIdentity> {
    const [result] = await db.insert(schema.userIdentities).values(identity).returning();
    return result;
  }

  async getUserIdentityByProviderKey(provider: string, providerKey: string): Promise<UserIdentity | undefined> {
    const [result] = await db
      .select()
      .from(schema.userIdentities)
      .where(and(
        eq(schema.userIdentities.provider, provider),
        eq(schema.userIdentities.providerKey, providerKey)
      ));
    return result;
  }

  async getUserIdentitiesByUserId(userId: string): Promise<UserIdentity[]> {
    return await db
      .select()
      .from(schema.userIdentities)
      .where(eq(schema.userIdentities.userId, userId));
  }

  // Identity Spine: Anonymous User operations
  async createAnonymousUser(anonUser: InsertAnonymousUser): Promise<AnonymousUser> {
    const [result] = await db.insert(schema.anonymousUsers).values(anonUser).returning();
    return result;
  }

  async getAnonymousUserById(id: string): Promise<AnonymousUser | undefined> {
    const [result] = await db
      .select()
      .from(schema.anonymousUsers)
      .where(eq(schema.anonymousUsers.id, id));
    return result;
  }

  async updateAnonymousUserLastSeen(id: string): Promise<void> {
    await db
      .update(schema.anonymousUsers)
      .set({ lastSeenAt: new Date() })
      .where(eq(schema.anonymousUsers.id, id));
  }

  async linkAnonymousUserToUser(anonId: string, userId: string): Promise<void> {
    await db
      .update(schema.anonymousUsers)
      .set({ userId })
      .where(eq(schema.anonymousUsers.id, anonId));
  }

  // LLM Cost Log operations
  async createLlmCostLog(log: InsertLlmCostLog): Promise<LlmCostLog> {
    const [result] = await db.insert(schema.llmCostLogs).values(log).returning();
    return result;
  }

  async getDailyCostByUser(userId: string): Promise<number> {
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);
    
    const result = await db
      .select({ total: sql<string>`COALESCE(SUM(${schema.llmCostLogs.costUsd}), 0)` })
      .from(schema.llmCostLogs)
      .where(and(
        eq(schema.llmCostLogs.userId, userId),
        gte(schema.llmCostLogs.createdAt, startOfDay)
      ));
    
    return parseFloat(result[0]?.total || "0");
  }

  async getDailyCostByAnon(anonId: string): Promise<number> {
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);
    
    const result = await db
      .select({ total: sql<string>`COALESCE(SUM(${schema.llmCostLogs.costUsd}), 0)` })
      .from(schema.llmCostLogs)
      .where(and(
        eq(schema.llmCostLogs.anonId, anonId),
        gte(schema.llmCostLogs.createdAt, startOfDay)
      ));
    
    return parseFloat(result[0]?.total || "0");
  }

  // Event operations
  async createEvent(event: InsertEvent): Promise<Event> {
    const [result] = await db.insert(schema.events).values(event).returning();
    return result;
  }

  // Town preference operations
  async getAvailableTowns(): Promise<string[]> {
    // Currently only Ossipee is active
    return ["Ossipee"];
  }

  async setActorDefaultTown(actor: ActorIdentifier, town: string): Promise<void> {
    if (actor.type === 'user' && actor.userId) {
      await db
        .update(schema.users)
        .set({ defaultTown: town })
        .where(eq(schema.users.id, actor.userId));
    } else if (actor.type === 'anon' && actor.anonId) {
      await db
        .update(schema.anonymousUsers)
        .set({ defaultTown: town })
        .where(eq(schema.anonymousUsers.id, actor.anonId));
    }
  }

  async getActorDefaultTown(actor: ActorIdentifier): Promise<string | null> {
    if (actor.type === 'user' && actor.userId) {
      const [user] = await db
        .select({ defaultTown: schema.users.defaultTown })
        .from(schema.users)
        .where(eq(schema.users.id, actor.userId));
      return user?.defaultTown || null;
    } else if (actor.type === 'anon' && actor.anonId) {
      const [anonUser] = await db
        .select({ defaultTown: schema.anonymousUsers.defaultTown })
        .from(schema.anonymousUsers)
        .where(eq(schema.anonymousUsers.id, actor.anonId));
      return anonUser?.defaultTown || null;
    }
    return null;
  }

  async setSessionTownPreference(sessionId: string, town: string): Promise<void> {
    await db
      .update(schema.chatSessions)
      .set({ townPreference: town, updatedAt: new Date() })
      .where(eq(schema.chatSessions.id, sessionId));
  }

  async getSessionTownPreference(sessionId: string): Promise<string | null> {
    const [session] = await db
      .select({ townPreference: schema.chatSessions.townPreference })
      .from(schema.chatSessions)
      .where(eq(schema.chatSessions.id, sessionId));
    return session?.townPreference || null;
  }

  // Recent minutes updates - canonical query using logicalDocuments + documentVersions
  async getRecentMinutesUpdates(params: { town: string; limit?: number }): Promise<MinutesUpdateItem[]> {
    const { town, limit = 5 } = params;
    
    const results = await db
      .select({
        logicalDocumentId: schema.logicalDocuments.id,
        documentVersionId: schema.documentVersions.id,
        town: schema.logicalDocuments.town,
        board: schema.logicalDocuments.board,
        category: schema.logicalDocuments.category,
        meetingDate: schema.documentVersions.meetingDate,
        ingestedAt: schema.documentVersions.createdAt,
        fileSearchDocumentName: schema.documentVersions.fileSearchDocumentName,
      })
      .from(schema.logicalDocuments)
      .innerJoin(
        schema.documentVersions,
        eq(schema.logicalDocuments.id, schema.documentVersions.documentId)
      )
      .where(
        and(
          eq(schema.logicalDocuments.category, 'meeting_minutes'),
          eq(schema.documentVersions.isCurrent, true),
          eq(schema.logicalDocuments.town, town)
        )
      )
      .orderBy(desc(schema.documentVersions.createdAt))
      .limit(limit);

    return results.map(r => ({
      logicalDocumentId: r.logicalDocumentId,
      documentVersionId: r.documentVersionId,
      town: r.town,
      board: r.board,
      category: r.category,
      meetingDate: r.meetingDate?.toISOString() || null,
      ingestedAt: r.ingestedAt.toISOString(),
      fileSearchDocumentName: r.fileSearchDocumentName,
    }));
  }

  async getRecentMinutesUpdatesAdmin(params: { town?: string; board?: string; limit?: number }): Promise<MinutesUpdateItem[]> {
    const { town, board, limit = 50 } = params;
    
    // Build where conditions dynamically
    const conditions = [
      eq(schema.logicalDocuments.category, 'meeting_minutes'),
      eq(schema.documentVersions.isCurrent, true),
    ];
    
    if (town) {
      conditions.push(eq(schema.logicalDocuments.town, town));
    }
    if (board) {
      conditions.push(eq(schema.logicalDocuments.board, board));
    }

    const results = await db
      .select({
        logicalDocumentId: schema.logicalDocuments.id,
        documentVersionId: schema.documentVersions.id,
        town: schema.logicalDocuments.town,
        board: schema.logicalDocuments.board,
        category: schema.logicalDocuments.category,
        meetingDate: schema.documentVersions.meetingDate,
        ingestedAt: schema.documentVersions.createdAt,
        fileSearchDocumentName: schema.documentVersions.fileSearchDocumentName,
      })
      .from(schema.logicalDocuments)
      .innerJoin(
        schema.documentVersions,
        eq(schema.logicalDocuments.id, schema.documentVersions.documentId)
      )
      .where(and(...conditions))
      .orderBy(desc(schema.documentVersions.createdAt))
      .limit(limit);

    return results.map(r => ({
      logicalDocumentId: r.logicalDocumentId,
      documentVersionId: r.documentVersionId,
      town: r.town,
      board: r.board,
      category: r.category,
      meetingDate: r.meetingDate?.toISOString() || null,
      ingestedAt: r.ingestedAt.toISOString(),
      fileSearchDocumentName: r.fileSearchDocumentName,
    }));
  }
}

export const storage = new DatabaseStorage();
