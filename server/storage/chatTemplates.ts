import { db, schema, eq, desc } from "./db";
import type {
  ChatTemplate,
  InsertChatTemplate,
  TemplatePayload,
} from "@shared/schema";

export async function createChatTemplate(template: InsertChatTemplate): Promise<ChatTemplate> {
  const [result] = await db.insert(schema.chatTemplates).values(template).returning();
  return result;
}

export async function getChatTemplates(): Promise<ChatTemplate[]> {
  return await db
    .select()
    .from(schema.chatTemplates)
    .orderBy(desc(schema.chatTemplates.updatedAt));
}

export async function getChatTemplateById(id: string): Promise<ChatTemplate | undefined> {
  const [result] = await db
    .select()
    .from(schema.chatTemplates)
    .where(eq(schema.chatTemplates.id, id));
  return result;
}

export async function updateChatTemplate(
  id: string,
  data: Partial<InsertChatTemplate>
): Promise<ChatTemplate | undefined> {
  const [result] = await db
    .update(schema.chatTemplates)
    .set({ ...data, updatedAt: new Date() })
    .where(eq(schema.chatTemplates.id, id))
    .returning();
  return result;
}

export async function deleteChatTemplate(id: string): Promise<void> {
  await db.delete(schema.chatTemplates).where(eq(schema.chatTemplates.id, id));
}

export async function getActiveChatTemplate(): Promise<ChatTemplate | undefined> {
  const [result] = await db
    .select()
    .from(schema.chatTemplates)
    .where(eq(schema.chatTemplates.isActive, true))
    .orderBy(desc(schema.chatTemplates.updatedAt))
    .limit(1);
  return result;
}

export async function deactivateAllTemplates(): Promise<void> {
  await db
    .update(schema.chatTemplates)
    .set({ isActive: false, updatedAt: new Date() })
    .where(eq(schema.chatTemplates.isActive, true));
}

export async function getChatTemplateBySlug(slug: string): Promise<ChatTemplate | undefined> {
  const [result] = await db
    .select()
    .from(schema.chatTemplates)
    .where(eq(schema.chatTemplates.slug, slug));
  return result;
}
