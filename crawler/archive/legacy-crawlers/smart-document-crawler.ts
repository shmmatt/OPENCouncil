#!/usr/bin/env tsx
/**
 * Smart Document Crawler - Adaptive multi-strategy approach
 * 
 * Strategy:
 * 1. Fingerprint CMS and site structure
 * 2. Try focused index page approach first (fast, polite)
 * 3. Evaluate results - if insufficient coverage, switch strategies:
 *    - Add navigation link following (WordPress with deep archives)
 *    - Try alternative node IDs (CivicPlus)
 *    - Expand search depth
 * 4. Stop when coverage is adequate or max effort reached
 */

import { chromium } from 'playwright-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import { S3Client, PutObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import { promises as fs } from 'fs';
import * as path from 'path';
import { Command } from 'commander';

chromium.use(StealthPlugin());

// ==================== Configuration ====================

const S3_BUCKET = 'opencouncil-municipal-docs';
const S3_REGION = 'us-east-1';
const TEMP_DIR = '/tmp/opencouncil-docs';
const CRAWL_DELAY_MS = 1000;

const s3 = new S3Client({
  region: S3_REGION,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID || 'AKIAXEEDJLE2AYAKJDMZ',
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || '',
  },
});

// ==================== Types ====================

interface CrawlStats {
  discovered: Set<string>;
  downloaded: number;
  uploaded: number;
  skipped: number;
  failed: number;
  byCategory: Record<string, number>;
  strategiesUsed: string[];
}

type CMSType = 'WordPress' | 'CivicPlus' | 'Revize' | 'Custom';

interface CoverageAssessment {
  docCount: number;
  hasMinutes: boolean;
  hasAgendas: boolean;
  hasForms: boolean;
  hasMultipleYears: boolean;
  adequateCoverage: boolean;
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
  
  // Priority order matters - check most specific first
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

function assessCoverage(discovered: Set<string>): CoverageAssessment {
  const docs = Array.from(discovered);
  const categories = docs.map(d => categorizeDocument(d, d));
  const years = docs.map(d => extractYear(d)).filter(y => y !== 'unknown');
  
  const hasMinutes = categories.includes('minutes');
  const hasAgendas = categories.includes('agendas');
  const hasForms = categories.includes('forms');
  const hasMultipleYears = new Set(years).size >= 3;
  
  // Coverage is adequate if:
  // - Has minutes OR agendas (not just forms)
  // - Has at least 100 docs, OR
  // - Has all three categories (minutes, agendas, forms)
  const adequateCoverage = (
    (hasMinutes || hasAgendas) && 
    (docs.length >= 100 || (hasMinutes && hasAgendas && hasForms))
  );
  
  return {
    docCount: docs.length,
    hasMinutes,
    hasAgendas,
    hasForms,
    hasMultipleYears,
    adequateCoverage
  };
}

// ==================== CMS Detection ====================

async function detectCMS(page: any): Promise<CMSType> {
  const html = await page.content();
  const htmlLower = html.toLowerCase();
  
  if (htmlLower.includes('civicplus') || htmlLower.includes('government websites by civicplus')) {
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

async function extractDocumentLinks(page: any, baseUrl: string): Promise<string[]> {
  const base = baseUrl.replace(/\/$/, '');
  const links = await page.evaluate((baseArg) => {
    const urls = [];
    const docExts = ['.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx'];
    const imageExts = ['.jpg', '.jpeg', '.png', '.gif', '.svg', '.webp', '.bmp'];
    const curr = window.location.href;
    
    document.querySelectorAll('a[href]').forEach((link) => {
      let href = link.getAttribute('href');
      if (!href || href.startsWith('#') || href.startsWith('javascript:') || 
          href.startsWith('mailto:') || href.startsWith('tel:')) return;
      
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
          href.includes('/sites/g/files/') ||
          href.includes('/AgendaCenter/ViewFile/') ||
          href.includes('/DocumentCenter/View/') ||
          href.includes('/FormCenter/') ||
          href.includes('/DocumentCenter/') ||
          href.includes('how_do_i/') ||
          href.match(/\/(forms|documents).*\.php/i)) {
        urls.push(href);
      }
    });
    
    return [...new Set(urls)];
  }, base);
  
  return links;
}

async function extractAllNavigationLinks(page: any, baseUrl: string): Promise<string[]> {
  const base = baseUrl.replace(/\/$/, '');
  
  // Aggressive WordPress menu expansion
  await page.evaluate(() => {
    // Method 1: Hover over menu items
    document.querySelectorAll('.menu-item-has-children, .menu > li, nav li, header li').forEach(item => {
      if (item instanceof HTMLElement) {
        item.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
        item.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
        item.classList.add('hover', 'focus', 'active', 'open');
      }
    });
    
    // Method 2: Click toggles and expand buttons
    const toggleSelectors = [
      '.menu-toggle', '.mobile-menu-toggle', '.navbar-toggle',
      '[aria-expanded="false"]', '.toggle', '.expand',
      'button[class*="menu"]', 'button[class*="nav"]'
    ];
    
    toggleSelectors.forEach(sel => {
      document.querySelectorAll(sel).forEach(toggle => {
        if (toggle instanceof HTMLElement) {
          try { toggle.click(); } catch (e) {}
        }
      });
    });
    
    // Method 3: Force display on hidden submenus
    document.querySelectorAll('.sub-menu, .dropdown-menu, .submenu').forEach(menu => {
      if (menu instanceof HTMLElement) {
        menu.style.display = 'block';
        menu.style.visibility = 'visible';
        menu.style.opacity = '1';
      }
    });
  });
  
  await sleep(2000); // Longer wait for menus to appear
  
  const links = await page.evaluate((baseArg) => {
    const urls = [];
    
    // Extended selectors including more menu patterns
    const selectors = [
      'nav a', 'header a', '.menu a', '.navigation a',
      '[role="navigation"] a', '.navbar a', '.nav a',
      '.site-navigation a', '.main-navigation a', '.primary-navigation a',
      '#menu a', '#navigation a', '.header-menu a',
      '.sub-menu a', '.dropdown-menu a', '.submenu a',
      'ul.menu a', 'ul.nav a', 'ul[class*="menu"] a'
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
    
    // Also check for any links in the page that might be navigation
    if (urls.length < 5) {
      // Fallback: get all same-domain links
      document.querySelectorAll('a[href]').forEach(link => {
        const href = link.getAttribute('href');
        if (href && !href.startsWith('#') && !href.startsWith('mailto:') && !href.startsWith('tel:') && !href.startsWith('javascript:')) {
          try {
            const u = new URL(href, window.location.href);
            if (u.hostname === new URL(baseArg).hostname) {
              // Only include if it looks like a page link (not a file)
              if (!u.pathname.match(/\.(pdf|doc|docx|xls|xlsx|jpg|png|gif)$/i)) {
                urls.push(u.href);
              }
            }
          } catch {}
        }
      });
    }
    
    return [...new Set(urls)];
  }, base);
  
  return links;
}

// ==================== Strategy 1: Focused Index Pages ====================

async function strategyIndexPages(
  page: any,
  baseUrl: string,
  cms: CMSType,
  stats: CrawlStats
): Promise<void> {
  console.log('\n📋 Strategy 1: Focused Index Pages');
  stats.strategiesUsed.push('Index Pages');
  
  const indexUrls: string[] = [];
  const workingPages: string[] = [];
  
  // CivicPlus patterns
  if (cms === 'CivicPlus' || cms === 'Custom') {
    indexUrls.push(
      `${baseUrl}/minutes-agendas`,
      `${baseUrl}/minutes-and-agendas`,
      `${baseUrl}/find-it-fast`,
      `${baseUrl}/a-z-directory`,
      `${baseUrl}/DocumentCenter`,
      `${baseUrl}/AgendaCenter`,
      `${baseUrl}/FormCenter`
    );
    
    // Try common node IDs
    const commonNodes = [8, 10, 12, 15, 20, 25, 30, 100, 105];
    const currentYear = new Date().getFullYear();
    
    for (const nodeId of commonNodes) {
      indexUrls.push(
        `${baseUrl}/node/${nodeId}/minutes`,
        `${baseUrl}/node/${nodeId}/files`
      );
      
      for (let year = currentYear; year >= currentYear - 2; year--) {
        indexUrls.push(`${baseUrl}/node/${nodeId}/minutes/${year}`);
      }
    }
  }
  
  // WordPress patterns
  if (cms === 'WordPress' || cms === 'Custom') {
    indexUrls.push(
      `${baseUrl}/documents`,
      `${baseUrl}/minutes`,
      `${baseUrl}/agendas`,
      `${baseUrl}/boards`,
      `${baseUrl}/forms`,
      `${baseUrl}/applications`,
      `${baseUrl}/regulations`
    );
  }
  
  // Revize patterns
  if (cms === 'Revize') {
    indexUrls.push(
      `${baseUrl}/DocumentCenter`,
      `${baseUrl}/how_do_i`
    );
  }
  
  console.log(`   Checking ${indexUrls.length} index page candidates...`);
  
  let checked = 0;
  let found = 0;
  
  for (const url of indexUrls) {
    checked++;
    
    try {
      const response = await page.goto(url, { 
        waitUntil: 'domcontentloaded', 
        timeout: 15000 
      });
      
      if (!response || response.status() >= 400) {
        process.stdout.write('✗');
        await sleep(CRAWL_DELAY_MS);
        continue;
      }
      
      await sleep(500);
      
      const title = await page.title();
      if (title.toLowerCase().includes('just a moment')) {
        process.stdout.write('⊗');
        await sleep(CRAWL_DELAY_MS);
        continue;
      }
      
      const docs = await extractDocumentLinks(page, baseUrl);
      docs.forEach(doc => stats.discovered.add(normalizeUrl(doc)));
      
      if (docs.length > 0) {
        found++;
        workingPages.push(url);
        process.stdout.write(`✓(${docs.length})`);
      } else {
        process.stdout.write('.');
      }
      
      if (checked % 20 === 0) {
        console.log(`\n   [${checked}/${indexUrls.length}] ${stats.discovered.size} docs, ${found} active pages`);
      }
      
      await sleep(CRAWL_DELAY_MS);
      
    } catch {
      process.stdout.write('✗');
      await sleep(CRAWL_DELAY_MS);
    }
  }
  
  console.log(`\n   Result: ${stats.discovered.size} docs from ${found} index pages`);
  
  if (workingPages.length > 0) {
    console.log(`\n   📄 Working index pages:`);
    workingPages.forEach(p => {
      const path = p.replace(baseUrl, '');
      console.log(`      ${path}`);
    });
  }
}

// ==================== Strategy 2: Navigation Following ====================

async function strategySitemap(
  page: any,
  baseUrl: string,
  stats: CrawlStats
): Promise<void> {
  console.log('\n🗺️  Strategy 2.5: Sitemap Extraction');
  stats.strategiesUsed.push('Sitemap');
  
  try {
    const response = await fetch(`${baseUrl}/sitemap.xml`, {
      signal: AbortSignal.timeout(10000)
    });
    
    if (!response.ok) {
      console.log('   No sitemap found');
      return;
    }
    
    const xml = await response.text();
    const urlMatches = xml.matchAll(/<loc>(.*?)<\/loc>/g);
    const urls = Array.from(urlMatches).map(match => match[1]);
    
    console.log(`   Found ${urls.length} URLs in sitemap`);
    
    if (urls.length === 0) return;
    
    // Visit up to 30 sitemap pages that look promising
    const promisingUrls = urls.filter(url => {
      const lower = url.toLowerCase();
      return lower.includes('document') || lower.includes('minute') || 
             lower.includes('agenda') || lower.includes('form') ||
             lower.includes('board') || lower.includes('meeting');
    }).slice(0, 30);
    
    console.log(`   Visiting ${promisingUrls.length} promising pages...`);
    
    let checked = 0;
    for (const url of promisingUrls) {
      checked++;
      
      try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
        await sleep(500);
        
        const docs = await extractDocumentLinks(page, baseUrl);
        docs.forEach(doc => stats.discovered.add(normalizeUrl(doc)));
        
        if (docs.length > 0) {
          process.stdout.write(`✓(${docs.length})`);
        } else {
          process.stdout.write('.');
        }
        
        if (checked % 10 === 0) {
          console.log(`\n   [${checked}/${promisingUrls.length}] ${stats.discovered.size} docs total`);
        }
        
        await sleep(CRAWL_DELAY_MS);
        
      } catch {
        process.stdout.write('✗');
        await sleep(CRAWL_DELAY_MS);
      }
    }
    
    console.log(`\n   Result: ${stats.discovered.size} docs after sitemap extraction`);
    
  } catch (e) {
    console.log('   Sitemap extraction failed');
  }
}

async function strategyNavigationFollowing(
  page: any,
  baseUrl: string,
  stats: CrawlStats,
  maxPages: number = 50
): Promise<void> {
  console.log('\n🗺️  Strategy 2: Navigation Following');
  stats.strategiesUsed.push('Navigation Following');
  
  const navLinks = await extractAllNavigationLinks(page, baseUrl);
  console.log(`   Found ${navLinks.length} navigation links`);
  
  const visited = new Set<string>();
  let checked = 0;
  
  for (const url of navLinks.slice(0, maxPages)) {
    if (visited.has(url)) continue;
    visited.add(url);
    checked++;
    
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
      await sleep(500);
      
      // Expand JS sections
      await page.evaluate(() => {
        document.querySelectorAll('[aria-expanded="false"], .toggle').forEach(el => {
          if (el instanceof HTMLElement) {
            try { el.click(); } catch (e) {}
          }
        });
      });
      
      await sleep(500);
      
      const docs = await extractDocumentLinks(page, baseUrl);
      docs.forEach(doc => stats.discovered.add(normalizeUrl(doc)));
      
      if (docs.length > 0) {
        process.stdout.write(`✓(${docs.length})`);
      } else {
        process.stdout.write('.');
      }
      
      if (checked % 20 === 0) {
        console.log(`\n   [${checked}/${Math.min(maxPages, navLinks.length)}] ${stats.discovered.size} docs total`);
      }
      
      await sleep(CRAWL_DELAY_MS);
      
    } catch {
      process.stdout.write('✗');
      await sleep(CRAWL_DELAY_MS);
    }
  }
  
  console.log(`\n   Result: ${stats.discovered.size} docs after navigation following`);
}

// ==================== S3 Operations ====================

async function documentExistsInS3(s3Key: string): Promise<boolean> {
  try {
    await s3.send(new HeadObjectCommand({ Bucket: S3_BUCKET, Key: s3Key }));
    return true;
  } catch (error: any) {
    if (error.name === 'NotFound') return false;
    throw error;
  }
}

async function downloadDocument(page: any, url: string, filename: string): Promise<string | null> {
  try {
    await fs.mkdir(TEMP_DIR, { recursive: true });
    const tempPath = path.join(TEMP_DIR, filename);
    
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
    
    try {
      const response = await page.goto(url, { waitUntil: 'networkidle', timeout: 15000 });
      if (response && response.status() < 400) {
        const buffer = await response.body();
        if (buffer && buffer.length > 0) {
          await fs.writeFile(tempPath, buffer);
          return tempPath;
        }
      }
    } catch {}
    
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

async function crawl(town: string, baseUrl: string, dryRun: boolean = false, thorough: boolean = false) {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`🤖 Smart Document Crawler (${thorough ? 'Thorough' : 'Adaptive'})`);
  console.log(`🏛️  Town: ${town}`);
  console.log(`🌐 URL: ${baseUrl}`);
  console.log(`${'='.repeat(60)}`);
  
  const stats: CrawlStats = {
    discovered: new Set(),
    downloaded: 0,
    uploaded: 0,
    skipped: 0,
    failed: 0,
    byCategory: {},
    strategiesUsed: []
  };
  
  const browser = await chromium.launch({ 
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-blink-features=AutomationControlled']
  });
  
  const page = await browser.newPage({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    viewport: { width: 1920, height: 1080 }
  });
  
  // Step 1: Fingerprint with Cloudflare retry
  console.log('\n🔍 Fingerprinting site...');
  let cms: CMSType = 'Custom';
  let homepageLoaded = false;
  
  try {
    await page.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await sleep(5000); // Longer initial wait
    
    let title = await page.title();
    let attempts = 0;
    
    // Cloudflare retry logic
    while (title.toLowerCase().includes('just a moment') && attempts < 3) {
      console.log(`   Cloudflare detected, waiting (attempt ${attempts + 1}/3)...`);
      await sleep(10000); // 10 second wait per attempt
      title = await page.title();
      attempts++;
    }
    
    if (title.toLowerCase().includes('just a moment')) {
      console.log('   Cloudflare challenge persists, trying network idle...');
      try {
        await page.waitForLoadState('networkidle', { timeout: 20000 });
        await sleep(3000);
        title = await page.title();
      } catch {
        console.log('   Cloudflare detected, proceeding with pattern-based discovery');
      }
    }
    
    if (!title.toLowerCase().includes('just a moment')) {
      cms = await detectCMS(page);
      homepageLoaded = true;
    }
  } catch (e: any) {
    console.log(`   Homepage load failed (${e.message}), proceeding anyway`);
  }
  
  console.log(`   CMS: ${cms}`);
  
  // Step 2: Strategy 1 - Index Pages
  await strategyIndexPages(page, baseUrl, cms, stats);
  
  const assessment1 = assessCoverage(stats.discovered);
  
  // Get detailed category breakdown
  const docs = Array.from(stats.discovered);
  const categoryCounts: Record<string, number> = {};
  docs.forEach(doc => {
    const cat = categorizeDocument(doc, doc);
    categoryCounts[cat] = (categoryCounts[cat] || 0) + 1;
  });
  
  console.log(`\n📊 Coverage Assessment:`);
  console.log(`   Documents: ${assessment1.docCount}`);
  console.log(`   Categories:`);
  Object.entries(categoryCounts)
    .sort((a, b) => b[1] - a[1])
    .forEach(([cat, count]) => {
      const icon = cat === 'minutes' || cat === 'agendas' ? '✓' : '-';
      console.log(`      ${icon} ${cat}: ${count}`);
    });
  console.log(`   Years: ${assessment1.hasMultipleYears ? '✓ Multiple' : '✗ Limited'}`);
  console.log(`   Status: ${assessment1.adequateCoverage ? '✓ Adequate' : '⚠️  Insufficient'}`);
  
  // Step 3: Strategy 2 (Navigation) if needed
  const shouldRunNav = !assessment1.adequateCoverage || thorough;
  const canRunNav = homepageLoaded || thorough; // In thorough mode, try nav even if homepage failed
  
  let finalAssessment = assessment1;
  
  if (shouldRunNav && canRunNav) {
    if (thorough && assessment1.adequateCoverage) {
      console.log('\n⚡ Thorough mode: Running navigation strategy anyway...');
    } else if (thorough && !homepageLoaded) {
      console.log('\n⚡ Thorough mode: Attempting navigation despite homepage load failure...');
    } else {
      console.log('\n⚡ Coverage insufficient, switching to navigation strategy...');
      console.log(`   Reason: ${!assessment1.hasMinutes && !assessment1.hasAgendas ? 'No minutes or agendas found' : 'Document count too low'}`);
    }
    
    // If homepage didn't load, try loading it now for navigation
    if (!homepageLoaded) {
      try {
        console.log('   Loading homepage for navigation extraction...');
        await page.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await sleep(5000);
        homepageLoaded = true;
      } catch (e) {
        console.log('   Warning: Homepage still failed, navigation may be limited');
      }
    }
    
    await strategyNavigationFollowing(page, baseUrl, stats, 50);
    
    const assessment2 = assessCoverage(stats.discovered);
    finalAssessment = assessment2;
    
    // Get updated category breakdown
    const midCategoryCounts: Record<string, number> = {};
    Array.from(stats.discovered).forEach(doc => {
      const cat = categorizeDocument(doc, doc);
      midCategoryCounts[cat] = (midCategoryCounts[cat] || 0) + 1;
    });
    
    console.log(`\n📊 Assessment After Navigation:`);
    console.log(`   Documents: ${assessment2.docCount} (+${assessment2.docCount - assessment1.docCount})`);
    console.log(`   Categories:`);
    Object.entries(midCategoryCounts)
      .sort((a, b) => b[1] - a[1])
      .forEach(([cat, count]) => {
        const change = count - (categoryCounts[cat] || 0);
        const changeStr = change > 0 ? ` (+${change})` : '';
        const icon = cat === 'minutes' || cat === 'agendas' ? '✓' : '-';
        console.log(`      ${icon} ${cat}: ${count}${changeStr}`);
      });
    console.log(`   Status: ${assessment2.adequateCoverage ? '✓ Adequate' : '⚠️  Still insufficient'}`);
    
    // Step 4: Strategy 3 (Sitemap) if still insufficient or thorough
    if (!assessment2.adequateCoverage || thorough) {
      if (thorough && assessment2.adequateCoverage) {
        console.log('\n⚡ Thorough mode: Trying sitemap extraction too...');
      } else {
        console.log('\n⚡ Still need more coverage, trying sitemap...');
      }
      
      await strategySitemap(page, baseUrl, stats);
      
      const assessment3 = assessCoverage(stats.discovered);
      finalAssessment = assessment3;
      
      const finalCategoryCounts: Record<string, number> = {};
      Array.from(stats.discovered).forEach(doc => {
        const cat = categorizeDocument(doc, doc);
        finalCategoryCounts[cat] = (finalCategoryCounts[cat] || 0) + 1;
      });
      
      console.log(`\n📊 Final Assessment:`);
      console.log(`   Documents: ${assessment3.docCount} (total gained: +${assessment3.docCount - assessment1.docCount})`);
      console.log(`   Categories:`);
      Object.entries(finalCategoryCounts)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10) // Top 10 categories
        .forEach(([cat, count]) => {
          const icon = cat === 'minutes' || cat === 'agendas' ? '✓' : '-';
          console.log(`      ${icon} ${cat}: ${count}`);
        });
      console.log(`   Status: ${assessment3.adequateCoverage ? '✓ Adequate' : '⚠️  Best effort'}`);
    }
  } else if (shouldRunNav && !canRunNav) {
    console.log('\n⚠️  Cannot run navigation (homepage failed), trying sitemap instead...');
    await strategySitemap(page, baseUrl, stats);
    
    const assessment2 = assessCoverage(stats.discovered);
    finalAssessment = assessment2;
    
    console.log(`\n📊 Final Assessment:`);
    console.log(`   Documents: ${assessment2.docCount} (+${assessment2.docCount - assessment1.docCount})`);
    console.log(`   Status: ${assessment2.adequateCoverage ? '✓ Adequate' : '⚠️  Best effort'}`);
  }
  
  console.log(`\n${'='.repeat(60)}`);
  console.log(`DISCOVERY COMPLETE: ${stats.discovered.size} documents`);
  console.log(`Strategies used: ${stats.strategiesUsed.join(' → ')}`);
  console.log(`${'='.repeat(60)}\n`);
  
  if (stats.discovered.size === 0) {
    console.log('⚠️  No documents found.\n');
    await browser.close();
    return;
  }
  
  if (dryRun) {
    console.log('🔍 DRY RUN\n');
    console.log('Sample documents:');
    Array.from(stats.discovered).slice(0, 10).forEach(doc => console.log(`   ${doc}`));
    await browser.close();
    return;
  }
  
  // Download and upload
  console.log('⬇️  Downloading and uploading...\n');
  
  for (const docUrl of Array.from(stats.discovered)) {
    let filename = docUrl.split('/').pop() || 'unknown.pdf';
    if (filename.includes('?')) filename = filename.split('?')[0];
    if (!filename.includes('.')) filename = filename + '.pdf';
    
    filename = sanitizeFilename(filename);
    const category = categorizeDocument(docUrl, filename);
    const year = extractYear(docUrl + ' ' + filename);
    const s3Key = `${town.toLowerCase().replace(/\s+/g, '-')}/${category}/general/${year}/${filename}`;
    
    const exists = await documentExistsInS3(s3Key);
    if (exists) {
      stats.skipped++;
      process.stdout.write('⊙');
      continue;
    }
    
    const localPath = await downloadDocument(page, docUrl, filename);
    if (!localPath) {
      stats.failed++;
      process.stdout.write('✗');
      continue;
    }
    
    stats.downloaded++;
    const uploaded = await uploadToS3(localPath, s3Key);
    if (uploaded) {
      stats.uploaded++;
      stats.byCategory[category] = (stats.byCategory[category] || 0) + 1;
      process.stdout.write('✓');
    } else {
      stats.failed++;
      process.stdout.write('✗');
    }
    
    try { await fs.unlink(localPath); } catch {}
    await sleep(CRAWL_DELAY_MS);
  }
  
  await browser.close();
  
  console.log(`\n\n${'='.repeat(60)}`);
  console.log('SUMMARY');
  console.log(`${'='.repeat(60)}`);
  console.log(`Discovered: ${stats.discovered.size}`);
  console.log(`Uploaded: ${stats.uploaded}`);
  console.log(`Skipped: ${stats.skipped}`);
  console.log(`Failed: ${stats.failed}`);
  
  if (Object.keys(stats.byCategory).length > 0) {
    console.log('\nBy category:');
    Object.entries(stats.byCategory)
      .sort((a, b) => b[1] - a[1])
      .forEach(([cat, count]) => console.log(`  ${cat}: ${count}`));
  }
  
  console.log('');
}

// ==================== CLI ====================

const program = new Command();

program
  .name('smart-document-crawler')
  .description('Smart adaptive document crawler')
  .requiredOption('--town <name>', 'Town name')
  .requiredOption('--url <url>', 'Town website URL')
  .option('--dry-run', 'Discover only, do not download/upload')
  .option('--thorough', 'Always run all strategies regardless of coverage assessment')
  .action(async (options) => {
    await crawl(options.town, options.url, options.dryRun || false, options.thorough || false);
  });

program.parse();
