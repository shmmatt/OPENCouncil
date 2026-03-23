/**
 * Dashboard storage operations
 * Handles user keywords, feature requests, and missing doc suggestions
 */

import { db, schema, eq, desc, and, or, inArray } from "./db";
import { ilike } from "drizzle-orm";
import type {
  UserKeyword,
  InsertUserKeyword,
  FeatureRequest,
  InsertFeatureRequest,
  MissingDocSuggestion,
  InsertMissingDocSuggestion,
} from "@shared/schema";

// ============================================================
// USER KEYWORDS
// ============================================================

export async function getUserKeywords(userId: string): Promise<UserKeyword[]> {
  return await db
    .select()
    .from(schema.userKeywords)
    .where(eq(schema.userKeywords.userId, userId))
    .orderBy(desc(schema.userKeywords.createdAt));
}

export async function addUserKeyword(data: InsertUserKeyword): Promise<UserKeyword> {
  const [result] = await db
    .insert(schema.userKeywords)
    .values(data)
    .returning();
  return result;
}

export async function removeUserKeyword(id: string, userId: string): Promise<void> {
  await db
    .delete(schema.userKeywords)
    .where(and(
      eq(schema.userKeywords.id, id),
      eq(schema.userKeywords.userId, userId)
    ));
}

export interface KeywordMatchDoc {
  id: string;
  canonicalTitle: string;
  town: string;
  category: string;
  previewText: string | null;
  updatedAt: Date;
}

export async function searchDocumentsByKeywords(keywords: string[]): Promise<KeywordMatchDoc[]> {
  if (!keywords || keywords.length === 0) return [];

  const conditions = keywords.flatMap((kw) => [
    ilike(schema.logicalDocuments.canonicalTitle, `%${kw}%`),
    ilike(schema.logicalDocuments.category, `%${kw}%`),
  ]);

  const previewConditions = keywords.map((kw) =>
    ilike(schema.fileBlobs.previewText, `%${kw}%`)
  );

  const allConditions = [...conditions, ...previewConditions];

  const results = await db
    .select({
      id: schema.logicalDocuments.id,
      canonicalTitle: schema.logicalDocuments.canonicalTitle,
      town: schema.logicalDocuments.town,
      category: schema.logicalDocuments.category,
      previewText: schema.fileBlobs.previewText,
      updatedAt: schema.logicalDocuments.updatedAt,
    })
    .from(schema.logicalDocuments)
    .leftJoin(
      schema.documentVersions,
      and(
        eq(schema.documentVersions.documentId, schema.logicalDocuments.id),
        eq(schema.documentVersions.isCurrent, true)
      )
    )
    .leftJoin(
      schema.fileBlobs,
      eq(schema.documentVersions.fileBlobId, schema.fileBlobs.id)
    )
    .where(or(...allConditions))
    .orderBy(desc(schema.logicalDocuments.updatedAt))
    .limit(20);

  return results;
}

// ============================================================
// NEW DOCS BY TOWNS
// ============================================================

export interface RecentDoc {
  id: string;
  canonicalTitle: string;
  town: string;
  category: string;
  updatedAt: Date;
}

export async function getRecentDocsByTowns(towns: string[], limit = 10): Promise<RecentDoc[]> {
  if (!towns || towns.length === 0) return [];

  return await db
    .select({
      id: schema.logicalDocuments.id,
      canonicalTitle: schema.logicalDocuments.canonicalTitle,
      town: schema.logicalDocuments.town,
      category: schema.logicalDocuments.category,
      updatedAt: schema.logicalDocuments.updatedAt,
    })
    .from(schema.logicalDocuments)
    .where(inArray(schema.logicalDocuments.town, towns))
    .orderBy(desc(schema.logicalDocuments.updatedAt))
    .limit(limit);
}

// ============================================================
// FEATURE REQUESTS
// ============================================================

export async function createFeatureRequest(data: InsertFeatureRequest): Promise<FeatureRequest> {
  const [result] = await db
    .insert(schema.featureRequests)
    .values(data)
    .returning();
  return result;
}

export async function getAllFeatureRequests(): Promise<FeatureRequest[]> {
  return await db
    .select()
    .from(schema.featureRequests)
    .orderBy(desc(schema.featureRequests.createdAt));
}

// ============================================================
// MISSING DOC SUGGESTIONS
// ============================================================

export async function createMissingDocSuggestion(data: InsertMissingDocSuggestion): Promise<MissingDocSuggestion> {
  const [result] = await db
    .insert(schema.missingDocSuggestions)
    .values(data)
    .returning();
  return result;
}

export async function getAllMissingDocSuggestions(): Promise<MissingDocSuggestion[]> {
  return await db
    .select()
    .from(schema.missingDocSuggestions)
    .orderBy(desc(schema.missingDocSuggestions.createdAt));
}
