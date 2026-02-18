/**
 * Database connection for batch pipeline
 * Uses streaming to avoid memory issues
 */

import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from '../../shared/schema';

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  throw new Error('DATABASE_URL environment variable is required');
}

// Create postgres client with streaming support
export const sql = postgres(connectionString, {
  max: 1, // Single connection for streaming
  idle_timeout: 30,
  connect_timeout: 10,
});

export const db = drizzle(sql, { schema });

export async function closeDb() {
  await sql.end();
}
