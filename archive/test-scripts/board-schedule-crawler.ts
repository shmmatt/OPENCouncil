/**
 * Board Schedule Crawler
 * 
 * Specifically targets board meeting pages to extract:
 * - Meeting schedules (day/time)
 * - Meeting locations
 * - Board member names
 * - Contact information
 * 
 * Usage:
 *   npm run crawl:boards -- --town Conway --url https://conwaynh.gov
 */

import * as fs from "fs/promises";
import * as path from "path";
import { program } from "commander";
import { chromium, Browser, Page } from "playwright";

interface BoardInfo {
  name: string;
  schedule?: string;
  location?: string;
  members?: string[];
  contact?: string;
  url?: string;
}

interface CrawlOptions {
  town: string;
  url: string;
  output?: string;
  maxDepth?: number;
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Board keywords to look for
 */
const BOARD_KEYWORDS = [
  'select', 'selectmen', 'selectboard',
  'planning', 'zoning', 'zba',
  'conservation', 'budget', 'school',
  'economic', 'development', 'recreation',
  'library', 'cemetery', 'trustees',
];

/**
 * Fetch page with browser
 */
async function fetchPage(page: Page, url: string): Promise<string | null> {
  try {
    console.log(`    Fetching: ${url}`);
    await page.goto(url, {
      waitUntil: 'domcontentloaded',
      timeout: 30000,
    });
    await sleep(2000);
    const html = await page.content();
    return html.length > 500 ? html : null;
  } catch (error: any) {
    console.warn(`    Failed: ${error.message}`);
    return null;
  }
}

/**
 * Extract all links from page
 */
function extractLinks(html: string, baseUrl: string): string[] {
  const links: string[] = [];
  const hrefRegex = /href=["']([^"']+)["']/gi;
  let match;
  
  while ((match = hrefRegex.exec(html)) !== null) {
    let href = match[1];
    
    // Skip non-HTTP links
    if (href.startsWith('#') || href.startsWith('mailto:') || href.startsWith('tel:')) {
      continue;
    }
    
    // Convert relative to absolute
    if (href.startsWith('/')) {
      href = baseUrl.replace(/\/$/, '') + href;
    } else if (!href.startsWith('http')) {
      href = baseUrl.replace(/\/$/, '') + '/' + href;
    }
    
    // Only same domain
    try {
      const baseHost = new URL(baseUrl).hostname;
      const linkHost = new URL(href).hostname;
      if (baseHost === linkHost) {
        links.push(href);
      }
    } catch (e) {
      // Invalid URL, skip
    }
  }
  
  return [...new Set(links)];
}

/**
 * Filter links that likely contain board info
 */
function filterBoardLinks(links: string[]): string[] {
  return links.filter(link => {
    const lower = link.toLowerCase();
    return BOARD_KEYWORDS.some(keyword => 
      lower.includes(keyword) || 
      lower.includes('board') || 
      lower.includes('committee') ||
      lower.includes('commission')
    );
  });
}

/**
 * Extract text from HTML
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
 * Extract meeting schedules with multiple patterns
 */
function extractSchedules(text: string): string[] {
  const schedules: string[] = [];
  
  // Pattern 1: "2nd and 4th Monday at 6:00 PM"
  const pattern1 = /(?:\d+(?:st|nd|rd|th)\s+(?:and\s+\d+(?:st|nd|rd|th)\s+)?(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday))(?:\s+at\s+\d{1,2}:\d{2}\s*(?:AM|PM)?)?/gi;
  schedules.push(...(text.match(pattern1) || []));
  
  // Pattern 2: "Every Monday at 6:00 PM"
  const pattern2 = /every\s+(?:other\s+)?(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)(?:\s+at\s+\d{1,2}:\d{2}\s*(?:AM|PM)?)?/gi;
  schedules.push(...(text.match(pattern2) || []));
  
  // Pattern 3: "Meets: Tuesday 7:00 PM"
  const pattern3 = /meets?\s*:?\s*(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)(?:\s+at\s+)?\s*\d{1,2}:\d{2}\s*(?:AM|PM)?/gi;
  schedules.push(...(text.match(pattern3) || []));
  
  // Pattern 4: "First Monday of each month"
  const pattern4 = /(?:first|second|third|fourth|last)\s+(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)\s+(?:of\s+(?:each|every)\s+month)?/gi;
  schedules.push(...(text.match(pattern4) || []));
  
  // Pattern 5: "Mondays 6:00 PM" or "Mon 6PM"
  const pattern5 = /(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday|Mon|Tue|Wed|Thu|Fri|Sat|Sun)s?\s+\d{1,2}:\d{2}\s*(?:AM|PM)?/gi;
  schedules.push(...(text.match(pattern5) || []));
  
  return [...new Set(schedules)].slice(0, 5);
}

/**
 * Extract meeting locations
 */
function extractLocations(text: string): string[] {
  const locations: string[] = [];
  
  // Pattern 1: "Town Hall", "Library", etc.
  const pattern1 = /(?:Town Hall|City Hall|Municipal Building|Library|Community Center|Fire Station|Conference Room|Meeting Room)/gi;
  locations.push(...(text.match(pattern1) || []));
  
  // Pattern 2: "Location: ..." or "Where: ..."
  const pattern2 = /(?:location|where|place|room)\s*:?\s*([A-Z][a-zA-Z\s,]+(?:Hall|Building|Center|Room|Library|Station))/gi;
  let match;
  while ((match = pattern2.exec(text)) !== null) {
    locations.push(match[1]);
  }
  
  return [...new Set(locations)].slice(0, 3);
}

/**
 * Extract board member names
 */
function extractMembers(text: string): string[] {
  const members: string[] = [];
  
  // Look for patterns like "John Smith, Chair" or "Jane Doe, Member"
  const pattern = /([A-Z][a-z]+\s+[A-Z][a-z]+)(?:\s*,\s*(?:Chair|Vice Chair|Member|Secretary|Treasurer|Clerk))?/g;
  
  // Only extract if in context of "members" or "committee"
  const memberSectionRegex = /(?:members?|committee|board|trustees?)[\s\S]{0,500}/gi;
  const sections = text.match(memberSectionRegex) || [];
  
  for (const section of sections) {
    let match;
    while ((match = pattern.exec(section)) !== null) {
      members.push(match[1]);
    }
  }
  
  return [...new Set(members)].slice(0, 7);
}

/**
 * Extract contact info (phone/email)
 */
function extractContact(text: string): string | undefined {
  const phones = text.match(/\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}/);
  const emails = text.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
  
  if (phones && emails) {
    return `${phones[0]} / ${emails[0]}`;
  } else if (phones) {
    return phones[0];
  } else if (emails) {
    return emails[0];
  }
  return undefined;
}

/**
 * Extract board name from URL or page title
 */
function extractBoardName(url: string, text: string): string {
  // Try from URL first
  for (const keyword of BOARD_KEYWORDS) {
    if (url.toLowerCase().includes(keyword)) {
      return keyword.charAt(0).toUpperCase() + keyword.slice(1) + " Board";
    }
  }
  
  // Try from page title/heading
  const titleMatch = text.match(/(?:Board of Selectmen|Planning Board|Zoning Board|Conservation Commission|Budget Committee|Economic Development Committee)/i);
  if (titleMatch) {
    return titleMatch[0];
  }
  
  return "Unknown Board";
}

/**
 * Extract board info from page
 */
function extractBoardInfo(url: string, html: string): BoardInfo | null {
  const text = htmlToText(html);
  
  const schedules = extractSchedules(text);
  const locations = extractLocations(text);
  const members = extractMembers(text);
  const contact = extractContact(text);
  const name = extractBoardName(url, text);
  
  // Only return if we found at least a schedule or members
  if (schedules.length === 0 && members.length === 0) {
    return null;
  }
  
  return {
    name,
    schedule: schedules.length > 0 ? schedules.join(' / ') : undefined,
    location: locations.length > 0 ? locations.join(' or ') : undefined,
    members: members.length > 0 ? members : undefined,
    contact,
    url,
  };
}

/**
 * Main crawler
 */
async function crawlBoards(options: CrawlOptions): Promise<void> {
  const { town, url, output, maxDepth = 2 } = options;
  
  console.log(`\n📅 BOARD SCHEDULE CRAWLER`);
  console.log(`Town: ${town}`);
  console.log(`URL: ${url}\n`);
  
  const baseUrl = url.replace(/\/$/, '');
  const visited = new Set<string>();
  const toVisit = [baseUrl];
  const boards: BoardInfo[] = [];
  
  console.log(`🚀 Launching browser...`);
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });
  const page = await browser.newPage({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
  });
  console.log(`✅ Browser ready\n`);
  
  // Phase 1: Discover board pages
  console.log(`🔍 Phase 1: Discovering board pages...\n`);
  
  let depth = 0;
  while (toVisit.length > 0 && depth < maxDepth) {
    const currentUrl = toVisit.shift()!;
    
    if (visited.has(currentUrl)) continue;
    visited.add(currentUrl);
    
    console.log(`  [Depth ${depth}] ${currentUrl}`);
    
    const html = await fetchPage(page, currentUrl);
    if (!html) continue;
    
    // Extract links for next depth
    if (depth < maxDepth - 1) {
      const links = extractLinks(html, baseUrl);
      const boardLinks = filterBoardLinks(links);
      
      for (const link of boardLinks) {
        if (!visited.has(link) && !toVisit.includes(link)) {
          toVisit.push(link);
        }
      }
    }
    
    await sleep(1500);
    
    depth++;
  }
  
  console.log(`\n✅ Discovered ${visited.size} pages\n`);
  
  // Phase 2: Extract board info from relevant pages
  console.log(`📋 Phase 2: Extracting board information...\n`);
  
  for (const pageUrl of visited) {
    // Re-visit board pages to extract info
    const isBoard = filterBoardLinks([pageUrl]).length > 0;
    if (!isBoard && pageUrl !== baseUrl) continue;
    
    console.log(`  Analyzing: ${pageUrl}`);
    
    const html = await fetchPage(page, pageUrl);
    if (!html) continue;
    
    const boardInfo = extractBoardInfo(pageUrl, html);
    if (boardInfo) {
      boards.push(boardInfo);
      console.log(`    ✅ Found: ${boardInfo.name}`);
      if (boardInfo.schedule) console.log(`       Schedule: ${boardInfo.schedule}`);
      if (boardInfo.location) console.log(`       Location: ${boardInfo.location}`);
    }
    
    await sleep(1000);
  }
  
  await browser.close();
  
  console.log(`\n📊 Results: ${boards.length} boards found\n`);
  
  // Save results
  const timestamp = new Date().toISOString().split('T')[0];
  const outputDir = output || "town-profiles";
  await fs.mkdir(outputDir, { recursive: true });
  
  const jsonPath = path.join(outputDir, `${town.toLowerCase()}-boards-${timestamp}.json`);
  const mdPath = path.join(outputDir, `${town.toLowerCase()}-boards-${timestamp}.md`);
  
  // Generate JSON
  const result = {
    town,
    extractedAt: new Date().toISOString(),
    sourceUrl: url,
    pagesVisited: visited.size,
    boards,
  };
  
  await fs.writeFile(jsonPath, JSON.stringify(result, null, 2));
  
  // Generate Markdown
  let md = `# ${town} Board Meeting Schedules\n\n`;
  md += `**Extracted:** ${timestamp}\n`;
  md += `**Source:** ${url}\n`;
  md += `**Pages Analyzed:** ${visited.size}\n\n`;
  md += `---\n\n`;
  
  for (const board of boards) {
    md += `## ${board.name}\n\n`;
    if (board.schedule) md += `**Schedule:** ${board.schedule}\n`;
    if (board.location) md += `**Location:** ${board.location}\n`;
    if (board.contact) md += `**Contact:** ${board.contact}\n`;
    if (board.url) md += `**More Info:** ${board.url}\n`;
    if (board.members && board.members.length > 0) {
      md += `\n**Members:**\n`;
      for (const member of board.members) {
        md += `- ${member}\n`;
      }
    }
    md += `\n`;
  }
  
  md += `---\n\n`;
  md += `*Automatically extracted from town website. Please verify before use.*\n`;
  
  await fs.writeFile(mdPath, md);
  
  console.log(`✅ COMPLETE`);
  console.log(`JSON: ${jsonPath}`);
  console.log(`Markdown: ${mdPath}\n`);
  
  // Print summary
  console.log(`📋 Summary:\n`);
  for (const board of boards) {
    console.log(`${board.name}:`);
    console.log(`  Schedule: ${board.schedule || 'Not found'}`);
    console.log(`  Location: ${board.location || 'Not found'}`);
    console.log(``);
  }
}

// CLI
program
  .name("board-schedule-crawler")
  .description("Extract board meeting schedules from town website")
  .requiredOption("--town <name>", "Town name")
  .requiredOption("--url <url>", "Town website URL")
  .option("--output <dir>", "Output directory", "town-profiles")
  .option("--max-depth <n>", "Max crawl depth", "2")
  .action(async (opts) => {
    try {
      await crawlBoards({
        town: opts.town,
        url: opts.url,
        output: opts.output,
        maxDepth: parseInt(opts.maxDepth),
      });
    } catch (error: any) {
      console.error(`\n❌ Error: ${error.message}`);
      process.exit(1);
    }
  });

program.parse();
