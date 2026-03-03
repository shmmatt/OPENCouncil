import { db, schema, eq, desc, and } from "./db";
import type { TownFeedItem, InsertTownFeedItem } from "@shared/schema";

export async function createTownFeedItem(item: InsertTownFeedItem): Promise<TownFeedItem> {
  const [result] = await db.insert(schema.townFeedItems).values(item as any).returning();
  return result;
}

export async function getTownFeedItems(town?: string): Promise<TownFeedItem[]> {
  if (town) {
    return await db
      .select()
      .from(schema.townFeedItems)
      .where(eq(schema.townFeedItems.town, town))
      .orderBy(desc(schema.townFeedItems.updatedAt));
  }
  return await db
    .select()
    .from(schema.townFeedItems)
    .orderBy(desc(schema.townFeedItems.updatedAt));
}

export async function getTownFeedItemById(id: string): Promise<TownFeedItem | undefined> {
  const [result] = await db
    .select()
    .from(schema.townFeedItems)
    .where(eq(schema.townFeedItems.id, id));
  return result;
}

export async function updateTownFeedItem(
  id: string,
  data: Partial<InsertTownFeedItem>
): Promise<TownFeedItem | undefined> {
  const [result] = await db
    .update(schema.townFeedItems)
    .set({ ...data, updatedAt: new Date() } as any)
    .where(eq(schema.townFeedItems.id, id))
    .returning();
  return result;
}

export async function deleteTownFeedItem(id: string): Promise<void> {
  await db.delete(schema.townFeedItems).where(eq(schema.townFeedItems.id, id));
}

export async function getPublishedFeedItems(town: string): Promise<TownFeedItem[]> {
  return await db
    .select()
    .from(schema.townFeedItems)
    .where(
      and(
        eq(schema.townFeedItems.town, town),
        eq(schema.townFeedItems.status, "published")
      )
    )
    .orderBy(desc(schema.townFeedItems.updatedAt));
}
