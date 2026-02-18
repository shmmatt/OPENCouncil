#!/usr/bin/env tsx
/**
 * Check database status of crawler documents
 */

import { db, sql } from '../server/storage/db';
import { crawlerDocuments, crawlerRuns } from '@shared/schema';

async function checkStatus() {
  console.log('========================================');
  console.log('💾 Database Status');
  console.log('========================================\n');

  try {
    // Documents by status
    console.log('📊 Documents by Status:');
    console.log('----------------------------------------');
    
    const statusQuery = sql`
      SELECT status, COUNT(*) as count
      FROM crawler_documents
      GROUP BY status
      ORDER BY status
    `;
    
    const statusResults = await db.execute(statusQuery);
    const rows = statusResults.rows as Array<{ status: string; count: string }>;
    
    const total = rows.reduce((sum, r) => sum + Number(r.count), 0);
    
    if (rows.length === 0) {
      console.log('  No documents yet');
    } else {
      for (const row of rows) {
        const count = Number(row.count);
        const pct = total > 0 ? ((count / total) * 100).toFixed(1) : '0.0';
        console.log(`  ${row.status?.padEnd(12)} ${String(count).padStart(6)}  (${pct}%)`);
      }
    }

    console.log('\n📊 Documents by Town (top 10):');
    console.log('----------------------------------------');
    
    const townQuery = sql`
      SELECT 
        t.slug as town_slug,
        COUNT(d.id) as total,
        SUM(CASE WHEN d.status = 'discovered' THEN 1 ELSE 0 END) as discovered,
        SUM(CASE WHEN d.status = 'uploaded' THEN 1 ELSE 0 END) as uploaded
      FROM crawler_documents d
      JOIN crawler_towns t ON d.town_id = t.id
      GROUP BY t.slug
      ORDER BY total DESC
      LIMIT 10
    `;
    
    const townResults = await db.execute(townQuery);
    const townRows = townResults.rows as Array<{
      town_slug: string;
      total: string;
      discovered: string;
      uploaded: string;
    }>;

    if (townRows.length === 0) {
      console.log('  No town data yet');
    } else {
      console.log(`${'Town'.padEnd(20)} | ${'Total'.padStart(6)} | ${'Disc'.padStart(6)} | ${'Upload'.padStart(6)}`);
      console.log(`${'-'.repeat(20)}-+-${'-'.repeat(6)}-+-${'-'.repeat(6)}-+-${'-'.repeat(6)}`);
      
      for (const row of townRows) {
        console.log(
          `${(row.town_slug || 'unknown').padEnd(20)} | ` +
          `${String(row.total).padStart(6)} | ` +
          `${String(row.discovered || 0).padStart(6)} | ` +
          `${String(row.uploaded || 0).padStart(6)}`
        );
      }
    }

    console.log('\n📊 Recent Runs:');
    console.log('----------------------------------------');
    
    const runQuery = sql`
      SELECT id, status, started_at, completed_at, documents_discovered, documents_downloaded
      FROM crawler_runs
      ORDER BY started_at DESC
      LIMIT 5
    `;
    
    const runResults = await db.execute(runQuery);
    const runRows = runResults.rows as Array<{
      id: string;
      status: string;
      started_at: Date;
      completed_at: Date | null;
      documents_discovered: number | null;
      documents_downloaded: number | null;
    }>;

    if (runRows.length === 0) {
      console.log('  No runs yet');
    } else {
      for (const run of runRows) {
        const started = run.started_at ? new Date(run.started_at).toLocaleString() : 'unknown';
        const status = run.status || 'unknown';
        const discovered = run.documents_discovered || 0;
        const downloaded = run.documents_downloaded || 0;
        console.log(`  ${run.id?.slice(0, 8)} | ${status.padEnd(10)} | ${started} | Discovered: ${discovered} | Downloaded: ${downloaded}`);
      }
    }

    console.log(`\n💡 Total documents in system: ${total}`);
    console.log('');

  } catch (error) {
    console.error('❌ Error:', error);
    process.exit(1);
  }

  process.exit(0);
}

checkStatus();
