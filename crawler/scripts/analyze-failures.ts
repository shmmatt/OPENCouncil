#!/usr/bin/env tsx
/**
 * Analyze download failures to inform retry strategy
 */

import { db, sql } from '../server/storage/db';

async function analyzeFailures() {
  console.log('======================================================================');
  console.log('❌ Download Failure Analysis');
  console.log('======================================================================\n');

  // Get failure statistics
  const failureStats = await db.execute(sql`
    SELECT 
      COUNT(*) as total,
      error_message
    FROM crawler_documents
    WHERE status = 'failed'
    GROUP BY error_message
    ORDER BY total DESC
  `);

  const rows = failureStats.rows as Array<{ total: string; error_message: string }>;
  
  console.log('📊 Failures by Error Type:\n');
  let totalFailures = 0;
  
  for (const row of rows) {
    const count = Number(row.total);
    totalFailures += count;
    const message = row.error_message || 'Unknown';
    console.log(`  ${String(count).padStart(4)} - ${message}`);
  }
  
  console.log(`\n  Total: ${totalFailures} failures\n`);

  // Get failures by domain
  const domainQuery = await db.execute(sql`
    SELECT 
      SUBSTRING(url FROM 'https?://([^/]+)') as domain,
      COUNT(*) as count,
      error_message
    FROM crawler_documents
    WHERE status = 'failed'
    GROUP BY domain, error_message
    ORDER BY count DESC
    LIMIT 20
  `);

  const domainRows = domainQuery.rows as Array<{
    domain: string;
    count: string;
    error_message: string;
  }>;

  console.log('🌐 Top Failing Domains:\n');
  console.log(`${'Domain'.padEnd(30)} | ${'Count'.padStart(5)} | Error`);
  console.log(`${'-'.repeat(30)}-+-${'-'.repeat(5)}-+-------`);
  
  for (const row of domainRows.slice(0, 15)) {
    const domain = row.domain || 'unknown';
    const count = Number(row.count);
    const error = row.error_message?.substring(0, 40) || 'Unknown';
    console.log(`${domain.padEnd(30)} | ${String(count).padStart(5)} | ${error}`);
  }

  // Categorize by HTTP status
  const statusQuery = await db.execute(sql`
    SELECT 
      CASE 
        WHEN error_message LIKE '%403%' THEN '403 Forbidden'
        WHEN error_message LIKE '%404%' THEN '404 Not Found'
        WHEN error_message LIKE '%503%' THEN '503 Service Unavailable'
        WHEN error_message LIKE '%timeout%' THEN 'Timeout'
        ELSE 'Other'
      END as error_category,
      COUNT(*) as count
    FROM crawler_documents
    WHERE status = 'failed'
    GROUP BY error_category
    ORDER BY count DESC
  `);

  const statusRows = statusQuery.rows as Array<{
    error_category: string;
    count: string;
  }>;

  console.log('\n\n📋 Failures by HTTP Status:\n');
  
  for (const row of statusRows) {
    const category = row.error_category;
    const count = Number(row.count);
    const pct = ((count / totalFailures) * 100).toFixed(1);
    console.log(`  ${category.padEnd(25)} ${String(count).padStart(4)} (${pct}%)`);
  }

  // Recommended strategies
  console.log('\n\n💡 Recommended Retry Strategies:\n');
  
  for (const row of statusRows) {
    const category = row.error_category;
    const count = Number(row.count);
    
    if (category === '403 Forbidden') {
      console.log(`  ${count}× 403 Forbidden → Use browser automation (Playwright)`);
    } else if (category === '503 Service Unavailable') {
      console.log(`  ${count}× 503 Service Unavailable → Add per-domain rate limiting + exponential backoff`);
    } else if (category === '404 Not Found') {
      console.log(`  ${count}× 404 Not Found → Attempt URL corrections (.pdf.pdf, case, etc.)`);
    } else if (category === 'Timeout') {
      console.log(`  ${count}× Timeout → Increase timeout, add retry with backoff`);
    }
  }

  console.log('\n📖 See docs/DOWNLOAD-FAILURE-STRATEGIES.md for detailed implementation\n');
}

analyzeFailures()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error('Error:', error);
    process.exit(1);
  });
