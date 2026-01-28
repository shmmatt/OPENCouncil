/**
 * Temporary upload storage operations (for bulk upload workflow)
 */

import { db, schema, eq } from "./db";
import type { TempUpload, InsertTempUpload } from "@shared/schema";

export async function createTempUpload(upload: InsertTempUpload): Promise<TempUpload> {
  const [result] = await db.insert(schema.tempUploads).values(upload).returning();
  return result;
}

export async function getTempUploadById(id: string): Promise<TempUpload | undefined> {
  const [result] = await db
    .select()
    .from(schema.tempUploads)
    .where(eq(schema.tempUploads.id, id));
  return result;
}

export async function deleteTempUpload(id: string): Promise<void> {
  await db.delete(schema.tempUploads).where(eq(schema.tempUploads.id, id));
}
