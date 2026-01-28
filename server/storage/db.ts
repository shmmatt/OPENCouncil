/**
 * Shared database connection
 * 
 * This module exports the drizzle database instance and schema
 * for use by all storage domain modules.
 */

import { drizzle } from "drizzle-orm/neon-serverless";
import { Pool, neonConfig } from "@neondatabase/serverless";
import ws from "ws";
import * as schema from "@shared/schema";

// Configure WebSocket for Neon serverless
neonConfig.webSocketConstructor = ws;

// Create connection pool
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// Create drizzle instance with schema
export const db = drizzle({ client: pool, schema });

// Re-export schema for convenience
export { schema };

// Re-export commonly used drizzle operators
export { eq, desc, asc, and, or, gte, sql, isNull, inArray, lt } from "drizzle-orm";
