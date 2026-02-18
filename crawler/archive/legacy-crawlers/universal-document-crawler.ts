#!/usr/bin/env tsx
/**
 * Universal Document Crawler for NH Town Websites
 * 
 * A single, reliable crawler that works for all CMS types:
 * - WordPress (most common)
 * - CivicPlus
 * - Revize
 * - Custom/Static sites
 * 
 * Strategy:
 * 1. Load homepage, detect CMS
 * 2. Extract ALL navigation links
 * 3. Visit all links + sitemap + high-value paths
 * 4. Extract documents from each page
 * 5. Download and upload to S3
 */

import { chromium as playwrightChromium, Browser, Page } from 'playwright';
import { chromium } from 'playwright-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import { S3Client, PutObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import { promises as fs } from 'fs';
import * as path from 'path';
import { Command } from 'commander';

// Add stealth plugin to evade Cloudflare detection
chromium.use(StealthPlugin());

// ==================== Configuration ====================

const S3_BUCKET = 'opencouncil-municipal-docs';
const S3_REGION = 'us-east-1';
const TEMP_DIR = '/tmp/opencouncil-docs';

const s3 = new S3Client({
  region: S3_REGION,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID || 'AKIAXEEDJLE2AYAKJDMZ',
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || '',
  },
});

// High-value paths to try on every site
const HIGH_VALUE_PATHS = [
  '/documents', '/minutes', '/agendas', '/boards', '/forms', '/reports',
  '/AgendaCenter', '/FormCenter', '/DocumentCenter', // CivicPlus
  '/downloads', '/ordinances', '/regulations', '/applications'
];

// ==================== Types ====================

interface CrawlStats {
  discovered: Set<string>;
  downloaded: number;
  uploaded: number;
  skipped: number;
  failed: number;
  byCategory: Record<string, number>;
}

type CMSType = 'WordPress' | 'CivicPlus' | 'Revize' | 'Custom';

interface CMSProfile {
  indexPatterns: string[];  // URL patterns that are likely document index pages
  detailPageSelectors: string[];  // Selectors for finding PDFs on detail pages
  storagePatterns: RegExp[];  // Common file storage paths
}

const CMS_PROFILES: Record<CMSType, CMSProfile> = {
  'CivicPlus': {
    indexPatterns: [
      '/minutes-agendas',
      '/node/*/minutes',
      '/node/*/agendas', 
      '/node/*/files',
      '/find-it-fast',
      '/a-z-directory',
      '/DocumentCenter',
      '/AgendaCenter',
      '/FormCenter'
    ],
    detailPageSelectors: [
      'a[href*="/files/"]',
      'a[href*="/agendas/"]',
      'a[href*="/minutes/"]',
      '.field-name-field-upload-file a',
      '.file a'
    ],
    storagePatterns: [
      /\/sites\/g\/files\/.*\.pdf/i,
      /\/AgendaCenter\/ViewFile\//i,
      /\/DocumentCenter\/View\//i
    ]
  },
  'WordPress': {
    indexPatterns: [
      '/documents',
      '/minutes',
      '/agendas',
      '/boards',
      '/forms'
    ],
    detailPageSelectors: [
      'a[href*="/wp-content/uploads/"]'
    ],
    storagePatterns: [
      /\/wp-content\/uploads\/.*\.(pdf|doc|docx|xls|xlsx)/i
    ]
  },
  'Revize': {
    indexPatterns: [
      '/DocumentCenter',
      '/how_do_i'
    ],
    detailPageSelectors: [
      'a[href*=".php"]',
      'a[href*="/DocumentCenter/"]'
    ],
    storagePatterns: [
      /\/DocumentCenter\//i,
      /\/(forms|documents).*\.php/i
    ]
  },
  'Custom': {
    indexPatterns: [
      // Try common patterns as fallback
      '/minutes-agendas',
      '/node/*/minutes',
      '/node/*/agendas',
      '/node/*/files',
      '/find-it-fast',
      '/documents',
      '/forms'
    ],
    detailPageSelectors: [
      'a[href*="/files/"]',
      'a[href*="/wp-content/uploads/"]'
    ],
    storagePatterns: []
  }
};

// ==================== Helper Functions ====================

function sanitizeFilename(filename: string): string {
  return filename
    .replace(/[^a-zA-Z0-9._-]/g, '_')
    .replace(/_+/g, '_')
    .substring(0, 200);
}

function categorizeDocument(url: string, filename: string): string {
  const text = (url + ' ' + filename).toLowerCase();
  
  if (text.includes('minute')) return 'minutes';
  if (text.includes('agenda')) return 'agendas';
  if (text.includes('form') || text.includes('application')) return 'forms';
  if (text.includes('ordinance')) return 'ordinances';
  if (text.includes('budget')) return 'budget';
  if (text.includes('report')) return 'reports';
  if (text.includes('regulation') || text.includes('bylaw')) return 'regulations';
  if (text.includes('tax')) return 'tax';
  if (text.includes('zoning')) return 'zoning';
  if (text.includes('planning')) return 'planning';
  
  return 'misc';
}

function extractYear(text: string): string {
  const match = text.match(/20\d{2}/);
  return match ? match[0] : 'unknown';
}

function normalizeUrl(url: string): string {
  try {
    const u = new URL(url);
    u.hash = '';
    u.search = u.search.replace(/[?&](session|token|sid)=[^&]*/g, '');
    return u.href;
  } catch {
    return url;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ==================== CMS Detection ====================

async function detectCMS(page: Page): Promise<CMSType> {
  const html = await page.content();
  const htmlLower = html.toLowerCase();
  
  // Check footer and meta tags for CivicPlus signature
  if (htmlLower.includes('civicplus') || 
      htmlLower.includes('government websites by civicplus') ||
      htmlLower.includes('/agendacenter/') ||
      htmlLower.includes('/node/') && htmlLower.includes('drupal')) {
    return 'CivicPlus';
  }
  
  if (htmlLower.includes('wp-content') || htmlLower.includes('wordpress')) {
    return 'WordPress';
  }
  
  if (htmlLower.includes('revize') || htmlLower.includes('.revize.')) {
    return 'Revize';
  }
  
  return 'Custom';
}

// ==================== Document Extraction ====================

/**
 * Extract document links from current page.
 * This is the PROVEN function that works without TypeScript __name bugs.
 */
async function extractDocumentLinks(page: Page, baseUrl: string): Promise<string[]> {
  const base = baseUrl.replace(/\/$/, '');
  const links = await page.evaluate((baseArg) => {
    const urls = [];
    const docExts = ['.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.txt', '.rtf'];
    const imageExts = ['.jpg', '.jpeg', '.png', '.gif', '.svg', '.webp', '.bmp'];
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
      
      // Skip images
      if (imageExts.some(ext => low.includes(ext))) return;
      
      // Check patterns
      if (docExts.some(ext => low.includes(ext)) ||
          href.includes('/wp-content/uploads/') ||
          href.includes('/AgendaCenter/ViewFile/') ||
          href.includes('/DocumentCenter/View/') ||
          href.includes('/DocumentCenter/') ||  // Revize
          href.includes('/FormCenter/') ||
          href.includes('how_do_i/') ||  // Revize
          href.match(/\/(forms|documents).*\.php/i) ||  // Revize PHP handlers
          href.match(/\/files?\/[^\/]+$/i) ||  // Interstitial patterns
          href.match(/\/download\/[^\/]+$/i) ||
          href.match(/\/view\/[^\/]+$/i)) {
        urls.push(href);
      }
    });
    
    // Check iframes/embeds
    document.querySelectorAll('iframe[src], embed[src], object[data]').forEach((el) => {
      const src = el.getAttribute('src') || el.getAttribute('data');
      if (src) {
        const srcLow = src.toLowerCase();
        // Skip images
        if (imageExts.some(ext => srcLow.includes(ext))) return;
        
        if (docExts.some(ext => srcLow.includes(ext))) {
          try {
            const u = new URL(src, curr);
            if (u.hostname === new URL(baseArg).hostname) urls.push(u.href);
          } catch {}
        }
      }
    });
    
    return [...new Set(urls)];
  }, base);
  
  return links;
}

// ==================== Navigation Link Extraction ====================

async function extractAllNavigationLinks(page: Page, baseUrl: string): Promise<string[]> {
  const base = baseUrl.replace(/\/$/, '');
  
  // Expand WordPress menus first
  await page.evaluate(() => {
    document.querySelectorAll('.menu-item-has-children, .menu > li, nav li').forEach(item => {
      if (item instanceof HTMLElement) {
        item.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
        item.classList.add('hover', 'focus', 'active');
      }
    });
    
    document.querySelectorAll('.menu-toggle, .mobile-menu-toggle, [aria-label*="menu" i]').forEach(toggle => {
      if (toggle instanceof HTMLElement) {
        try { toggle.click(); } catch (e) {}
      }
    });
  });
  
  await sleep(1000);
  
  // Extract ALL nav/menu links
  const links = await page.evaluate((baseArg) => {
    const urls = [];
    const selectors = [
      'nav a', 'header a', '.menu a', '.navigation a',
      '[role="navigation"] a', '.navbar a', '.nav a',
      '#menu a', '#navigation a', '.site-navigation a',
      '.main-navigation a', 'ul.menu a', 'ul.nav a'
    ];
    
    selectors.forEach(sel => {
      document.querySelectorAll(sel).forEach(link => {
        const href = link.getAttribute('href');
        if (href && !href.startsWith('#') && !href.startsWith('mailto:') && !href.startsWith('tel:')) {
          try {
            const u = new URL(href, window.location.href);
            if (u.hostname === new URL(baseArg).hostname) {
              urls.push(u.href);
            }
          } catch {}
        }
      });
    });
    
    return [...new Set(urls)];
  }, base);
  
  return links;
}

// ==================== Sitemap Parsing ====================

async function parseSitemap(baseUrl: string): Promise<string[]> {
  try {
    const response = await fetch(`${baseUrl}/sitemap.xml`, {
      signal: AbortSignal.timeout(10000)
    });
    
    if (!response.ok) return [];
    
    const xml = await response.text();
    const urlMatches = xml.matchAll(/<loc>(.*?)<\/loc>/g);
    return Array.from(urlMatches).map(match => match[1]);
  } catch {
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
    
    // Try download event first
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
    } catch {}
    
    // Try navigation
    try {
      const response = await page.goto(url, {
        waitUntil: 'networkidle',
        timeout: 15000,
      });
      
      if (response && response.status() < 400) {
        const buffer = await response.body();
        if (buffer && buffer.length > 0) {
          await fs.writeFile(tempPath, buffer);
          return tempPath;
        }
      }
    } catch {}
    
    // Try direct fetch
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(10000) });
      if (response.ok) {
        const arrayBuffer = await response.arrayBuffer();
        if (arrayBuffer.byteLength > 0) {
          await fs.writeFile(tempPath, Buffer.from(arrayBuffer));
          return tempPath;
        }
      }
    } catch {}
    
    return null;
  } catch {
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
    }));
    
    return true;
  } catch {
    return false;
  }
}

// ==================== Main Crawler ====================

async function crawl(town: string, baseUrl: string, dryRun: boolean = false, maxPages: number = 100) {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`📄 Universal Document Crawler`);
  console.log(`🏛️  Town: ${town}`);
  console.log(`🌐 URL: ${baseUrl}`);
  console.log(`${'='.repeat(60)}\n`);
  
  const stats: CrawlStats = {
    discovered: new Set(),
    downloaded: 0,
    uploaded: 0,
    skipped: 0,
    failed: 0,
    byCategory: {}
  };
  
  const browser = await chromium.launch({ 
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-blink-features=AutomationControlled'
    ]
  });
  
  const page = await browser.newPage({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    viewport: { width: 1920, height: 1080 }
  });
  
  // Step 1: Load homepage and detect CMS
  console.log('🏠 Loading homepage...');
  await page.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
  
  // Wait for Cloudflare challenges to resolve
  console.log('   Waiting for Cloudflare/JS...');
  await sleep(5000);
  
  // Check if we got through Cloudflare
  let title = await page.title();
  let attempts = 0;
  while ((title.toLowerCase().includes('just a moment') || title.toLowerCase().includes('checking your browser')) && attempts < 3) {
    console.log(`   Cloudflare detected, waiting (attempt ${attempts + 1}/3)...`);
    await sleep(10000);
    title = await page.title();
    attempts++;
  }
  
  // If still blocked, try waiting for network idle
  if (title.toLowerCase().includes('just a moment')) {
    console.log('   Waiting for network idle...');
    try {
      await page.waitForLoadState('networkidle', { timeout: 20000 });
      await sleep(2000);
    } catch {
      console.log('   Warning: Cloudflare may still be active');
    }
  }
  
  const cms = await detectCMS(page);
  const profile = CMS_PROFILES[cms];
  console.log(`   CMS detected: ${cms}\n`);
  
  // Step 2: Build page visit queue
  console.log('🔍 Building page visit queue...');
  
  const visited = new Set<string>();
  const toVisit = new Set<string>();
  
  // Add homepage
  toVisit.add(baseUrl);
  
  // Add all navigation links
  const navLinks = await extractAllNavigationLinks(page, baseUrl);
  console.log(`   Found ${navLinks.length} navigation links`);
  navLinks.forEach(link => toVisit.add(link));
  
  // Add sitemap URLs
  const sitemapUrls = await parseSitemap(baseUrl);
  if (sitemapUrls.length > 0) {
    console.log(`   Found ${sitemapUrls.length} sitemap URLs`);
    sitemapUrls.slice(0, 50).forEach(url => toVisit.add(url));
    
    // Smart archive pattern generation: if we see /archive/2025, generate 2015-2024
    const yearPattern = /\/(\d{4})\/?$/;
    const seenPatterns = new Set<string>();
    
    for (const url of sitemapUrls) {
      const match = url.match(yearPattern);
      if (match) {
        const basePattern = url.replace(yearPattern, '');
        if (!seenPatterns.has(basePattern)) {
          seenPatterns.add(basePattern);
          const currentYear = new Date().getFullYear();
          for (let year = currentYear; year >= currentYear - 10; year--) {
            toVisit.add(`${basePattern}/${year}`);
          }
        }
      }
    }
  }
  
  // Add high-value paths
  HIGH_VALUE_PATHS.forEach(path => {
    toVisit.add(`${baseUrl}${path}`);
  });
  
  // Add CMS-specific index patterns
  profile.indexPatterns.forEach(pattern => {
    // Handle wildcard patterns
    if (pattern.includes('*')) {
      // For node/* patterns, try common IDs
      const commonNodeIds = [8, 100, 10, 12, 15, 20, 25, 30, 35, 40, 50, 60, 70, 80, 90, 105, 110];
      const currentYear = new Date().getFullYear();
      
      if (pattern.includes('/node/*/minutes')) {
        commonNodeIds.forEach(id => {
          toVisit.add(`${baseUrl}/node/${id}/minutes`);
          for (let year = currentYear; year >= currentYear - 3; year--) {
            toVisit.add(`${baseUrl}/node/${id}/minutes/${year}`);
          }
        });
      } else if (pattern.includes('/node/*/agendas')) {
        commonNodeIds.forEach(id => {
          toVisit.add(`${baseUrl}/node/${id}/agendas`);
          for (let year = currentYear; year >= currentYear - 3; year--) {
            toVisit.add(`${baseUrl}/node/${id}/agendas/${year}`);
          }
        });
      } else if (pattern.includes('/node/*/files')) {
        commonNodeIds.forEach(id => {
          toVisit.add(`${baseUrl}/node/${id}/files`);
        });
      }
    } else {
      toVisit.add(`${baseUrl}${pattern}`);
    }
  });
  
  console.log(`   Total pages to visit: ${toVisit.size}\n`);
  
  // Step 3: Visit pages and extract documents
  console.log('📥 Visiting pages and extracting documents...');
  
  let pagesVisited = 0;
  
  for (const url of Array.from(toVisit)) {
    if (pagesVisited >= maxPages) break;
    if (visited.has(url)) continue;
    
    visited.add(url);
    pagesVisited++;
    
    // Rate limiting: 1 request per second (Cloudflare-safe)
    if (pagesVisited > 1) {
      await sleep(1000);
    }
    
    try {
      const response = await page.goto(url, { 
        waitUntil: 'domcontentloaded', 
        timeout: 15000 
      });
      
      if (!response || response.status() >= 400) {
        process.stdout.write('✗');
        continue;
      }
      
      await sleep(1000);
      
      // Check for Cloudflare and retry once
      const title = await page.title();
      if (title.toLowerCase().includes('just a moment')) {
        await sleep(10000);
        const retryTitle = await page.title();
        if (retryTitle.toLowerCase().includes('just a moment')) {
          process.stdout.write('✗');
          continue;
        }
      }
      
      // Expand any JS sections
      await page.evaluate(() => {
        document.querySelectorAll('[aria-expanded="false"], .toggle, .accordion-toggle').forEach(el => {
          if (el instanceof HTMLElement) {
            try { el.click(); } catch (e) {}
          }
        });
      });
      
      await sleep(500);
      
      // Extract documents
      const docs = await extractDocumentLinks(page, baseUrl);
      docs.forEach(doc => stats.discovered.add(normalizeUrl(doc)));
      
      // For CivicPlus/Drupal sites, look for detail page links and follow them
      if (cms === 'CivicPlus' && docs.length < 5) {
        // Extract detail page links (pages that might contain PDFs)
        const detailLinks = await page.evaluate((baseArg, selectors) => {
          const links: string[] = [];
          
          // Look for links that might be detail pages
          document.querySelectorAll('a[href*="/node/"]').forEach(link => {
            const href = link.getAttribute('href');
            const text = (link.textContent || '').toLowerCase();
            
            // Skip if it's a year link (we already visit those)
            if (href && !href.match(/\/\d{4}$/)) {
              // Include if it mentions documents, minutes, agendas, etc.
              if (text.includes('minute') || text.includes('agenda') || 
                  text.includes('meeting') || text.includes('document')) {
                try {
                  const url = new URL(href, window.location.href);
                  if (url.hostname === new URL(baseArg).hostname) {
                    links.push(url.href);
                  }
                } catch {}
              }
            }
          });
          
          return [...new Set(links)].slice(0, 10); // Limit to 10 detail pages per index
        }, baseUrl, profile.detailPageSelectors);
        
        // Add detail pages to visit queue (if not already visited)
        detailLinks.forEach(link => {
          if (!visited.has(link) && toVisit.size < maxPages * 2) {
            toVisit.add(link);
          }
        });
      }
      
      if (docs.length > 0) {
        process.stdout.write(`✓(${docs.length})`);
      } else {
        process.stdout.write('.');
      }
      
      if (pagesVisited % 20 === 0) {
        console.log(`\n   [${pagesVisited}/${Math.min(toVisit.size, maxPages)}] ${stats.discovered.size} docs found`);
      }
      
    } catch {
      process.stdout.write('✗');
    }
  }
  
  console.log(`\n\n${'='.repeat(60)}`);
  console.log(`DISCOVERY COMPLETE: ${stats.discovered.size} documents found`);
  console.log(`${'='.repeat(60)}\n`);
  
  if (stats.discovered.size === 0) {
    console.log('⚠️  No documents found. This town might:');
    console.log('   - Store documents on external platforms');
    console.log('   - Have documents behind authentication');
    console.log('   - Use an unsupported custom CMS\n');
    await browser.close();
    return;
  }
  
  if (dryRun) {
    console.log('🔍 DRY RUN - Skipping download/upload\n');
    console.log('Sample documents found:');
    Array.from(stats.discovered).slice(0, 10).forEach(doc => {
      console.log(`   ${doc}`);
    });
    await browser.close();
    return;
  }
  
  // Step 4: Download and upload documents
  console.log('⬇️  Downloading and uploading to S3...\n');
  
  for (const docUrl of Array.from(stats.discovered)) {
    let filename = docUrl.split('/').pop() || 'unknown.pdf';
    if (filename.includes('?')) {
      filename = filename.split('?')[0];
    }
    if (!filename.includes('.')) {
      filename = filename + '.pdf';
    }
    
    filename = sanitizeFilename(filename);
    
    const category = categorizeDocument(docUrl, filename);
    const year = extractYear(docUrl + ' ' + filename);
    const s3Key = `${town.toLowerCase().replace(/\s+/g, '-')}/${category}/general/${year}/${filename}`;
    
    // Check if already exists
    const exists = await documentExistsInS3(s3Key);
    if (exists) {
      stats.skipped++;
      process.stdout.write('⊙');
      continue;
    }
    
    // Download
    const localPath = await downloadDocument(page, docUrl, filename);
    if (!localPath) {
      stats.failed++;
      process.stdout.write('✗');
      continue;
    }
    
    stats.downloaded++;
    
    // Upload
    const uploaded = await uploadToS3(localPath, s3Key);
    if (uploaded) {
      stats.uploaded++;
      stats.byCategory[category] = (stats.byCategory[category] || 0) + 1;
      process.stdout.write('✓');
    } else {
      stats.failed++;
      process.stdout.write('✗');
    }
    
    // Cleanup
    try {
      await fs.unlink(localPath);
    } catch {}
  }
  
  await browser.close();
  
  // Summary
  console.log(`\n\n${'='.repeat(60)}`);
  console.log('SUMMARY');
  console.log(`${'='.repeat(60)}`);
  console.log(`Discovered: ${stats.discovered.size} unique documents`);
  console.log(`Downloaded: ${stats.downloaded}`);
  console.log(`Uploaded: ${stats.uploaded}`);
  console.log(`Skipped (existing): ${stats.skipped}`);
  console.log(`Failed: ${stats.failed}`);
  
  if (Object.keys(stats.byCategory).length > 0) {
    console.log('\nBy category:');
    Object.entries(stats.byCategory)
      .sort((a, b) => b[1] - a[1])
      .forEach(([cat, count]) => {
        console.log(`  ${cat}: ${count}`);
      });
  }
  
  console.log('');
}

// ==================== CLI ====================

const program = new Command();

program
  .name('universal-document-crawler')
  .description('Universal document crawler for NH town websites')
  .requiredOption('--town <name>', 'Town name')
  .requiredOption('--url <url>', 'Town website URL')
  .option('--dry-run', 'Discover documents but do not download/upload')
  .option('--max-pages <number>', 'Maximum pages to visit', '100')
  .action(async (options) => {
    await crawl(
      options.town,
      options.url,
      options.dryRun || false,
      parseInt(options.maxPages)
    );
  });

program.parse();
