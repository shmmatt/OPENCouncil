/**
 * Admin storage operations
 */

import { db, schema, eq } from "./db";
import type { Admin, InsertAdmin } from "@shared/schema";

export async function createAdmin(admin: InsertAdmin): Promise<Admin> {
  const [result] = await db.insert(schema.admins).values(admin).returning();
  return result;
}

export async function getAdminByEmail(email: string): Promise<Admin | undefined> {
  const [result] = await db
    .select()
    .from(schema.admins)
    .where(eq(schema.admins.email, email));
  return result;
}
