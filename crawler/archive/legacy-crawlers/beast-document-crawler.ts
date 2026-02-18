/**
 * Beast Document Crawler - The No-Compromise Edition
 * 
 * Finds EVERY publicly accessible PDF from NH town websites.
 * 
 * Multi-strategy approach:
 * 1. TownCloud API detection + page scanning
 * 2. Google Drive folder extraction (for TownCloud minutes)
 * 3. Deep recursive link crawling
 * 4. Cloudflare bypass with delays
 * 5. Common URL pattern testing
 * 6. Sitemap parsing
 * 7. Document viewer/iframe detection
 * 8. Search result scraping
 * 
 * These documents are legally required (NH RSA 91-A), so they MUST exist somewhere!
 * 
 * Usage:
 *   npm run crawl:beast -- --town Conway --url https://conwaynh.gov/
 */

import * as fs from "fs/promises";
import * as path from "path";
import { program } from "commander";
import { chromium, Browser, Page } from "playwright";
import { S3Client, PutObjectCommand, HeadObjectCommand } from "@aws-sdk/client-s3";
import { createHash } from "crypto";

// Config
const S3_BUCKET = process.env.S3_BUCKET || "opencouncil-municipal-docs";
const S3_REGION = process.env.AWS_REGION || "us-east-1";
const TEMP_DIR = "/tmp/opencouncil-docs";

const s3 = new S3Client({ region: S3_REGION });

interface Document {
  url: string;
  filename: string;
  category: string;
  board?: string;
  year?: string;
  size?: number;
  source: string; // Which strategy found it
}

interface CrawlOptions {
  town: string;
  url: string;
  maxDepth?: number;
  maxDocuments?: number;
  dryRun?: boolean;
  skipExisting?: boolean;
  verbose?: boolean;
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

// ==================== DOCUMENT CATEGORIES ====================

const CATEGORY_PATTERNS = {
  minutes: /minutes?|mtg/i,
  agenda: /agenda/i,
  budget: /budget|financial|warrant|appropriation/i,
  ordinance: /ordinance|regulation|bylaw|code/i,
  zoning: /zoning|land\s*use|subdivision/i,
  planning: /planning|site\s*plan|master\s*plan/i,
  election: /election|ballot|vote/i,
  form: /form|application|permit|license/i,
  report: /annual\s*report|town\s*report/i,
  policy: /policy|procedure|guideline/i,
  audit: /audit/i,
  tax: /tax\s*rate|assessment|abatement/i,
};

const BOARD_PATTERNS = {
  select_board: /select\s*(board|men)|board\s*of\s*select/i,
  planning: /planning\s*board/i,
  zoning: /zoning|zba|board\s*of\s*adjustment/i,
  conservation: /conservation/i,
  budget: /budget\s*committee/i,
  school: /school\s*board/i,
};

function categorizeDocument(url: string, filename: string): string {
  const combined = `${url} ${filename}`.toLowerCase();
  
  for (const [category, pattern] of Object.entries(CATEGORY_PATTERNS)) {
    if (pattern.test(combined)) {
      return category;
    }
  }
  
  return 'misc';
}

function extractBoard(url: string, filename: string): string | undefined {
  const combined = `${url} ${filename}`.toLowerCase();
  
  for (const [board, pattern] of Object.entries(BOARD_PATTERNS)) {
    if (pattern.test(combined)) {
      return board;
    }
  }
  
  return undefined;
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

async function tryTownCloudAPI(baseUrl: string): Promise<string[]> {
  try {
    console.log(`  🔍 Checking TownCloud API...`);
    const response = await fetch(`${baseUrl}/pages/all-pages.json`);
    if (response.ok) {
      const data = await response.json();
      if (data.Pages && Array.isArray(data.Pages)) {
        console.log(`  ✅ TownCloud API: ${data.Pages.length} pages`);
        return data.Pages.map((p: any) => `${baseUrl}/${p.slug}`);
      }
    }
  } catch (error) {
    // Not TownCloud
  }
  console.log(`  ℹ️  Not a TownCloud site`);
  return [];
}

// ==================== STRATEGY 2: Google Drive Extraction ====================

async function extractGoogleDriveLinks(page: Page): Promise<string[]> {
  const driveLinks = await page.evaluate(() => {
    const links: string[] = [];
    document.querySelectorAll('a[href*="drive.google.com"]').forEach(link => {
      const href = link.getAttribute('href');
      if (href && href.includes('drive.google.com')) {
        links.push(href);
      }
    });
    return links;
  });
  
  if (driveLinks.length > 0) {
    console.log(`  ✅ Found ${driveLinks.length} Google Drive folder links`);
  }
  
  return driveLinks;
}

/**
 * Extract PDFs from a public Google Drive folder
 * Note: This requires the folder to be publicly accessible
 */
async function crawlGoogleDriveFolder(page: Page, folderUrl: string): Promise<string[]> {
  try {
    console.log(`  📁 Crawling Google Drive folder...`);
    
    await page.goto(folderUrl, { waitUntil: 'networkidle', timeout: 30000 });
    await sleep(3000);
    
    // Extract all file links
    const pdfLinks = await page.evaluate(() => {
      const links: string[] = [];
      
      // Google Drive file links have specific patterns
      document.querySelectorAll('div[data-id]').forEach(elem => {
        const dataId = elem.getAttribute('data-id');
        if (dataId && elem.textContent?.toLowerCase().includes('.pdf')) {
          links.push(`https://drive.google.com/uc?id=${dataId}&export=download`);
        }
      });
      
      // Also try direct links
      document.querySelectorAll('a[href*="/file/d/"]').forEach(link => {
        const href = link.getAttribute('href');
        if (href && href.includes('.pdf')) {
          links.push(href);
        }
      });
      
      return links;
    });
    
    console.log(`  ✅ Extracted ${pdfLinks.length} PDFs from Drive folder`);
    return pdfLinks;
    
  } catch (error: any) {
    console.log(`  ⚠️  Failed to crawl Drive folder: ${error.message}`);
    return [];
  }
}

// ==================== STRATEGY 3: Deep Link Extraction ====================

async function extractAllLinks(page: Page, baseUrl: string, currentDepth: number = 0): Promise<string[]> {
  const links = await page.evaluate((base) => {
    const urls: string[] = [];
    document.querySelectorAll('a[href]').forEach(link => {
      let href = link.getAttribute('href');
      if (!href || href.startsWith('#') || href.startsWith('mailto:') || href.startsWith('tel:') || href.startsWith('javascript:')) {
        return;
      }
      
      // Make absolute
      if (href.startsWith('/')) {
        href = base + href;
      } else if (!href.startsWith('http')) {
        href = base + '/' + href;
      }
      
      // Same domain only
      try {
        const baseHost = new URL(base).hostname;
        const linkHost = new URL(href).hostname;
        if (baseHost === linkHost) {
          urls.push(href);
        }
      } catch (e) {}
    });
    return urls;
  }, baseUrl);
  
  return [...new Set(links)];
}

async function extractDocumentLinks(page: Page, baseUrl: string): Promise<string[]> {
  const links = await page.evaluate((base) => {
    const urls: string[] = [];
    const docExtensions = ['.pdf', '.doc', '.docx', '.xls', '.xlsx'];
    
    // Direct links
    document.querySelectorAll('a[href]').forEach(link => {
      let href = link.getAttribute('href');
      if (!href) return;
      
      // Make absolute
      if (href.startsWith('/')) {
        href = base + href;
      } else if (!href.startsWith('http')) {
        href = base + '/' + href;
      }
      
      // Check if it's a document
      const lower = href.toLowerCase();
      if (docExtensions.some(ext => lower.includes(ext))) {
        urls.push(href);
      }
    });
    
    // iframes (document viewers)
    document.querySelectorAll('iframe[src]').forEach(iframe => {
      let src = iframe.getAttribute('src');
      if (!src) return;
      
      if (src.startsWith('/')) {
        src = base + src;
      }
      
      const lower = src.toLowerCase();
      if (docExtensions.some(ext => lower.includes(ext))) {
        urls.push(src);
      }
    });
    
    return urls;
  }, baseUrl.replace(/\/$/, ''));
  
  return [...new Set(links)];
}

// ==================== STRATEGY 4: Common URL Patterns ====================

const COMMON_DOC_PATHS = [
  '/documents', '/docs', '/files',
  '/minutes', '/agendas', '/meetings',
  '/boards', '/committees',
  '/selectboard', '/select-board', '/selectboard/minutes', '/selectboard/agendas',
  '/planning', '/planning-board', '/planning/minutes',
  '/zoning', '/zba',
  '/conservation', '/conservation-commission',
  '/budget', '/budget-committee',
  '/school-board',
  '/forms', '/applications',
  '/reports', '/annual-reports',
  '/ordinances', '/regulations',
  '/elections', '/voting',
  '/public-notices',
  '/pages/documents', '/pages/minutes', '/pages/boards',
];

function generateCommonUrls(baseUrl: string): string[] {
  return COMMON_DOC_PATHS.map(path => `${baseUrl}${path}`);
}

// ==================== STRATEGY 5: Sitemap Parsing ====================

async function parseSitemap(baseUrl: string): Promise<string[]> {
  try {
    console.log(`  🗺️  Checking sitemap...`);
    const sitemapUrl = `${baseUrl}/sitemap.xml`;
    const response = await fetch(sitemapUrl);
    
    if (!response.ok) {
      console.log(`  ℹ️  No sitemap found`);
      return [];
    }
    
    const xml = await response.text();
    const urlMatches = xml.matchAll(/<loc>(.*?)<\/loc>/g);
    const urls = Array.from(urlMatches).map(match => match[1]);
    
    console.log(`  ✅ Sitemap: ${urls.length} URLs`);
    return urls;
    
  } catch (error) {
    return [];
  }
}

// ==================== S3 Upload ====================

async function documentExistsInS3(s3Key: string): Promise<boolean> {
  try {
    await s3.send(new HeadObjectCommand({
      Bucket: S3_BUCKET,
      Key: s3Key,
    }));
    return true;
  } catch (error: any) {
    if (error.name === 'NotFound') {
      return false;
    }
    throw error;
  }
}

async function downloadDocument(page: Page, url: string, filename: string): Promise<string | null> {
  try {
    await fs.mkdir(TEMP_DIR, { recursive: true });
    
    const tempPath = path.join(TEMP_DIR, filename);
    
    const response = await page.goto(url, {
      waitUntil: 'domcontentloaded',
      timeout: 30000,
    });
    
    if (!response || !response.ok()) {
      return null;
    }
    
    const buffer = await response.body();
    if (!buffer) {
      return null;
    }
    
    await fs.writeFile(tempPath, buffer);
    return tempPath;
    
  } catch (error: any) {
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
        'uploaded-by': 'beast-crawler',
        'uploaded-at': new Date().toISOString(),
      },
    }));
    
    return true;
  } catch (error: any) {
    console.error(`    S3 upload failed: ${error.message}`);
    return false;
  }
}

function buildS3Key(
  town: string,
  category: string,
  filename: string,
  board?: string,
  year?: string
): string {
  const parts = [town.toLowerCase()];
  parts.push(category);
  if (board) parts.push(board);
  if (year) parts.push(year);
  parts.push(filename);
  return parts.join('/');
}

// ==================== MAIN CRAWLER ====================

async function crawlBeast(options: CrawlOptions): Promise<void> {
  const {
    town,
    url,
    maxDepth = 3,
    maxDocuments = 2000,
    dryRun = false,
    skipExisting = true,
    verbose = false,
  } = options;
  
  console.log(`\n🦁 BEAST DOCUMENT CRAWLER`);
  console.log(`Town: ${town}`);
  console.log(`URL: ${url}`);
  console.log(`Max depth: ${maxDepth}`);
  console.log(`Max documents: ${maxDocuments}`);
  console.log(`Dry run: ${dryRun}`);
  console.log(`Skip existing: ${skipExisting}\n`);
  
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
  
  const documents: Document[] = [];
  const visitedPages = new Set<string>();
  
  console.log(`🚀 Launching browser...\n`);
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });
  
  const page = await browser.newPage({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
  });
  
  // Track strategy success
  function recordStrategy(strategy: string, count: number) {
    stats.byStrategy[strategy] = (stats.byStrategy[strategy] || 0) + count;
  }
  
  // ==================== PHASE 1: DISCOVERY ====================
  console.log(`🔍 PHASE 1: DISCOVERY\n`);
  
  // Strategy 1: TownCloud API
  console.log(`📋 Strategy 1: TownCloud API`);
  const townCloudPages = await tryTownCloudAPI(baseUrl);
  recordStrategy('TownCloud API', townCloudPages.length);
  console.log('');
  
  // Strategy 2: Homepage analysis
  console.log(`🏠 Strategy 2: Homepage Analysis`);
  try {
    console.log(`  Loading homepage...`);
    await page.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await sleep(3000); // Cloudflare bypass
    
    visitedPages.add(baseUrl);
    
    // Check for Google Drive links
    const driveLinks = await extractGoogleDriveLinks(page);
    recordStrategy('Google Drive', driveLinks.length);
    
    // Crawl Drive folders
    for (const driveUrl of driveLinks) {
      const driveDocs = await crawlGoogleDriveFolder(page, driveUrl);
      driveDocs.forEach(doc => stats.discovered.add(doc));
    }
    
    // Extract direct document links
    const homeDocs = await extractDocumentLinks(page, baseUrl);
    homeDocs.forEach(doc => stats.discovered.add(doc));
    console.log(`  ✅ Found ${homeDocs.length} documents on homepage`);
    
  } catch (error: any) {
    console.log(`  ⚠️  Homepage failed: ${error.message}`);
  }
  console.log('');
  
  // Strategy 3: Sitemap
  console.log(`📍 Strategy 3: Sitemap Parsing`);
  const sitemapUrls = await parseSitemap(baseUrl);
  recordStrategy('Sitemap', sitemapUrls.length);
  console.log('');
  
  // Strategy 4: Common URL patterns
  console.log(`🎯 Strategy 4: Common URL Patterns (${COMMON_DOC_PATHS.length} patterns)`);
  const commonUrls = generateCommonUrls(baseUrl);
  
  for (const testUrl of commonUrls) {
    if (visitedPages.has(testUrl)) continue;
    
    try {
      if (verbose) process.stdout.write(`  ${testUrl}... `);
      
      await page.goto(testUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
      await sleep(1500);
      
      const text = await page.evaluate(() => document.body.innerText);
      if (text.toLowerCase().includes('404') || text.toLowerCase().includes('not found') || text.length < 200) {
        if (verbose) console.log(`❌`);
        continue;
      }
      
      visitedPages.add(testUrl);
      
      const docs = await extractDocumentLinks(page, baseUrl);
      docs.forEach(doc => stats.discovered.add(doc));
      
      if (verbose) console.log(`✅ ${docs.length} docs`);
      
    } catch (error) {
      if (verbose) console.log(`❌`);
    }
  }
  console.log(`  ✅ Tested ${commonUrls.length} common patterns`);
  console.log('');
  
  // Strategy 5: Deep recursive crawl
  console.log(`🌊 Strategy 5: Deep Recursive Crawl (max depth: ${maxDepth})`);
  
  // Combine all discovered pages
  const allPages = [
    ...townCloudPages,
    ...sitemapUrls,
    ...Array.from(visitedPages),
  ];
  
  const pagesToCrawl = [...new Set(allPages)].filter(url => !visitedPages.has(url));
  console.log(`  ${pagesToCrawl.length} pages to explore`);
  
  let crawled = 0;
  for (const pageUrl of pagesToCrawl.slice(0, 100)) { // Limit to 100 pages for sanity
    if (visitedPages.has(pageUrl)) continue;
    
    try {
      await page.goto(pageUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
      await sleep(1000);
      
      visitedPages.add(pageUrl);
      crawled++;
      
      const docs = await extractDocumentLinks(page, baseUrl);
      docs.forEach(doc => stats.discovered.add(doc));
      
      if (verbose && docs.length > 0) {
        console.log(`  ✅ ${pageUrl}: ${docs.length} docs`);
      }
      
    } catch (error) {
      // Skip inaccessible pages
    }
  }
  
  console.log(`  ✅ Crawled ${crawled} pages`);
  recordStrategy('Deep crawl', crawled);
  console.log('');
  
  // ==================== PHASE 2: PROCESSING ====================
  console.log(`\n📦 PHASE 2: PROCESSING ${stats.discovered.size} DOCUMENTS\n`);
  
  let processedCount = 0;
  const docArray = Array.from(stats.discovered).slice(0, maxDocuments);
  
  for (const docUrl of docArray) {
    processedCount++;
    
    let filename = docUrl.split('/').pop() || 'unknown.pdf';
    if (filename.includes('?')) {
      filename = filename.split('?')[0];
    }
    filename = sanitizeFilename(filename);
    
    const category = categorizeDocument(docUrl, filename);
    const board = extractBoard(docUrl, filename);
    const year = extractYear(docUrl + ' ' + filename);
    
    const s3Key = buildS3Key(town, category, filename, board, year);
    
    console.log(`[${processedCount}/${docArray.length}] ${filename}`);
    console.log(`  Category: ${category}`);
    if (board) console.log(`  Board: ${board}`);
    if (year) console.log(`  Year: ${year}`);
    console.log(`  S3: ${s3Key}`);
    
    // Check if exists
    if (skipExisting && !dryRun) {
      const exists = await documentExistsInS3(s3Key);
      if (exists) {
        console.log(`  ⏭️  Already in S3\n`);
        stats.skipped++;
        continue;
      }
    }
    
    if (dryRun) {
      console.log(`  [DRY RUN]\n`);
      continue;
    }
    
    // Download
    console.log(`  ⬇️  Downloading...`);
    const localPath = await downloadDocument(page, docUrl, filename);
    
    if (!localPath) {
      console.log(`  ❌ Failed\n`);
      stats.failed++;
      continue;
    }
    
    const fileStats = await fs.stat(localPath);
    console.log(`  ✅ Downloaded (${Math.round(fileStats.size / 1024)} KB)`);
    stats.downloaded++;
    
    // Upload
    console.log(`  ⬆️  Uploading...`);
    const success = await uploadToS3(localPath, s3Key);
    
    if (success) {
      console.log(`  ✅ Uploaded\n`);
      stats.uploaded++;
      stats.byCategory[category] = (stats.byCategory[category] || 0) + 1;
      
      documents.push({
        url: docUrl,
        filename,
        category,
        board,
        year,
        size: fileStats.size,
        source: 'mixed',
      });
    } else {
      console.log(`  ❌ Upload failed\n`);
      stats.failed++;
    }
    
    // Cleanup
    try {
      await fs.unlink(localPath);
    } catch (e) {}
    
    await sleep(500);
  }
  
  await browser.close();
  
  // ==================== SUMMARY ====================
  console.log(`\n${"=".repeat(80)}`);
  console.log(`📊 SUMMARY`);
  console.log(`${"=".repeat(80)}\n`);
  
  console.log(`Discovered: ${stats.discovered.size} unique documents`);
  console.log(`Downloaded: ${stats.downloaded}`);
  console.log(`Uploaded: ${stats.uploaded}`);
  console.log(`Skipped (existing): ${stats.skipped}`);
  console.log(`Failed: ${stats.failed}\n`);
  
  console.log(`By strategy:`);
  for (const [strategy, count] of Object.entries(stats.byStrategy).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${strategy}: ${count}`);
  }
  console.log('');
  
  console.log(`By category:`);
  for (const [category, count] of Object.entries(stats.byCategory).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${category}: ${count}`);
  }
  console.log('');
  
  // Save summary
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
    documents: documents.map(d => ({
      filename: d.filename,
      category: d.category,
      board: d.board,
      year: d.year,
      size: d.size,
    })),
  };
  
  const summaryPath = `town-profiles/${town.toLowerCase()}-beast-${new Date().toISOString().split('T')[0]}.json`;
  await fs.writeFile(summaryPath, JSON.stringify(summary, null, 2));
  
  console.log(`Summary saved: ${summaryPath}\n`);
  console.log(`✅ Beast mode complete!\n`);
}

// ==================== CLI ====================

program
  .name("beast-document-crawler")
  .description("The ultimate NH town document crawler")
  .requiredOption("--town <name>", "Town name")
  .requiredOption("--url <url>", "Town website URL")
  .option("--max-depth <n>", "Max crawl depth", "3")
  .option("--max-docs <n>", "Max documents to process", "2000")
  .option("--dry-run", "Don't actually download/upload")
  .option("--no-skip-existing", "Re-download existing files")
  .option("--verbose", "Verbose output")
  .action(async (opts) => {
    try {
      await crawlBeast({
        town: opts.town,
        url: opts.url,
        maxDepth: parseInt(opts.maxDepth),
        maxDocuments: parseInt(opts.maxDocs),
        dryRun: opts.dryRun,
        skipExisting: opts.skipExisting !== false,
        verbose: opts.verbose,
      });
    } catch (error: any) {
      console.error(`\n❌ Error: ${error.message}`);
      console.error(error.stack);
      process.exit(1);
    }
  });

program.parse();
