import { db, schema, eq, desc, and, lt, inArray, sql } from "./db";
import type { TownFeedItem, InsertTownFeedItem } from "@shared/schema";

export async function createTownFeedItem(item: InsertTownFeedItem): Promise<TownFeedItem> {
  const [result] = await db.insert(schema.townFeedItems).values(item as any).returning();
  return result;
}

export async function getTownFeedItems(town?: string, options?: { status?: string; search?: string; sortBy?: string; sortDir?: string }): Promise<TownFeedItem[]> {
  const conditions = [];
  if (town) {
    conditions.push(eq(schema.townFeedItems.town, town));
  }
  if (options?.status) {
    conditions.push(eq(schema.townFeedItems.status, options.status));
  }

  let query = db
    .select()
    .from(schema.townFeedItems)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .$dynamic();

  const sortDir = options?.sortDir === "asc" ? "asc" : "desc";
  const sortCol = options?.sortBy === "upvoteCount" ? schema.townFeedItems.upvoteCount
    : options?.sortBy === "town" ? schema.townFeedItems.town
    : schema.townFeedItems.updatedAt;

  if (sortDir === "asc") {
    query = query.orderBy(sortCol);
  } else {
    query = query.orderBy(desc(sortCol));
  }

  let items = await query;

  if (options?.search) {
    const searchLower = options.search.toLowerCase();
    items = items.filter(
      (item) =>
        item.title.toLowerCase().includes(searchLower) ||
        item.summary.toLowerCase().includes(searchLower) ||
        item.town.toLowerCase().includes(searchLower)
    );
  }

  return items;
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

export async function getPublishedFeedItemsPaginated(
  towns: string[],
  cursor?: string,
  limit: number = 10
): Promise<{ items: TownFeedItem[]; hasMore: boolean; nextCursor: string | null }> {
  const conditions = [
    eq(schema.townFeedItems.status, "published"),
    sql`${schema.townFeedItems.publishedAt} IS NOT NULL`,
  ];

  if (towns.length > 0) {
    conditions.push(inArray(schema.townFeedItems.town, towns));
  }

  if (cursor) {
    const [cursorTime, cursorId] = cursor.split("|");
    const cursorDate = new Date(cursorTime);
    conditions.push(
      sql`(${schema.townFeedItems.publishedAt}, ${schema.townFeedItems.id}) < (${cursorDate}, ${cursorId})`
    );
  }

  const items = await db
    .select()
    .from(schema.townFeedItems)
    .where(and(...conditions))
    .orderBy(desc(schema.townFeedItems.publishedAt), desc(schema.townFeedItems.id))
    .limit(limit + 1);

  const hasMore = items.length > limit;
  if (hasMore) items.pop();

  let nextCursor: string | null = null;
  if (hasMore && items.length > 0) {
    const lastItem = items[items.length - 1];
    if (lastItem.publishedAt) {
      nextCursor = `${lastItem.publishedAt.toISOString()}|${lastItem.id}`;
    }
  }

  return { items, hasMore, nextCursor };
}
