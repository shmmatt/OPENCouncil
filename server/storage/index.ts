/**
 * Storage module index
 * 
 * Re-exports all storage operations from domain modules.
 * This provides backward compatibility with the old monolithic storage.ts
 */

// Database connection
export { db, schema } from "./db";

// Admin operations
export * from "./admins";

// Chat operations
export * from "./chat";

// Document operations (legacy + v2)
export * from "./documents";

// User/identity operations
export * from "./users";

// FileBlob and OCR operations
export * from "./fileBlobs";

// Ingestion job operations
export * from "./ingestion";

// Analytics, events, cost logging
export * from "./analytics";

// Temp uploads
export * from "./tempUploads";

// S3 Gemini Sync
export * from "./s3GeminiSync";
