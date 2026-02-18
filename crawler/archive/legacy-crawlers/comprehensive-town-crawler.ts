/**
 * Comprehensive Town Crawler - Never Give Up Edition
 * 
 * Tries every strategy to find required public information:
 * 1. TownCloud API
 * 2. Visible navigation
 * 3. Hidden links in HTML
 * 4. Common URL patterns
 * 5. Search functionality
 * 6. PDF documents
 * 7. Deep page exploration
 * 
 * This info is legally required (NH RSA 91-A) so it MUST be somewhere!
 * 
 * Usage:
 *   npm run crawl:comprehensive -- --town Conway --url https://conwaynh.gov/
 */

import * as fs from "fs/promises";
import * as path from "path";
import { program } from "commander";
import { chromium, Browser, Page } from "playwright";

interface TownInfo {
  town: string;
  extractedAt: string;
  sourceUrl: string;
  
  // Contact info
  townHall?: {
    address?: string;
    phone?: string;
    email?: string;
    hours?: string;
  };
  
  // Boards with meeting info
  boards: {
    [boardName: string]: {
      meetingSchedule?: string;
      location?: string;
      members?: string[];
      contact?: string;
      upcomingMeetings?: Array<{
        date: string;
        time?: string;
        location?: string;
      }>;
    };
  };
  
  // Departments
  departments: {
    [deptName: string]: {
      staffName?: string;
      phone?: string;
      email?: string;
      hours?: string;
    };
  };
  
  pagesExplored: string[];
  strategiesUsed: string[];
}

interface CrawlOptions {
  town: string;
  url: string;
  output?: string;
  verbose?: boolean;
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

// Common URL patterns where towns hide info
const COMMON_PATHS = [
  '/boards', '/committees', '/boards-committees', '/government',
  '/selectboard', '/select-board', '/selectmen', '/board-of-selectmen',
  '/planning', '/planning-board', '/zoning', '/zba',
  '/conservation', '/budget-committee',
  '/departments', '/town-clerk', '/administration',
  '/calendar', '/events', '/meetings', '/agendas',
  '/contact', '/about', '/directory',
  '/pages/boards', '/pages/committees', '/pages/calendar'
];

/**
 * Strategy 1: TownCloud API
 */
async function tryTownCloudAPI(baseUrl: string): Promise<string[]> {
  try {
    const response = await fetch(`${baseUrl}/pages/all-pages.json`);
    if (response.ok) {
      const data = await response.json();
      if (data.Pages && Array.isArray(data.Pages)) {
        console.log(`  ✅ Found TownCloud API with ${data.Pages.length} pages`);
        return data.Pages.map((p: any) => p.slug);
      }
    }
  } catch (error) {
    // Not TownCloud
  }
  return [];
}

/**
 * Strategy 2: Extract all links from page
 */
async function extractAllLinks(page: Page, baseUrl: string): Promise<string[]> {
  const links = await page.evaluate((base) => {
    const urls: string[] = [];
    document.querySelectorAll('a[href]').forEach(link => {
      let href = link.getAttribute('href');
      if (!href || href.startsWith('#') || href.startsWith('mailto:') || href.startsWith('tel:')) {
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

/**
 * Strategy 3: Try common URL patterns
 */
function generateCommonUrls(baseUrl: string): string[] {
  return COMMON_PATHS.map(path => `${baseUrl}${path}`);
}

/**
 * Extract contact info from text
 */
function extractContactInfo(text: string): any {
  const phones = text.match(/\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}/g);
  const emails = text.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g);
  const addresses = text.match(/\d+\s+[A-Z][a-zA-Z\s]+(?:Street|St|Road|Rd|Avenue|Ave|Drive|Dr|Lane|Ln|Box|PO Box)[^,]*,\s*[A-Z][a-zA-Z\s]+,?\s*NH\s*0\d{4}/gi);
  
  const hours: string[] = [];
  const hourRegex = /(?:Monday|Mon|Tuesday|Tue|Wednesday|Wed|Thursday|Thu|Friday|Fri)[\s:,-]+\d{1,2}:\d{2}\s*(?:AM|PM)?[\s-]+\d{1,2}:\d{2}\s*(?:AM|PM)?/gi;
  const hourMatches = text.match(hourRegex);
  if (hourMatches) hours.push(...hourMatches.slice(0, 5));
  
  return {
    phones: phones ? [...new Set(phones)].slice(0, 5) : [],
    emails: emails ? [...new Set(emails)].slice(0, 5) : [],
    addresses: addresses ? [...new Set(addresses)].slice(0, 3) : [],
    hours: hours.length > 0 ? hours.join(', ') : undefined,
  };
}

/**
 * Extract board/meeting info from text
 */
function extractBoardInfo(text: string): any {
  const boards: any = {};
  const lines = text.split('\n').map(l => l.trim()).filter(l => l.length > 0);
  
  const boardKeywords = ['select', 'selectmen', 'planning', 'zoning', 'conservation', 'budget'];
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].toLowerCase();
    
    for (const keyword of boardKeywords) {
      if (!line.includes(keyword)) continue;
      
      const boardKey = keyword + '_board';
      if (!boards[boardKey]) {
        boards[boardKey] = {
          name: keyword.charAt(0).toUpperCase() + keyword.slice(1) + ' Board',
        };
      }
      
      // Look for meeting schedule in surrounding lines
      for (let j = Math.max(0, i - 2); j < Math.min(lines.length, i + 5); j++) {
        const checkLine = lines[j];
        
        // Schedule patterns
        const scheduleMatch = checkLine.match(/(?:\d+(?:st|nd|rd|th)\s+(?:and\s+\d+(?:st|nd|rd|th)\s+)?(?:Monday|Tuesday|Wednesday|Thursday|Friday)|every\s+(?:Monday|Tuesday|Wednesday|Thursday|Friday)|(?:Monday|Tuesday|Wednesday|Thursday|Friday)s?\s+at\s+\d)/i);
        if (scheduleMatch && !boards[boardKey].meetingSchedule) {
          boards[boardKey].meetingSchedule = scheduleMatch[0];
        }
        
        // Time
        const timeMatch = checkLine.match(/\d{1,2}:\d{2}\s*(?:AM|PM|am|pm)/i);
        if (timeMatch && boards[boardKey].meetingSchedule && !boards[boardKey].meetingSchedule.includes(timeMatch[0])) {
          boards[boardKey].meetingSchedule += ' at ' + timeMatch[0];
        }
        
        // Location
        const locationMatch = checkLine.match(/(?:Town Hall|Library|Municipal Building|Conference Room)/i);
        if (locationMatch && !boards[boardKey].location) {
          boards[boardKey].location = locationMatch[0];
        }
      }
    }
  }
  
  return boards;
}

/**
 * Check if URL is accessible
 */
async function isUrlAccessible(page: Page, url: string): Promise<boolean> {
  try {
    const response = await page.goto(url, {
      waitUntil: 'domcontentloaded',
      timeout: 15000,
    });
    await sleep(1500);
    
    // Check if it's a real page (not 404)
    const text = await page.evaluate(() => document.body.innerText);
    if (text.toLowerCase().includes('404') || text.toLowerCase().includes('not found') || text.length < 200) {
      return false;
    }
    
    return true;
  } catch (error) {
    return false;
  }
}

/**
 * Main crawler
 */
async function crawlComprehensive(options: CrawlOptions): Promise<void> {
  const { town, url, output, verbose = false } = options;
  
  console.log(`\n🔍 COMPREHENSIVE TOWN CRAWLER`);
  console.log(`Town: ${town}`);
  console.log(`URL: ${url}`);
  console.log(`Mission: Find meeting schedules, contacts, and board members\n`);
  
  const baseUrl = url.replace(/\/$/, '');
  const info: TownInfo = {
    town,
    extractedAt: new Date().toISOString(),
    sourceUrl: url,
    boards: {},
    departments: {},
    pagesExplored: [],
    strategiesUsed: [],
  };
  
  console.log(`🚀 Launching browser...\n`);
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });
  const page = await browser.newPage({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
  });
  
  // ==================== STRATEGY 1: TownCloud API ====================
  console.log(`📋 Strategy 1: Checking for TownCloud API...`);
  const townCloudPages = await tryTownCloudAPI(baseUrl);
  if (townCloudPages.length > 0) {
    info.strategiesUsed.push('TownCloud API');
    console.log(`  Found ${townCloudPages.length} pages via API\n`);
  } else {
    console.log(`  Not a TownCloud site (or API unavailable)\n`);
  }
  
  // ==================== STRATEGY 2: Homepage Analysis ====================
  console.log(`🏠 Strategy 2: Analyzing homepage...`);
  await page.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await sleep(3000);
  
  const homeText = await page.evaluate(() => document.body.innerText);
  const homeContact = extractContactInfo(homeText);
  const homeBoards = extractBoardInfo(homeText);
  
  // Merge found info
  if (homeContact.phones.length > 0 || homeContact.emails.length > 0) {
    info.townHall = {
      phone: homeContact.phones[0],
      email: homeContact.emails[0],
      address: homeContact.addresses[0],
      hours: homeContact.hours,
    };
    console.log(`  ✅ Found contact info on homepage`);
  }
  
  Object.assign(info.boards, homeBoards);
  if (Object.keys(homeBoards).length > 0) {
    console.log(`  ✅ Found ${Object.keys(homeBoards).length} boards on homepage`);
  }
  
  info.pagesExplored.push(baseUrl);
  console.log('');
  
  // ==================== STRATEGY 3: Extract All Links ====================
  console.log(`🔗 Strategy 3: Extracting all links from homepage...`);
  const allLinks = await extractAllLinks(page, baseUrl);
  console.log(`  Found ${allLinks.length} total links`);
  
  const relevantLinks = allLinks.filter(link => {
    const lower = link.toLowerCase();
    return ['board', 'committee', 'department', 'calendar', 'event', 'meeting', 'agenda', 'contact'].some(kw => lower.includes(kw));
  });
  console.log(`  ${relevantLinks.length} look relevant\n`);
  
  info.strategiesUsed.push('Link extraction');
  
  // ==================== STRATEGY 4: Try Common Patterns ====================
  console.log(`🎯 Strategy 4: Trying common URL patterns...`);
  const commonUrls = generateCommonUrls(baseUrl);
  const workingUrls: string[] = [];
  
  for (const testUrl of commonUrls) {
    if (info.pagesExplored.includes(testUrl)) continue;
    
    if (verbose) process.stdout.write(`  Testing: ${testUrl}... `);
    
    const works = await isUrlAccessible(page, testUrl);
    if (works) {
      workingUrls.push(testUrl);
      if (verbose) console.log(`✅`);
    } else {
      if (verbose) console.log(`❌`);
    }
  }
  
  console.log(`  ${workingUrls.length} common patterns work\n`);
  info.strategiesUsed.push('Common URL patterns');
  
  // ==================== STRATEGY 5: Visit All Relevant Pages ====================
  console.log(`📄 Strategy 5: Deep diving relevant pages...`);
  
  // Combine TownCloud, extracted links, and working common URLs
  const pagesToVisit = [
    ...townCloudPages.map(slug => `${baseUrl}/${slug}`),
    ...relevantLinks,
    ...workingUrls
  ].filter(url => !info.pagesExplored.includes(url));
  
  const uniquePages = [...new Set(pagesToVisit)].slice(0, 30); // Limit to 30 pages
  console.log(`  Will explore ${uniquePages.length} pages\n`);
  
  for (const pageUrl of uniquePages) {
    if (info.pagesExplored.includes(pageUrl)) continue;
    
    console.log(`  Visiting: ${pageUrl}`);
    
    try {
      await page.goto(pageUrl, {
        waitUntil: 'domcontentloaded',
        timeout: 15000,
      });
      await sleep(2000);
      
      const pageText = await page.evaluate(() => document.body.innerText);
      
      // Check for 404
      if (pageText.toLowerCase().includes('404') || pageText.toLowerCase().includes('not found')) {
        console.log(`    ⚠️  404 Not Found`);
        continue;
      }
      
      info.pagesExplored.push(pageUrl);
      
      // Extract info from this page
      const pageContact = extractContactInfo(pageText);
      const pageBoards = extractBoardInfo(pageText);
      
      // Merge new contact info
      if (!info.townHall?.phone && pageContact.phones.length > 0) {
        if (!info.townHall) info.townHall = {};
        info.townHall.phone = pageContact.phones[0];
      }
      if (!info.townHall?.email && pageContact.emails.length > 0) {
        if (!info.townHall) info.townHall = {};
        info.townHall.email = pageContact.emails[0];
      }
      
      // Merge board info (don't overwrite existing info)
      for (const [boardKey, boardData] of Object.entries(pageBoards)) {
        if (!info.boards[boardKey]) {
          info.boards[boardKey] = boardData;
        } else {
          // Merge missing fields
          if (!info.boards[boardKey].meetingSchedule && boardData.meetingSchedule) {
            info.boards[boardKey].meetingSchedule = boardData.meetingSchedule;
          }
          if (!info.boards[boardKey].location && boardData.location) {
            info.boards[boardKey].location = boardData.location;
          }
        }
      }
      
      const foundInfo = [];
      if (pageContact.phones.length > 0) foundInfo.push(`${pageContact.phones.length} phones`);
      if (pageContact.emails.length > 0) foundInfo.push(`${pageContact.emails.length} emails`);
      if (Object.keys(pageBoards).length > 0) foundInfo.push(`${Object.keys(pageBoards).length} boards`);
      
      if (foundInfo.length > 0) {
        console.log(`    ✅ ${foundInfo.join(', ')}`);
      }
      
    } catch (error: any) {
      console.log(`    ❌ Failed: ${error.message}`);
    }
  }
  
  await browser.close();
  
  // ==================== RESULTS ====================
  console.log(`\n📊 RESULTS:\n`);
  console.log(`Pages explored: ${info.pagesExplored.length}`);
  console.log(`Strategies used: ${info.strategiesUsed.join(', ')}\n`);
  
  console.log(`Contact Info:`);
  if (info.townHall?.phone) console.log(`  Phone: ${info.townHall.phone}`);
  if (info.townHall?.email) console.log(`  Email: ${info.townHall.email}`);
  if (info.townHall?.address) console.log(`  Address: ${info.townHall.address}`);
  if (info.townHall?.hours) console.log(`  Hours: ${info.townHall.hours}`);
  console.log('');
  
  console.log(`Boards found: ${Object.keys(info.boards).length}`);
  for (const [key, board] of Object.entries(info.boards)) {
    console.log(`  ${board.name}:`);
    if (board.meetingSchedule) console.log(`    Schedule: ${board.meetingSchedule}`);
    if (board.location) console.log(`    Location: ${board.location}`);
    if (board.contact) console.log(`    Contact: ${board.contact}`);
  }
  
  // Save results
  const timestamp = new Date().toISOString().split('T')[0];
  const outputDir = output || "town-profiles";
  await fs.mkdir(outputDir, { recursive: true });
  
  const jsonPath = path.join(outputDir, `${town.toLowerCase()}-comprehensive-${timestamp}.json`);
  await fs.writeFile(jsonPath, JSON.stringify(info, null, 2));
  
  console.log(`\n✅ COMPLETE`);
  console.log(`Results: ${jsonPath}\n`);
}

// CLI
program
  .name("comprehensive-town-crawler")
  .description("Comprehensive crawler that tries every strategy to find required public info")
  .requiredOption("--town <name>", "Town name")
  .requiredOption("--url <url>", "Town website URL")
  .option("--output <dir>", "Output directory", "town-profiles")
  .option("--verbose", "Verbose output")
  .action(async (opts) => {
    try {
      await crawlComprehensive({
        town: opts.town,
        url: opts.url,
        output: opts.output,
        verbose: opts.verbose,
      });
    } catch (error: any) {
      console.error(`\n❌ Error: ${error.message}`);
      console.error(error.stack);
      process.exit(1);
    }
  });

program.parse();
