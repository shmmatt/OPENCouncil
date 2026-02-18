/**
 * Simple Town Crawler - Regex-Based Edition
 * 
 * No LLM dependencies, pure text extraction with regex patterns.
 * More reliable for basic contact info, schedules, etc.
 * 
 * Usage:
 *   npm run crawl:simple -- --town Conway --url https://conwaynh.gov
 */

import * as fs from "fs/promises";
import * as path from "path";
import { program } from "commander";
import type { TownProfile } from "@shared/town-profile-schema";
import { profileToMarkdown } from "@shared/town-profile-schema";
import { chromium, Browser, Page } from "playwright";

interface CrawlOptions {
  town: string;
  url: string;
  county?: string;
  state?: string;
  output?: string;
  maxPages?: number;
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Fetch page with browser
 */
async function fetchPage(page: Page, url: string): Promise<string | null> {
  try {
    await page.goto(url, {
      waitUntil: 'domcontentloaded',
      timeout: 30000,
    });
    await sleep(2000);
    return await page.content();
  } catch (error: any) {
    console.warn(`    Failed: ${error.message}`);
    return null;
  }
}

/**
 * Extract all text from HTML
 */
function htmlToText(html: string): string {
  return html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .trim();
}

/**
 * Extract patterns using regex
 */
function extractPatterns(text: string): {
  phones: string[];
  emails: string[];
  addresses: string[];
  hours: string[];
  schedules: string[];
} {
  const phones: string[] = [];
  const emails: string[] = [];
  const addresses: string[] = [];
  const hours: string[] = [];
  const schedules: string[] = [];
  
  // Phone numbers: (603) 447-3811 or 603-447-3811
  const phoneRegex = /\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}/g;
  const phoneMatches = text.match(phoneRegex);
  if (phoneMatches) {
    phones.push(...phoneMatches.slice(0, 10));
  }
  
  // Emails
  const emailRegex = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
  const emailMatches = text.match(emailRegex);
  if (emailMatches) {
    emails.push(...emailMatches.slice(0, 10));
  }
  
  // Addresses with NH zip codes
  const addressRegex = /\b\d+\s+[A-Z][a-zA-Z\s]+(?:Street|St|Road|Rd|Avenue|Ave|Drive|Dr|Lane|Ln|Box|PO Box)[^,]*,\s*[A-Z][a-zA-Z\s]+,?\s*NH\s*0\d{4}/gi;
  const addressMatches = text.match(addressRegex);
  if (addressMatches) {
    addresses.push(...addressMatches.slice(0, 5));
  }
  
  // Office hours patterns
  const hoursRegex = /(?:Monday|Mon|Tuesday|Tue|Wednesday|Wed|Thursday|Thu|Friday|Fri)[\s:,-]+\d{1,2}:\d{2}\s*(?:AM|PM)?[\s-]+\d{1,2}:\d{2}\s*(?:AM|PM)?/gi;
  const hoursMatches = text.match(hoursRegex);
  if (hoursMatches) {
    hours.push(...hoursMatches.slice(0, 10));
  }
  
  // Meeting schedules: "2nd and 4th Monday"
  const scheduleRegex = /(?:\d+(?:st|nd|rd|th)\s+(?:and\s+\d+(?:st|nd|rd|th)\s+)?(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday))(?:\s+at\s+\d{1,2}:\d{2}\s*(?:AM|PM)?)?/gi;
  const scheduleMatches = text.match(scheduleRegex);
  if (scheduleMatches) {
    schedules.push(...scheduleMatches.slice(0, 10));
  }
  
  return { phones, emails, addresses, hours, schedules };
}

/**
 * Build profile from extracted patterns
 */
function buildProfile(
  townName: string,
  county: string,
  state: string,
  combinedText: string,
  sourceUrls: string[],
  patterns: ReturnType<typeof extractPatterns>
): TownProfile {
  const { phones, emails, addresses, hours, schedules } = patterns;
  
  // Clean and dedupe
  const uniquePhones = [...new Set(phones)];
  const uniqueEmails = [...new Set(emails)];
  const uniqueAddresses = [...new Set(addresses)];
  
  // Build profile
  const profile: TownProfile = {
    town: townName,
    county,
    state,
    lastUpdated: new Date().toISOString().split('T')[0],
    sourceUrls,
    
    townHall: {
      address: uniqueAddresses[0] || null,
      phone: uniquePhones[0] || null,
      email: uniqueEmails[0] || null,
      website: sourceUrls[0],
      hours: hours.length > 0 ? {
        weekdays: hours.slice(0, 3).join(', '),
        weekends: null,
      } : undefined,
    },
    
    boards: {},
    departments: {},
  };
  
  // Try to extract board info from schedules
  if (schedules.length > 0) {
    const boardKeywords = ['select', 'planning', 'zoning', 'budget', 'school'];
    const textLower = combinedText.toLowerCase();
    
    for (const keyword of boardKeywords) {
      for (const schedule of schedules) {
        const contextStart = textLower.indexOf(keyword);
        if (contextStart !== -1) {
          const context = combinedText.substring(Math.max(0, contextStart - 100), contextStart + 200);
          if (context.toLowerCase().includes(schedule.toLowerCase())) {
            const boardName = keyword.charAt(0).toUpperCase() + keyword.slice(1) + " Board";
            profile.boards[keyword + "_board"] = {
              name: boardName,
              meetingSchedule: schedule,
              location: undefined,
            };
            break;
          }
        }
      }
    }
  }
  
  // Extract departments from phone/email clusters
  const deptKeywords = ['clerk', 'tax', 'assessor', 'selectmen', 'administrator'];
  const textLower = combinedText.toLowerCase();
  
  for (const keyword of deptKeywords) {
    const idx = textLower.indexOf(keyword);
    if (idx !== -1) {
      const context = combinedText.substring(idx, idx + 300);
      const deptPhones = context.match(/\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}/g);
      const deptEmails = context.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g);
      
      if (deptPhones || deptEmails) {
        profile.departments[keyword] = {
          name: keyword.charAt(0).toUpperCase() + keyword.slice(1),
          phone: deptPhones?.[0],
          email: deptEmails?.[0],
        };
      }
    }
  }
  
  // Add raw data to notes
  profile.notes = `Extracted ${uniquePhones.length} phones, ${uniqueEmails.length} emails, ${uniqueAddresses.length} addresses, ${hours.length} hour entries, ${schedules.length} meeting schedules.\n\n`;
  
  if (uniquePhones.length > 1) {
    profile.notes += `Additional phones: ${uniquePhones.slice(1).join(', ')}\n`;
  }
  if (uniqueEmails.length > 1) {
    profile.notes += `Additional emails: ${uniqueEmails.slice(1).join(', ')}\n`;
  }
  
  return profile;
}

/**
 * Main crawler
 */
async function crawlTown(options: CrawlOptions): Promise<void> {
  const { town, url, county = "Carroll", state = "NH", output, maxPages = 8 } = options;
  
  console.log(`\n🕷️  SIMPLE TOWN CRAWLER (Regex-Based)`);
  console.log(`Town: ${town}`);
  console.log(`URL: ${url}\n`);
  
  // URLs to try
  const baseUrl = url.replace(/\/$/, '');
  const urlsToTry = [
    baseUrl,
    `${baseUrl}/`,
    `${baseUrl}/documents`,
    `${baseUrl}/about`,
    `${baseUrl}/contact`,
    `${baseUrl}/departments`,
    `${baseUrl}/boards`,
    `${baseUrl}/government`,
  ].slice(0, maxPages);
  
  console.log(`🚀 Launching browser...`);
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });
  const page = await browser.newPage({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
  });
  console.log(`✅ Browser ready\n`);
  
  // Fetch pages
  const fetchedPages: { url: string; html: string; text: string }[] = [];
  
  for (const pageUrl of urlsToTry) {
    console.log(`  [${fetchedPages.length + 1}/${urlsToTry.length}] ${pageUrl}`);
    
    const html = await fetchPage(page, pageUrl);
    
    if (html && html.length > 500) {
      const text = htmlToText(html);
      if (text.length > 200) {
        fetchedPages.push({ url: pageUrl, html, text });
        console.log(`    ✅ ${text.length} chars`);
      } else {
        console.log(`    ⚠️  Minimal content`);
      }
    }
    
    await sleep(1000);
  }
  
  await browser.close();
  
  console.log(`\n📊 Fetched: ${fetchedPages.length}/${urlsToTry.length} pages`);
  
  if (fetchedPages.length === 0) {
    throw new Error(`No pages fetched successfully. Site may be down or blocking.`);
  }
  
  // Extract patterns
  console.log(`\n🔍 Extracting patterns...`);
  const combinedText = fetchedPages.map(p => p.text).join(' ');
  const patterns = extractPatterns(combinedText);
  
  console.log(`   Phones: ${patterns.phones.length}`);
  console.log(`   Emails: ${patterns.emails.length}`);
  console.log(`   Addresses: ${patterns.addresses.length}`);
  console.log(`   Hours: ${patterns.hours.length}`);
  console.log(`   Schedules: ${patterns.schedules.length}`);
  
  // Build profile
  const profile = buildProfile(
    town,
    county,
    state,
    combinedText,
    fetchedPages.map(p => p.url),
    patterns
  );
  
  console.log(`\n✅ Profile built`);
  
  // Save
  const timestamp = new Date().toISOString().split('T')[0];
  const outputDir = output || "town-profiles";
  await fs.mkdir(outputDir, { recursive: true });
  
  const jsonPath = path.join(outputDir, `${town.toLowerCase()}-profile-${timestamp}-simple.json`);
  const mdPath = path.join(outputDir, `${town.toLowerCase()}-profile-${timestamp}-simple.md`);
  
  await fs.writeFile(jsonPath, JSON.stringify(profile, null, 2));
  await fs.writeFile(mdPath, profileToMarkdown(profile));
  
  console.log(`\n✅ COMPLETE`);
  console.log(`JSON: ${jsonPath}`);
  console.log(`Markdown: ${mdPath}\n`);
}

// CLI
program
  .name("simple-town-crawler")
  .description("Simple regex-based town profile crawler")
  .requiredOption("--town <name>", "Town name")
  .requiredOption("--url <url>", "Town website URL")
  .option("--county <name>", "County", "Carroll")
  .option("--state <abbr>", "State", "NH")
  .option("--output <dir>", "Output directory", "town-profiles")
  .option("--max-pages <n>", "Max pages to crawl", "8")
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
