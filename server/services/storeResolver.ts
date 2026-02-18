import { db, schema, eq, and, sql } from "../storage/db";

let statewideStoreIdCache: string | null | undefined = undefined;

export async function getStoreIdForTown(town: string): Promise<string | null> {
  if (!town) return null;
  
  try {
    const townLower = town.toLowerCase();
    
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

    const [docVersion] = await db
      .select({ fileSearchStoreName: schema.documentVersions.fileSearchStoreName })
      .from(schema.documentVersions)
      .innerJoin(schema.logicalDocuments, eq(schema.documentVersions.documentId, schema.logicalDocuments.id))
      .where(sql`LOWER(${schema.logicalDocuments.town}) = ${townLower}`)
      .limit(1);

    if (docVersion?.fileSearchStoreName) {
      return docVersion.fileSearchStoreName;
    }

    return null;
  } catch (error) {
    console.error(`[StoreResolver] Failed to resolve store for ${town}:`, error);
    return null;
  }
}

export async function getStatewideStoreId(): Promise<string | null> {
  if (statewideStoreIdCache !== undefined) {
    return statewideStoreIdCache;
  }
  
  try {
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

    const [docVersion] = await db
      .select({ fileSearchStoreName: schema.documentVersions.fileSearchStoreName })
      .from(schema.documentVersions)
      .innerJoin(schema.logicalDocuments, eq(schema.documentVersions.documentId, schema.logicalDocuments.id))
      .where(sql`LOWER(${schema.logicalDocuments.town}) = 'statewide'`)
      .limit(1);

    if (docVersion?.fileSearchStoreName) {
      statewideStoreIdCache = docVersion.fileSearchStoreName;
      return statewideStoreIdCache;
    }

    console.warn('[StoreResolver] No statewide store found in database');
    statewideStoreIdCache = null;
    return null;
  } catch (error) {
    console.error(`[StoreResolver] Failed to resolve statewide store:`, error);
    return null;
  }
}

export function clearStatewideStoreCache(): void {
  statewideStoreIdCache = undefined;
}
