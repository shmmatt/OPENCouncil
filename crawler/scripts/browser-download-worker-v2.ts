#!/usr/bin/env tsx
/**
 * Browser-Based Download Worker V2 - "Session-First" for Cloudflare
 * 
 * Key improvements:
 * 1. Visits parent page (discoveredFrom) before each download to clear CF challenge
 * 2. Proper Referer headers
 * 3. Randomized jitter delays (not fixed intervals)
 * 4. Waits for CF challenge to clear before proceeding
 */

import { chromium } from 'playwright-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import type { Browser, BrowserContext, Page } from 'playwright';
import { db } from '../../server/storage/db';
import { crawlerDocuments, crawlerTowns } from '../../shared/crawler-schema';
import { eq, and, sql } from 'drizzle-orm';
import { S3Client, PutObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import { generateS3Key, extractFilename } from '../../server/services/crawlerStateExtensions';

chromium.use(StealthPlugin());

const S3_BUCKET = process.env.S3_BUCKET || 'opencouncil-municipal-docs';
const S3_REGION = process.env.AWS_REGION || 'us-east-1';
const s3 = new S3Client({ region: S3_REGION });

const MAX_RETRIES = 3;
const BASE_DELAY = 8000;  // 8s base delay
const JITTER_RANGE = 4000;  // ±4s jitter
const CF_WAIT_TIME = 5000;  // 5s wait for CF challenge

interface DownloadStats {
  total: number;
  uploaded: number;
  skipped: number;
  failed: number;
}

function randomJitter(): number {
  return BASE_DELAY + (Math.random() * 2 - 1) * JITTER_RANGE;
}

async function checkS3Exists(key: string): Promise<boolean> {
  try {
    await s3.send(new HeadObjectCommand({ Bucket: S3_BUCKET, Key: key }));
    return true;
  } catch (error: any) {
    if (error.name === 'NotFound' || error.$metadata?.httpStatusCode === 404) {
      return false;
    }
    throw error;
  }
}

async function uploadToS3(key: string, buffer: Buffer, contentType: string): Promise<void> {
  await s3.send(new PutObjectCommand({
    Bucket: S3_BUCKET,
    Key: key,
    Body: buffer,
    ContentType: contentType
  }));
}

/**
 * Wait for Cloudflare challenge to clear
 */
async function waitForCloudflare(page: Page, maxWaitMs = 15000): Promise<boolean> {
  const startTime = Date.now();
  
  while (Date.now() - startTime < maxWaitMs) {
    const content = await page.content();
    if (!content.includes('Just a moment') && !content.includes('Checking your browser')) {
      return true;  // Challenge cleared
    }
    await page.waitForTimeout(1000);
  }
  
  return false;  // Timeout waiting for CF
}

/**
 * Establish session by visiting parent page first
 */
async function establishSession(page: Page, parentUrl: string, baseUrl: string): Promise<boolean> {
  const targetUrl = parentUrl || baseUrl;
  
  try {
    await page.goto(targetUrl, { 
      waitUntil: 'domcontentloaded', 
      timeout: 30000 
    });
    
    // Wait for CF challenge to clear
    const cleared = await waitForCloudflare(page);
    if (!cleared) {
      console.log('   ⚠️  Cloudflare challenge timeout');
      return false;
    }
    
    // Let cookies settle
    await page.waitForTimeout(CF_WAIT_TIME);
    return true;
    
  } catch (error) {
    console.log(`   ⚠️  Failed to establish session: ${error}`);
    return false;
  }
}

/**
 * Download with proper session context and Referer
 */
async function downloadWithSession(
  page: Page,
  url: string,
  referer: string
): Promise<{ buffer: Buffer; contentType: string } | null> {
  
  // Set extra headers including Referer
  await page.setExtraHTTPHeaders({
    'Referer': referer,
    'Sec-Fetch-Dest': 'document',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': 'same-origin',
    'Sec-Fetch-User': '?1'
  });
  
  const isDownloadUrl = url.includes('/files/') || 
                        url.includes('/minutes/') ||
                        url.includes('/agenda/') ||
                        url.includes('/DocumentCenter/') ||
                        url.includes('/AgendaCenter/') ||
                        url.match(/\.(pdf|doc|docx|xls|xlsx)$/i);
  
  if (isDownloadUrl) {
    // For direct download URLs, intercept the download event
    const downloadPromise = page.waitForEvent('download', { timeout: 45000 });
    
    // Navigate to trigger download
    await page.goto(url, { waitUntil: 'commit', timeout: 30000 }).catch(() => {});
    
    const download = await downloadPromise;
    const path = await download.path();
    
    if (!path) {
      throw new Error('Download failed - no file path');
    }
    
    const fs = await import('fs/promises');
    const buffer = await fs.readFile(path);
    
    if (buffer.length < 100) {
      throw new Error('Document too small or empty');
    }
    
    const filename = download.suggestedFilename().toLowerCase();
    let contentType = 'application/pdf';
    if (filename.endsWith('.doc') || filename.endsWith('.docx')) {
      contentType = 'application/msword';
    } else if (filename.endsWith('.xls') || filename.endsWith('.xlsx')) {
      contentType = 'application/vnd.ms-excel';
    }
    
    return { buffer, contentType };
    
  } else {
    // Standard navigation
    const response = await page.goto(url, {
      waitUntil: 'networkidle',
      timeout: 30000
    });
    
    if (!response) throw new Error('No response received');
    
    const status = response.status();
    if (status === 404 || status === 403) {
      throw new Error(`HTTP ${status}`);
    }
    if (status >= 400) {
      throw new Error(`HTTP ${status}`);
    }
    
    const buffer = await response.body();
    if (!buffer || buffer.length < 100) {
      throw new Error('Document too small');
    }
    
    const contentType = response.headers()['content-type'] || 'application/pdf';
    return { buffer: Buffer.from(buffer), contentType };
  }
}

async function processTown(townSlug: string, limit = 100): Promise<DownloadStats> {
  const stats: DownloadStats = { total: 0, uploaded: 0, skipped: 0, failed: 0 };
  
  // Get town
  const [town] = await db.select().from(crawlerTowns).where(eq(crawlerTowns.slug, townSlug));
  if (!town) {
    console.error(`❌ Town not found: ${townSlug}`);
    return stats;
  }
  
  // Get pending docs
  const docs = await db.select()
    .from(crawlerDocuments)
    .where(and(
      eq(crawlerDocuments.townId, town.id),
      eq(crawlerDocuments.status, 'discovered')
    ))
    .limit(limit);
  
  if (docs.length === 0) {
    console.log(`✅ No pending documents for ${townSlug}`);
    return stats;
  }
  
  console.log(`\n${'═'.repeat(70)}`);
  console.log(`🏛️  ${town.name} - Session-First Downloads`);
  console.log(`🌐 ${town.url}`);
  console.log(`📄 Documents to process: ${docs.length}`);
  console.log('═'.repeat(70));
  
  // Launch browser with stealth
  const browser = await chromium.launch({ 
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });
  
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    viewport: { width: 1920, height: 1080 },
    locale: 'en-US'
  });
  
  const page = await context.newPage();
  
  // Initial session establishment
  console.log(`\n🔐 Establishing initial session...`);
  await establishSession(page, town.url || '', town.url || '');
  
  // Derive parent page from URL structure
  function getParentUrl(url: string, baseUrl: string): string {
    try {
      const u = new URL(url);
      const baseHost = new URL(baseUrl).host;
      
      // If URL is external (different domain), use base URL
      if (u.host !== baseHost) {
        return baseUrl;
      }
      
      const pathParts = u.pathname.split('/').filter(Boolean);
      
      // For URLs like /about-us/files/doc, parent is /about-us
      if (pathParts.length >= 2 && (pathParts[1] === 'files' || pathParts[1] === 'minutes' || pathParts[1] === 'agenda')) {
        return `${u.origin}/${pathParts[0]}`;
      }
      if (pathParts.length > 1) {
        return `${u.origin}/${pathParts.slice(0, -1).join('/')}`;
      }
      return baseUrl;
    } catch {
      return baseUrl;
    }
  }
  
  // Group docs by their parent page for efficient session reuse
  const docsByParent = new Map<string, typeof docs>();
  for (const doc of docs) {
    const parent = getParentUrl(doc.url, town.url || '');
    if (!docsByParent.has(parent)) {
      docsByParent.set(parent, []);
    }
    docsByParent.get(parent)!.push(doc);
  }
  
  console.log(`📂 Grouped into ${docsByParent.size} parent pages\n`);
  
  let docIndex = 0;
  
  for (const [parentUrl, parentDocs] of docsByParent) {
    // Establish session for this parent page
    console.log(`\n🔗 Session: ${parentUrl.substring(0, 60)}...`);
    let sessionOk = await establishSession(page, parentUrl, town.url || '');
    
    // Fallback to base URL if parent fails
    if (!sessionOk && parentUrl !== town.url) {
      console.log(`   🔄 Fallback to base URL...`);
      sessionOk = await establishSession(page, town.url || '', town.url || '');
    }
    
    if (!sessionOk) {
      console.log(`   ⚠️  Skipping ${parentDocs.length} docs due to session failure`);
      stats.failed += parentDocs.length;
      continue;
    }
    
    for (const doc of parentDocs) {
      docIndex++;
      stats.total++;
      
      const filename = doc.filename || extractFilename(doc.url);
      const s3Key = generateS3Key({
        town: town.slug,
        url: doc.url,
        filename,
        discoveredFrom: doc.discoveredFrom
      });
      
      // Check S3 first
      if (await checkS3Exists(s3Key)) {
        console.log(`[${docIndex}/${docs.length}] ⏭️  ${filename} (exists)`);
        await db.update(crawlerDocuments)
          .set({ status: 'uploaded', s3Key, s3UploadedAt: new Date(), updatedAt: new Date() })
          .where(eq(crawlerDocuments.id, doc.id));
        stats.skipped++;
        continue;
      }
      
      // Download with retries
      console.log(`[${docIndex}/${docs.length}] ⬇️  ${filename}...`);
      
      let success = false;
      for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        try {
          const result = await downloadWithSession(page, doc.url, parentUrl);
          
          if (result) {
            // Upload to S3
            await uploadToS3(s3Key, result.buffer, result.contentType);
            
            // Update DB
            await db.update(crawlerDocuments)
              .set({
                status: 'uploaded',
                s3Key,
                s3UploadedAt: new Date(),
                sizeBytes: result.buffer.length,
                mimeType: result.contentType,
                updatedAt: new Date()
              })
              .where(eq(crawlerDocuments.id, doc.id));
            
            console.log(`[${docIndex}/${docs.length}] ✅ ${filename} (${Math.round(result.buffer.length/1024)}KB)`);
            stats.uploaded++;
            success = true;
            break;
          }
        } catch (error: any) {
          const msg = error.message || 'Unknown error';
          
          // Don't retry 404/403
          if (msg.includes('404') || msg.includes('403')) {
            console.log(`[${docIndex}/${docs.length}] ❌ ${filename}: ${msg}`);
            await db.update(crawlerDocuments)
              .set({ status: 'failed', errorMessage: msg, updatedAt: new Date() })
              .where(eq(crawlerDocuments.id, doc.id));
            stats.failed++;
            success = true;
            break;
          }
          
          if (attempt < MAX_RETRIES) {
            const delay = Math.pow(2, attempt) * 2000;
            console.log(`   ⏳ Retry ${attempt}/${MAX_RETRIES} in ${delay/1000}s...`);
            await page.waitForTimeout(delay);
            
            // Re-establish session before retry
            await establishSession(page, parentUrl, town.url || '');
          }
        }
      }
      
      if (!success) {
        console.log(`[${docIndex}/${docs.length}] ❌ ${filename}: Failed after ${MAX_RETRIES} retries`);
        await db.update(crawlerDocuments)
          .set({ status: 'failed', errorMessage: 'Max retries exceeded', updatedAt: new Date() })
          .where(eq(crawlerDocuments.id, doc.id));
        stats.failed++;
      }
      
      // Random jitter delay between downloads
      const jitterDelay = randomJitter();
      await page.waitForTimeout(jitterDelay);
    }
  }
  
  await browser.close();
  
  console.log(`\n${'═'.repeat(70)}`);
  console.log(`📊 FINAL SUMMARY`);
  console.log('═'.repeat(70));
  console.log(`✅ Total processed: ${stats.total}`);
  console.log(`📤 Uploaded: ${stats.uploaded}`);
  console.log(`⏭️  Skipped: ${stats.skipped}`);
  console.log(`❌ Failed: ${stats.failed}`);
  
  return stats;
}

// Main
const townSlug = process.argv[2];
const limit = parseInt(process.argv[3] || '50', 10);

if (!townSlug) {
  console.log('Usage: browser-download-worker-v2.ts <town-slug> [limit]');
  console.log('Example: browser-download-worker-v2.ts brookfield 50');
  process.exit(1);
}

processTown(townSlug, limit)
  .then(() => process.exit(0))
  .catch(e => {
    console.error(e);
    process.exit(1);
  });
