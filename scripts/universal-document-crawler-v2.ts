#!/usr/bin/env tsx
/**
 * Universal Document Crawler V2 - Fixed and Bulletproof
 * 
 * Key improvements over V1:
 * 1. Sitemap-first strategy (doesn't require browser)
 * 2. Headful mode for Cloudflare-protected sites
 * 3. Aggressive nav extraction with fallback
 * 4. Increased page limits (200 default)
 * 5. Document content validation
 * 6. Better error handling
 */

import { chromium as playwrightChromium, Browser, Page } from 'playwright';
import { chromium } from 'playwright-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import { S3Client, PutObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import { promises as fs } from 'fs';
import * as path from 'path';
import { Command } from 'commander';
import * as crypto from 'crypto';

// State management imports
import {
  getTown,
  createRun,
  updateRun,
  completeRun,
  saveSitemap,
  hashSitemap,
  recordUrl,
  hashUrl,
  recordDocument,
  markDocumentUploaded,
  markDocumentFailed,
  updateTownStats,
  resetFailureCount,
  incrementFailureCount,
  type CrawlerTown,
  type CrawlerRun,
  type SitemapUrl,
  type CrawlRunSummary,
} from '../server/services/crawlerState';

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

const HIGH_VALUE_PATHS = [
  '/documents', '/minutes', '/agendas', '/boards', '/forms', '/reports',
  '/AgendaCenter', '/FormCenter', '/DocumentCenter',
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

interface Checkpoint {
  townName: string;
  baseUrl: string;
  visitedUrls: string[];
  queueUrls: string[];
  discoveredDocs: string[];
  pagesVisited: number;
  stats: {
    downloaded: number;
    uploaded: number;
    skipped: number;
    failed: number;
    byCategory: Record<string, number>;
  };
  timestamp: string;
}

// ==================== Checkpoint Functions ====================

const CHECKPOINT_DIR = path.join(process.cwd(), 'checkpoints');

async function saveCheckpoint(checkpoint: Checkpoint): Promise<void> {
  try {
    await fs.mkdir(CHECKPOINT_DIR, { recursive: true });
    const filename = `${checkpoint.townName.toLowerCase().replace(/[^a-z0-9]/g, '-')}.json`;
    const checkpointPath = path.join(CHECKPOINT_DIR, filename);
    await fs.writeFile(checkpointPath, JSON.stringify(checkpoint, null, 2));
  } catch (error) {
    console.error('Failed to save checkpoint:', error);
  }
}

async function loadCheckpoint(townName: string): Promise<Checkpoint | null> {
  try {
    const filename = `${townName.toLowerCase().replace(/[^a-z0-9]/g, '-')}.json`;
    const checkpointPath = path.join(CHECKPOINT_DIR, filename);
    const content = await fs.readFile(checkpointPath, 'utf-8');
    return JSON.parse(content);
  } catch {
    return null;
  }
}

async function deleteCheckpoint(townName: string): Promise<void> {
  try {
    const filename = `${townName.toLowerCase().replace(/[^a-z0-9]/g, '-')}.json`;
    const checkpointPath = path.join(CHECKPOINT_DIR, filename);
    await fs.unlink(checkpointPath);
  } catch {
    // Ignore if doesn't exist
  }
}

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
  if (text.includes('warrant')) return 'warrants';
  if (text.includes('annual report') || text.includes('annualreport') || text.includes('town report') || text.includes('townreport')) return 'annual-reports';
  if (text.includes('form') || text.includes('application')) return 'forms';
  if (text.includes('ordinance')) return 'ordinances';
  if (text.includes('budget')) return 'budget';
  if (text.includes('policy') || text.includes('policies')) return 'policies';
  if (text.includes('regulation') || text.includes('bylaw')) return 'regulations';
  if (text.includes('report')) return 'reports';
  if (text.includes('tax rate') || text.includes('tax-rate') || text.includes('taxrate')) return 'tax-documents';
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
  
  if (htmlLower.includes('civicplus') || 
      htmlLower.includes('government websites by civicplus') ||
      htmlLower.includes('/agendacenter/') ||
      (htmlLower.includes('/node/') && htmlLower.includes('drupal'))) {
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

// ==================== CivicPlus-Specific Handling ====================

/**
 * CivicPlus: Start with base URLs and discover links dynamically
 * Documents are JS-rendered, so we extract all links and follow pagination as discovered
 */
function getCivicPlusDocumentPages(baseUrl: string): string[] {
  console.log('   🏛️  Starting with CivicPlus base URLs (dynamic discovery)...');
  
  // Just the 3 main centers - we'll discover everything else dynamically
  const pages = [
    `${baseUrl}/AgendaCenter`,
    `${baseUrl}/DocumentCenter`, 
    `${baseUrl}/FormCenter`
  ];
  
  console.log(`      Starting with ${pages.length} base URLs (will discover more)`);
  
  return pages;
}

async function discoverCivicPlusDocuments(baseUrl: string): Promise<string[]> {
  console.log('   🏛️  Querying CivicPlus API endpoints...');
  const docs: string[] = [];
  
  // Try API endpoints first (faster if they work)
  const apiEndpoints = [
    '/api/v1/Documents/All',
    '/api/v1/AgendaItems/All',
    '/api/v1/Forms/All',
  ];
  
  for (const endpoint of apiEndpoints) {
    try {
      const url = `${baseUrl}${endpoint}`;
      const response = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Accept': 'application/json, text/html, */*'
        }
      });
      
      if (!response.ok) continue;
      
      const contentType = response.headers.get('content-type') || '';
      
      if (contentType.includes('application/json')) {
        const data = await response.json();
        
        // Extract document URLs from JSON
        const extractUrls = (obj: any, urls: string[]) => {
          if (typeof obj !== 'object' || obj === null) return;
          
          for (const [key, value] of Object.entries(obj)) {
            if (key.toLowerCase().includes('url') || 
                key.toLowerCase().includes('link') ||
                key.toLowerCase().includes('file')) {
              if (typeof value === 'string' && 
                  (value.includes('.pdf') || 
                   value.includes('/ViewFile/') ||
                   value.includes('/Document/'))) {
                urls.push(value.startsWith('http') ? value : `${baseUrl}${value}`);
              }
            }
            
            if (typeof value === 'object') {
              extractUrls(value, urls);
            }
          }
        };
        
        extractUrls(data, docs);
      }
    } catch (error) {
      continue;
    }
  }
  
  const uniqueDocs = Array.from(new Set(docs));
  
  if (uniqueDocs.length > 0) {
    console.log(`   ✅ CivicPlus API: Found ${uniqueDocs.length} documents`);
  }
  
  return uniqueDocs;
}

// ==================== Sitemap Parsing (FIX #1: Sitemap-first + Recursive Index Support) ====================

interface SitemapResult {
  urls: string[];
  sitemapsProcessed: number;
  depth: number;
}

/**
 * Recursively fetch and parse sitemaps, following sitemap indexes
 * Handles WordPress-style sitemap indexes that point to sub-sitemaps
 */
async function parseSitemapRecursive(
  url: string,
  visited = new Set<string>(),
  currentDepth = 0,
  maxDepth = 3
): Promise<SitemapResult> {
  // Prevent infinite loops
  if (currentDepth >= maxDepth) {
    console.log(`   ⚠️  Max sitemap depth ${maxDepth} reached`);
    return { urls: [], sitemapsProcessed: 0, depth: currentDepth };
  }

  // Prevent duplicate fetches
  if (visited.has(url)) {
    return { urls: [], sitemapsProcessed: 0, depth: currentDepth };
  }

  visited.add(url);

  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(15000),
      headers: {
        'User-Agent': 'OPENCouncil-Bot/1.0 (Municipal Document Crawler)'
      }
    });

    if (!response.ok) {
      if (currentDepth === 0) {
        console.log(`   No sitemap found (${response.status})`);
      }
      return { urls: [], sitemapsProcessed: 0, depth: currentDepth };
    }

    const xml = await response.text();
    
    // Check if this is a sitemap index
    const isSitemapIndex = xml.includes('<sitemapindex');
    
    if (isSitemapIndex) {
      console.log(`   📚 Sitemap index detected (depth ${currentDepth})`);
      
      // Extract sub-sitemap URLs
      const sitemapMatches = xml.matchAll(/<loc>(.*?)<\/loc>/g);
      const subSitemaps = Array.from(sitemapMatches).map(match => match[1].trim());
      
      console.log(`      → Processing ${subSitemaps.length} sub-sitemaps...`);
      
      // Recursively fetch all sub-sitemaps
      const allUrls: string[] = [];
      let totalSitemaps = 1; // Count this index
      
      for (const subSitemap of subSitemaps) {
        const result = await parseSitemapRecursive(subSitemap, visited, currentDepth + 1, maxDepth);
        allUrls.push(...result.urls);
        totalSitemaps += result.sitemapsProcessed;
      }
      
      console.log(`      ✓ Extracted ${allUrls.length} total URLs from sub-sitemaps`);
      
      return { 
        urls: allUrls, 
        sitemapsProcessed: totalSitemaps,
        depth: currentDepth
      };
      
    } else {
      // Regular sitemap - extract URLs
      const urlMatches = xml.matchAll(/<loc>(.*?)<\/loc>/g);
      const urls = Array.from(urlMatches)
        .map(match => match[1].trim())
        .filter(url => {
          // Filter out XML files (these are likely more sitemaps we missed)
          if (url.endsWith('.xml')) {
            return false;
          }
          return true;
        });
      
      if (currentDepth === 0) {
        console.log(`   ✓ Found ${urls.length} URLs in sitemap`);
      }
      
      return { 
        urls, 
        sitemapsProcessed: 1,
        depth: currentDepth
      };
    }
    
  } catch (error) {
    if (currentDepth === 0) {
      console.log('   Sitemap fetch failed:', error instanceof Error ? error.message : 'Unknown error');
    }
    return { urls: [], sitemapsProcessed: 0, depth: currentDepth };
  }
}

/**
 * Main sitemap parser entry point
 */
async function parseSitemap(baseUrl: string): Promise<string[]> {
  console.log('🗺️  Fetching sitemap...');
  
  const sitemapUrl = `${baseUrl}/sitemap.xml`;
  const result = await parseSitemapRecursive(sitemapUrl);
  
  // Deduplicate URLs
  const uniqueUrls = Array.from(new Set(result.urls));
  
  if (result.sitemapsProcessed > 1) {
    console.log(`   📊 Processed ${result.sitemapsProcessed} sitemaps, found ${uniqueUrls.length} unique URLs`);
  }
  
  return uniqueUrls;
}

// FIX #6: Expanded sitemap pattern recognition
function generateYearVariants(sitemapUrls: string[]): string[] {
  const variants = new Set<string>();
  const currentYear = new Date().getFullYear();
  
  const yearPatterns = [
    /\/(\d{4})\/?$/,           // /2024
    /\/(\d{4})\/[^\/]+$/,      // /2024/january
    /[?&]year=(\d{4})/         // ?year=2024
  ];
  
  const seenPatterns = new Set<string>();
  
  for (const url of sitemapUrls) {
    for (const pattern of yearPatterns) {
      const match = url.match(pattern);
      if (match) {
        const year = match[1];
        const basePattern = url.replace(pattern, (m, y) => m.replace(y, 'YEAR'));
        
        if (!seenPatterns.has(basePattern)) {
          seenPatterns.add(basePattern);
          
          // Generate past 10 years
          for (let y = currentYear; y >= currentYear - 10; y--) {
            const variant = basePattern.replace('YEAR', y.toString());
            variants.add(variant);
          }
        }
      }
    }
  }
  
  return Array.from(variants);
}

// ==================== Document Extraction ====================

async function extractDocumentLinks(page: Page, baseUrl: string, isCivicPlus: boolean = false): Promise<string[]> {
  const base = baseUrl.replace(/\/$/, '');
  
  // CivicPlus-specific: Wait for JS rendering and trigger lazy loading
  if (isCivicPlus) {
    try {
      console.log('      [CivicPlus] Waiting for JS rendering...');
      
      // Wait for initial render
      await page.waitForTimeout(3000);
      
      // Click "View All" or "Show All" buttons first
      const viewAllClicked = await page.evaluate(() => {
        const viewAllSelectors = [
          'button:has-text("View All")',
          'a:has-text("View All")',
          'button:has-text("Show All")',
          'a:has-text("Show All")',
          '[class*="view-all"]',
          '[class*="show-all"]',
          '[data-action*="viewall"]',
          '[data-action*="showall"]'
        ];
        
        let clicked = false;
        for (const selector of viewAllSelectors) {
          try {
            const elements = document.querySelectorAll(selector);
            elements.forEach(el => {
              const text = el.textContent?.toLowerCase() || '';
              if (text.includes('view all') || text.includes('show all')) {
                if (el instanceof HTMLElement) {
                  el.click();
                  clicked = true;
                }
              }
            });
          } catch {}
        }
        return clicked;
      });
      
      if (viewAllClicked) {
        console.log('      [CivicPlus] Clicked "View All" button');
        await page.waitForTimeout(3000);
      }
      
      // Scroll to trigger lazy loading
      await page.evaluate(() => {
        window.scrollTo(0, document.body.scrollHeight);
      });
      await page.waitForTimeout(2000);
      
      // Scroll back up
      await page.evaluate(() => {
        window.scrollTo(0, 0);
      });
      await page.waitForTimeout(1000);
      
      // Click all "Load More", "Show More", pagination buttons
      const loadMoreResult = await page.evaluate(() => {
        const selectors = [
          'button',
          'a',
          '[class*="load-more"]',
          '[class*="show-more"]',
          '[class*="pagination"] a',
          '.pager a',
          '[data-action*="loadmore"]',
          '[data-action*="showmore"]'
        ];
        
        let clickCount = 0;
        const clickedTexts: string[] = [];
        
        for (const selector of selectors) {
          try {
            const elements = document.querySelectorAll(selector);
            elements.forEach(el => {
              const text = el.textContent?.toLowerCase() || '';
              if (text.includes('load more') || 
                  text.includes('show more') || 
                  text.includes('next') ||
                  text.includes('more results')) {
                if (el instanceof HTMLElement && el.offsetParent !== null) {
                  try {
                    el.click();
                    clickCount++;
                    clickedTexts.push(text.substring(0, 30));
                  } catch {}
                }
              }
            });
          } catch {}
        }
        
        return { clickCount, clickedTexts };
      });
      
      if (loadMoreResult.clickCount > 0) {
        console.log(`      [CivicPlus] Clicked ${loadMoreResult.clickCount} pagination buttons`);
        await page.waitForTimeout(3000); // Wait for content to load
      }
      
      // Wait for any network activity to settle
      await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
      
    } catch (error) {
      console.log(`      [CivicPlus] JS waiting error: ${error instanceof Error ? error.message : 'Unknown'}`);
    }
  }
  
  let links: string[] = [];
  
  try {
    links = await page.evaluate((baseArg) => {
      const urls: string[] = [];
      const docExts = ['.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.txt', '.rtf'];
      const imageExts = ['.jpg', '.jpeg', '.png', '.gif', '.svg', '.webp', '.bmp'];
      const curr = window.location.href;
      
      // CivicPlus-specific: Extract from row structures (but don't return early!)
      const civicPlusRows = document.querySelectorAll('.catAgendaRow, .catDocumentRow, .catFormRow, [data-type="document"], [data-type="agenda"]');
      if (civicPlusRows.length > 0) {
        console.log(`[CivicPlus] Found ${civicPlusRows.length} document rows`);
        
        civicPlusRows.forEach(row => {
          row.querySelectorAll('a[href]').forEach((link) => {
            let href = link.getAttribute('href');
            if (!href || href.includes('PreviousVersions')) return; // Skip version history
            
            try {
              const u = new URL(href, curr);
              if (u.hostname !== new URL(baseArg).hostname) return;
              href = u.href;
            } catch {
              return;
            }
            
            // CivicPlus ViewFile links are always documents
            if (href.includes('/ViewFile/') || 
                href.includes('/View/') && href.match(/\/\d+$/)) {
              urls.push(href);
            }
          });
        });
        
        console.log(`[CivicPlus] Extracted ${urls.length} docs from row structures`);
      }
    
    // ALSO run general document extraction (don't skip it!)
    document.querySelectorAll('a[href]').forEach((link) => {
      let href = link.getAttribute('href');
      if (!href || href.startsWith('#') || href.startsWith('javascript:') || 
          href.startsWith('mailto:') || href.startsWith('tel:') ||
          href.includes('PreviousVersions')) return;
      
      try {
        const u = new URL(href, curr);
        const bHost = new URL(baseArg).hostname;
        if (u.hostname !== bHost) return;
        href = u.href;
      } catch {
        return;
      }
      
      const low = href.toLowerCase();
      
      if (imageExts.some(ext => low.includes(ext))) return;
      
      if (docExts.some(ext => low.includes(ext)) ||
          href.includes('/wp-content/uploads/') ||
          href.includes('/AgendaCenter/ViewFile/') ||
          href.includes('/DocumentCenter/View/') ||
          href.includes('/FormCenter/View/') ||
          href.includes('/ViewFile/') ||
          href.includes('how_do_i/') ||
          href.match(/\/(forms|documents).*\.php/i) ||
          href.match(/\/files?\/[^\/]+$/i) ||
          href.match(/\/download\/[^\/]+$/i) ||
          href.match(/\/view\/[^\/]+$/i)) {
        urls.push(href);
      }
    });
    
    document.querySelectorAll('iframe[src], embed[src], object[data]').forEach((el) => {
      const src = el.getAttribute('src') || el.getAttribute('data');
      if (src) {
        const srcLow = src.toLowerCase();
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
  } catch (error) {
    console.log(`      ❌ Extraction error: ${error instanceof Error ? error.message : String(error)}`);
    return [];
  }
  
  console.log(`      ✓ Extracted ${links.length} document links`);
  return links;
}

// FIX #3: Better nav extraction with fallback
async function extractAllNavigationLinks(page: Page, baseUrl: string): Promise<string[]> {
  const base = baseUrl.replace(/\/$/, '');
  
  // Aggressive menu expansion
  await page.evaluate(() => {
    // Hover over menu items
    document.querySelectorAll('.menu-item-has-children, .menu > li, nav li, header li').forEach(item => {
      if (item instanceof HTMLElement) {
        item.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
        item.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
        item.classList.add('hover', 'focus', 'active', 'open');
      }
    });
    
    // Click ALL possible toggles
    const toggleSelectors = [
      'button', '[role="button"]', '.toggle', '.expand',
      '.menu-toggle', '.mobile-menu-toggle', '.navbar-toggle',
      '[class*="menu"]', '[class*="nav"]', '[class*="toggle"]',
      '[aria-expanded="false"]', '[aria-haspopup]'
    ];
    
    toggleSelectors.forEach(sel => {
      document.querySelectorAll(sel).forEach(el => {
        if (el instanceof HTMLElement) {
          try {
            el.click();
            el.dispatchEvent(new Event('click', { bubbles: true }));
          } catch {}
        }
      });
    });
    
    // Force display hidden submenus
    document.querySelectorAll('.sub-menu, .dropdown-menu, .submenu').forEach(menu => {
      if (menu instanceof HTMLElement) {
        menu.style.display = 'block';
        menu.style.visibility = 'visible';
        menu.style.opacity = '1';
      }
    });
  });
  
  // Wait longer for AJAX
  await sleep(2000);
  
  // Extract from nav selectors
  const links = await page.evaluate((baseArg) => {
    const urls = [];
    const selectors = [
      'nav a', 'header a', '.menu a', '.navigation a',
      '[role="navigation"] a', '.navbar a', '.nav a',
      '#menu a', '#navigation a', '.site-navigation a',
      '.main-navigation a', '.primary-navigation a',
      'ul.menu a', 'ul.nav a', 'ul[class*="menu"] a',
      '.sub-menu a', '.dropdown-menu a', '.submenu a'
    ];
    
    selectors.forEach(sel => {
      document.querySelectorAll(sel).forEach(link => {
        const href = link.getAttribute('href');
        if (href && !href.startsWith('#') && !href.startsWith('mailto:') && !href.startsWith('tel:') && !href.startsWith('javascript:')) {
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
  
  // FALLBACK: If < 5 links, scrape ALL page links
  if (links.length < 5) {
    console.log('   ⚠️  Low nav link count, using fallback extraction');
    const allLinks = await page.evaluate((baseArg) => {
      const urls = [];
      document.querySelectorAll('a[href]').forEach(link => {
        const href = link.getAttribute('href');
        if (href && !href.startsWith('#') && !href.startsWith('mailto:') && !href.startsWith('tel:') && !href.startsWith('javascript:')) {
          try {
            const u = new URL(href, window.location.href);
            if (u.hostname === new URL(baseArg).hostname) {
              // Exclude file extensions
              if (!u.pathname.match(/\.(pdf|jpg|png|gif|doc|docx|xls|xlsx)$/i)) {
                urls.push(u.href);
              }
            }
          } catch {}
        }
      });
      return [...new Set(urls)];
    }, base);
    
    console.log(`   ✓ Fallback found ${allLinks.length} page links`);
    return allLinks;
  }
  
  return links;
}

// FIX #2: Cloudflare handling with headful mode
async function launchBrowserWithCloudflareHandling(baseUrl: string, forceHeadful: boolean = false): Promise<Browser> {
  // Always launch headless - headful mode crashes on servers without X display
  const browser = await chromium.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-blink-features=AutomationControlled'
    ]
  });
  
  // Test for Cloudflare but DON'T relaunch
  const page = await browser.newPage({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    viewport: { width: 1920, height: 1080 }
  });
  
  try {
    await page.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: 10000 });
    await sleep(5000);
    
    const title = await page.title();
    const isCloudflare = title.toLowerCase().includes('just a moment') || 
                        title.toLowerCase().includes('checking your browser');
    
    if (isCloudflare) {
      console.log('   ⚠️  Cloudflare detected - will work with limited access');
    }
    
    await page.close();
    return browser;
  } catch (error) {
    await page.close();
    return browser;
  }
}

// FIX #5: Document content validation
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
          
          // Validate content
          if (await isValidDocument(tempPath, filename)) {
            return tempPath;
          } else {
            await fs.unlink(tempPath);
            return null;
          }
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
          
          if (await isValidDocument(tempPath, filename)) {
            return tempPath;
          } else {
            await fs.unlink(tempPath);
            return null;
          }
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
          
          if (await isValidDocument(tempPath, filename)) {
            return tempPath;
          } else {
            await fs.unlink(tempPath);
            return null;
          }
        }
      }
    } catch {}
    
    return null;
  } catch {
    return null;
  }
}

// FIX #5: Validate downloaded content
async function isValidDocument(filePath: string, filename: string): Promise<boolean> {
  try {
    const buffer = await fs.readFile(filePath);
    
    if (buffer.length < 100) {
      return false; // Too small to be a real document
    }
    
    const first4 = buffer.toString('utf8', 0, 4);
    const first100 = buffer.toString('utf8', 0, 100).toLowerCase();
    
    // PDF signature
    if (first4.startsWith('%PDF')) {
      return true;
    }
    
    // ZIP signature (docx, xlsx, pptx)
    if (first4.startsWith('PK')) {
      return true;
    }
    
    // HTML detection (interstitial page)
    if (first100.includes('<html') || first100.includes('<!doctype')) {
      console.log(`      ⚠️  ${filename} is HTML, not a document`);
      return false;
    }
    
    // Plain text is OK for .txt files
    if (filename.endsWith('.txt') || filename.endsWith('.rtf')) {
      return true;
    }
    
    // If we can't identify it but it's not HTML, accept it
    return true;
  } catch {
    return false;
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

async function crawl(town: string, baseUrl: string, dryRun: boolean = false, maxPages: number = 200, resume: boolean = false) {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`📄 Universal Document Crawler V2`);
  console.log(`🏛️  Town: ${town}`);
  console.log(`🌐 URL: ${baseUrl}`);
  console.log(`📊 Max pages: ${maxPages}`);
  if (resume) {
    console.log(`🔄 Resume: Enabled`);
  }
  console.log(`${'='.repeat(60)}\n`);
  
  // STATE MANAGEMENT: Get/create town and start crawl run
  let townRecord: CrawlerTown | null = null;
  let crawlRun: CrawlerRun | null = null;
  
  try {
    const slug = town.toLowerCase().replace(/[^a-z0-9]/g, '-');
    townRecord = await getTown(slug);
    
    if (!townRecord) {
      console.log(`⚠️  Town "${town}" not found in database. State tracking disabled.`);
    } else {
      console.log(`📊 State tracking enabled for ${townRecord.name}`);
      
      // Create crawl run record
      crawlRun = await createRun({
        townId: townRecord.id,
        mode: resume ? 'incremental' : 'full',
        triggerType: 'manual',
        maxPagesLimit: maxPages,
        resumedFromCheckpoint: resume,
      });
      
      console.log(`   Run ID: ${crawlRun.id}\n`);
    }
  } catch (error) {
    console.error('⚠️  State tracking initialization failed:', error instanceof Error ? error.message : 'Unknown error');
    console.log('   Continuing without state tracking...\n');
  }
  
  // Check for existing checkpoint
  let checkpoint: Checkpoint | null = null;
  if (resume) {
    checkpoint = await loadCheckpoint(town);
    if (checkpoint) {
      console.log(`✅ Found checkpoint from ${checkpoint.timestamp}`);
      console.log(`   Visited: ${checkpoint.visitedUrls.length} URLs`);
      console.log(`   Queue: ${checkpoint.queueUrls.length} URLs`);
      console.log(`   Discovered: ${checkpoint.discoveredDocs.length} documents`);
      console.log(`   Pages visited: ${checkpoint.pagesVisited}\n`);
    } else {
      console.log(`ℹ️  No checkpoint found, starting fresh\n`);
    }
  }
  
  const stats: CrawlStats = checkpoint ? {
    discovered: new Set(checkpoint.discoveredDocs),
    downloaded: checkpoint.stats.downloaded,
    uploaded: checkpoint.stats.uploaded,
    skipped: checkpoint.stats.skipped,
    failed: checkpoint.stats.failed,
    byCategory: checkpoint.stats.byCategory
  } : {
    discovered: new Set(),
    downloaded: 0,
    uploaded: 0,
    skipped: 0,
    failed: 0,
    byCategory: {}
  };
  
  // STRATEGY 1: Sitemap first (doesn't need browser)
  const sitemapUrls = await parseSitemap(baseUrl);
  const yearVariants = generateYearVariants(sitemapUrls);
  
  console.log(`   Generated ${yearVariants.length} year variants\n`);
  
  // STATE MANAGEMENT: Save sitemap snapshot
  if (townRecord && sitemapUrls.length > 0) {
    try {
      // Fetch raw sitemap for hashing
      const sitemapResponse = await fetch(`${baseUrl}/sitemap.xml`);
      if (sitemapResponse.ok) {
        const sitemapXml = await sitemapResponse.text();
        const sitemapHash = hashSitemap(sitemapXml);
        
        const sitemapData: SitemapUrl[] = sitemapUrls.map(url => ({
          url,
          priority: HIGH_VALUE_PATHS.some(p => url.includes(p)) ? 'high' as const : 'medium' as const,
          discovered: new Date().toISOString(),
          docCount: 0,
        }));
        
        await saveSitemap({
          townId: townRecord.id,
          sitemapUrl: `${baseUrl}/sitemap.xml`,
          hash: sitemapHash,
          urlCount: sitemapUrls.length,
          urls: sitemapData,
        });
        
        console.log(`   📊 Sitemap saved (${sitemapUrls.length} URLs, hash: ${sitemapHash.substring(0, 8)}...)\n`);
      }
    } catch (error) {
      console.error('   ⚠️  Failed to save sitemap:', error instanceof Error ? error.message : 'Unknown');
    }
  }
  
  // Launch browser (with Cloudflare detection)
  const browser = await launchBrowserWithCloudflareHandling(baseUrl);
  
  const page = await browser.newPage({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    viewport: { width: 1920, height: 1080 }
  });
  
  // Forward browser console to debug extraction issues
  page.on('console', msg => {
    const text = msg.text();
    if (text.includes('[CivicPlus]') || text.includes('[Browser]') || text.includes('ERROR') || text.includes('ERROR')) {
      console.log(`      [Browser] ${text}`);
    }
  });
  
  // STRATEGY 2: Homepage and navigation
  console.log('🏠 Loading homepage...');
  let homepageLoaded = false;
  let cms: CMSType = 'Custom';
  let navLinks: string[] = [];
  let actualBaseUrl = baseUrl; // Track actual URL after redirects
  
  try {
    await page.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await sleep(5000);
    
    // Capture actual URL after redirects (e.g., madison-nh.org -> www.madison-nh.org)
    actualBaseUrl = page.url();
    const actualUrl = new URL(actualBaseUrl);
    const originalUrl = new URL(baseUrl);
    
    if (actualUrl.hostname !== originalUrl.hostname) {
      console.log(`   ⚠️  Redirect detected: ${originalUrl.hostname} → ${actualUrl.hostname}`);
      // Update baseUrl to use actual hostname
      baseUrl = `${actualUrl.protocol}//${actualUrl.hostname}`;
    }
    
    // Wait for Cloudflare
    let title = await page.title();
    let attempts = 0;
    while ((title.toLowerCase().includes('just a moment') || title.toLowerCase().includes('checking your browser')) && attempts < 3) {
      console.log(`   Waiting for Cloudflare (attempt ${attempts + 1}/3)...`);
      await sleep(15000); // Longer wait per attempt
      title = await page.title();
      attempts++;
    }
    
    if (!title.toLowerCase().includes('just a moment')) {
      homepageLoaded = true;
      cms = await detectCMS(page);
      console.log(`   ✓ CMS detected: ${cms}`);
      
      // Extract navigation - use actualBaseUrl for proper hostname matching
      console.log('   Extracting navigation links...');
      navLinks = await extractAllNavigationLinks(page, actualBaseUrl);
      console.log(`   ✓ Found ${navLinks.length} navigation links\n`);
    } else {
      console.log('   ⚠️  Cloudflare block persists, will rely on sitemap\n');
    }
  } catch (error) {
    console.log('   ⚠️  Homepage load failed:', error instanceof Error ? error.message : 'Unknown error');
    console.log('   Will rely on sitemap URLs\n');
  }
  
  // CivicPlus-specific handling
  let civicPlusDocs: string[] = [];
  let civicPlusPages: string[] = [];
  if (cms === 'CivicPlus') {
    try {
      // Try API first (fast)
      civicPlusDocs = await discoverCivicPlusDocuments(baseUrl);
      
      // Add CivicPlus document center pages for JS-based crawling
      civicPlusPages = getCivicPlusDocumentPages(baseUrl);
      console.log(`   📄 Added ${civicPlusPages.length} CivicPlus document pages (with JS waiting)`);
    } catch (error) {
      console.log('   ⚠️  CivicPlus setup failed:', error instanceof Error ? error.message : 'Unknown');
    }
  }
  
  // Build visit queue
  console.log('📋 Building page visit queue...');
  const visited = new Set<string>(checkpoint?.visitedUrls || []);
  const toVisit = new Set<string>(checkpoint?.queueUrls || []);
  
  // If no checkpoint, build fresh queue
  if (!checkpoint) {
    // Priority 1: Sitemap URLs (proven to exist)
    sitemapUrls.forEach(url => toVisit.add(url));
    yearVariants.forEach(url => toVisit.add(url));
    
    // Priority 2: CivicPlus document pages (will use JS waiting)
    civicPlusPages.forEach(url => toVisit.add(url));
    
    // Priority 3: CivicPlus API documents (direct document URLs)
    civicPlusDocs.forEach(url => toVisit.add(url));
    
    // Priority 4: Navigation links
    navLinks.forEach(link => toVisit.add(link));
    
    // Priority 5: High-value paths
    HIGH_VALUE_PATHS.forEach(path => {
      toVisit.add(`${baseUrl}${path}`);
    });
  } else {
    // Resuming - queue was loaded from checkpoint
    console.log(`   ✓ Restored ${visited.size} visited URLs`);
    console.log(`   ✓ Restored ${toVisit.size} queued URLs`);
  }
  
  // Priority 4: CMS-specific patterns
  if (cms === 'CivicPlus' || cms === 'Custom') {
    const commonNodeIds = [8, 10, 12, 15, 20, 25, 30, 35, 40, 50, 60, 70, 80, 90, 100, 105, 110];
    const currentYear = new Date().getFullYear();
    
    commonNodeIds.forEach(id => {
      toVisit.add(`${baseUrl}/node/${id}/minutes`);
      toVisit.add(`${baseUrl}/node/${id}/agendas`);
      toVisit.add(`${baseUrl}/node/${id}/files`);
      
      for (let year = currentYear; year >= currentYear - 3; year--) {
        toVisit.add(`${baseUrl}/node/${id}/minutes/${year}`);
        toVisit.add(`${baseUrl}/node/${id}/agendas/${year}`);
      }
    });
  }
  
  console.log(`   Total pages to visit: ${toVisit.size}\n`);
  
  // Visit pages and extract documents
  console.log('📥 Visiting pages and extracting documents (dynamic discovery enabled)...');
  
  let pagesVisited = checkpoint?.pagesVisited || 0;
  let adaptiveMaxPages = maxPages;
  
  // Convert to array for iteration, but allow dynamic additions
  const urlQueue = Array.from(toVisit);
  let queueIndex = 0;
  
  while (queueIndex < urlQueue.length && pagesVisited < adaptiveMaxPages) {
    const url = urlQueue[queueIndex++];
    if (visited.has(url)) continue;
    
    visited.add(url);
    pagesVisited++;
    
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
      
      // Check for Cloudflare
      const title = await page.title();
      if (title.toLowerCase().includes('just a moment')) {
        await sleep(15000);
        const retryTitle = await page.title();
        if (retryTitle.toLowerCase().includes('just a moment')) {
          process.stdout.write('⊗');
          continue;
        }
      }
      
      // Expand JS sections
      await page.evaluate(() => {
        document.querySelectorAll('[aria-expanded="false"], .toggle, .accordion-toggle').forEach(el => {
          if (el instanceof HTMLElement) {
            try { el.click(); } catch {}
          }
        });
      });
      
      await sleep(500);
      
      // Extract documents (with CivicPlus-specific JS waiting if needed)
      const docs = await extractDocumentLinks(page, baseUrl, cms === 'CivicPlus');
      docs.forEach(doc => stats.discovered.add(normalizeUrl(doc)));
      
      // DYNAMIC DISCOVERY: Extract navigation links for CivicPlus sites
      if (cms === 'CivicPlus') {
        const navLinks = await page.evaluate((baseArg) => {
          const links: string[] = [];
          const curr = window.location.href;
          
          // Look for pagination and navigation links
          const selectors = [
            '.pager a',
            '.pagination a',
            '[class*="pagination"] a',
            'a[href*="page="]',
            'a[href*="Page="]',
            // Year/category filters in AgendaCenter
            'a[href*="AgendaCenter"]',
            'a[href*="DocumentCenter"]',
            'a[href*="FormCenter"]',
          ];
          
          selectors.forEach(selector => {
            document.querySelectorAll(selector).forEach((link) => {
              const href = link.getAttribute('href');
              if (!href || href.startsWith('#') || href.startsWith('javascript:')) return;
              
              try {
                const u = new URL(href, curr);
                if (u.hostname === new URL(baseArg).hostname) {
                  // Skip document view links entirely
                  if (u.pathname.includes('/ViewFile/')) return;
                  
                  // Add navigation links: pagination, AgendaCenter/DocumentCenter/FormCenter pages
                  if (u.pathname.includes('/AgendaCenter') ||
                      u.pathname.includes('/DocumentCenter') ||
                      u.pathname.includes('/FormCenter') ||
                      u.search.includes('page=') ||
                      u.search.includes('Page=')) {
                    links.push(u.href);
                  }
                }
              } catch {}
            });
          });
          
          return [...new Set(links)]; // Dedupe
        }, baseUrl);
        
        // Add discovered navigation links to queue (with safety limit)
        let newLinksAdded = 0;
        const MAX_NEW_LINKS_PER_PAGE = 20; // Prevent runaway discovery
        
        navLinks.slice(0, MAX_NEW_LINKS_PER_PAGE).forEach(link => {
          if (!visited.has(link) && !toVisit.has(link)) {
            toVisit.add(link);
            urlQueue.push(link);
            newLinksAdded++;
          }
        });
        
        if (newLinksAdded > 0) {
          process.stdout.write(`+${newLinksAdded}`);
        }
        
        if (navLinks.length > MAX_NEW_LINKS_PER_PAGE) {
          console.log(`\n      [CivicPlus] Found ${navLinks.length} nav links, limited to ${MAX_NEW_LINKS_PER_PAGE}`);
        }
      }
      
      // STATE MANAGEMENT: Record URL visit
      if (townRecord) {
        try {
          await recordUrl({
            townId: townRecord.id,
            url,
            urlHash: hashUrl(url),
            source: sitemapUrls.includes(url) ? 'sitemap' : 'navigation',
            priority: HIGH_VALUE_PATHS.some(p => url.includes(p)) ? 'high' : 'medium',
            lastVisited: new Date(),
            visitCount: 1,
            documentCount: docs.length,
            status: 'visited',
          });
        } catch (error) {
          // Silently fail URL recording - don't stop crawl
        }
      }
      
      if (docs.length > 0) {
        process.stdout.write(`✓(${docs.length})`);
      } else {
        process.stdout.write('.');
      }
      
      if (pagesVisited % 20 === 0) {
        console.log(`\n   [${pagesVisited}/${adaptiveMaxPages}] ${stats.discovered.size} docs found`);
        
        // FIX #4: Adaptive page limit
        if (stats.discovered.size > 100 && pagesVisited >= adaptiveMaxPages) {
          adaptiveMaxPages += 50;
          console.log(`   ⚡ High doc count, extending to ${adaptiveMaxPages} pages`);
        }
        
        // Save checkpoint every 20 pages
        if (resume) {
          await saveCheckpoint({
            townName: town,
            baseUrl,
            visitedUrls: Array.from(visited),
            queueUrls: Array.from(toVisit).filter(u => !visited.has(u)),
            discoveredDocs: Array.from(stats.discovered),
            pagesVisited,
            stats: {
              downloaded: stats.downloaded,
              uploaded: stats.uploaded,
              skipped: stats.skipped,
              failed: stats.failed,
              byCategory: stats.byCategory
            },
            timestamp: new Date().toISOString()
          });
        }
        
        // STATE MANAGEMENT: Update crawl run progress
        if (crawlRun) {
          try {
            await updateRun(crawlRun.id, {
              pagesVisited,
              documentsDiscovered: stats.discovered.size,
            });
          } catch (error) {
            // Silently fail run updates
          }
        }
      }
      
    } catch {
      process.stdout.write('✗');
    }
  }
  
  console.log(`\n\n${'='.repeat(60)}`);
  console.log(`DISCOVERY COMPLETE: ${stats.discovered.size} documents found`);
  console.log(`${'='.repeat(60)}`);
  
  // Discovery method breakdown for logging
  console.log('\n📊 Discovery Method Breakdown:');
  console.log(`   CMS Type: ${cms}`);
  console.log(`   Sitemap URLs processed: ${sitemapUrls.length}`);
  console.log(`   Navigation links found: ${navLinks.length}`);
  if (cms === 'CivicPlus') {
    console.log(`   CivicPlus pages generated: ${civicPlusPages.length}`);
    console.log(`   CivicPlus API documents: ${civicPlusDocs.length}`);
  }
  console.log(`   Pages visited: ${pagesVisited}`);
  console.log(`   Documents discovered: ${stats.discovered.size}\n`);
  
  if (stats.discovered.size === 0) {
    console.log('⚠️  No documents found.');
    
    // STATE MANAGEMENT: Complete run with failure
    if (crawlRun && townRecord) {
      try {
        await completeRun(crawlRun.id, 'completed', undefined, 'No documents discovered');
        await incrementFailureCount(townRecord.id);
      } catch {}
    }
    
    await browser.close();
    return;
  }
  
  if (dryRun) {
    console.log('🔍 DRY RUN - Skipping download/upload\n');
    console.log('Sample documents:');
    Array.from(stats.discovered).slice(0, 10).forEach(doc => {
      console.log(`   ${doc}`);
    });
    
    // STATE MANAGEMENT: Complete dry run
    if (crawlRun && townRecord) {
      try {
        await completeRun(crawlRun.id, 'completed', {
          byCategory: {},
          byBoard: {},
          newDocuments: 0,
          duplicates: 0,
          errors: [],
        });
      } catch {}
    }
    
    await browser.close();
    return;
  }
  
  // Check if we should queue for upload service
  const queueForUpload = process.argv.includes('--queue-upload');
  
  if (queueForUpload) {
    console.log('📦 Queueing documents for upload service...\n');
  } else {
    console.log('⬇️  Downloading and uploading to S3...\n');
  }
  
  const uploadQueue: Array<{localPath: string, s3Key: string, url: string, title: string}> = [];
  
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
    
    const docUrlHash = hashUrl(docUrl);
    
    // STATE MANAGEMENT: Record document as discovered (BEFORE S3 check!)
    // This ensures state tracks ALL discovered docs, not just new uploads
    if (townRecord) {
      try {
        await recordDocument({
          townId: townRecord.id,
          url: docUrl,
          urlHash: docUrlHash,
          filename,
          category,
          year,
          status: 'discovered',
        });
      } catch (error) {
        // Silently fail document recording (e.g., duplicate URL)
      }
    }
    
    // Check if already in S3 - skip upload but doc is recorded in state above
    const exists = await documentExistsInS3(s3Key);
    if (exists) {
      stats.skipped++;
      process.stdout.write('⊙');
      continue;
    }
    
    const localPath = await downloadDocument(page, docUrl, filename);
    if (!localPath) {
      stats.failed++;
      
      // STATE MANAGEMENT: Mark document as failed
      if (townRecord) {
        try {
          await markDocumentFailed(docUrlHash, 'Download failed');
        } catch {}
      }
      
      process.stdout.write('✗');
      continue;
    }
    
    stats.downloaded++;
    
    if (queueForUpload) {
      // Queue for upload service
      uploadQueue.push({
        localPath,
        s3Key,
        url: docUrl,
        title: filename
      });
      stats.uploaded++; // Count as "queued for upload"
      stats.byCategory[category] = (stats.byCategory[category] || 0) + 1;
      process.stdout.write('Q');
    } else {
      // Upload immediately
      const uploaded = await uploadToS3(localPath, s3Key);
      if (uploaded) {
        stats.uploaded++;
        stats.byCategory[category] = (stats.byCategory[category] || 0) + 1;
        
        // STATE MANAGEMENT: Mark document as uploaded
        if (townRecord) {
          try {
            await markDocumentUploaded(docUrlHash, s3Key);
          } catch {}
        }
        
        process.stdout.write('✓');
        
        // Delete local file after immediate upload
        try {
          await fs.unlink(localPath);
        } catch {}
      } else {
        stats.failed++;
        
        // STATE MANAGEMENT: Mark upload as failed
        if (townRecord) {
          try {
            await markDocumentFailed(docUrlHash, 'S3 upload failed');
          } catch {}
        }
        
        process.stdout.write('✗');
      }
    }
  }
  
  await browser.close();
  
  // Save upload queue if requested
  if (queueForUpload && uploadQueue.length > 0) {
    const queueDir = path.join(process.cwd(), 'upload-queue');
    await fs.mkdir(queueDir, { recursive: true });
    const queueFile = path.join(queueDir, `${town.toLowerCase().replace(/\s+/g, '-')}-${Date.now()}.json`);
    await fs.writeFile(queueFile, JSON.stringify({
      townName: town,
      documents: uploadQueue
    }, null, 2));
    console.log(`\n📦 Upload queue saved: ${queueFile}`);
    console.log(`   ${uploadQueue.length} documents queued for upload service`);
  }
  
  // Delete checkpoint on successful completion
  if (resume) {
    await deleteCheckpoint(town);
    console.log(`\n✅ Checkpoint deleted (crawl complete)`);
  }
  
  // STATE MANAGEMENT: Complete crawl run and update town stats
  if (crawlRun && townRecord) {
    try {
      const runSummary: CrawlRunSummary = {
        byCategory: stats.byCategory,
        byBoard: {},
        newDocuments: stats.uploaded,
        duplicates: stats.skipped,
        errors: [],
      };
      
      const runStatus = stats.failed > stats.uploaded ? 'failed' : 'completed';
      
      await completeRun(
        crawlRun.id,
        runStatus,
        runSummary,
        stats.failed > 0 ? `${stats.failed} documents failed to download/upload` : undefined
      );
      
      // Update town statistics
      await updateTownStats(townRecord.id, {
        totalDocuments: stats.discovered.size,
        totalUploaded: stats.uploaded,
        lastCrawlDocsFound: stats.discovered.size,
        lastFullCrawl: new Date(),
      });
      
      if (stats.uploaded > 0) {
        await resetFailureCount(townRecord.id);
      } else if (stats.discovered.size === 0) {
        await incrementFailureCount(townRecord.id);
      }
      
      console.log(`\n📊 State updated in database`);
    } catch (error) {
      console.error('\n⚠️  Failed to update final state:', error instanceof Error ? error.message : 'Unknown');
    }
  }
  
  // Summary
  console.log(`\n${'='.repeat(60)}`);
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
  .name('universal-document-crawler-v2')
  .description('Universal document crawler V2 with improved Cloudflare handling')
  .requiredOption('--town <name>', 'Town name')
  .requiredOption('--url <url>', 'Town website URL')
  .option('--dry-run', 'Discover documents but do not download/upload')
  .option('--max-pages <number>', 'Maximum pages to visit', '200')
  .option('--resume', 'Resume from checkpoint if available')
  .option('--queue-upload', 'Queue documents for upload service instead of immediate upload')
  .action(async (options) => {
    await crawl(
      options.town,
      options.url,
      options.dryRun || false,
      parseInt(options.maxPages),
      options.resume || false
    );
  });

program.parse();
