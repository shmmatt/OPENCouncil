import { storage } from "./storage";

// Persistent File Search store management
let fileSearchStoreId: string | null = null;

export async function getOrCreateFileSearchStoreId(town?: string): Promise<string> {
  // If town is provided, lookup/create town-specific store
  if (town) {
    // Check DB for town mapping? Or use existing convention?
    // Since we don't have a DB table for stores, we'll delegate to the s3Sync logic
    // but this function lives in gemini-store.ts which can't easily import s3Sync due to cycles
    
    // TEMPORARY FIX: Hardcode the known stores we just created or fetch via API
    // Ideally we should move store management to a shared module
    
    // For now, let's query the Gemini API to find the store by display name
    // This is expensive but safe
    // Actually, we can just use the 'getOrCreateTownStore' logic if we move it here or import it
    
    // Let's assume we can rely on the s3Sync map if we could access it, but we can't.
    // Instead, let's look at the implementation in s3Sync and replicate it or use a persistent lookup.
    
    // BETTER: Check the logicalDocuments table for a doc from this town and get its storeId
    // This maintains the pattern used below
    try {
        const { storage } = await import("./storage");
        const docs = await storage.searchLogicalDocuments({ town });
        if (docs.length > 0) {
            // Need to join with versions to get store ID
            const docWithVer = await storage.getLogicalDocumentWithVersions(docs[0].id);
            if (docWithVer?.currentVersion?.fileSearchStoreName) {
                return docWithVer.currentVersion.fileSearchStoreName;
            }
        }
    } catch (e) {
        console.error("Failed to resolve town store from DB:", e);
    }
  }

  // Legacy fallback (Statewide/Default)
  if (fileSearchStoreId) {
    return fileSearchStoreId;
  }


  // Try to get from database (from any existing document)
  const documents = await storage.getDocuments();
  if (documents.length > 0 && documents[0].fileSearchStoreId) {
    fileSearchStoreId = documents[0].fileSearchStoreId;
    return fileSearchStoreId;
  }

  // Will be created on first upload
  return "";
}

export function setFileSearchStoreId(storeId: string): void {
  fileSearchStoreId = storeId;
}
