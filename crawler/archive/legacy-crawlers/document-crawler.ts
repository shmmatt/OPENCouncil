/**
 * Comprehensive Document Crawler for Carroll County Towns
 * 
 * Crawls town websites to find and download all public documents:
 * - Meeting minutes
 * - Budgets & financial reports
 * - Forms & applications
 * - Ordinances & regulations
 * - Election documents
 * - Board agendas
 * 
 * Uploads to S3 with proper structure and triggers ingestion.
 * 
 * Usage:
 *   npm run crawl:documents -- --town Conway
 *   npm run crawl:documents:batch  # All Carroll County towns
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
  title?: string;
  size?: number;
}

interface CrawlOptions {
  town: string;
  url: string;
  maxDocuments?: number;
  dryRun?: boolean;
  skipExisting?: boolean;
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Document categories based on content/URL patterns
 */
const CATEGORY_PATTERNS = {
  minutes: /minutes?|mtg|meeting/i,
  budget: /budget|financial|warrant|appropriation/i,
  ordinance: /ordinance|regulation|bylaw|code/i,
  zoning: /zoning|land\s*use|subdivision/i,
  planning: /planning|site\s*plan|master\s*plan/i,
  election: /election|ballot|vote|voting/i,
  form: /form|application|permit|license/i,
  report: /annual\s*report|town\s*report/i,
  agenda: /agenda/i,
  policy: /policy|procedure|guideline/i,
};

/**
 * Board name patterns
 */
const BOARD_PATTERNS = {
  select_board: /select\s*(board|men)|board\s*of\s*select/i,
  planning: /planning\s*board/i,
  zoning: /zoning|zba|board\s*of\s*adjustment/i,
  conservation: /conservation/i,
  budget: /budget\s*committee/i,
  school: /school\s*board/i,
};

/**
 * Extract category from URL and filename
 */
function categorizeDocument(url: string, filename: string): string {
  const combined = `${url} ${filename}`.toLowerCase();
  
  for (const [category, pattern] of Object.entries(CATEGORY_PATTERNS)) {
    if (pattern.test(combined)) {
      return category;
    }
  }
  
  return 'misc_other';
}

/**
 * Extract board name from URL and filename
 */
function extractBoard(url: string, filename: string): string | undefined {
  const combined = `${url} ${filename}`.toLowerCase();
  
  for (const [board, pattern] of Object.entries(BOARD_PATTERNS)) {
    if (pattern.test(combined)) {
      return board;
    }
  }
  
  return undefined;
}

/**
 * Extract year from filename or URL
 */
function extractYear(text: string): string | undefined {
  // Look for 4-digit year (2000-2099)
  const yearMatch = text.match(/20\d{2}/);
  return yearMatch ? yearMatch[0] : undefined;
}

/**
 * Find all document links on a page
 */
async function extractDocumentLinks(page: Page, baseUrl: string): Promise<string[]> {
  const links = await page.evaluate((base) => {
    const urls: string[] = [];
    const docExtensions = ['.pdf', '.doc', '.docx', '.xls', '.xlsx'];
    
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
    
    return urls;
  }, baseUrl.replace(/\/$/, ''));
  
  return [...new Set(links)];
}

/**
 * Download document to temp directory
 */
async function downloadDocument(page: Page, url: string, filename: string): Promise<string | null> {
  try {
    await fs.mkdir(TEMP_DIR, { recursive: true });
    
    const tempPath = path.join(TEMP_DIR, filename);
    
    // Navigate to document URL
    const response = await page.goto(url, {
      waitUntil: 'domcontentloaded',
      timeout: 30000,
    });
    
    if (!response || !response.ok()) {
      console.warn(`    Failed to download: HTTP ${response?.status()}`);
      return null;
    }
    
    // Get the buffer
    const buffer = await response.body();
    if (!buffer) {
      console.warn(`    No content received`);
      return null;
    }
    
    // Save to temp file
    await fs.writeFile(tempPath, buffer);
    
    return tempPath;
  } catch (error: any) {
    console.warn(`    Download failed: ${error.message}`);
    return null;
  }
}

/**
 * Check if document already exists in S3
 */
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

/**
 * Upload document to S3
 */
async function uploadToS3(
  localPath: string,
  s3Key: string
): Promise<boolean> {
  try {
    const fileContent = await fs.readFile(localPath);
    
    await s3.send(new PutObjectCommand({
      Bucket: S3_BUCKET,
      Key: s3Key,
      Body: fileContent,
      ContentType: s3Key.endsWith('.pdf') ? 'application/pdf' : 'application/octet-stream',
      Metadata: {
        'uploaded-by': 'opencouncil-crawler',
        'uploaded-at': new Date().toISOString(),
      },
    }));
    
    return true;
  } catch (error: any) {
    console.error(`    S3 upload failed: ${error.message}`);
    return false;
  }
}

/**
 * Build S3 key following convention:
 * {town}/{category}/{board}/{year}/{filename}
 */
function buildS3Key(
  town: string,
  category: string,
  filename: string,
  board?: string,
  year?: string
): string {
  const parts = [town.toLowerCase()];
  
  parts.push(category);
  
  if (board) {
    parts.push(board);
  }
  
  if (year) {
    parts.push(year);
  }
  
  parts.push(filename);
  
  return parts.join('/');
}

/**
 * Sanitize filename
 */
function sanitizeFilename(filename: string): string {
  return filename
    .replace(/[^a-zA-Z0-9._-]/g, '_')
    .replace(/_+/g, '_')
    .substring(0, 200);
}

/**
 * Main crawler
 */
async function crawlDocuments(options: CrawlOptions): Promise<void> {
  const { town, url, maxDocuments = 500, dryRun = false, skipExisting = true } = options;
  
  console.log(`\n📄 DOCUMENT CRAWLER`);
  console.log(`Town: ${town}`);
  console.log(`URL: ${url}`);
  console.log(`Max documents: ${maxDocuments}`);
  console.log(`Dry run: ${dryRun}`);
  console.log(`Skip existing: ${skipExisting}\n`);
  
  const baseUrl = url.replace(/\/$/, '');
  const discovered: Document[] = [];
  const downloaded: Document[] = [];
  const uploaded: Document[] = [];
  const skipped: Document[] = [];
  
  console.log(`🚀 Launching browser...\n`);
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });
  const page = await browser.newPage();
  
  // Phase 1: Discover documents
  console.log(`🔍 Phase 1: Discovering documents...\n`);
  
  const pagesToCrawl = [
    baseUrl,
    `${baseUrl}/documents`,
    `${baseUrl}/minutes`,
    `${baseUrl}/agendas`,
    `${baseUrl}/boards`,
    `${baseUrl}/selectboard`,
    `${baseUrl}/planning`,
    `${baseUrl}/budget`,
    `${baseUrl}/forms`,
    `${baseUrl}/elections`,
  ];
  
  const allDocUrls = new Set<string>();
  
  for (const pageUrl of pagesToCrawl) {
    try {
      console.log(`  Scanning: ${pageUrl}`);
      await page.goto(pageUrl, {
        waitUntil: 'domcontentloaded',
        timeout: 15000,
      });
      await sleep(1000);
      
      const docLinks = await extractDocumentLinks(page, baseUrl);
      docLinks.forEach(link => allDocUrls.add(link));
      
      console.log(`    Found ${docLinks.length} documents`);
    } catch (error: any) {
      console.log(`    Skipped: ${error.message}`);
    }
  }
  
  console.log(`\n✅ Discovered ${allDocUrls.size} unique documents\n`);
  
  // Phase 2: Categorize and process
  console.log(`📋 Phase 2: Processing documents...\n`);
  
  let processedCount = 0;
  
  for (const docUrl of Array.from(allDocUrls).slice(0, maxDocuments)) {
    processedCount++;
    
    const urlParts = docUrl.split('/');
    let filename = urlParts[urlParts.length - 1];
    
    // Extract query params
    if (filename.includes('?')) {
      filename = filename.split('?')[0];
    }
    
    // Sanitize
    filename = sanitizeFilename(filename);
    
    // Categorize
    const category = categorizeDocument(docUrl, filename);
    const board = extractBoard(docUrl, filename);
    const year = extractYear(docUrl + ' ' + filename);
    
    const doc: Document = {
      url: docUrl,
      filename,
      category,
      board,
      year,
    };
    
    discovered.push(doc);
    
    // Build S3 key
    const s3Key = buildS3Key(town, category, filename, board, year);
    
    console.log(`[${processedCount}/${allDocUrls.size}] ${filename}`);
    console.log(`  URL: ${docUrl}`);
    console.log(`  Category: ${category}`);
    if (board) console.log(`  Board: ${board}`);
    if (year) console.log(`  Year: ${year}`);
    console.log(`  S3: ${s3Key}`);
    
    // Check if exists in S3
    if (skipExisting && !dryRun) {
      const exists = await documentExistsInS3(s3Key);
      if (exists) {
        console.log(`  ⏭️  Already in S3, skipping\n`);
        skipped.push(doc);
        continue;
      }
    }
    
    if (dryRun) {
      console.log(`  [DRY RUN] Would download and upload\n`);
      continue;
    }
    
    // Download
    console.log(`  ⬇️  Downloading...`);
    const localPath = await downloadDocument(page, docUrl, filename);
    
    if (!localPath) {
      console.log(`  ❌ Download failed\n`);
      continue;
    }
    
    const stats = await fs.stat(localPath);
    doc.size = stats.size;
    console.log(`  ✅ Downloaded (${Math.round(stats.size / 1024)} KB)`);
    
    downloaded.push(doc);
    
    // Upload to S3
    console.log(`  ⬆️  Uploading to S3...`);
    const success = await uploadToS3(localPath, s3Key);
    
    if (success) {
      console.log(`  ✅ Uploaded to S3\n`);
      uploaded.push(doc);
    } else {
      console.log(`  ❌ Upload failed\n`);
    }
    
    // Clean up temp file
    try {
      await fs.unlink(localPath);
    } catch (e) {}
    
    // Rate limiting
    await sleep(500);
  }
  
  await browser.close();
  
  // Summary
  console.log(`\n${"=".repeat(80)}`);
  console.log(`📊 SUMMARY`);
  console.log(`${"=".repeat(80)}\n`);
  
  console.log(`Discovered: ${discovered.length} documents`);
  console.log(`Downloaded: ${downloaded.length}`);
  console.log(`Uploaded to S3: ${uploaded.length}`);
  console.log(`Skipped (existing): ${skipped.length}\n`);
  
  // By category
  const byCategory: { [key: string]: number } = {};
  for (const doc of uploaded) {
    byCategory[doc.category] = (byCategory[doc.category] || 0) + 1;
  }
  
  console.log(`By category:`);
  for (const [category, count] of Object.entries(byCategory).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${category}: ${count}`);
  }
  console.log('');
  
  // Save summary
  const summary = {
    town,
    crawledAt: new Date().toISOString(),
    discovered: discovered.length,
    downloaded: downloaded.length,
    uploaded: uploaded.length,
    skipped: skipped.length,
    byCategory,
    documents: uploaded.map(d => ({
      filename: d.filename,
      category: d.category,
      board: d.board,
      year: d.year,
      size: d.size,
    })),
  };
  
  const summaryPath = `town-profiles/${town.toLowerCase()}-documents-${new Date().toISOString().split('T')[0]}.json`;
  await fs.writeFile(summaryPath, JSON.stringify(summary, null, 2));
  
  console.log(`Summary saved: ${summaryPath}`);
  console.log(`\n✅ Document crawl complete!`);
  console.log(`\nNext steps:`);
  console.log(`1. Run ingestion discovery: npm run ingest:discover -- ${town}`);
  console.log(`2. Run ingestion worker: npm run ingest:worker\n`);
}

// CLI
program
  .name("document-crawler")
  .description("Crawl town websites for documents and upload to S3")
  .requiredOption("--town <name>", "Town name")
  .requiredOption("--url <url>", "Town website URL")
  .option("--max <n>", "Max documents to process", "500")
  .option("--dry-run", "Don't actually download/upload")
  .option("--no-skip-existing", "Re-download existing files")
  .action(async (opts) => {
    try {
      await crawlDocuments({
        town: opts.town,
        url: opts.url,
        maxDocuments: parseInt(opts.max),
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
