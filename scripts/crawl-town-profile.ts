/**
 * Town Profile Crawler - Production Edition
 * 
 * Crawls town websites with:
 * - Structured JSON output (guaranteed valid)
 * - Resilient connection handling
 * - Cloudflare bypass via Playwright
 * 
 * Usage:
 *   npm run crawl:town -- --town Ossipee --url https://www.ossipee.org
 *   npm run crawl:town -- --town Conway --url https://conwaynh.com
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
  minPages?: number;
  useBrowser?: boolean;
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Retry with exponential backoff
 */
async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  maxRetries: number = 3,
  baseDelay: number = 1000
): Promise<T | null> {
  for (let i = 0; i < maxRetries; i++) {
    try {
      return await fn();
    } catch (error: any) {
      if (i === maxRetries - 1) {
        return null;
      }
      const delay = baseDelay * Math.pow(2, i);
      console.warn(`    Retry ${i + 1}/${maxRetries} after ${delay}ms...`);
      await sleep(delay);
    }
  }
  return null;
}

/**
 * Fetch via HTTP with robust timeout and error handling
 */
async function fetchPageDirect(url: string): Promise<string | null> {
  return retryWithBackoff(async () => {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 20000); // 20s timeout
    
    try {
      const response = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.9',
          'Connection': 'keep-alive',
          'Cache-Control': 'max-age=0',
        },
        signal: controller.signal,
      });
      
      clearTimeout(timeoutId);
      
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      
      const html = await response.text();
      if (html.length < 500) {
        throw new Error('Insufficient content');
      }
      
      return html;
    } catch (error: any) {
      clearTimeout(timeoutId);
      if (error.name === 'AbortError') {
        throw new Error('Timeout');
      }
      throw error;
    }
  }, 2, 1500);
}

/**
 * Fetch via browser with longer timeout for slow sites
 */
async function fetchPageBrowser(page: Page, url: string): Promise<string | null> {
  return retryWithBackoff(async () => {
    try {
      // Use longer timeout and less strict wait
      await page.goto(url, { 
        waitUntil: 'domcontentloaded',
        timeout: 60000 // 60s for really slow sites
      });
      
      // Wait for any dynamic content
      await sleep(3000);
      
      const html = await page.content();
      if (html.length < 500) {
        throw new Error('Insufficient content');
      }
      
      return html;
    } catch (error: any) {
      // Log but don't fail on timeouts
      if (error.message?.includes('Timeout')) {
        console.warn(`    Timeout (60s exceeded)`);
      }
      throw error;
    }
  }, 2, 3000);
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
  
  if (text.length > 100000) {
    text = text.substring(0, 100000) + "\n\n[Content truncated...]";
  }
  
  return text;
}

/**
 * Generate prioritized URLs
 */
function generateCrawlUrls(baseUrl: string): string[] {
  const base = baseUrl.replace(/\/$/, '');
  
  // High priority first
  const paths = [
    '', '/', '/contact', '/departments', '/boards', '/calendar',
    '/town-clerk', '/services', '/about', '/board-of-selectmen'
  ];
  
  const urls = new Set<string>();
  for (const p of paths) {
    urls.add(p === '' || p === '/' ? base : `${base}${p}`);
  }
  
  return Array.from(urls);
}

/**
 * Extract profile using JSON mode (simpler, more reliable)
 */
async function extractProfile(
  townName: string,
  county: string,
  state: string,
  combinedContent: string,
  sourceUrls: string[]
): Promise<TownProfile> {
  console.log(`\n🤖 Extracting with Gemini 2.5 Flash (JSON mode)...`);
  
  const maxChars = 90000;
  let content = combinedContent;
  if (combinedContent.length > maxChars) {
    content = combinedContent.substring(0, maxChars);
  }
  
  const prompt = `Extract town profile for ${townName}, ${county} County, ${state} from these web pages.

RULES:
- Return ONLY valid JSON (no markdown, no explanation)
- Use null for missing information
- Extract ONLY facts explicitly stated
- Do not make up or infer information

Web content (${sourceUrls.length} pages):
---
${content}
---

Return JSON with this EXACT structure (use null for unknowns):
{
  "town": "${townName}",
  "county": "${county}",
  "state": "${state}",
  "lastUpdated": "${new Date().toISOString().split('T')[0]}",
  "sourceUrls": ${JSON.stringify(sourceUrls)},
  "townHall": {
    "address": "...",
    "phone": "...",
    "email": null,
    "website": "...",
    "hours": { "weekdays": "...", "weekends": null }
  },
  "boards": {
    "select_board": { "name": "Board of Selectmen", "meetingSchedule": "...", "location": "...", "contact": null }
  },
  "departments": {
    "town_clerk": { "name": "Town Clerk", "staffName": null, "phone": "...", "hours": "..." }
  },
  "services": null,
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
    
    let text = (response.text || '').trim();
    
    // Clean up potential issues
    text = text
      .replace(/```json/g, '')
      .replace(/```/g, '')
      .replace(/\n\n+/g, '\n')
      .trim();
    
    // Find JSON boundaries
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start !== -1 && end !== -1) {
      text = text.substring(start, end + 1);
    }
    
    const profile = JSON.parse(text) as TownProfile;
    console.log(`✅ Extracted profile for ${profile.town}`);
    return profile;
  } catch (error: any) {
    console.error(`❌ Extraction failed: ${error.message}`);
    console.error(`First 500 chars of response: ${(response?.text || '').substring(0, 500)}`);
    throw error;
  }
}

/**
 * Main crawler
 */
async function crawlTownProfile(options: CrawlOptions): Promise<void> {
  const { 
    town, 
    url, 
    county = "Carroll", 
    state = "NH", 
    output, 
    maxPages = 10,
    minPages = 3,
    useBrowser: forceBrowser = false 
  } = options;
  
  console.log(`\n🕷️  TOWN PROFILE CRAWLER`);
  console.log(`Town: ${town}`);
  console.log(`URL: ${url}`);
  console.log(`Target: ${minPages}-${maxPages} pages\n`);
  
  const allUrls = generateCrawlUrls(url);
  const urlsToCrawl = allUrls.slice(0, maxPages);
  
  let browser: Browser | null = null;
  let page: Page | null = null;
  let useBrowser = forceBrowser;
  
  // Test homepage
  if (!forceBrowser) {
    console.log(`🔍 Testing homepage access...`);
    const testHtml = await fetchPageDirect(urlsToCrawl[0]);
    if (testHtml && testHtml.length > 1000) {
      console.log(`✅ Direct fetch works\n`);
      useBrowser = false;
    } else {
      console.log(`⚠️  Direct fetch failed, using browser\n`);
      useBrowser = true;
    }
  }
  
  // Launch browser if needed
  if (useBrowser) {
    console.log(`🚀 Launching browser...`);
    browser = await chromium.launch({ 
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
    });
    page = await browser.newPage({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    });
    console.log(`✅ Browser ready\n`);
  }
  
  // Crawl pages
  const fetchedPages: { url: string; content: string }[] = [];
  let consecutiveFailures = 0;
  
  for (const pageUrl of urlsToCrawl) {
    console.log(`  [${fetchedPages.length + 1}/${urlsToCrawl.length}] ${pageUrl}`);
    
    let html: string | null = null;
    
    if (useBrowser && page) {
      html = await fetchPageBrowser(page, pageUrl);
    } else {
      html = await fetchPageDirect(pageUrl);
    }
    
    if (html && html.length > 500) {
      const text = htmlToText(html);
      if (text.length > 200) {
        fetchedPages.push({ url: pageUrl, content: text });
        console.log(`    ✅ ${text.length} chars`);
        consecutiveFailures = 0;
      } else {
        console.log(`    ⚠️  Minimal content`);
        consecutiveFailures++;
      }
    } else {
      console.log(`    ❌ Failed`);
      consecutiveFailures++;
    }
    
    // Stop if too many failures
    if (consecutiveFailures >= 5) {
      console.log(`\n⚠️  Too many failures, stopping`);
      break;
    }
    
    // Success threshold met
    if (fetchedPages.length >= minPages && consecutiveFailures >= 3) {
      console.log(`\n✅ Have ${fetchedPages.length} pages, stopping`);
      break;
    }
    
    await sleep(1000);
  }
  
  if (browser) await browser.close();
  
  console.log(`\n📊 Fetched: ${fetchedPages.length}/${urlsToCrawl.length} pages`);
  
  if (fetchedPages.length < minPages) {
    throw new Error(`Only ${fetchedPages.length} pages fetched (need ${minPages}). Site may be down or blocking.`);
  }
  
  // Combine content
  const combinedContent = fetchedPages
    .map(p => `[SOURCE: ${p.url}]\n\n${p.content}`)
    .join("\n\n" + "=".repeat(80) + "\n\n");
  
  console.log(`📝 Combined: ${combinedContent.length} chars`);
  
  // Extract profile
  const profile = await extractProfile(town, county, state, combinedContent, fetchedPages.map(p => p.url));
  
  // Add note about extraction
  profile.notes = (profile.notes || '') + `\n\nExtracted from ${fetchedPages.length}/${urlsToCrawl.length} pages on ${new Date().toISOString().split('T')[0]}.`;
  
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
  .name("crawl-town-profile")
  .description("Crawl town website and extract profile")
  .requiredOption("--town <name>", "Town name")
  .requiredOption("--url <url>", "Town website URL")
  .option("--county <name>", "County", "Carroll")
  .option("--state <abbr>", "State", "NH")
  .option("--output <dir>", "Output dir", "town-profiles")
  .option("--max-pages <n>", "Max pages", "10")
  .option("--min-pages <n>", "Min pages", "3")
  .option("--use-browser", "Force browser")
  .action(async (opts) => {
    try {
      await crawlTownProfile({
        town: opts.town,
        url: opts.url,
        county: opts.county,
        state: opts.state,
        output: opts.output,
        maxPages: parseInt(opts.maxPages),
        minPages: parseInt(opts.minPages),
        useBrowser: opts.useBrowser,
      });
    } catch (error: any) {
      console.error(`\n❌ Error: ${error.message}`);
      process.exit(1);
    }
  });

program.parse();
