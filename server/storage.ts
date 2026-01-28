/**
 * Storage layer - backward compatibility wrapper
 * 
 * This file maintains the original IStorage interface and DatabaseStorage class
 * for backward compatibility, while delegating to the new modular storage modules.
 * 
 * New code should import directly from ./storage/index.ts or specific modules.
 */

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
  ChatAnalytics,
  InsertChatAnalytics,
  MinutesUpdateItem,
  ActorIdentifier,
  SituationContext,
  SessionSource,
} from "@shared/schema";

// Import all functions from modular storage
import * as admins from "./storage/admins";
import * as chat from "./storage/chat";
import * as documents from "./storage/documents";
import * as users from "./storage/users";
import * as fileBlobs from "./storage/fileBlobs";
import * as ingestion from "./storage/ingestion";
import * as analytics from "./storage/analytics";
import * as tempUploads from "./storage/tempUploads";

/**
 * Storage interface - kept for backward compatibility
 * @deprecated Import functions directly from ./storage modules instead
 */
export interface IStorage {
  // Admin operations
  createAdmin(admin: InsertAdmin): Promise<Admin>;
  getAdminByEmail(email: string): Promise<Admin | undefined>;

  // Legacy document operations
  createDocument(doc: InsertDocument): Promise<Document>;
  getDocuments(): Promise<Document[]>;
  getDocumentById(id: string): Promise<Document | undefined>;
  deleteDocument(id: string): Promise<void>;

  // Chat session operations
  createChatSession(session: InsertChatSession): Promise<ChatSession>;
  getChatSessions(actor?: ActorIdentifier): Promise<ChatSession[]>;
  getChatSessionById(id: string): Promise<ChatSession | undefined>;
  updateChatSession(id: string, data: Partial<InsertChatSession>): Promise<void>;
  getAllChatSessions(): Promise<ChatSession[]>;

  // Chat message operations
  createChatMessage(message: InsertChatMessage): Promise<ChatMessage>;
  getMessagesBySessionId(sessionId: string): Promise<ChatMessage[]>;

  // Temp upload operations
  createTempUpload(upload: InsertTempUpload): Promise<TempUpload>;
  getTempUploadById(id: string): Promise<TempUpload | undefined>;
  deleteTempUpload(id: string): Promise<void>;

  // FileBlob operations
  createFileBlob(blob: InsertFileBlob): Promise<FileBlob>;
  getFileBlobById(id: string): Promise<FileBlob | undefined>;
  getFileBlobByRawHash(rawHash: string): Promise<FileBlob | undefined>;
  getFileBlobByPreviewHash(previewHash: string): Promise<FileBlob | undefined>;
  findDuplicateBlobs(rawHash: string, previewHash?: string): Promise<{ exact: FileBlob | null; preview: FileBlob | null }>;
  updateFileBlob(id: string, data: Partial<InsertFileBlob>): Promise<void>;
  
  // OCR operations
  getFileBlobsNeedingOcr(): Promise<FileBlob[]>;
  claimNextOcrJob(): Promise<FileBlob | null>;
  updateOcrStatus(id: string, status: string, data?: { ocrText?: string; ocrTextCharCount?: number; ocrFailureReason?: string }): Promise<void>;
  queueFileBlobForOcr(id: string): Promise<void>;
  recoverStaleOcrJobs(staleMinutes?: number): Promise<number>;
  resetStuckProcessingJobs(): Promise<number>;
  getOcrCompletedNeedingReindex(): Promise<Array<{ fileBlob: FileBlob; metadata: any }>>;
  markOcrReindexed(fileBlobId: string): Promise<void>;
  getOcrFailedMissingFileCount(): Promise<number>;
  retryOcrFailedMissingFiles(): Promise<number>;
  getFileBlobsWithLocalPaths(): Promise<FileBlob[]>;
  getFileBlobsNeedingOcrQueue(minCharThreshold: number): Promise<FileBlob[]>;
  getOcrQueueStats(): Promise<{ queued: number; processing: number; completed: number; failed: number; blocked: number }>;

  // LogicalDocument operations
  createLogicalDocument(doc: InsertLogicalDocument): Promise<LogicalDocument>;
  getLogicalDocuments(): Promise<LogicalDocument[]>;
  getLogicalDocumentById(id: string): Promise<LogicalDocument | undefined>;
  getLogicalDocumentWithVersions(id: string): Promise<LogicalDocumentWithVersions | undefined>;
  updateLogicalDocument(id: string, data: Partial<InsertLogicalDocument>): Promise<void>;
  searchLogicalDocuments(query: { town?: string; category?: string; board?: string }): Promise<LogicalDocument[]>;

  // DocumentVersion operations
  createDocumentVersion(version: InsertDocumentVersion): Promise<DocumentVersion>;
  getDocumentVersionById(id: string): Promise<DocumentVersion | undefined>;
  getDocumentVersionsByDocumentId(documentId: string): Promise<DocumentVersionWithBlob[]>;
  getCurrentVersionForDocument(documentId: string): Promise<DocumentVersionWithBlob | undefined>;
  setCurrentVersion(documentId: string, versionId: string): Promise<void>;
  getDocumentVersionByFileSearchName(fileSearchDocumentName: string): Promise<DocumentVersion | undefined>;

  // IngestionJob operations
  createIngestionJob(job: InsertIngestionJob): Promise<IngestionJob>;
  getIngestionJobById(id: string): Promise<IngestionJob | undefined>;
  getIngestionJobWithBlob(id: string): Promise<IngestionJobWithBlob | undefined>;
  getIngestionJobsByStatus(status: IngestionJobStatus): Promise<IngestionJobWithBlob[]>;
  getAllIngestionJobs(): Promise<IngestionJobWithBlob[]>;
  updateIngestionJob(id: string, data: Partial<InsertIngestionJob>): Promise<void>;
  deleteIngestionJob(id: string): Promise<void>;

  // User operations
  createUser(user: InsertUser): Promise<User>;
  getUserById(id: string): Promise<User | undefined>;
  updateUser(id: string, data: Partial<InsertUser>): Promise<void>;
  updateUserLastLogin(id: string): Promise<void>;

  // UserIdentity operations
  createUserIdentity(identity: InsertUserIdentity): Promise<UserIdentity>;
  getUserIdentityByProviderKey(provider: string, providerKey: string): Promise<UserIdentity | undefined>;
  getUserIdentitiesByUserId(userId: string): Promise<UserIdentity[]>;

  // AnonymousUser operations
  createAnonymousUser(anonUser: InsertAnonymousUser): Promise<AnonymousUser>;
  getAnonymousUserById(id: string): Promise<AnonymousUser | undefined>;
  updateAnonymousUserLastSeen(id: string): Promise<void>;
  linkAnonymousUserToUser(anonId: string, userId: string): Promise<void>;

  // Cost logging
  createLlmCostLog(log: InsertLlmCostLog): Promise<LlmCostLog>;
  getDailyCostByUser(userId: string): Promise<number>;
  getDailyCostByAnon(anonId: string): Promise<number>;

  // Events
  createEvent(event: InsertEvent): Promise<Event>;

  // Town preferences
  getAvailableTowns(): Promise<string[]>;
  setActorDefaultTown(actor: ActorIdentifier, town: string): Promise<void>;
  getActorDefaultTown(actor: ActorIdentifier): Promise<string | null>;
  setSessionTownPreference(sessionId: string, town: string): Promise<void>;
  getSessionTownPreference(sessionId: string): Promise<string | null>;

  // Situation context
  setSessionSituationContext(sessionId: string, context: SituationContext): Promise<void>;
  getSessionSituationContext(sessionId: string): Promise<SituationContext | null>;

  // Session sources
  addSessionSource(sessionId: string, source: SessionSource, maxSources?: number): Promise<void>;
  getSessionSources(sessionId: string): Promise<SessionSource[]>;
  clearSessionSources(sessionId: string): Promise<void>;

  // Minutes updates
  getRecentMinutesUpdates(params: { town: string; limit?: number }): Promise<MinutesUpdateItem[]>;
  getRecentMinutesUpdatesAdmin(params: { town?: string; board?: string; limit?: number }): Promise<MinutesUpdateItem[]>;

  // Chat analytics
  createChatAnalytics(analytics: InsertChatAnalytics): Promise<ChatAnalytics>;
  getChatAnalyticsBySessionId(sessionId: string): Promise<ChatAnalytics | undefined>;
  upsertChatAnalytics(analytics: InsertChatAnalytics): Promise<ChatAnalytics>;
}

/**
 * Database storage implementation - delegates to modular storage
 * @deprecated Import functions directly from ./storage modules instead
 */
export class DatabaseStorage implements IStorage {
  // Admin
  createAdmin = admins.createAdmin;
  getAdminByEmail = admins.getAdminByEmail;

  // Documents (legacy)
  createDocument = documents.createDocument;
  getDocuments = documents.getDocuments;
  getDocumentById = documents.getDocumentById;
  deleteDocument = documents.deleteDocument;

  // Chat sessions
  createChatSession = chat.createChatSession;
  getChatSessions = chat.getChatSessions;
  getChatSessionById = chat.getChatSessionById;
  updateChatSession = chat.updateChatSession;
  getAllChatSessions = chat.getAllChatSessions;

  // Chat messages
  createChatMessage = chat.createChatMessage;
  getMessagesBySessionId = chat.getMessagesBySessionId;

  // Situation context
  setSessionSituationContext = chat.setSessionSituationContext;
  getSessionSituationContext = chat.getSessionSituationContext;

  // Session sources
  addSessionSource = chat.addSessionSource;
  getSessionSources = chat.getSessionSources;
  clearSessionSources = chat.clearSessionSources;

  // Session town preference
  setSessionTownPreference = chat.setSessionTownPreference;
  getSessionTownPreference = chat.getSessionTownPreference;

  // Temp uploads
  createTempUpload = tempUploads.createTempUpload;
  getTempUploadById = tempUploads.getTempUploadById;
  deleteTempUpload = tempUploads.deleteTempUpload;

  // FileBlobs
  createFileBlob = fileBlobs.createFileBlob;
  getFileBlobById = fileBlobs.getFileBlobById;
  getFileBlobByRawHash = fileBlobs.getFileBlobByRawHash;
  getFileBlobByPreviewHash = fileBlobs.getFileBlobByPreviewHash;
  findDuplicateBlobs = fileBlobs.findDuplicateBlobs;
  updateFileBlob = fileBlobs.updateFileBlob;

  // OCR
  getFileBlobsNeedingOcr = fileBlobs.getFileBlobsNeedingOcr;
  claimNextOcrJob = fileBlobs.claimNextOcrJob;
  updateOcrStatus = fileBlobs.updateOcrStatus;
  queueFileBlobForOcr = fileBlobs.queueFileBlobForOcr;
  recoverStaleOcrJobs = fileBlobs.recoverStaleOcrJobs;
  resetStuckProcessingJobs = fileBlobs.resetStuckProcessingJobs;
  getOcrCompletedNeedingReindex = fileBlobs.getOcrCompletedNeedingReindex;
  markOcrReindexed = fileBlobs.markOcrReindexed;
  getOcrFailedMissingFileCount = fileBlobs.getOcrFailedMissingFileCount;
  retryOcrFailedMissingFiles = fileBlobs.retryOcrFailedMissingFiles;
  getFileBlobsWithLocalPaths = fileBlobs.getFileBlobsWithLocalPaths;
  getFileBlobsNeedingOcrQueue = fileBlobs.getFileBlobsNeedingOcrQueue;
  getOcrQueueStats = fileBlobs.getOcrQueueStats;

  // LogicalDocuments
  createLogicalDocument = documents.createLogicalDocument;
  getLogicalDocuments = documents.getLogicalDocuments;
  getLogicalDocumentById = documents.getLogicalDocumentById;
  getLogicalDocumentWithVersions = documents.getLogicalDocumentWithVersions;
  updateLogicalDocument = documents.updateLogicalDocument;
  searchLogicalDocuments = documents.searchLogicalDocuments;

  // DocumentVersions
  createDocumentVersion = documents.createDocumentVersion;
  getDocumentVersionById = documents.getDocumentVersionById;
  getDocumentVersionsByDocumentId = documents.getDocumentVersionsByDocumentId;
  getCurrentVersionForDocument = documents.getCurrentVersionForDocument;
  setCurrentVersion = documents.setCurrentVersion;
  getDocumentVersionByFileSearchName = documents.getDocumentVersionByFileSearchName;

  // Minutes updates
  getRecentMinutesUpdates = documents.getRecentMinutesUpdates;
  getRecentMinutesUpdatesAdmin = documents.getRecentMinutesUpdatesAdmin;

  // IngestionJobs
  createIngestionJob = ingestion.createIngestionJob;
  getIngestionJobById = ingestion.getIngestionJobById;
  getIngestionJobWithBlob = ingestion.getIngestionJobWithBlob;
  getIngestionJobsByStatus = ingestion.getIngestionJobsByStatus;
  getAllIngestionJobs = ingestion.getAllIngestionJobs;
  updateIngestionJob = ingestion.updateIngestionJob;
  deleteIngestionJob = ingestion.deleteIngestionJob;

  // Users
  createUser = users.createUser;
  getUserById = users.getUserById;
  updateUser = users.updateUser;
  updateUserLastLogin = users.updateUserLastLogin;

  // UserIdentities
  createUserIdentity = users.createUserIdentity;
  getUserIdentityByProviderKey = users.getUserIdentityByProviderKey;
  getUserIdentitiesByUserId = users.getUserIdentitiesByUserId;

  // AnonymousUsers
  createAnonymousUser = users.createAnonymousUser;
  getAnonymousUserById = users.getAnonymousUserById;
  updateAnonymousUserLastSeen = users.updateAnonymousUserLastSeen;
  linkAnonymousUserToUser = users.linkAnonymousUserToUser;

  // Town preferences (actor-level)
  getAvailableTowns = users.getAvailableTowns;
  setActorDefaultTown = users.setActorDefaultTown;
  getActorDefaultTown = users.getActorDefaultTown;

  // Cost logging
  createLlmCostLog = analytics.createLlmCostLog;
  getDailyCostByUser = analytics.getDailyCostByUser;
  getDailyCostByAnon = analytics.getDailyCostByAnon;

  // Events
  createEvent = analytics.createEvent;

  // Chat analytics
  createChatAnalytics = analytics.createChatAnalytics;
  getChatAnalyticsBySessionId = analytics.getChatAnalyticsBySessionId;
  upsertChatAnalytics = analytics.upsertChatAnalytics;
}

// Export singleton instance for backward compatibility
export const storage = new DatabaseStorage();
