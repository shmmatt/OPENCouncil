import { db, schema, eq, desc } from "./db";
import type { Promotion, InsertPromotion } from "@shared/schema";

export async function createPromotion(data: InsertPromotion): Promise<Promotion> {
  const [result] = await db.insert(schema.promotions).values(data as any).returning();
  return result;
}

export async function getPromotionById(id: number): Promise<Promotion | undefined> {
  const [result] = await db
    .select()
    .from(schema.promotions)
    .where(eq(schema.promotions.id, id));
  return result;
}

export async function getPromotionByFeedItemId(feedItemId: string): Promise<Promotion | undefined> {
  const [result] = await db
    .select()
    .from(schema.promotions)
    .where(eq(schema.promotions.feedItemId, feedItemId));
  return result;
}

export async function getAllPromotions(): Promise<Promotion[]> {
  return await db
    .select()
    .from(schema.promotions)
    .orderBy(desc(schema.promotions.updatedAt));
}

export async function updatePromotion(
  id: number,
  data: Partial<InsertPromotion>
): Promise<Promotion | undefined> {
  const [result] = await db
    .update(schema.promotions)
    .set({ ...data, updatedAt: new Date() } as any)
    .where(eq(schema.promotions.id, id))
    .returning();
  return result;
}
