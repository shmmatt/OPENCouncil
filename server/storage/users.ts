/**
 * User and identity storage operations
 */

import { db, schema, eq, and } from "./db";
import type { 
  User, 
  InsertUser,
  UserIdentity,
  InsertUserIdentity,
  AnonymousUser,
  InsertAnonymousUser,
  ActorIdentifier,
} from "@shared/schema";

// ============================================================
// USERS
// ============================================================

export async function createUser(user: InsertUser): Promise<User> {
  const [result] = await db.insert(schema.users).values(user).returning();
  return result;
}

export async function getUserById(id: string): Promise<User | undefined> {
  const [result] = await db
    .select()
    .from(schema.users)
    .where(eq(schema.users.id, id));
  return result;
}

export async function updateUser(id: string, data: Partial<InsertUser>): Promise<void> {
  await db
    .update(schema.users)
    .set(data)
    .where(eq(schema.users.id, id));
}

export async function updateUserLastLogin(id: string): Promise<void> {
  await db
    .update(schema.users)
    .set({ lastLoginAt: new Date() })
    .where(eq(schema.users.id, id));
}

// ============================================================
// USER IDENTITIES
// ============================================================

export async function createUserIdentity(identity: InsertUserIdentity): Promise<UserIdentity> {
  const [result] = await db.insert(schema.userIdentities).values(identity).returning();
  return result;
}

export async function getUserIdentityByProviderKey(provider: string, providerKey: string): Promise<UserIdentity | undefined> {
  const [result] = await db
    .select()
    .from(schema.userIdentities)
    .where(and(
      eq(schema.userIdentities.provider, provider),
      eq(schema.userIdentities.providerKey, providerKey)
    ));
  return result;
}

export async function getUserIdentitiesByUserId(userId: string): Promise<UserIdentity[]> {
  return await db
    .select()
    .from(schema.userIdentities)
    .where(eq(schema.userIdentities.userId, userId));
}

// ============================================================
// ANONYMOUS USERS
// ============================================================

export async function createAnonymousUser(anonUser: InsertAnonymousUser): Promise<AnonymousUser> {
  const [result] = await db.insert(schema.anonymousUsers).values(anonUser).returning();
  return result;
}

export async function getAnonymousUserById(id: string): Promise<AnonymousUser | undefined> {
  const [result] = await db
    .select()
    .from(schema.anonymousUsers)
    .where(eq(schema.anonymousUsers.id, id));
  return result;
}

export async function updateAnonymousUserLastSeen(id: string): Promise<void> {
  await db
    .update(schema.anonymousUsers)
    .set({ lastSeenAt: new Date() })
    .where(eq(schema.anonymousUsers.id, id));
}

export async function linkAnonymousUserToUser(anonId: string, userId: string): Promise<void> {
  await db
    .update(schema.anonymousUsers)
    .set({ userId })
    .where(eq(schema.anonymousUsers.id, anonId));
}

// ============================================================
// TOWN PREFERENCES (actor-level)
// ============================================================

export async function setActorDefaultTown(actor: ActorIdentifier, town: string): Promise<void> {
  if (actor.type === 'user' && actor.userId) {
    await db
      .update(schema.users)
      .set({ defaultTown: town })
      .where(eq(schema.users.id, actor.userId));
  } else if (actor.anonId) {
    await db
      .update(schema.anonymousUsers)
      .set({ defaultTown: town })
      .where(eq(schema.anonymousUsers.id, actor.anonId));
  }
}

export async function getActorDefaultTown(actor: ActorIdentifier): Promise<string | null> {
  if (actor.type === 'user' && actor.userId) {
    const [result] = await db
      .select({ defaultTown: schema.users.defaultTown })
      .from(schema.users)
      .where(eq(schema.users.id, actor.userId));
    return result?.defaultTown || null;
  } else if (actor.anonId) {
    const [result] = await db
      .select({ defaultTown: schema.anonymousUsers.defaultTown })
      .from(schema.anonymousUsers)
      .where(eq(schema.anonymousUsers.id, actor.anonId));
    return result?.defaultTown || null;
  }
  return null;
}

// ============================================================
// AVAILABLE TOWNS
// ============================================================

export async function getAvailableTowns(): Promise<string[]> {
  const results = await db
    .selectDistinct({ town: schema.logicalDocuments.town })
    .from(schema.logicalDocuments)
    .where(schema.logicalDocuments.town);

  return results
    .map(r => r.town)
    .filter((t): t is string => t !== null && t !== 'statewide')
    .sort();
}
