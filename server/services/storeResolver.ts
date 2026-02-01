
import { db, schema, eq, and } from "../storage/db";

// Force a change to break Replit's build cache after import fix.


/**
 * Resolve the Gemini File Search Store ID for a given town.
 * Queries the database for existing documents associated with that town.
 */
export async function getStoreIdForTown(town: string): Promise<string | null> {
  if (!town) return null;
  
  try {
    // 1. Check s3_gemini_sync table (Fastest source of truth for new ingestion)
    const syncRecord = await db.query.s3GeminiSync.findFirst({
      where: and(
        eq(schema.s3GeminiSync.town, town),
        eq(schema.s3GeminiSync.status, "synced")
      )
    });
    
    if (syncRecord && syncRecord.geminiStoreId) {
      return syncRecord.geminiStoreId;
    }

    // 2. Fallback: Check Logical Documents (Legacy/Manual Uploads)
    const logicalDoc = await db.query.logicalDocuments.findFirst({
        where: eq(schema.logicalDocuments.town, town),
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
