#!/usr/bin/env tsx
/**
 * Run SQL Migration
 * 
 * Executes a SQL migration file using the app's database connection
 */

import { promises as fs } from 'fs';
import * as path from 'path';
import { db } from '../server/storage/db';
import { sql } from 'drizzle-orm';

async function runMigration(migrationFile: string) {
  console.log(`📦 Running migration: ${migrationFile}\n`);
  
  try {
    // Read migration file
    const migrationPath = path.join(process.cwd(), 'migrations', migrationFile);
    const migrationSql = await fs.readFile(migrationPath, 'utf-8');
    
    console.log(`SQL Preview (first 500 chars):`);
    console.log(migrationSql.substring(0, 500) + '...\n');
    
    // Execute the entire migration as one transaction
    // (Splitting by ; is unreliable with complex SQL)
    console.log('Executing migration SQL...\n');
    
    try {
      await db.execute(sql.raw(migrationSql));
      console.log(`  ✅ Success\n`);
    } catch (error) {
      console.error(`  ❌ Error:`, error instanceof Error ? error.message : 'Unknown error');
      throw error;
    }
    
    console.log('✅ Migration completed successfully!\n');
  } catch (error) {
    console.error('\n❌ Migration failed:', error);
    process.exit(1);
  }
}

// Get migration file from args
const migrationFile = process.argv[2];

if (!migrationFile) {
  console.error('Usage: npm run migrate <migration-file>');
  console.error('Example: npm run migrate 0002_crawler_state_tables.sql');
  process.exit(1);
}

runMigration(migrationFile)
  .then(() => process.exit(0))
  .catch((error) => {
    console.error('Fatal error:', error);
    process.exit(1);
  });
