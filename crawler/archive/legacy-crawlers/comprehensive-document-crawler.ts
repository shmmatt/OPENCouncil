/**
 * Comprehensive Document Crawler
 * 
 * Generalizable multi-strategy crawler for extracting PDFs from any town website.
 * 
 * Strategies (in order):
 * 1. TownCloud API detection
 * 2. Direct page scraping (documents, minutes, agendas pages)
 * 3. Google Drive folder recursion
 * 4. Common CMS patterns
 * 5. Sitemap parsing
 * 6. Deep link following
 * 
 * Designed to adapt to different CMS platforms without overfitting to specific towns.
 * 
 * Usage:
 *   npm run crawl:docs -- --town Conway --url https://conwaynh.gov/
 *   npm run crawl:docs -- --town Conway --url https://conwaynh.gov/ --dry-run
 */

import * as fs from "fs/promises";
import * as path from "path";
import { program } from "commander";
import { chromium, Browser, Page } from "playwright";
import { S3Client, PutObjectCommand, HeadObjectCommand } from "@aws-sdk/client-s3";

const S3_BUCKET = process.env.S3_BUCKET || "opencouncil-municipal-docs";
const S3_REGION = process.env.AWS_REGION || "us-east-1";
const TEMP_DIR = "/tmp/opencouncil-docs";

const s3 = new S3Client({ region: S3_REGION });

interface CrawlOptions {
  town: string;
  url: string;
  maxDocuments?: number;
  dryRun?: boolean;
  skipExisting?: boolean;
}

interface CrawlStats {
  discovered: Set<string>;
  downloaded: number;
  uploaded: number;
  skipped: number;
  failed: number;
  byCategory: { [key: string]: number };
  byStrategy: { [key: string]: number };
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

// ==================== HELPERS ====================

function normalizeUrl(url: string): string {
  try {
    const parsed = new URL(url);
    // Remove query params and anchors for deduplication
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return url;
  }
}

async function saveProgress(town: string, discovered: string[]): Promise<void> {
  try {
    const checkpointPath = path.join(TEMP_DIR, `${town}-checkpoint.json`);
    await fs.mkdir(TEMP_DIR, { recursive: true });
    await fs.writeFile(checkpointPath, JSON.stringify(discovered, null, 2));
  } catch (error) {
    // Non-critical, continue
  }
}

async function loadProgress(town: string): Promise<string[] | null> {
  try {
    const checkpointPath = path.join(TEMP_DIR, `${town}-checkpoint.json`);
    const data = await fs.readFile(checkpointPath, 'utf-8');
    return JSON.parse(data);
  } catch {
    return null;
  }
}

function chunk<T>(array: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < array.length; i += size) {
    chunks.push(array.slice(i, i + size));
  }
  return chunks;
}

// Document categorization patterns (generalizable)
const CATEGORY_PATTERNS = {
  minutes: /minutes?|mtg/i,
  agenda: /agenda/i,
  budget: /budget|financial|warrant|appropriation/i,
  ordinance: /ordinance|regulation|bylaw/i,
  zoning: /zoning|land\s*use/i,
  planning: /planning|site\s*plan|master\s*plan/i,
  election: /election|ballot|vote/i,
  form: /form|application|permit/i,
  report: /annual\s*report|town\s*report/i,
  audit: /audit/i,
  tax: /tax\s*rate|assessment/i,
};

function categorizeDocument(url: string, filename: string): string {
  const combined = `${url} ${filename}`.toLowerCase();
  for (const [category, pattern] of Object.entries(CATEGORY_PATTERNS)) {
    if (pattern.test(combined)) return category;
  }
  return 'misc';
}

function extractYear(text: string): string | undefined {
  const yearMatch = text.match(/20\d{2}/);
  return yearMatch ? yearMatch[0] : undefined;
}

function sanitizeFilename(filename: string): string {
  return filename
    .replace(/[^a-zA-Z0-9._-]/g, '_')
    .replace(/_+/g, '_')
    .substring(0, 200);
}

// ==================== STRATEGY 1: TownCloud API ====================

async function detectTownCloudPages(baseUrl: string): Promise<string[]> {
  try {
    const response = await fetch(`${baseUrl}/pages/all-pages.json`, { 
      signal: AbortSignal.timeout(10000) 
    });
    if (response.ok) {
      const data = await response.json();
      if (data.Pages && Array.isArray(data.Pages)) {
        return data.Pages.map((p: any) => `${baseUrl}/${p.slug}`);
      }
    }
  } catch (error) {
    // Not TownCloud or API unavailable
  }
  return [];
}

// ==================== STRATEGY 2: Direct Document Page Scraping ====================

/**
 * High-value pages that commonly contain documents
 * Includes common CMS patterns (case-insensitive matching)
 */
const HIGH_VALUE_PATHS = [
  '/documents',
  '/minutes',
  '/agendas',
  '/boards',
  '/forms',
  '/reports',
  // CivicPlus patterns
  '/AgendaCenter',
  '/FormCenter',
  '/DocumentCenter',
  // Alternative spellings/patterns
  '/downloads',
  '/ordinances',
  '/regulations',
];

async function extractDocumentLinks(page: Page, baseUrl: string): Promise<string[]> {
  const base = baseUrl.replace(/\/$/, '');
  const links = await page.evaluate((baseArg) => {
    const urls = [];
    const docExts = ['.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.txt', '.rtf'];
    const curr = window.location.href;
    
    document.querySelectorAll('a[href]').forEach((link) => {
      let href = link.getAttribute('href');
      if (!href || href.startsWith('#') || href.startsWith('javascript:') || 
          href.startsWith('mailto:') || href.startsWith('tel:')) return;
      
      // Make absolute
      try {
        const u = new URL(href, curr);
        const bHost = new URL(baseArg).hostname;
        if (u.hostname !== bHost) return;
        href = u.href;
      } catch {
        return;
      }
      
      const low = href.toLowerCase();
      
      // Check patterns
      if (docExts.some(ext => low.includes(ext)) ||
          href.includes('/wp-content/uploads/') ||
          href.includes('/AgendaCenter/ViewFile/') ||
          href.includes('/DocumentCenter/View/') ||
          href.includes('/FormCenter/')) {
        urls.push(href);
      }
    });
    
    // Check iframes/embeds
    document.querySelectorAll('iframe[src], embed[src], object[data]').forEach((el) => {
      const src = el.getAttribute('src') || el.getAttribute('data');
      if (src && docExts.some(ext => src.toLowerCase().includes(ext))) {
        try {
          const u = new URL(src, curr);
          if (u.hostname === new URL(baseArg).hostname) urls.push(u.href);
        } catch {}
      }
    });
    
    return [...new Set(urls)];
  }, base);
  
  return links;
}

/**
 * Strategy: Homepage keyword link discovery
 * Finds links on the homepage that contain document-related keywords
 */
async function discoverKeywordLinks(page: Page, baseUrl: string): Promise<string[]> {
  const links = await page.evaluate((base: string) => {
    const keywords = [
      'agenda', 'minute', 'form', 'ordinance', 'download', 'document',
      'regulation', 'policy', 'report', 'budget'
    ];
    const urls: string[] = [];
    
    document.querySelectorAll('a[href]').forEach(link => {
      const href = link.getAttribute('href');
      const text = (link.textContent || '').toLowerCase();
      const hrefLower = (href || '').toLowerCase();
      
      if (href && keywords.some(kw => hrefLower.includes(kw) || text.includes(kw))) {
        let fullUrl = href;
        if (href.startsWith('/')) {
          fullUrl = base + href;
        } else if (!href.startsWith('http')) {
          fullUrl = base + '/' + href;
        }
        
        // Same domain only
        try {
          const baseHost = new URL(base).hostname;
          const linkHost = new URL(fullUrl).hostname;
          if (baseHost === linkHost) {
            urls.push(fullUrl);
          }
        } catch (e) {}
      }
    });
    
    return [...new Set(urls)];
  }, baseUrl.replace(/\/$/, ''));
  
  return links;
}

async function scrapeDocumentPages(
  page: Page,
  baseUrl: string,
  stats: CrawlStats
): Promise<void> {
  console.log(`\n📄 Scraping high-value document pages...`);
  
  for (const pathString of HIGH_VALUE_PATHS) {
    const url = `${baseUrl}${pathString}`;
    
    try {
      process.stdout.write(`  ${pathString}... `);
      
      const response = await page.goto(url, { 
        waitUntil: 'domcontentloaded', 
        timeout: 15000 
      });
      
      // Log HTTP status for debugging
      if (!response || response.status() >= 400) {
        console.log(`✗ (HTTP ${response?.status() || 'timeout'})`);
        continue;
      }
      
      await sleep(2000); // Let JavaScript load
      
      const text = await page.evaluate(() => document.body.innerText);
      
      // Check if valid page
      if (text.toLowerCase().includes('404') || 
          text.toLowerCase().includes('not found') || 
          text.length < 200) {
        console.log(`✗ (not found)`);
        continue;
      }
      
      const docs = await extractDocumentLinks(page, baseUrl);
      docs.forEach(doc => stats.discovered.add(doc));
      
      console.log(`✓ ${docs.length} docs`);
      stats.byStrategy[`Page: ${pathString}`] = docs.length;
      
    } catch (error: any) {
      console.log(`✗ ${error.message}`);
    }
  }
}

// ==================== STRATEGY 3: Deep Navigation Crawl ====================

/**
 * AGGRESSIVE deep crawl - finds documents buried ANYWHERE on the site.
 * Follows all promising links, expands all JS sections, searches every page.
 * This is the "nuclear option" for comprehensive document discovery.
 */
async function deepCrawlNavigation(
  page: Page,
  baseUrl: string,
  stats: CrawlStats,
  maxDepth: number = 5,
  maxPages: number = 100
): Promise<void> {
  const visited = new Set<string>();
  const toVisit: { url: string; depth: number }[] = [];
  const discoveredNormalized = new Set<string>();
  
  // FIRST: Expand WordPress menus and other hidden navigation
  await page.evaluate(() => {
    // WordPress: Hover over menu items to reveal submenus
    document.querySelectorAll('.menu-item-has-children, .menu > li, nav li').forEach(item => {
      if (item instanceof HTMLElement) {
        item.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
        item.classList.add('hover', 'focus', 'active');
      }
    });
    
    // Click mobile menu toggles
    document.querySelectorAll('.menu-toggle, .mobile-menu-toggle, [aria-label*="menu" i]').forEach(toggle => {
      if (toggle instanceof HTMLElement) {
        try { toggle.click(); } catch (e) {}
      }
    });
    
    // Wait for menus to expand
    return new Promise(resolve => setTimeout(resolve, 1000));
  });
  
  // Extract ALL promising links from current page (including now-visible nav)
  const promisingLinks = await page.evaluate((base: string) => {
    const links: string[] = [];
    
    // EXPANDED keywords for broader coverage
    const contentKeywords = [
      // Boards & departments
      'board', 'committee', 'department', 'selectmen', 'planning',
      'budget', 'conservation', 'zoning', 'fire', 'police', 'highway',
      'clerk', 'tax', 'assessor', 'welfare', 'recreation', 'council',
      
      // Document-related
      'document', 'form', 'resource', 'download', 'file', 'report',
      'minutes', 'agenda', 'ordinance', 'regulation', 'policy', 'notice',
      
      // Services & info
      'service', 'permit', 'license', 'registration', 'application',
      
      // Archives & years
      'archive', 'year', '202', '201', 'past', 'historical'
    ];
    
    // Check ALL links on page - be very inclusive
    document.querySelectorAll('a[href]').forEach(link => {
      const href = link.getAttribute('href');
      const text = (link.textContent || '').toLowerCase();
      
      // Skip obvious non-content links
      if (!href || href === '#' || href.startsWith('mailto:') || 
          href.startsWith('tel:') || href.startsWith('javascript:')) {
        return;
      }
      
      // Include if matches any keyword OR points to common document paths
      const matchesKeyword = contentKeywords.some(kw => 
        text.includes(kw) || href.toLowerCase().includes(kw)
      );
      
      const isDocPath = /\/(documents?|files?|forms?|boards?|departments?|services?|resources?|general-info|selectmen|applications|notices|regulations)\//i.test(href);
      
      // Also include links that are in nav/menu structures (WordPress menus)
      const isNavLink = link.closest('nav, .menu, header, .navigation, [role="navigation"]') !== null;
      
      if (matchesKeyword || isDocPath || isNavLink) {
        try {
          const url = new URL(href, base);
          if (url.hostname === new URL(base).hostname) {
            links.push(url.href);
          }
        } catch (e) {}
      }
    });
    
    return [...new Set(links)];
  }, baseUrl);
  
  console.log(`   Found ${promisingLinks.length} promising links to explore`);
  
  // DEBUG: Show first 10 links
  if (promisingLinks.length > 0) {
    console.log(`   First 10 links:`);
    promisingLinks.slice(0, 10).forEach(url => {
      const path = url.replace(baseUrl, '');
      console.log(`     ${path}`);
    });
  }
  
  // Queue all promising links
  promisingLinks.forEach(url => toVisit.push({ url, depth: 1 }));
  
  let pagesVisited = 0;
  let docsFound = 0;
  
  while (toVisit.length > 0 && pagesVisited < maxPages) {
    const { url, depth } = toVisit.shift()!;
    
    if (visited.has(url) || depth > maxDepth) continue;
    visited.add(url);
    
    try {
      const response = await page.goto(url, { 
        waitUntil: 'domcontentloaded', 
        timeout: 30000  // Longer timeout for slow pages
      });
      
      // Skip error pages
      if (!response || response.status() >= 400) {
        process.stdout.write(`✗`);
        continue;
      }
      
      await sleep(1500);
      
      // AGGRESSIVE JavaScript expansion - click everything that might reveal content
      await page.evaluate(() => {
        // Find and click all expand buttons
        const selectors = [
          '[aria-expanded="false"]',
          '.toggle', '.accordion-toggle', '.expand', '.show-more',
          'button[class*="expand"]', 'button[class*="toggle"]',
          'a[class*="expand"]', 'a[class*="toggle"]',
          '.collapsed', '[data-toggle]'
        ];
        
        selectors.forEach(selector => {
          document.querySelectorAll(selector).forEach(el => {
            if (el instanceof HTMLElement) {
              try {
                el.click();
              } catch (e) {}
            }
          });
        });
        
        // Also try clicking elements with "show"/"view"/"expand" text
        document.querySelectorAll('button, a').forEach(el => {
          const text = (el.textContent || '').toLowerCase();
          if (text.includes('show') || text.includes('view') || 
              text.includes('expand') || text.includes('more')) {
            if (el instanceof HTMLElement) {
              try {
                el.click();
              } catch (e) {}
            }
          }
        });
        
        // Wait for content to render
        return new Promise(resolve => setTimeout(resolve, 1000));
      });
      
      // Extract documents from this page with early deduplication
      const docs = await extractDocumentLinks(page, baseUrl);
      docs.forEach(doc => {
        const normalized = normalizeUrl(doc);
        if (!discoveredNormalized.has(normalized)) {
          discoveredNormalized.add(normalized);
          stats.discovered.add(doc);
        }
      });
      
      if (docs.length > 0) {
        docsFound += docs.length;
        process.stdout.write(`✓`);
      } else {
        process.stdout.write(`.`);
      }
      
      pagesVisited++;
      
      // Show progress every 10 pages
      if (pagesVisited % 10 === 0) {
        console.log(`\n   [${pagesVisited}/${maxPages}] ${docsFound} docs found, ${toVisit.length} pages queued`);
      }
      
      // Queue MORE links from this page if we haven't hit max depth
      if (depth < maxDepth) {
        const moreLinks = await page.evaluate((base: string) => {
          const links: string[] = [];
          const keywords = [
            'document', 'form', 'archive', 'minutes', 'agenda', 'year',
            '202', '201', 'board', 'committee', 'department'
          ];
          
          document.querySelectorAll('a[href]').forEach(link => {
            const href = link.getAttribute('href');
            const text = (link.textContent || '').toLowerCase();
            
            if (href && keywords.some(kw => text.includes(kw) || href.includes(kw))) {
              try {
                const url = new URL(href, base);
                if (url.hostname === new URL(base).hostname) {
                  links.push(url.href);
                }
              } catch (e) {}
            }
          });
          
          return [...new Set(links)];
        }, baseUrl);
        
        // Smart archive pattern recognition: if we see /archive/2025, generate 2015-2024
        const yearPattern = /\/(\d{4})\/?$/;
        const seenPatterns = new Set<string>();
        
        moreLinks.forEach(link => {
          const match = link.match(yearPattern);
          if (match) {
            const basePattern = link.replace(yearPattern, '');
            if (!seenPatterns.has(basePattern)) {
              seenPatterns.add(basePattern);
              // Generate last 10 years
              const currentYear = new Date().getFullYear();
              for (let year = currentYear; year >= currentYear - 10; year--) {
                const generatedUrl = `${basePattern}/${year}`;
                if (!visited.has(generatedUrl)) {
                  toVisit.push({ url: generatedUrl, depth: depth + 1 });
                }
              }
            }
          } else if (!visited.has(link)) {
            toVisit.push({ url: link, depth: depth + 1 });
          }
        });
      }
      
    } catch (error) {
      process.stdout.write(`✗`);
    }
  }
  
  console.log(`\n   Visited ${pagesVisited} pages, found ${docsFound} documents`);
  if (docsFound > 0) {
    stats.byStrategy['Deep navigation'] = docsFound;
  }
}

// ==================== STRATEGY 4: Google Drive Detection ====================

async function extractGoogleDriveLinks(page: Page): Promise<string[]> {
  return await page.evaluate(() => {
    const links: string[] = [];
    document.querySelectorAll('a[href*="drive.google.com"]').forEach(link => {
      const href = link.getAttribute('href');
      if (href) links.push(href);
    });
    return links;
  });
}

/**
 * Note: Google Drive folder crawling requires the folder to be publicly accessible.
 * This is a simplified implementation - full Drive API integration would be more robust.
 */
async function detectGoogleDriveFolders(page: Page, stats: CrawlStats): Promise<void> {
  try {
    const driveLinks = await extractGoogleDriveLinks(page);
    
    if (driveLinks.length > 0) {
      console.log(`\n📁 Detected ${driveLinks.length} Google Drive folder(s)`);
      console.log(`   Note: Google Drive crawling requires API access or manual collection`);
      console.log(`   Links found:`);
      driveLinks.forEach(link => console.log(`     ${link}`));
      
      stats.byStrategy['Google Drive (detected)'] = driveLinks.length;
    }
  } catch (error) {
    // Page might be in error state after deep crawl - skip Google Drive detection
    console.log(`\n📁 Skipping Google Drive detection (page error)`);
  }
}

// ==================== STRATEGY 4: Sitemap Parsing ====================

async function parseSitemap(baseUrl: string): Promise<string[]> {
  try {
    const response = await fetch(`${baseUrl}/sitemap.xml`, {
      signal: AbortSignal.timeout(10000)
    });
    
    if (!response.ok) return [];
    
    const xml = await response.text();
    const urlMatches = xml.matchAll(/<loc>(.*?)<\/loc>/g);
    const urls = Array.from(urlMatches).map(match => match[1]);
    
    return urls;
  } catch (error) {
    return [];
  }
}

// ==================== S3 Operations ====================

async function documentExistsInS3(s3Key: string): Promise<boolean> {
  try {
    await s3.send(new HeadObjectCommand({
      Bucket: S3_BUCKET,
      Key: s3Key,
    }));
    return true;
  } catch (error: any) {
    if (error.name === 'NotFound') return false;
    throw error;
  }
}

async function downloadDocument(page: Page, url: string, filename: string): Promise<string | null> {
  try {
    await fs.mkdir(TEMP_DIR, { recursive: true });
    const tempPath = path.join(TEMP_DIR, filename);
    
    // Approach 1: Try download event (for Content-Disposition: attachment)
    try {
      const download = await Promise.race([
        page.waitForEvent('download', { timeout: 5000 }),
        page.goto(url, { waitUntil: 'domcontentloaded', timeout: 5000 }).then(() => null)
      ]);
      
      if (download) {
        const downloadPath = await download.path();
        if (downloadPath) {
          await fs.copyFile(downloadPath, tempPath);
          return tempPath;
        }
      }
    } catch (e) {
      // Download event didn't fire, try next approach
    }
    
    // Approach 2: Navigate and extract response body
    try {
      const response = await page.goto(url, {
        waitUntil: 'networkidle',
        timeout: 15000,
      });
      
      if (!response) {
        throw new Error('No response');
      }
      
      const status = response.status();
      if (status >= 400) {
        console.error(`[DOWNLOAD FAILED] HTTP ${status} for ${url}`);
        return null;
      }
      
      const buffer = await response.body();
      
      if (!buffer || buffer.length === 0) {
        console.error(`[DOWNLOAD FAILED] Empty response for ${url}`);
        return null;
      }
      
      await fs.writeFile(tempPath, buffer);
      return tempPath;
    } catch (navError: any) {
      // Navigation failed, try fallback
    }
    
    // Approach 3: Direct fetch as last resort
    try {
      const response = await fetch(url, {
        signal: AbortSignal.timeout(10000),
      });
      
      if (!response.ok) {
        console.error(`[DOWNLOAD FAILED] HTTP ${response.status} for ${url}`);
        return null;
      }
      
      const arrayBuffer = await response.arrayBuffer();
      if (!arrayBuffer || arrayBuffer.byteLength === 0) {
        console.error(`[DOWNLOAD FAILED] Empty response for ${url}`);
        return null;
      }
      
      const buffer = Buffer.from(arrayBuffer);
      await fs.writeFile(tempPath, buffer);
      return tempPath;
    } catch (fetchError: any) {
      console.error(`[DOWNLOAD ERROR] ${url}: All approaches failed`);
      return null;
    }
    
  } catch (error: any) {
    console.error(`[DOWNLOAD ERROR] ${url}: ${error.message}`);
    return null;
  }
}

async function uploadToS3(localPath: string, s3Key: string): Promise<boolean> {
  try {
    const fileContent = await fs.readFile(localPath);
    
    await s3.send(new PutObjectCommand({
      Bucket: S3_BUCKET,
      Key: s3Key,
      Body: fileContent,
      ContentType: s3Key.endsWith('.pdf') ? 'application/pdf' : 'application/octet-stream',
      Metadata: {
        'uploaded-by': 'comprehensive-crawler',
        'uploaded-at': new Date().toISOString(),
      },
    }));
    
    return true;
  } catch (error: any) {
    console.error(`[S3 UPLOAD FAILED] ${s3Key}: ${error.message}`);
    return false;
  }
}

function buildS3Key(town: string, category: string, filename: string, year?: string): string {
  const parts = [town.toLowerCase(), category];
  if (year) parts.push(year);
  parts.push(filename);
  return parts.join('/');
}

// ==================== MAIN CRAWLER ====================

async function saveSummary(town: string, stats: CrawlStats): Promise<void> {
  const summary = {
    town,
    crawledAt: new Date().toISOString(),
    discovered: stats.discovered.size,
    downloaded: stats.downloaded,
    uploaded: stats.uploaded,
    skipped: stats.skipped,
    failed: stats.failed,
    byCategory: stats.byCategory,
    byStrategy: stats.byStrategy,
  };
  
  const summaryPath = `town-profiles/${town.toLowerCase()}-docs-${new Date().toISOString().split('T')[0]}.json`;
  await fs.writeFile(summaryPath, JSON.stringify(summary, null, 2));
}

async function crawl(options: CrawlOptions): Promise<void> {
  const {
    town,
    url,
    maxDocuments = 2000,
    dryRun = false,
    skipExisting = true,
  } = options;
  
  console.log(`\n🔍 COMPREHENSIVE DOCUMENT CRAWLER`);
  console.log(`Town: ${town}`);
  console.log(`URL: ${url}`);
  console.log(`Max documents: ${maxDocuments}`);
  console.log(`Dry run: ${dryRun}\n`);
  
  const baseUrl = url.replace(/\/$/, '');
  
  const stats: CrawlStats = {
    discovered: new Set<string>(),
    downloaded: 0,
    uploaded: 0,
    skipped: 0,
    failed: 0,
    byCategory: {},
    byStrategy: {},
  };
  
  console.log(`🚀 Launching browser...\n`);
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });
  
  const page = await browser.newPage({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
  });
  
  // ==================== DISCOVERY PHASE ====================
  console.log(`${"=".repeat(60)}`);
  console.log(`PHASE 1: DISCOVERY`);
  console.log(`${"=".repeat(60)}`);
  
  // Load homepage first
  console.log(`\n🔗 Loading homepage...`);
  try {
    const response = await page.goto(baseUrl, { waitUntil: 'networkidle', timeout: 60000 });
    const finalUrl = page.url();
    if (finalUrl !== baseUrl) {
      console.log(`   → Redirected to: ${finalUrl}`);
    }
  } catch {
    // Fallback if networkidle times out
    await page.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    const finalUrl = page.url();
    if (finalUrl !== baseUrl) {
      console.log(`   → Redirected to: ${finalUrl}`);
    }
  }
  
  // Strategy 1: CMS Detection
  console.log(`\n🔍 Detecting CMS...`);
  const cmsType = await page.evaluate(() => {
    const html = document.documentElement.outerHTML.toLowerCase();
    if (html.includes('civicplus')) return 'CivicPlus';
    if (html.includes('towncloud')) return 'TownCloud';
    if (html.includes('wordpress') || html.includes('wp-content')) return 'WordPress';
    if (html.includes('revize')) return 'Revize';
    return 'Unknown';
  });
  console.log(`   → Detected: ${cmsType}`);
  
  // Strategy 2: TownCloud API
  console.log(`\n📋 Checking TownCloud API...`);
  const townCloudPages = await detectTownCloudPages(baseUrl);
  if (townCloudPages.length > 0) {
    console.log(`   ✓ TownCloud site detected: ${townCloudPages.length} pages`);
    stats.byStrategy['TownCloud API'] = townCloudPages.length;
  } else {
    console.log(`   ✗ Not a TownCloud site`);
  }
  
  // Strategy 3: Homepage keyword link discovery
  console.log(`\n🔗 Discovering keyword links from homepage...`)
  console.log(`   Waiting 10 seconds for Cloudflare/JS...`);
  await sleep(10000); // Cloudflare bypass - needs significant time
  const keywordLinks = await discoverKeywordLinks(page, baseUrl);
  if (keywordLinks.length > 0) {
    console.log(`   ✓ Found ${keywordLinks.length} promising links`);
    stats.byStrategy['Homepage keywords'] = keywordLinks.length;
  } else {
    console.log(`   ✗ No keyword links found`);
  }
  
  // Strategy 3: High-value document pages (predefined paths)
  await scrapeDocumentPages(page, baseUrl, stats);
  
  // Strategy 4: Visit keyword links from homepage
  if (keywordLinks.length > 0) {
    console.log(`\n📄 Visiting keyword-discovered pages...`);
    let visited = 0;
    for (const link of keywordLinks.slice(0, 15)) {
      try {
        process.stdout.write(`  ${link.substring(baseUrl.length)}... `);
        await page.goto(link, { waitUntil: 'domcontentloaded', timeout: 10000 });
        await sleep(1500);
        
        const docs = await extractDocumentLinks(page, baseUrl);
        docs.forEach(doc => stats.discovered.add(doc));
        
        if (docs.length > 0) {
          console.log(`✓ ${docs.length} docs`);
          visited++;
        } else {
          console.log(`✗`);
        }
      } catch (error) {
        console.log(`✗`);
      }
    }
    if (visited > 0) {
      console.log(`   ✓ ${visited} pages had documents`);
    }
  }
  
  // Strategy 5: Deep navigation crawl (boards, departments, archives)
  console.log(`\n🌲 Deep crawling navigation structure...`);
  await deepCrawlNavigation(page, baseUrl, stats);
  
  // Strategy 6: Google Drive detection (return to homepage first for stable page state)
  try {
    await page.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: 10000 });
    await sleep(1000);
    await detectGoogleDriveFolders(page, stats);
  } catch (error) {
    console.log(`\n📁 Skipping Google Drive detection (navigation error)`);
  }
  
  // Strategy 7: Aggressive Sitemap Crawling
  console.log(`\n🗺️  Parsing sitemap...`);
  const sitemapUrls = await parseSitemap(baseUrl);
  if (sitemapUrls.length > 0) {
    console.log(`   ✓ Found ${sitemapUrls.length} URLs in sitemap`);
    
    // Visit ALL pages in sitemap (not just promising ones), up to a reasonable limit
    const maxSitemapPages = 50;
    const pagesToVisit = sitemapUrls.slice(0, maxSitemapPages);
    
    console.log(`   Crawling ${pagesToVisit.length} sitemap pages for documents...`);
    
    let docsFromSitemap = 0;
    for (const url of pagesToVisit) {
      try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
        await sleep(1000);
        
        // Expand any JS sections on this page too
        await page.evaluate(() => {
          document.querySelectorAll('[aria-expanded="false"], .toggle, .accordion-toggle').forEach(el => {
            if (el instanceof HTMLElement) {
              try { el.click(); } catch (e) {}
            }
          });
          return new Promise(resolve => setTimeout(resolve, 500));
        });
        
        const docs = await extractDocumentLinks(page, baseUrl);
        docs.forEach(doc => stats.discovered.add(doc));
        
        if (docs.length > 0) {
          docsFromSitemap += docs.length;
          process.stdout.write(`✓`);
        } else {
          process.stdout.write(`.`);
        }
      } catch (error) {
        process.stdout.write(`✗`);
      }
    }
    
    console.log(`\n   Found ${docsFromSitemap} documents from sitemap pages`);
    if (docsFromSitemap > 0) {
      stats.byStrategy['Sitemap'] = docsFromSitemap;
    }
  } else {
    console.log(`   ✗ No sitemap found`);
  }
  
  console.log(`\n${"=".repeat(60)}`);
  console.log(`DISCOVERY COMPLETE: ${stats.discovered.size} documents found`);
  console.log(`${"=".repeat(60)}`);
  
  // Save checkpoint after discovery
  await saveProgress(town, Array.from(stats.discovered));
  
  if (stats.discovered.size === 0) {
    console.log(`\n⚠️  No documents discovered. This town might:`);
    console.log(`   - Use a custom CMS not yet supported`);
    console.log(`   - Require JavaScript rendering (check page manually)`);
    console.log(`   - Store documents on external platforms`);
    console.log(`   - Have documents behind authentication\n`);
    await browser.close();
    return;
  }
  
  // ==================== PROCESSING PHASE ====================
  console.log(`\n${"=".repeat(60)}`);
  console.log(`PHASE 2: PROCESSING`);
  console.log(`${"=".repeat(60)}\n`);
  
  const docArray = Array.from(stats.discovered).slice(0, maxDocuments);
  const batches = chunk(docArray, 100);
  
  let processed = 0;
  let batchNum = 0;
  
  for (const batch of batches) {
    batchNum++;
    console.log(`\n📦 Processing batch ${batchNum}/${batches.length} (${batch.length} documents)\n`);
    
    for (const docUrl of batch) {
      processed++;
      
      let filename = docUrl.split('/').pop() || 'unknown.pdf';
      if (filename.includes('?')) {
        filename = filename.split('?')[0];
      }
      
      // Handle dynamic endpoints without proper extensions
      if (!filename.includes('.')) {
        // Try to infer from URL path
        if (docUrl.includes('/ViewFile/Minutes/')) {
          filename = filename + '.pdf';
        } else if (docUrl.includes('/ViewFile/Agenda/')) {
          filename = filename + '.pdf';
        } else if (docUrl.includes('/DocumentCenter/View/')) {
          filename = 'doc_' + filename + '.pdf';
        } else {
          filename = filename + '.pdf';
        }
      }
      
      filename = sanitizeFilename(filename);
      
      const category = categorizeDocument(docUrl, filename);
      const year = extractYear(docUrl + ' ' + filename);
      
      const s3Key = buildS3Key(town, category, filename, year);
      
      if (processed % 10 === 0 || processed === batch.length) {
        console.log(`[${processed}/${docArray.length}] ${filename}`);
      }
      
      // Check if exists
      if (skipExisting && !dryRun) {
        const exists = await documentExistsInS3(s3Key);
        if (exists) {
          stats.skipped++;
          continue;
        }
      }
      
      if (dryRun) {
        console.log(`  [DRY RUN] Would upload to: ${s3Key}`);
        continue;
      }
      
      // Download
      const localPath = await downloadDocument(page, docUrl, filename);
      if (!localPath) {
        stats.failed++;
        continue;
      }
      
      stats.downloaded++;
      
      // Upload
      const success = await uploadToS3(localPath, s3Key);
      if (success) {
        stats.uploaded++;
        stats.byCategory[category] = (stats.byCategory[category] || 0) + 1;
      } else {
        stats.failed++;
      }
      
      // Cleanup
      try {
        await fs.unlink(localPath);
      } catch (e) {}
      
      await sleep(300);
      
      // Browser memory management: restart every 100 docs
      if (processed % 100 === 0 && processed < docArray.length) {
        console.log(`\n🔄 Restarting browser to free memory...\n`);
        await browser.close();
        browser = await chromium.launch({
          headless: true,
          args: ['--no-sandbox', '--disable-setuid-sandbox'],
        });
        page = await browser.newPage({
          userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        });
      }
    }
    
    // Save checkpoint after each batch
    await saveSummary(town, stats);
    console.log(`\n✅ Batch ${batchNum} complete. Progress saved.\n`);
  }
  
  await browser.close();
  
  // ==================== SUMMARY ====================
  console.log(`\n${"=".repeat(60)}`);
  console.log(`SUMMARY`);
  console.log(`${"=".repeat(60)}\n`);
  
  console.log(`Discovered: ${stats.discovered.size} unique documents`);
  console.log(`Downloaded: ${stats.downloaded}`);
  console.log(`Uploaded: ${stats.uploaded}`);
  console.log(`Skipped (existing): ${stats.skipped}`);
  console.log(`Failed: ${stats.failed}\n`);
  
  if (Object.keys(stats.byStrategy).length > 0) {
    console.log(`By strategy:`);
    for (const [strategy, count] of Object.entries(stats.byStrategy).sort((a, b) => b[1] - a[1])) {
      console.log(`  ${strategy}: ${count}`);
    }
    console.log('');
  }
  
  if (Object.keys(stats.byCategory).length > 0) {
    console.log(`By category:`);
    for (const [category, count] of Object.entries(stats.byCategory).sort((a, b) => b[1] - a[1])) {
      console.log(`  ${category}: ${count}`);
    }
    console.log('');
  }
  
  // Save final summary
  await saveSummary(town, stats);
  const summaryPath = `town-profiles/${town.toLowerCase()}-docs-${new Date().toISOString().split('T')[0]}.json`;
  console.log(`Summary saved: ${summaryPath}\n`);
}

// ==================== CLI ====================

program
  .name("comprehensive-document-crawler")
  .description("Generalizable crawler for NH town documents")
  .requiredOption("--town <name>", "Town name")
  .requiredOption("--url <url>", "Town website URL")
  .option("--max-docs <n>", "Max documents to process", "2000")
  .option("--dry-run", "Don't actually download/upload")
  .option("--no-skip-existing", "Re-download existing files")
  .action(async (opts) => {
    try {
      await crawl({
        town: opts.town,
        url: opts.url,
        maxDocuments: parseInt(opts.maxDocs),
        dryRun: opts.dryRun,
        skipExisting: opts.skipExisting !== false,
      });
    } catch (error: any) {
      console.error(`\n❌ Error: ${error.message}`);
      console.error(error.stack);
      process.exit(1);
    }
  });

program.parse();
