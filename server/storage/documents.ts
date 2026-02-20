/**
 * Document storage operations (legacy + v2 pipeline)
 */

import { db, schema, eq, desc, and, sql } from "./db";
import type { 
  Document, 
  InsertDocument,
  LogicalDocument,
  InsertLogicalDocument,
  DocumentVersion,
  InsertDocumentVersion,
  DocumentVersionWithBlob,
  LogicalDocumentWithVersions,
  MinutesUpdateItem,
} from "@shared/schema";

// ============================================================
// LEGACY DOCUMENTS (backwards compatibility)
// ============================================================

export async function createDocument(doc: InsertDocument): Promise<Document> {
  const [result] = await db.insert(schema.documents).values(doc).returning();
  return result;
}

export async function getDocuments(): Promise<Document[]> {
  return await db.select().from(schema.documents).orderBy(desc(schema.documents.createdAt));
}

export async function getDocumentById(id: string): Promise<Document | undefined> {
  const [result] = await db
    .select()
    .from(schema.documents)
    .where(eq(schema.documents.id, id));
  return result;
}

export async function deleteDocument(id: string): Promise<void> {
  await db.delete(schema.documents).where(eq(schema.documents.id, id));
}

// ============================================================
// V2 PIPELINE: LOGICAL DOCUMENTS
// ============================================================

export async function createLogicalDocument(doc: InsertLogicalDocument): Promise<LogicalDocument> {
  const [result] = await db.insert(schema.logicalDocuments).values(doc).returning();
  return result;
}

export async function getLogicalDocuments(): Promise<LogicalDocument[]> {
  return await db
    .select()
    .from(schema.logicalDocuments)
    .orderBy(desc(schema.logicalDocuments.updatedAt));
}

export async function getLogicalDocumentById(id: string): Promise<LogicalDocument | undefined> {
  const [result] = await db
    .select()
    .from(schema.logicalDocuments)
    .where(eq(schema.logicalDocuments.id, id));
  return result;
}

export async function getLogicalDocumentWithVersions(id: string): Promise<LogicalDocumentWithVersions | undefined> {
  const doc = await getLogicalDocumentById(id);
  if (!doc) return undefined;

  const versions = await db
    .select({
      version: schema.documentVersions,
      fileBlob: schema.fileBlobs,
    })
    .from(schema.documentVersions)
    .innerJoin(schema.fileBlobs, eq(schema.documentVersions.fileBlobId, schema.fileBlobs.id))
    .where(eq(schema.documentVersions.documentId, id))
    .orderBy(desc(schema.documentVersions.createdAt));

  const versionsWithBlob: DocumentVersionWithBlob[] = versions.map(v => ({
    ...v.version,
    fileBlob: v.fileBlob,
  }));

  const currentVersion = versionsWithBlob.find(v => v.isCurrent);

  return {
    ...doc,
    versions: versionsWithBlob,
    currentVersion,
  };
}

export async function updateLogicalDocument(id: string, data: Partial<InsertLogicalDocument>): Promise<void> {
  await db
    .update(schema.logicalDocuments)
    .set({ ...data, updatedAt: new Date() })
    .where(eq(schema.logicalDocuments.id, id));
}

export async function searchLogicalDocuments(query: { town?: string; category?: string; board?: string }): Promise<LogicalDocument[]> {
  const conditions = [];
  
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
    return getLogicalDocuments();
  }

  return await db
    .select()
    .from(schema.logicalDocuments)
    .where(and(...conditions))
    .orderBy(desc(schema.logicalDocuments.updatedAt));
}

// ============================================================
// V2 PIPELINE: DOCUMENT VERSIONS
// ============================================================

export async function createDocumentVersion(version: InsertDocumentVersion): Promise<DocumentVersion> {
  const [result] = await db.insert(schema.documentVersions).values(version).returning();
  return result;
}

export async function getDocumentVersionById(id: string): Promise<DocumentVersion | undefined> {
  const [result] = await db
    .select()
    .from(schema.documentVersions)
    .where(eq(schema.documentVersions.id, id));
  return result;
}

export async function getDocumentVersionsByDocumentId(documentId: string): Promise<DocumentVersionWithBlob[]> {
  const versions = await db
    .select({
      version: schema.documentVersions,
      fileBlob: schema.fileBlobs,
    })
    .from(schema.documentVersions)
    .innerJoin(schema.fileBlobs, eq(schema.documentVersions.fileBlobId, schema.fileBlobs.id))
    .where(eq(schema.documentVersions.documentId, documentId))
    .orderBy(desc(schema.documentVersions.createdAt));

  return versions.map(v => ({
    ...v.version,
    fileBlob: v.fileBlob,
  }));
}

export async function getCurrentVersionForDocument(documentId: string): Promise<DocumentVersionWithBlob | undefined> {
  const [result] = await db
    .select({
      version: schema.documentVersions,
      fileBlob: schema.fileBlobs,
    })
    .from(schema.documentVersions)
    .innerJoin(schema.fileBlobs, eq(schema.documentVersions.fileBlobId, schema.fileBlobs.id))
    .where(and(
      eq(schema.documentVersions.documentId, documentId),
      eq(schema.documentVersions.isCurrent, true)
    ));

  if (!result) return undefined;

  return {
    ...result.version,
    fileBlob: result.fileBlob,
  };
}

export async function setCurrentVersion(documentId: string, versionId: string): Promise<void> {
  // Unset current flag on all versions for this document
  await db
    .update(schema.documentVersions)
    .set({ isCurrent: false })
    .where(eq(schema.documentVersions.documentId, documentId));

  // Set current flag on the specified version
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

export async function getDocumentVersionByFileSearchName(fileSearchDocumentName: string): Promise<DocumentVersion | undefined> {
  const [result] = await db
    .select()
    .from(schema.documentVersions)
    .where(eq(schema.documentVersions.fileSearchDocumentName, fileSearchDocumentName));
  return result;
}

export async function getDocumentMetadataByFileBlobId(fileBlobId: string): Promise<{
  canonicalTitle?: string;
  town?: string;
  board?: string;
  year?: string;
  category?: string;
  meetingDate?: string;
} | null> {
  const [result] = await db
    .select({
      canonicalTitle: schema.logicalDocuments.canonicalTitle,
      town: schema.logicalDocuments.town,
      board: schema.logicalDocuments.board,
      category: schema.logicalDocuments.category,
      year: schema.documentVersions.year,
      meetingDate: schema.documentVersions.meetingDate,
    })
    .from(schema.documentVersions)
    .innerJoin(schema.logicalDocuments, eq(schema.documentVersions.documentId, schema.logicalDocuments.id))
    .where(eq(schema.documentVersions.fileBlobId, fileBlobId))
    .limit(1);

  if (!result) return null;

  const meetingDateStr = result.meetingDate
    ? (result.meetingDate instanceof Date
      ? result.meetingDate.toISOString().split('T')[0]
      : String(result.meetingDate))
    : undefined;

  return {
    canonicalTitle: result.canonicalTitle || undefined,
    town: result.town || undefined,
    board: result.board || undefined,
    year: result.year || undefined,
    category: result.category || undefined,
    meetingDate: meetingDateStr,
  };
}

export async function getCrawledUrlByFileBlobId(fileBlobId: string): Promise<string | null> {
  const [result] = await db
    .select({
      url: schema.crawlerDocuments.url,
      filename: schema.crawlerDocuments.filename,
      townId: schema.crawlerDocuments.townId,
    })
    .from(schema.crawlerDocuments)
    .where(eq(schema.crawlerDocuments.fileBlobId, fileBlobId))
    .limit(1);

  if (!result?.url) return null;

  if (result.url.startsWith("http://") || result.url.startsWith("https://")) {
    return result.url;
  }

  if (result.filename && result.townId) {
    const fallback = await db.execute(sql`
      SELECT url FROM crawler_documents
      WHERE town_id = ${result.townId}
        AND filename = ${result.filename}
        AND url LIKE 'http%'
      LIMIT 1
    `);
    const row = fallback.rows?.[0] as { url: string } | undefined;
    if (row?.url) return row.url;

    const resolved = await resolveUrlByStemCandidates(result.filename, result.townId);
    if (resolved) return resolved;
  }

  return null;
}

async function resolveUrlByStemCandidates(filename: string, townIdOrName: string): Promise<string | null> {
  const stem = filename.replace(/\.[^.]+$/, "");
  if (!stem) return null;

  const candidates = [...new Set([stem, stem.replace(/_\d+$/, "")])];
  const isTownId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(townIdOrName);

  for (const candidate of candidates) {
    const q = isTownId
      ? sql`
          SELECT url FROM crawler_documents
          WHERE town_id = ${townIdOrName}
            AND url LIKE 'http%'
            AND url LIKE ${"%" + candidate}
          LIMIT 1`
      : sql`
          SELECT cd.url FROM crawler_documents cd
          JOIN crawler_towns ct ON cd.town_id = ct.id
          WHERE ct.name ILIKE ${townIdOrName}
            AND cd.url LIKE 'http%'
            AND cd.url LIKE ${"%" + candidate}
          LIMIT 1`;
    const r = await db.execute(q);
    const row = r.rows?.[0] as { url: string } | undefined;
    if (row?.url) return row.url;
  }
  return null;
}

export async function getCrawledUrlByFilenameAndTown(filename: string, town: string): Promise<string | null> {
  const result = await db.execute(sql`
    SELECT cd.url FROM crawler_documents cd
    JOIN crawler_towns ct ON cd.town_id = ct.id
    WHERE ct.name ILIKE ${town}
      AND cd.filename = ${filename}
      AND cd.url LIKE 'http%'
    LIMIT 1
  `);
  const row = result.rows?.[0] as { url: string } | undefined;
  if (row?.url) return row.url;

  return resolveUrlByStemCandidates(filename, town);
}

// ============================================================
// RECENT MINUTES UPDATES
// ============================================================

export async function getRecentMinutesUpdates(params: { town: string; limit?: number }): Promise<MinutesUpdateItem[]> {
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
    .from(schema.documentVersions)
    .innerJoin(schema.logicalDocuments, eq(schema.documentVersions.documentId, schema.logicalDocuments.id))
    .where(and(
      eq(schema.logicalDocuments.town, town),
      eq(schema.documentVersions.isMinutes, true),
      eq(schema.documentVersions.isCurrent, true)
    ))
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

export async function getRecentMinutesUpdatesAdmin(params: { town?: string; board?: string; limit?: number }): Promise<MinutesUpdateItem[]> {
  const { town, board, limit = 50 } = params;

  const conditions = [
    eq(schema.documentVersions.isMinutes, true),
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
    .from(schema.documentVersions)
    .innerJoin(schema.logicalDocuments, eq(schema.documentVersions.documentId, schema.logicalDocuments.id))
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
