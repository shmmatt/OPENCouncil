/**
 * Calendar Crawler - Extract meeting schedules from town calendar pages
 * 
 * Aggressively searches for calendar/event pages and extracts:
 * - Meeting dates and times
 * - Board/committee names
 * - Meeting locations
 * 
 * Usage:
 *   npm run crawl:calendar -- --town Ossipee --url https://www.ossipee.org/
 */

import * as fs from "fs/promises";
import * as path from "path";
import { program } from "commander";
import { chromium, Browser, Page } from "playwright";

interface Meeting {
  board: string;
  date?: string;
  time?: string;
  location?: string;
  title?: string;
}

interface CrawlOptions {
  town: string;
  url: string;
  output?: string;
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Calendar-related keywords for link discovery
 */
const CALENDAR_KEYWORDS = [
  'calendar', 'events', 'meetings', 'schedule',
  'agenda', 'upcoming', 'dates'
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
    
    // Wait for dynamic content
    await sleep(3000);
    
    // Check for Cloudflare
    const bodyText = await page.textContent('body');
    if (bodyText?.includes('Checking your browser') || bodyText?.includes('Just a moment')) {
      console.log(`    Waiting for Cloudflare...`);
      await sleep(5000);
    }
    
    return await page.content();
  } catch (error: any) {
    console.warn(`    Failed: ${error.message}`);
    return null;
  }
}

/**
 * Extract all links from HTML
 */
function extractLinks(html: string, baseUrl: string): string[] {
  const links: string[] = [];
  const hrefRegex = /href=["']([^"']+)["']/gi;
  let match;
  
  while ((match = hrefRegex.exec(html)) !== null) {
    let href = match[1];
    
    if (href.startsWith('#') || href.startsWith('mailto:') || href.startsWith('tel:')) {
      continue;
    }
    
    if (href.startsWith('/')) {
      href = baseUrl.replace(/\/$/, '') + href;
    } else if (!href.startsWith('http')) {
      href = baseUrl.replace(/\/$/, '') + '/' + href;
    }
    
    try {
      const baseHost = new URL(baseUrl).hostname;
      const linkHost = new URL(href).hostname;
      if (baseHost === linkHost) {
        links.push(href);
      }
    } catch (e) {
      // Invalid URL
    }
  }
  
  return [...new Set(links)];
}

/**
 * Filter links that likely lead to calendars
 */
function filterCalendarLinks(links: string[]): string[] {
  return links.filter(link => {
    const lower = link.toLowerCase();
    return CALENDAR_KEYWORDS.some(keyword => lower.includes(keyword));
  });
}

/**
 * Extract visible text from HTML
 */
async function getPageText(page: Page): Promise<string> {
  return await page.evaluate(() => document.body.innerText);
}

/**
 * Parse calendar page for meetings
 */
function extractMeetingsFromText(text: string): Meeting[] {
  const meetings: Meeting[] = [];
  const lines = text.split('\n').map(l => l.trim()).filter(l => l.length > 0);
  
  // Board keywords to look for
  const boardKeywords = [
    'select', 'selectmen', 'planning', 'zoning', 'zba',
    'conservation', 'budget', 'school', 'economic'
  ];
  
  // Month names for date matching
  const months = [
    'january', 'february', 'march', 'april', 'may', 'june',
    'july', 'august', 'september', 'october', 'november', 'december',
    'jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'
  ];
  
  // Look for patterns like:
  // "February 10 - Board of Selectmen Meeting - 6:00 PM"
  // "Select Board - Monday Feb 10 at 6pm"
  // "Planning Board Meeting\n02/10/2026\n7:00 PM"
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].toLowerCase();
    const originalLine = lines[i];
    
    // Check if this line mentions a board
    const boardMatch = boardKeywords.find(kw => line.includes(kw));
    if (!boardMatch) continue;
    
    // Extract board name
    let boardName = 'Board';
    if (line.includes('select')) boardName = 'Board of Selectmen';
    else if (line.includes('planning')) boardName = 'Planning Board';
    else if (line.includes('zoning') || line.includes('zba')) boardName = 'Zoning Board of Adjustment';
    else if (line.includes('conservation')) boardName = 'Conservation Commission';
    else if (line.includes('budget')) boardName = 'Budget Committee';
    
    // Look for date in current line or next 2 lines
    let date: string | undefined;
    let time: string | undefined;
    let location: string | undefined;
    
    for (let j = i; j < Math.min(i + 3, lines.length); j++) {
      const checkLine = lines[j];
      const checkLower = checkLine.toLowerCase();
      
      // Date patterns: "Feb 10", "02/10/2026", "February 10, 2026", "Monday, Feb 10"
      const dateMatch = checkLine.match(/(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday),?\s+(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+\d{1,2}(?:,?\s+\d{4})?|(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+\d{1,2}(?:,?\s+\d{4})?|\d{1,2}\/\d{1,2}\/\d{2,4}/i);
      if (dateMatch && !date) {
        date = dateMatch[0];
      }
      
      // Time patterns: "6:00 PM", "7pm", "6:30 p.m.", "6:00 - 7:30 PM"
      const timeMatch = checkLine.match(/\d{1,2}:\d{2}\s*(?:am|pm|a\.m\.|p\.m\.)?(?:\s*-\s*\d{1,2}:\d{2}\s*(?:am|pm|a\.m\.|p\.m\.)?)?|\d{1,2}\s*(?:am|pm)(?:\s*-\s*\d{1,2}\s*(?:am|pm))?/i);
      if (timeMatch && !time) {
        time = timeMatch[0];
      }
      
      // Location patterns: "Town Hall", "Library", etc.
      if ((checkLower.includes('town hall') || checkLower.includes('library') || 
           checkLower.includes('municipal') || checkLower.includes('room')) && !location) {
        const locationMatch = checkLine.match(/(?:town hall|library|municipal building|conference room|meeting room)[^,\n]*/i);
        if (locationMatch) {
          location = locationMatch[0];
        }
      }
    }
    
    // Add meeting if we found at least a board name
    meetings.push({
      board: boardName,
      date,
      time,
      location,
      title: originalLine.substring(0, 100),
    });
  }
  
  return meetings;
}

/**
 * Try to detect embedded Google Calendar
 */
async function extractGoogleCalendarEvents(page: Page): Promise<Meeting[]> {
  try {
    const iframeCount = await page.locator('iframe').count();
    console.log(`    Found ${iframeCount} iframes on page`);
    
    for (let i = 0; i < iframeCount; i++) {
      const iframe = page.locator('iframe').nth(i);
      const src = await iframe.getAttribute('src');
      
      if (src && src.includes('google.com/calendar')) {
        console.log(`    Found Google Calendar iframe: ${src}`);
        
        // Try to extract from iframe
        const frame = iframe.contentFrame();
        if (frame) {
          const text = await frame.evaluate(() => document.body.innerText);
          return extractMeetingsFromText(text);
        }
      }
    }
  } catch (error) {
    console.warn(`    Google Calendar extraction failed: ${error}`);
  }
  
  return [];
}

/**
 * Analyze recurring patterns from meetings
 */
function analyzeRecurringPatterns(meetings: Meeting[]): { [board: string]: string } {
  const patterns: { [board: string]: string } = {};
  
  // Group meetings by board
  const byBoard: { [board: string]: Meeting[] } = {};
  for (const meeting of meetings) {
    if (!byBoard[meeting.board]) {
      byBoard[meeting.board] = [];
    }
    byBoard[meeting.board].push(meeting);
  }
  
  // For each board, try to find pattern
  for (const [board, mtgs] of Object.entries(byBoard)) {
    if (mtgs.length < 2) continue;
    
    // Check if meetings fall on same day of week
    const times = new Set(mtgs.map(m => m.time).filter(Boolean));
    if (times.size === 1) {
      patterns[board] = `Regular meetings at ${Array.from(times)[0]}`;
    }
  }
  
  return patterns;
}

/**
 * Main crawler
 */
async function crawlCalendar(options: CrawlOptions): Promise<void> {
  const { town, url, output } = options;
  
  console.log(`\n📅 CALENDAR CRAWLER`);
  console.log(`Town: ${town}`);
  console.log(`URL: ${url}\n`);
  
  const baseUrl = url.replace(/\/$/, '');
  
  console.log(`🚀 Launching browser...`);
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });
  const page = await browser.newPage({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
  });
  console.log(`✅ Browser ready\n`);
  
  // Phase 1: Find calendar page
  console.log(`🔍 Phase 1: Finding calendar page...\n`);
  
  const html = await fetchPage(page, baseUrl);
  if (!html) {
    throw new Error('Could not fetch homepage');
  }
  
  const links = extractLinks(html, baseUrl);
  const calendarLinks = filterCalendarLinks(links);
  
  console.log(`Found ${calendarLinks.length} calendar-related links:`);
  for (const link of calendarLinks.slice(0, 10)) {
    console.log(`  - ${link}`);
  }
  console.log('');
  
  // Phase 2: Extract meetings from calendar pages
  console.log(`📋 Phase 2: Extracting meetings...\n`);
  
  const allMeetings: Meeting[] = [];
  const visited = new Set<string>();
  
  // Try homepage first
  console.log(`Analyzing homepage...`);
  const homeText = await getPageText(page);
  const homeMeetings = extractMeetingsFromText(homeText);
  allMeetings.push(...homeMeetings);
  console.log(`  Found ${homeMeetings.length} meetings on homepage`);
  
  // Prioritize event-specific links (e.g., /events/46061)
  const eventLinks = calendarLinks.filter(link => link.includes('/events/'));
  const otherLinks = calendarLinks.filter(link => !link.includes('/events/'));
  const prioritizedLinks = [...eventLinks.slice(0, 10), ...otherLinks.slice(0, 5)];
  
  console.log(`\nPrioritizing ${eventLinks.length} event links, ${otherLinks.length} other calendar links\n`);
  
  // Try each calendar link
  for (const calLink of prioritizedLinks) {
    if (visited.has(calLink)) continue;
    visited.add(calLink);
    
    console.log(`Analyzing: ${calLink}`);
    
    const calHtml = await fetchPage(page, calLink);
    if (!calHtml) continue;
    
    // Check for Google Calendar embed
    const googleMeetings = await extractGoogleCalendarEvents(page);
    if (googleMeetings.length > 0) {
      console.log(`  Found ${googleMeetings.length} meetings from Google Calendar`);
      allMeetings.push(...googleMeetings);
    }
    
    // Extract from page text
    const calText = await getPageText(page);
    const textMeetings = extractMeetingsFromText(calText);
    if (textMeetings.length > 0) {
      console.log(`  Found ${textMeetings.length} meetings from page text`);
      allMeetings.push(...textMeetings);
    }
    
    await sleep(1500);
  }
  
  await browser.close();
  
  // Deduplicate meetings
  const uniqueMeetings = Array.from(
    new Map(allMeetings.map(m => [m.board + m.date + m.time, m])).values()
  );
  
  console.log(`\n📊 Results: ${uniqueMeetings.length} unique meetings found\n`);
  
  // Analyze patterns
  const patterns = analyzeRecurringPatterns(uniqueMeetings);
  
  // Save results
  const timestamp = new Date().toISOString().split('T')[0];
  const outputDir = output || "town-profiles";
  await fs.mkdir(outputDir, { recursive: true });
  
  const jsonPath = path.join(outputDir, `${town.toLowerCase()}-calendar-${timestamp}.json`);
  const mdPath = path.join(outputDir, `${town.toLowerCase()}-calendar-${timestamp}.md`);
  
  const result = {
    town,
    extractedAt: new Date().toISOString(),
    sourceUrl: url,
    calendarLinks,
    meetings: uniqueMeetings,
    recurringPatterns: patterns,
  };
  
  await fs.writeFile(jsonPath, JSON.stringify(result, null, 2));
  
  // Generate markdown
  let md = `# ${town} Meeting Calendar\n\n`;
  md += `**Extracted:** ${timestamp}\n`;
  md += `**Source:** ${url}\n\n`;
  md += `---\n\n`;
  
  // Group by board
  const byBoard: { [board: string]: Meeting[] } = {};
  for (const meeting of uniqueMeetings) {
    if (!byBoard[meeting.board]) {
      byBoard[meeting.board] = [];
    }
    byBoard[meeting.board].push(meeting);
  }
  
  for (const [board, meetings] of Object.entries(byBoard)) {
    md += `## ${board}\n\n`;
    
    if (patterns[board]) {
      md += `**Pattern:** ${patterns[board]}\n\n`;
    }
    
    md += `**Upcoming Meetings:**\n\n`;
    for (const mtg of meetings) {
      md += `- `;
      if (mtg.date) md += `**${mtg.date}**`;
      if (mtg.time) md += ` at ${mtg.time}`;
      if (mtg.location) md += ` - ${mtg.location}`;
      md += `\n`;
    }
    md += `\n`;
  }
  
  if (Object.keys(byBoard).length === 0) {
    md += `*No meetings found. Try checking the calendar links manually:*\n\n`;
    for (const link of calendarLinks.slice(0, 5)) {
      md += `- ${link}\n`;
    }
  }
  
  md += `\n---\n\n`;
  md += `*Automatically extracted from town website calendar.*\n`;
  
  await fs.writeFile(mdPath, md);
  
  console.log(`✅ COMPLETE`);
  console.log(`JSON: ${jsonPath}`);
  console.log(`Markdown: ${mdPath}\n`);
  
  // Print summary
  console.log(`📋 Summary:\n`);
  for (const [board, meetings] of Object.entries(byBoard)) {
    console.log(`${board}: ${meetings.length} meetings found`);
    if (patterns[board]) {
      console.log(`  Pattern: ${patterns[board]}`);
    }
  }
}

// CLI
program
  .name("calendar-crawler")
  .description("Extract meeting schedules from town calendar pages")
  .requiredOption("--town <name>", "Town name")
  .requiredOption("--url <url>", "Town website URL")
  .option("--output <dir>", "Output directory", "town-profiles")
  .action(async (opts) => {
    try {
      await crawlCalendar({
        town: opts.town,
        url: opts.url,
        output: opts.output,
      });
    } catch (error: any) {
      console.error(`\n❌ Error: ${error.message}`);
      process.exit(1);
    }
  });

program.parse();
