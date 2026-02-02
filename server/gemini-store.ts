import { storage } from "./storage";

// Persistent File Search store management
let fileSearchStoreId: string | null = null;

export async function getOrCreateFileSearchStoreId(): Promise<string> {
  // Try to get from memory cache first
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
