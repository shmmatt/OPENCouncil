
import { db, schema, eq, and, sql } from "../storage/db";

// Force a change to break Replit's build cache after import fix.

// Cache for statewide store ID (rarely changes)
let statewideStoreIdCache: string | null | undefined = undefined;

/**
 * Resolve the Gemini File Search Store ID for a given town.
 * Queries the database for existing documents associated with that town.
 */
export async function getStoreIdForTown(town: string): Promise<string | null> {
  if (!town) return null;
  
  try {
    // Normalize town name to lowercase for case-insensitive matching
    const townLower = town.toLowerCase();
    
    // Check s3_gemini_sync table with raw SQL for case-insensitive match
    const syncRecords = await db
      .select()
      .from(schema.s3GeminiSync)
      .where(and(
        sql`LOWER(town) = ${townLower}`,
        eq(schema.s3GeminiSync.status, "synced")
      ))
      .orderBy(sql`synced_at DESC`)
      .limit(1);
    
    if (syncRecords.length > 0 && syncRecords[0].geminiStoreId) {
      console.log(`[StoreResolver] Found store for ${town}: ${syncRecords[0].geminiStoreId}`);
      return syncRecords[0].geminiStoreId;
    }

    // Fallback: Check Logical Documents (Legacy/Manual Uploads)
    const logicalDoc = await db.query.logicalDocuments.findFirst({
        where: sql`LOWER(town) = ${townLower}`,
        with: {
            currentVersion: true
        }
    });

    if (logicalDoc?.currentVersion?.fileSearchStoreName) {
        return logicalDoc.currentVersion.fileSearchStoreName;
    }

    return null;
  } catch (error) {
    console.error(`[StoreResolver] Failed to resolve store for ${town}:`, error);
    return null;
  }
}

/**
 * Get the statewide File Search Store ID.
 * This store contains RSA statutes, NHMA guidance, and other NH-wide documents
 * that should be accessible for all town queries.
 */
export async function getStatewideStoreId(): Promise<string | null> {
  // Return cached value if available
  if (statewideStoreIdCache !== undefined) {
    return statewideStoreIdCache;
  }
  
  try {
    // Look for documents with town="statewide" (case-insensitive)
    const syncRecord = await db
      .select()
      .from(schema.s3GeminiSync)
      .where(and(
        sql`LOWER(town) = 'statewide'`,
        eq(schema.s3GeminiSync.status, "synced")
      ))
      .orderBy(sql`synced_at DESC`)
      .limit(1);
    
    if (syncRecord.length > 0 && syncRecord[0].geminiStoreId) {
      statewideStoreIdCache = syncRecord[0].geminiStoreId;
      console.log(`[StoreResolver] Found statewide store: ${statewideStoreIdCache}`);
      return statewideStoreIdCache;
    }

    // Fallback: Check logical_documents
    const logicalDoc = await db.query.logicalDocuments.findFirst({
        where: sql`LOWER(town) = 'statewide'`,
        with: {
            currentVersion: true
        }
    });

    if (logicalDoc?.currentVersion?.fileSearchStoreName) {
        statewideStoreIdCache = logicalDoc.currentVersion.fileSearchStoreName;
        return statewideStoreIdCache;
    }

    // No statewide store found
    console.warn('[StoreResolver] No statewide store found in database');
    statewideStoreIdCache = null;
    return null;
  } catch (error) {
    console.error(`[StoreResolver] Failed to resolve statewide store:`, error);
    return null;
  }
}

/**
 * Clear the statewide store cache (useful after ingesting new statewide documents)
 */
export function clearStatewideStoreCache(): void {
  statewideStoreIdCache = undefined;
}
