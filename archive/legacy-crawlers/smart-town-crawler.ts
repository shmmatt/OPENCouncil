/**
 * Smart Town Crawler - Platform-Aware Edition
 * 
 * Detects site platform and uses appropriate crawling strategy:
 * - TownCloud: API-based + key pages
 * - CivicPlus: Standard municipal paths
 * - Cloudflare sites: Browser automation
 * 
 * Usage:
 *   npm run crawl:smart -- --town Ossipee --url https://www.ossipee.org
 *   npm run crawl:smart -- --town Conway --url https://conwaynh.gov
 */

import * as fs from "fs/promises";
import * as path from "path";
import { program } from "commander";
import { GoogleGenAI } from "@google/genai";
import type { TownProfile } from "@shared/town-profile-schema";
import { profileToMarkdown } from "@shared/town-profile-schema";
import { chromium, Browser, Page } from "playwright";

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
if (!GEMINI_API_KEY) {
  throw new Error("GEMINI_API_KEY not set");
}

const genAI = new GoogleGenAI({ apiKey: GEMINI_API_KEY });

interface CrawlOptions {
  town: string;
  url: string;
  county?: string;
  state?: string;
  output?: string;
  maxPages?: number;
}

type Platform = "towncloud" | "civicplus" | "custom" | "cloudflare";

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Detect site platform
 */
async function detectPlatform(url: string): Promise<Platform> {
  try {
    const response = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      signal: AbortSignal.timeout(10000),
    });
    
    const html = await response.text();
    
    if (html.includes('TownCloud') || html.includes('sveltekit') || html.includes('/pages/all-pages.json')) {
      return 'towncloud';
    }
    if (html.includes('CivicPlus') || html.includes('civic-plus')) {
      return 'civicplus';
    }
    if (html.includes('Just a moment') || html.includes('Cloudflare')) {
      return 'cloudflare';
    }
    
    return 'custom';
  } catch (error: any) {
    if (error.message?.includes('403')) {
      return 'cloudflare';
    }
    return 'custom';
  }
}

/**
 * Get platform-specific URLs
 */
function getPlatformUrls(baseUrl: string, platform: Platform): string[] {
  const base = baseUrl.replace(/\/$/, '');
  
  switch (platform) {
    case 'towncloud':
      return [
        base,
        `${base}/town-departments`,
        `${base}/boards-commissions-committees`,
        `${base}/about-us`,
        `${base}/calandar`, // Yes, TownCloud misspells it
        `${base}/community-information`,
        `${base}/public-notices`,
      ];
    
    case 'civicplus':
      return [
        base,
        `${base}/Government/Departments`,
        `${base}/Government/Boards-Commissions`,
        `${base}/Government/Town-Clerk`,
        `${base}/Residents/Transfer-Station`,
        `${base}/Residents/Recreation`,
      ];
    
    case 'custom':
    case 'cloudflare':
      return [
        base,
        `${base}/contact`,
        `${base}/departments`,
        `${base}/boards`,
        `${base}/calendar`,
        `${base}/services`,
        `${base}/about`,
      ];
  }
}

/**
 * Retry with backoff
 */
async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  maxRetries: number = 2,
  baseDelay: number = 2000
): Promise<T | null> {
  for (let i = 0; i < maxRetries; i++) {
    try {
      return await fn();
    } catch (error: any) {
      if (i === maxRetries - 1) return null;
      const delay = baseDelay * Math.pow(1.5, i);
      console.warn(`    Retry ${i + 1}/${maxRetries} after ${delay}ms...`);
      await sleep(delay);
    }
  }
  return null;
}

/**
 * Fetch via browser (for Cloudflare or JavaScript-heavy sites)
 */
async function fetchWithBrowser(page: Page, url: string): Promise<string | null> {
  return retryWithBackoff(async () => {
    await page.goto(url, {
      waitUntil: 'domcontentloaded',
      timeout: 60000,
    });
    
    // Wait for any JS to render
    await sleep(2000);
    
    // Check for Cloudflare challenge
    const bodyText = await page.textContent('body');
    if (bodyText?.includes('Checking your browser') || bodyText?.includes('Just a moment')) {
      console.warn(`    Cloudflare detected, waiting...`);
      await sleep(5000);
    }
    
    const html = await page.content();
    if (html.length < 500) {
      throw new Error('Insufficient content');
    }
    
    return html;
  }, 2, 3000);
}

/**
 * Fetch TownCloud API data
 */
async function fetchTownCloudPages(baseUrl: string): Promise<string[]> {
  try {
    const apiUrl = `${baseUrl.replace(/\/$/, '')}/pages/all-pages.json`;
    const response = await fetch(apiUrl, { signal: AbortSignal.timeout(10000) });
    const data = await response.json();
    
    if (data.Pages && Array.isArray(data.Pages)) {
      const slugs = data.Pages
        .filter((p: any) => p.shownOnNav)
        .map((p: any) => p.slug);
      
      return slugs.map(slug => `${baseUrl.replace(/\/$/, '')}/${slug}`);
    }
  } catch (error) {
    console.warn(`    TownCloud API failed, using fallback URLs`);
  }
  
  return getPlatformUrls(baseUrl, 'towncloud');
}

/**
 * Clean HTML to text
 */
function htmlToText(html: string): string {
  let text = html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<noscript[^>]*>[\s\S]*?<\/noscript>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .trim();
  
  return text.substring(0, 100000);
}

/**
 * Extract profile using Gemini
 */
async function extractProfile(
  townName: string,
  county: string,
  state: string,
  combinedContent: string,
  sourceUrls: string[]
): Promise<TownProfile> {
  console.log(`\n🤖 Extracting with Gemini Flash (JSON mode)...`);
  
  const content = combinedContent.substring(0, 90000);
  
  const prompt = `Extract town profile for ${townName}, ${county} County, ${state} from these web pages.

CRITICAL RULES:
- Return ONLY valid JSON (no markdown, no explanation)
- Use null for missing information
- Extract ONLY facts explicitly stated
- Preserve exact wording for schedules/times
- For phone numbers, use format: (603) 539-4181
- For addresses, include full street + zip

Web content (${sourceUrls.length} pages):
---
${content}
---

Return JSON with this structure (null for unknowns):
{
  "town": "${townName}",
  "county": "${county}",
  "state": "${state}",
  "lastUpdated": "${new Date().toISOString().split('T')[0]}",
  "sourceUrls": ${JSON.stringify(sourceUrls.slice(0, 10))},
  "townHall": {
    "address": "...",
    "phone": "...",
    "email": "...",
    "website": "...",
    "hours": { "weekdays": "...", "weekends": null }
  },
  "boards": {
    "select_board": {
      "name": "Board of Selectmen",
      "meetingSchedule": "2nd and 4th Monday at 6:00 PM",
      "location": "Town Hall",
      "contact": null,
      "currentMembers": null
    }
  },
  "departments": {
    "town_clerk": {
      "name": "Town Clerk",
      "staffName": null,
      "phone": "...",
      "hours": "..."
    }
  },
  "services": {
    "transferStation": {
      "location": "...",
      "hours": "...",
      "fees": null
    }
  },
  "recreation": null,
  "taxes": null,
  "permits": null,
  "notes": null
}`;

  try {
    const response = await genAI.models.generateContent({
      model: "gemini-2.5-flash",
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      config: {
        temperature: 0,
        maxOutputTokens: 3000,
        responseMimeType: "application/json",
      },
    });
    
    let text = (response.text || '').trim()
      .replace(/```json/g, '')
      .replace(/```/g, '')
      .trim();
    
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start !== -1 && end !== -1) {
      text = text.substring(start, end + 1);
    }
    
    // Try to parse, if it fails try to fix common issues
    let profile: TownProfile;
    try {
      profile = JSON.parse(text) as TownProfile;
    } catch (parseError: any) {
      console.warn(`⚠️  Initial parse failed: ${parseError.message}`);
      console.log(`📝 Attempting to fix JSON...`);
      
      // Common fixes
      text = text
        .replace(/,(\s*[}\]])/g, '$1') // Remove trailing commas
        .replace(/:\s*'([^']*)'/g, ':"$1"') // Fix single quotes
        .replace(/\n/g, ' ') // Remove newlines in strings
        .replace(/  +/g, ' '); // Collapse multiple spaces
      
      // If still fails, ask Gemini to fix it
      try {
        profile = JSON.parse(text) as TownProfile;
        console.log(`✅ Fixed JSON successfully`);
      } catch (secondError: any) {
        console.error(`❌ JSON still invalid after fixes`);
        console.error(`First 1000 chars:\n${text.substring(0, 1000)}`);
        throw new Error(`Invalid JSON from Gemini: ${secondError.message}`);
      }
    }
    console.log(`✅ Extracted profile for ${profile.town}`);
    return profile;
  } catch (error: any) {
    console.error(`❌ Extraction completely failed: ${error.message}`);
    console.warn(`⚠️  Returning minimal profile with raw content`);
    
    // Return minimal profile with notes containing raw content
    return {
      town: townName,
      county,
      state,
      lastUpdated: new Date().toISOString().split('T')[0],
      sourceUrls,
      townHall: {
        address: "Unable to extract - see notes",
        phone: undefined,
        email: undefined,
        website: sourceUrls[0],
        hours: undefined,
      },
      boards: {},
      departments: {},
      services: undefined,
      recreation: undefined,
      taxes: undefined,
      permits: undefined,
      voting: undefined,
      notes: `EXTRACTION FAILED: ${error.message}\n\nRaw content (first 5000 chars):\n${combinedContent.substring(0, 5000)}`,
    };
  }
}

/**
 * Main crawler
 */
async function crawlTown(options: CrawlOptions): Promise<void> {
  const { town, url, county = "Carroll", state = "NH", output, maxPages = 10 } = options;
  
  console.log(`\n🕷️  SMART TOWN CRAWLER`);
  console.log(`Town: ${town}`);
  console.log(`URL: ${url}\n`);
  
  // Detect platform
  console.log(`🔍 Detecting platform...`);
  const platform = await detectPlatform(url);
  console.log(`✅ Platform: ${platform}\n`);
  
  // Get URLs to crawl
  let urlsToCrawl: string[];
  if (platform === 'towncloud') {
    console.log(`📋 Fetching TownCloud API...`);
    urlsToCrawl = await fetchTownCloudPages(url);
    console.log(`✅ Found ${urlsToCrawl.length} pages\n`);
  } else {
    urlsToCrawl = getPlatformUrls(url, platform);
  }
  
  urlsToCrawl = urlsToCrawl.slice(0, maxPages);
  
  // Use browser for Cloudflare or TownCloud (needs JS)
  const useBrowser = platform === 'cloudflare' || platform === 'towncloud';
  
  let browser: Browser | null = null;
  let page: Page | null = null;
  
  if (useBrowser) {
    console.log(`🚀 Launching browser...`);
    browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });
    page = await browser.newPage({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    });
    console.log(`✅ Browser ready\n`);
  }
  
  // Crawl pages
  const fetchedPages: { url: string; content: string }[] = [];
  
  for (const pageUrl of urlsToCrawl) {
    console.log(`  [${fetchedPages.length + 1}/${urlsToCrawl.length}] ${pageUrl}`);
    
    let html: string | null = null;
    
    if (page) {
      html = await fetchWithBrowser(page, pageUrl);
    }
    
    if (html && html.length > 500) {
      const text = htmlToText(html);
      if (text.length > 200) {
        fetchedPages.push({ url: pageUrl, content: text });
        console.log(`    ✅ ${text.length} chars`);
      } else {
        console.log(`    ⚠️  Minimal content`);
      }
    } else {
      console.log(`    ❌ Failed`);
    }
    
    // Stop if we have enough
    if (fetchedPages.length >= 5 && fetchedPages.length >= urlsToCrawl.length * 0.4) {
      console.log(`\n✅ Have ${fetchedPages.length} pages, sufficient data\n`);
      break;
    }
    
    await sleep(1500);
  }
  
  if (browser) await browser.close();
  
  console.log(`📊 Fetched: ${fetchedPages.length}/${urlsToCrawl.length} pages`);
  
  if (fetchedPages.length < 2) {
    throw new Error(`Only ${fetchedPages.length} pages fetched. Site may be blocking or down.`);
  }
  
  // Combine content
  const combinedContent = fetchedPages
    .map(p => `[SOURCE: ${p.url}]\n\n${p.content}`)
    .join("\n\n" + "=".repeat(80) + "\n\n");
  
  console.log(`📝 Combined: ${combinedContent.length} chars`);
  
  // Extract profile
  const profile = await extractProfile(town, county, state, combinedContent, fetchedPages.map(p => p.url));
  
  profile.notes = (profile.notes || '') + `\n\nExtracted via ${platform} platform from ${fetchedPages.length}/${urlsToCrawl.length} pages on ${new Date().toISOString().split('T')[0]}.`;
  
  // Save
  const timestamp = new Date().toISOString().split('T')[0];
  const outputDir = output || "town-profiles";
  await fs.mkdir(outputDir, { recursive: true });
  
  const jsonPath = path.join(outputDir, `${town.toLowerCase()}-profile-${timestamp}.json`);
  const mdPath = path.join(outputDir, `${town.toLowerCase()}-profile-${timestamp}.md`);
  
  await fs.writeFile(jsonPath, JSON.stringify(profile, null, 2));
  await fs.writeFile(mdPath, profileToMarkdown(profile));
  
  console.log(`\n✅ COMPLETE`);
  console.log(`JSON: ${jsonPath}`);
  console.log(`Markdown: ${mdPath}\n`);
}

// CLI
program
  .name("smart-town-crawler")
  .description("Platform-aware town website crawler")
  .requiredOption("--town <name>", "Town name")
  .requiredOption("--url <url>", "Town website URL")
  .option("--county <name>", "County", "Carroll")
  .option("--state <abbr>", "State", "NH")
  .option("--output <dir>", "Output directory", "town-profiles")
  .option("--max-pages <n>", "Max pages to crawl", "10")
  .action(async (opts) => {
    try {
      await crawlTown({
        town: opts.town,
        url: opts.url,
        county: opts.county,
        state: opts.state,
        output: opts.output,
        maxPages: parseInt(opts.maxPages),
      });
    } catch (error: any) {
      console.error(`\n❌ Error: ${error.message}`);
      process.exit(1);
    }
  });

program.parse();
