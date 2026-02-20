#!/usr/bin/env tsx
/**
 * Document Crawler V3 - Robust & Simple
 * 
 * Core principles:
 * - Multiple parallel discovery strategies
 * - Simple extraction (all links, filter after)
 * - Clear visibility on every page
 * - Built-in verification
 * - State tracking integration (records to database)
 */

import { chromium } from 'playwright-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import { promises as fs } from 'fs';
import * as path from 'path';
import type { Page, Browser } from 'playwright';

// State tracking integration
import { ensureTown, slugify, extractFilename } from '../server/services/crawlerStateExtensions';
import { recordDocument, hashUrl, createRun, completeRun } from '../server/services/crawlerState';
import { classifyError, type FailureType, type CrawlRunSummary } from '../shared/crawler-schema';

chromium.use(StealthPlugin());

interface CrawlConfig {
  town: string;
  url: string;
  maxPages?: number;
  timeout?: number;
  enableStateTracking?: boolean;
  existingRunId?: string;
}

interface CrawlResult {
  town: string;
  url: string;
  documentsFound: number;
  pagesVisited: number;
  strategies: {
    sitemap: number;
    crawl: number;
    knownPaths: number;
  };
  duration: number;
  documents: string[];
}

// ==================== UTILITIES ====================

function normalizeUrl(url: string): string {
  try {
    const u = new URL(url);
    u.hash = '';
    return u.href;
  } catch {
    return url;
  }
}

function isDocumentLink(url: string): boolean {
  const lower = url.toLowerCase();
  
  // Document file extensions
  const docExts = ['.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx'];
  if (docExts.some(ext => lower.includes(ext))) return true;
  
  // CivicPlus patterns
  if (lower.includes('/viewfile/')) return true;
  if (lower.includes('/agendacenter/viewfile/')) return true;
  if (lower.includes('/documentcenter/view/')) return true;
  if (lower.includes('/formcenter/view/')) return true;
  
  // WordPress uploads
  if (lower.includes('/wp-content/uploads/')) return true;
  
  // Common document paths
  if (lower.match(/\/(documents?|files?|downloads?)\//)) return true;
  if (lower.match(/\/download\//)) return true;
  
  return false;
}

function isNavigationLink(url: string, baseHostname: string): boolean {
  try {
    const u = new URL(url);
    
    // Must be same domain
    if (u.hostname !== baseHostname) return false;
    
    // Skip anchors, javascript, mailto, tel
    if (u.hash && !u.pathname) return false;
    if (url.startsWith('javascript:')) return false;
    if (url.startsWith('mailto:')) return false;
    if (url.startsWith('tel:')) return false;
    
    // Skip document links
    if (isDocumentLink(url)) return false;
    
    // Skip common non-content paths
    const skipPatterns = ['/search', '/login', '/account', '/cart', '/checkout'];
    if (skipPatterns.some(p => u.pathname.toLowerCase().includes(p))) return false;
    
    return true;
  } catch {
    return false;
  }
}

// ==================== DISCOVERY STRATEGIES ====================

async function discoverViaSitemap(baseUrl: string): Promise<string[]> {
  const urls: string[] = [];
  
  try {
    const sitemapUrl = `${baseUrl}/sitemap.xml`;
    const response = await fetch(sitemapUrl);
    
    if (!response.ok) {
      console.log(`   [Sitemap] Not found or error`);
      return urls;
    }
    
    const xml = await response.text();
    
    // Extract URLs from sitemap
    const urlMatches = xml.matchAll(/<loc>([^<]+)<\/loc>/g);
    for (const match of urlMatches) {
      urls.push(match[1]);
    }
    
    // Check for sitemap index
    if (xml.includes('<sitemapindex')) {
      const sitemapMatches = xml.matchAll(/<loc>([^<]+)<\/loc>/g);
      for (const match of sitemapMatches) {
        try {
          const subResponse = await fetch(match[1]);
          if (subResponse.ok) {
            const subXml = await subResponse.text();
            const subUrlMatches = subXml.matchAll(/<loc>([^<]+)<\/loc>/g);
            for (const subMatch of subUrlMatches) {
              urls.push(subMatch[1]);
            }
          }
        } catch {}
      }
    }
    
    console.log(`   [Sitemap] Found ${urls.length} URLs`);
  } catch (error) {
    console.log(`   [Sitemap] Error: ${error instanceof Error ? error.message : 'Unknown'}`);
  }
  
  return [...new Set(urls)];
}

async function discoverViaKnownPaths(baseUrl: string, page: Page): Promise<string[]> {
  const urls: string[] = [];
  
  // Common document hub paths
  const knownPaths = [
    '/agendacenter',
    '/documentcenter',
    '/formcenter',
    '/documents',
    '/meetings',
    '/agendas',
    '/minutes',
    '/boards',
    '/committees',
    '/forms',
    '/downloads',
    '/public-notices'
  ];
  
  console.log(`   [KnownPaths] Checking ${knownPaths.length} common paths...`);
  
  for (const path of knownPaths) {
    const testUrl = `${baseUrl}${path}`;
    
    try {
      const response = await page.goto(testUrl, { 
        waitUntil: 'domcontentloaded',
        timeout: 10000 
      });
      
      if (response?.status() === 200) {
        urls.push(testUrl);
        console.log(`   [KnownPaths] ✓ ${path}`);
      }
    } catch {
      // 404 or timeout - skip
    }
  }
  
  console.log(`   [KnownPaths] Found ${urls.length} valid paths`);
  return urls;
}

async function extractAllLinks(page: Page): Promise<string[]> {
  // Simple: get ALL links from the page
  const links = await page.$$eval('a[href]', (anchors) => {
    return anchors.map(a => (a as HTMLAnchorElement).href);
  });
  
  return links;
}

interface PageCrawlResult {
  docs: string[];
  nav: string[];
  error?: { url: string; error: string; failureType: FailureType };
}

async function crawlPageForLinks(page: Page, url: string, baseHostname: string): Promise<PageCrawlResult> {
  const docs: string[] = [];
  const nav: string[] = [];
  
  try {
    const response = await page.goto(url, {
      waitUntil: 'domcontentloaded',
      timeout: 15000
    });
    
    if (!response || response.status() >= 400) {
      const status = response?.status() || 0;
      const failureType = classifyError(`HTTP ${status}`);
      return { docs, nav, error: { url, error: `HTTP ${status}`, failureType } };
    }
    
    // Wait a bit for JS to render
    await page.waitForTimeout(2000);
    
    // Extract all links (simple, no complex logic)
    const allLinks = await extractAllLinks(page);
    
    // Filter in Node (debuggable!)
    for (const link of allLinks) {
      const normalized = normalizeUrl(link);
      
      if (isDocumentLink(normalized)) {
        docs.push(normalized);
      } else if (isNavigationLink(normalized, baseHostname)) {
        nav.push(normalized);
      }
    }
    
    console.log(`   ${url}`);
    console.log(`      Links: ${allLinks.length} total | Docs: ${docs.length} | Nav: ${nav.length}`);
    
  } catch (error) {
    const failureType = classifyError(error);
    const errMsg = error instanceof Error ? error.message : 'Unknown';
    console.log(`   ${url}`);
    console.log(`      Error [${failureType}]: ${errMsg}`);
    return { docs, nav, error: { url, error: errMsg, failureType } };
  }
  
  return { docs, nav };
}

// ==================== MAIN CRAWLER ====================

let activeRunId: string | null = null;

async function markRunFailed(reason: string): Promise<void> {
  if (activeRunId) {
    try {
      await completeRun(activeRunId, 'failed', undefined, reason);
      console.log(`   Run ${activeRunId} marked as failed: ${reason}`);
    } catch (e) {
      console.error(`   Could not mark run ${activeRunId} as failed:`, e);
    }
    activeRunId = null;
  }
}

process.on('SIGINT', async () => {
  console.log('\nReceived SIGINT');
  await markRunFailed('Process interrupted (SIGINT)');
  process.exit(1);
});

process.on('SIGTERM', async () => {
  console.log('\nReceived SIGTERM');
  await markRunFailed('Process terminated (SIGTERM)');
  process.exit(1);
});

process.on('uncaughtException', async (err) => {
  console.error('\nUncaught exception:', err);
  await markRunFailed(`Uncaught exception: ${err.message}`);
  process.exit(1);
});

process.on('unhandledRejection', async (reason) => {
  console.error('\nUnhandled rejection:', reason);
  const msg = reason instanceof Error ? reason.message : String(reason);
  await markRunFailed(`Unhandled rejection: ${msg}`);
  process.exit(1);
});

async function crawl(config: CrawlConfig): Promise<CrawlResult> {
  const startTime = Date.now();
  const { town, url: baseUrl, maxPages = 200, timeout = 30, enableStateTracking = true, existingRunId } = config;
  
  console.log('\n' + '='.repeat(70));
  console.log(`🏛️  ${town}`);
  console.log(`🌐 ${baseUrl}`);
  console.log(`📄 Max pages: ${maxPages}`);
  if (enableStateTracking) {
    console.log(`💾 State tracking: ENABLED`);
  }
  if (existingRunId) {
    console.log(`💾 Using existing run: ${existingRunId}`);
  }
  console.log('='.repeat(70) + '\n');
  
  // ==================== STATE TRACKING SETUP ====================
  let townRecord: any = null;
  let runId: string | null = null;
  
  if (enableStateTracking) {
    try {
      console.log('💾 Initializing state tracking...');
      townRecord = await ensureTown({
        name: town,
        slug: slugify(town),
        url: baseUrl,
        status: 'active',
        county: 'Carroll'
      });
      
      if (existingRunId) {
        runId = existingRunId;
        activeRunId = runId;
        console.log(`   ✓ Town: ${townRecord.slug} (${townRecord.id})`);
        console.log(`   ✓ Run (existing): ${runId}\n`);
      } else {
        const run = await createRun({
          townId: townRecord.id,
          mode: 'full',
          triggerType: 'manual',
          startedAt: new Date(),
          status: 'running'
        });
        runId = run.id;
        activeRunId = runId;
        console.log(`   ✓ Town: ${townRecord.slug} (${townRecord.id})`);
        console.log(`   ✓ Run (new): ${runId}\n`);
      }
    } catch (error) {
      console.error('⚠️  State tracking initialization failed:', error);
      console.log('   Continuing without state tracking...\n');
      townRecord = null;
      runId = null;
      activeRunId = null;
    }
  }
  
  let browser: Browser | null = null;
  const discoveredDocs = new Set<string>();
  const visitedUrls = new Set<string>();
  const toVisit = new Set<string>();
  const pageErrors: Array<{ url: string; error: string; failureType: FailureType }> = [];
  const failureCounts: Partial<Record<FailureType, number>> = {};
  
  const strategyStats = {
    sitemap: 0,
    crawl: 0,
    knownPaths: 0
  };
  
  try {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      viewport: { width: 1920, height: 1080 }
    });
    
    const baseHostname = new URL(baseUrl).hostname;
    
    // ==================== STRATEGY 1: SITEMAP ====================
    console.log('📍 Strategy 1: Sitemap Discovery');
    const sitemapUrls = await discoverViaSitemap(baseUrl);
    sitemapUrls.forEach(u => toVisit.add(u));
    
    // ==================== STRATEGY 2: KNOWN PATHS ====================
    console.log('\n📍 Strategy 2: Known Document Paths');
    const knownPathUrls = await discoverViaKnownPaths(baseUrl, page);
    knownPathUrls.forEach(u => toVisit.add(u));
    strategyStats.knownPaths = knownPathUrls.length;
    
    // ==================== STRATEGY 3: BREADTH-FIRST CRAWL ====================
    console.log('\n📍 Strategy 3: Breadth-First Link Crawl');
    
    const priorityUrls: string[] = [];
    const regularUrls: string[] = [];
    
    Array.from(toVisit).forEach(url => {
      const lower = url.toLowerCase();
      if (lower.includes('agenda') || lower.includes('document') || lower.includes('form') || 
          lower.includes('meeting') || lower.includes('minute') || lower.includes('board')) {
        priorityUrls.push(url);
      } else {
        regularUrls.push(url);
      }
    });
    
    const urlQueue = [baseUrl, ...priorityUrls, ...regularUrls];
    let queueIndex = 0;
    
    while (queueIndex < urlQueue.length && visitedUrls.size < maxPages) {
      const currentUrl = urlQueue[queueIndex++];
      
      if (visitedUrls.has(currentUrl)) continue;
      visitedUrls.add(currentUrl);
      
      const result = await crawlPageForLinks(page, currentUrl, baseHostname);
      
      if (result.error) {
        pageErrors.push(result.error);
        failureCounts[result.error.failureType] = (failureCounts[result.error.failureType] || 0) + 1;
      }
      
      result.docs.forEach(doc => {
        if (!discoveredDocs.has(doc)) {
          discoveredDocs.add(doc);
          strategyStats.crawl++;
        }
      });
      
      result.nav.forEach(navUrl => {
        if (!visitedUrls.has(navUrl) && !toVisit.has(navUrl)) {
          toVisit.add(navUrl);
          urlQueue.push(navUrl);
        }
      });
      
      if (visitedUrls.size % 20 === 0) {
        console.log(`\n   Progress: ${visitedUrls.size}/${maxPages} pages | ${discoveredDocs.size} docs`);
      }
    }
  } catch (crawlError) {
    const errorMsg = crawlError instanceof Error ? crawlError.message : String(crawlError);
    const fatalType = classifyError(crawlError);
    console.error(`\nCrawl failed [${fatalType}]: ${errorMsg}`);
    
    failureCounts[fatalType] = (failureCounts[fatalType] || 0) + 1;
    
    if (runId) {
      const summary: CrawlRunSummary = {
        byCategory: {},
        byBoard: {},
        newDocuments: 0,
        duplicates: 0,
        errors: pageErrors.slice(0, 100),
        failuresByType: Object.keys(failureCounts).length > 0 ? (failureCounts as Record<FailureType, number>) : undefined,
        pagesVisited: visitedUrls.size,
        documentsDiscovered: discoveredDocs.size,
        averageDocsPerPage: visitedUrls.size > 0 ? discoveredDocs.size / visitedUrls.size : 0,
      };
      await completeRun(runId, 'failed', summary, errorMsg);
      activeRunId = null;
      console.log(`   Run ${runId} marked as failed\n`);
    }
    
    throw crawlError;
  } finally {
    if (browser) {
      try { await browser.close(); } catch {}
    }
  }
  
  const duration = (Date.now() - startTime) / 1000;
  
  // ==================== RESULTS ====================
  console.log('\n' + '='.repeat(70));
  console.log('📊 RESULTS');
  console.log('='.repeat(70));
  console.log(`✅ Documents found: ${discoveredDocs.size}`);
  console.log(`📄 Pages visited: ${visitedUrls.size}`);
  console.log(`⏱️  Duration: ${duration.toFixed(1)}s`);
  console.log('\n📊 Discovery by Strategy:');
  console.log(`   Sitemap: ${strategyStats.sitemap}`);
  console.log(`   Known Paths: ${strategyStats.knownPaths}`);
  console.log(`   Breadth-First Crawl: ${strategyStats.crawl}`);
  
  if (pageErrors.length > 0) {
    console.log(`\n⚠️  Page Errors: ${pageErrors.length}`);
    const sortedTypes = Object.entries(failureCounts).sort((a, b) => b[1] - a[1]);
    for (const [type, count] of sortedTypes) {
      console.log(`   ${type}: ${count}`);
    }
  }
  
  // ==================== STATE TRACKING: RECORD DOCUMENTS ====================
  if (townRecord && runId) {
    console.log('\n💾 Recording documents to database...');
    
    let recorded = 0;
    let skipped = 0;
    
    for (const docUrl of discoveredDocs) {
      try {
        const filename = extractFilename(docUrl);
        
        await recordDocument({
          townId: townRecord.id,
          url: docUrl,
          urlHash: hashUrl(docUrl),
          filename,
          discoveredAt: new Date(),
          discoveredFrom: baseUrl,
          status: 'discovered'
        });
        
        recorded++;
        
        if (recorded % 100 === 0) {
          console.log(`   Recorded ${recorded}/${discoveredDocs.size} documents...`);
        }
      } catch (error) {
        skipped++;
      }
    }
    
    console.log(`   ✓ Recorded ${recorded} documents`);
    if (skipped > 0) {
      console.log(`   ⏭️  Skipped ${skipped} (already in database)`);
    }
    
    const runSummary: CrawlRunSummary = {
      byCategory: {},
      byBoard: {},
      newDocuments: recorded,
      duplicates: skipped,
      errors: pageErrors.slice(0, 100),
      failuresByType: Object.keys(failureCounts).length > 0 ? failureCounts as Record<FailureType, number> : undefined,
      pagesVisited: visitedUrls.size,
      documentsDiscovered: discoveredDocs.size,
      averageDocsPerPage: visitedUrls.size > 0 ? discoveredDocs.size / visitedUrls.size : 0,
    };
    await completeRun(runId, 'completed', runSummary);
    activeRunId = null;
    
    console.log(`   ✓ Run completed: ${runId}\n`);
  }
  
  return {
    town,
    url: baseUrl,
    documentsFound: discoveredDocs.size,
    pagesVisited: visitedUrls.size,
    strategies: strategyStats,
    duration,
    documents: Array.from(discoveredDocs)
  };
}

// ==================== VERIFICATION ====================

async function verifyAgainstS3(town: string, discovered: number): Promise<void> {
  // Known S3 baselines for testing
  const s3Baselines: Record<string, number> = {
    'Moultonborough': 263,
    'Madison': 1398,
    'Ossipee': 655,
    'Wolfeboro': 291
  };
  
  const expected = s3Baselines[town];
  if (!expected) {
    console.log('\n⚠️  No S3 baseline for verification');
    return;
  }
  
  const coverage = (discovered / expected) * 100;
  
  console.log('\n' + '='.repeat(70));
  console.log('🔍 VERIFICATION');
  console.log('='.repeat(70));
  console.log(`Expected (S3): ${expected} documents`);
  console.log(`Discovered: ${discovered} documents`);
  console.log(`Coverage: ${coverage.toFixed(1)}%`);
  
  if (coverage >= 90) {
    console.log('✅ EXCELLENT - 90%+ coverage');
  } else if (coverage >= 75) {
    console.log('⚠️  GOOD - 75%+ coverage, room for improvement');
  } else if (coverage >= 50) {
    console.log('⚠️  FAIR - 50%+ coverage, needs investigation');
  } else {
    console.log('❌ POOR - <50% coverage, major issues');
  }
}

// ==================== CLI ====================

function parseArgs(argv: string[]): { town: string; url: string; maxPages: number; runId?: string; mode?: string } {
  const args = argv.slice(2);
  
  const named: Record<string, string> = {};
  const positional: string[] = [];
  
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--') && i + 1 < args.length) {
      const key = args[i].slice(2);
      named[key] = args[++i];
    } else {
      positional.push(args[i]);
    }
  }
  
  const town = named['town'] || positional[0];
  const url = named['url'] || positional[1];
  const maxPages = parseInt(named['max-pages'] || positional[2] || '200');
  const runId = named['run-id'];
  const mode = named['mode'];
  
  if (!town || !url) {
    console.log('Usage: crawler-v3.ts --town <name> --url <url> [--max-pages N] [--run-id ID] [--mode full|incremental]');
    console.log('   or: crawler-v3.ts <town-name> <url> [max-pages]');
    process.exit(1);
  }
  
  return { town, url, maxPages, runId, mode };
}

async function main() {
  const { town, url, maxPages, runId: existingRunId } = parseArgs(process.argv);
  
  if (existingRunId) {
    activeRunId = existingRunId;
  }
  
  const result = await crawl({ town, url, maxPages, existingRunId });
  
  await verifyAgainstS3(town, result.documentsFound);
  
  const resultsDir = path.join(process.cwd(), 'crawl-logs');
  await fs.mkdir(resultsDir, { recursive: true });
  
  const resultsFile = path.join(resultsDir, `v3-${town.toLowerCase()}-${Date.now()}.json`);
  await fs.writeFile(resultsFile, JSON.stringify(result, null, 2));
  
  console.log(`\n💾 Results saved: ${resultsFile}`);
  
  process.exit(0);
}

main().catch(async (err) => {
  console.error('Fatal error:', err);
  await markRunFailed(`Fatal error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
