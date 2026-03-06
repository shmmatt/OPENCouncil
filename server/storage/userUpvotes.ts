import { db, schema, eq, and, sql, inArray } from "./db";

export async function toggleUpvote(
  userId: string,
  feedItemId: string
): Promise<{ upvoteCount: number; hasUpvoted: boolean }> {
  return await db.transaction(async (tx) => {
    const [existing] = await tx
      .select()
      .from(schema.userUpvotes)
      .where(
        and(
          eq(schema.userUpvotes.userId, userId),
          eq(schema.userUpvotes.feedItemId, feedItemId)
        )
      );

    if (existing) {
      await tx
        .delete(schema.userUpvotes)
        .where(eq(schema.userUpvotes.id, existing.id));

      const [updated] = await tx
        .update(schema.townFeedItems)
        .set({ upvoteCount: sql`GREATEST(${schema.townFeedItems.upvoteCount} - 1, 0)` })
        .where(eq(schema.townFeedItems.id, feedItemId))
        .returning({ upvoteCount: schema.townFeedItems.upvoteCount });

      return { upvoteCount: updated.upvoteCount, hasUpvoted: false };
    } else {
      await tx
        .insert(schema.userUpvotes)
        .values({ userId, feedItemId });

      const [updated] = await tx
        .update(schema.townFeedItems)
        .set({ upvoteCount: sql`${schema.townFeedItems.upvoteCount} + 1` })
        .where(eq(schema.townFeedItems.id, feedItemId))
        .returning({ upvoteCount: schema.townFeedItems.upvoteCount });

      return { upvoteCount: updated.upvoteCount, hasUpvoted: true };
    }
  });
}

export async function getUserUpvotedFeedItemIds(
  userId: string,
  feedItemIds: string[]
): Promise<Set<string>> {
  if (feedItemIds.length === 0) return new Set();

  const rows = await db
    .select({ feedItemId: schema.userUpvotes.feedItemId })
    .from(schema.userUpvotes)
    .where(
      and(
        eq(schema.userUpvotes.userId, userId),
        inArray(schema.userUpvotes.feedItemId, feedItemIds)
      )
    );

  return new Set(rows.map((r) => r.feedItemId));
}
