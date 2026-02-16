/**
 * Interactive Town Crawler
 * 
 * Uses Playwright to actively navigate town websites like a human:
 * - Finds and clicks navigation menu items
 * - Waits for JavaScript content to load
 * - Explores calendar, board, and department pages
 * - Extracts meeting schedules from rendered content
 * 
 * Perfect for JavaScript-heavy sites like TownCloud (Conway).
 * 
 * Usage:
 *   npm run crawl:interactive -- --town Conway --url https://conwaynh.gov/
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
  description?: string;
}

interface CrawlOptions {
  town: string;
  url: string;
  output?: string;
  verbose?: boolean;
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Navigation keywords to look for
 */
const NAV_KEYWORDS = [
  'calendar', 'events', 'meetings', 'schedule',
  'boards', 'committees', 'departments',
  'government', 'town hall'
];

/**
 * Click on navigation item by text
 */
async function clickNavItem(page: Page, text: string): Promise<boolean> {
  try {
    // Try to find link/button with this text (case insensitive)
    const selector = `a:has-text("${text}"), button:has-text("${text}")`;
    const element = page.locator(selector).first();
    
    if (await element.isVisible({ timeout: 2000 })) {
      console.log(`    Clicking: ${text}`);
      await element.click();
      await page.waitForLoadState('domcontentloaded');
      await sleep(2000); // Wait for JS to render
      return true;
    }
  } catch (error) {
    // Not found or not clickable
  }
  return false;
}

/**
 * Find all clickable navigation items (aggressive search)
 */
async function findNavItems(page: Page): Promise<string[]> {
  const navTexts = await page.evaluate(() => {
    const items: string[] = [];
    
    // Cast broad net - any link or button in header/nav areas
    const selectors = [
      'nav a', 'header a', '.nav a', '.menu a', 
      'nav button', 'header button',
      '[role="navigation"] a', '[role="navigation"] button',
      '.navbar a', '.navigation a', '.menu-item a',
      'a[href*="calendar"]', 'a[href*="board"]', 'a[href*="event"]',
      'a[href*="meeting"]', 'a[href*="committee"]'
    ];
    
    for (const selector of selectors) {
      try {
        const elements = document.querySelectorAll(selector);
        elements.forEach(el => {
          const text = el.textContent?.trim();
          const href = el.getAttribute('href');
          if (text && text.length > 0 && text.length < 100) {
            items.push(text);
          }
          // Also extract text from href if it looks meaningful
          if (href && href.includes('/')) {
            const path = href.split('/').pop();
            if (path && path.length > 3 && !path.includes('.')) {
              items.push(path.replace(/-/g, ' '));
            }
          }
        });
      } catch (e) {
        // Selector might not be valid, continue
      }
    }
    
    return items;
  });
  
  return [...new Set(navTexts)];
}

/**
 * Extract text content from page
 */
async function extractPageText(page: Page): Promise<string> {
  return await page.evaluate(() => document.body.innerText);
}

/**
 * Extract meetings from text
 */
function extractMeetings(text: string, sourceUrl: string): Meeting[] {
  const meetings: Meeting[] = [];
  const lines = text.split('\n').map(l => l.trim()).filter(l => l.length > 0);
  
  const boardKeywords = [
    'select', 'selectmen', 'selectboard',
    'planning', 'zoning', 'zba',
    'conservation', 'budget', 'school',
    'economic', 'development'
  ];
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].toLowerCase();
    const originalLine = lines[i];
    
    // Check if line mentions a board
    const boardMatch = boardKeywords.find(kw => line.includes(kw));
    if (!boardMatch) continue;
    
    // Determine board name
    let boardName = 'Board';
    if (line.includes('select')) boardName = 'Board of Selectmen';
    else if (line.includes('planning')) boardName = 'Planning Board';
    else if (line.includes('zoning') || line.includes('zba')) boardName = 'Zoning Board of Adjustment';
    else if (line.includes('conservation')) boardName = 'Conservation Commission';
    else if (line.includes('budget')) boardName = 'Budget Committee';
    else if (line.includes('economic')) boardName = 'Economic Development Committee';
    
    // Look for date/time in surrounding lines
    let date: string | undefined;
    let time: string | undefined;
    let location: string | undefined;
    
    for (let j = Math.max(0, i - 2); j < Math.min(lines.length, i + 5); j++) {
      const checkLine = lines[j];
      
      // Date patterns
      if (!date) {
        const dateMatch = checkLine.match(/(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)[,\s]+(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*[,\s]+\d{1,2}(?:[,\s]+\d{4})?|(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*[,\s]+\d{1,2}(?:[,\s]+\d{4})?|\d{1,2}\/\d{1,2}\/\d{2,4}/i);
        if (dateMatch) {
          date = dateMatch[0];
        }
      }
      
      // Time patterns
      if (!time) {
        const timeMatch = checkLine.match(/\d{1,2}:\d{2}\s*(?:am|pm|a\.m\.|p\.m\.)?(?:\s*-\s*\d{1,2}:\d{2}\s*(?:am|pm|a\.m\.|p\.m\.)?)?|\d{1,2}\s*(?:am|pm)(?:\s*-\s*\d{1,2}\s*(?:am|pm))?/i);
        if (timeMatch) {
          time = timeMatch[0];
        }
      }
      
      // Location patterns
      if (!location) {
        const locationMatch = checkLine.match(/(?:town hall|library|municipal building|conference room|meeting room|community center)[^,\n]*/i);
        if (locationMatch) {
          location = locationMatch[0];
        }
      }
    }
    
    // Add meeting if we found useful info
    if (date || time || location) {
      meetings.push({
        board: boardName,
        date,
        time,
        location,
        description: originalLine.substring(0, 150),
      });
    }
  }
  
  return meetings;
}

/**
 * Analyze recurring patterns
 */
function analyzePatterns(meetings: Meeting[]): { [board: string]: string } {
  const patterns: { [board: string]: string } = {};
  const byBoard: { [board: string]: Meeting[] } = {};
  
  for (const meeting of meetings) {
    if (!byBoard[meeting.board]) {
      byBoard[meeting.board] = [];
    }
    byBoard[meeting.board].push(meeting);
  }
  
  for (const [board, mtgs] of Object.entries(byBoard)) {
    const times = mtgs.map(m => m.time).filter(Boolean);
    const uniqueTimes = [...new Set(times)];
    
    if (uniqueTimes.length === 1 && times.length >= 2) {
      patterns[board] = `Regular meetings at ${uniqueTimes[0]}`;
    }
  }
  
  return patterns;
}

/**
 * Main crawler
 */
async function crawlInteractive(options: CrawlOptions): Promise<void> {
  const { town, url, output, verbose = false } = options;
  
  console.log(`\n🤖 INTERACTIVE TOWN CRAWLER`);
  console.log(`Town: ${town}`);
  console.log(`URL: ${url}\n`);
  
  const baseUrl = url.replace(/\/$/, '');
  const allMeetings: Meeting[] = [];
  const visitedPages = new Set<string>();
  
  console.log(`🚀 Launching browser...`);
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });
  
  const page = await browser.newPage({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
  });
  
  console.log(`✅ Browser ready\n`);
  
  // Navigate to homepage
  console.log(`📍 Loading homepage...`);
  await page.goto(baseUrl, {
    waitUntil: 'domcontentloaded',
    timeout: 30000,
  });
  await sleep(3000); // Let JavaScript render
  
  const homeUrl = page.url();
  visitedPages.add(homeUrl);
  console.log(`✅ Loaded: ${homeUrl}\n`);
  
  // Extract from homepage
  const homeText = await extractPageText(page);
  const homeMeetings = extractMeetings(homeText, homeUrl);
  allMeetings.push(...homeMeetings);
  console.log(`Found ${homeMeetings.length} meetings on homepage\n`);
  
  // Check if this is a TownCloud site
  console.log(`🔍 Detecting site platform...\n`);
  let townCloudPages: string[] = [];
  
  try {
    const apiUrl = `${baseUrl}/pages/all-pages.json`;
    const apiResponse = await fetch(apiUrl);
    if (apiResponse.ok) {
      const data = await apiResponse.json();
      if (data.Pages && Array.isArray(data.Pages)) {
        console.log(`✅ Detected TownCloud site with API\n`);
        townCloudPages = data.Pages
          .filter((p: any) => p.shownOnNav)
          .map((p: any) => p.slug);
        console.log(`Found ${townCloudPages.length} pages from TownCloud API:`);
        for (const slug of townCloudPages) {
          console.log(`  - ${slug}`);
        }
        console.log('');
      }
    }
  } catch (error) {
    // Not TownCloud or API unavailable
  }
  
  // Find navigation items
  console.log(`🔍 Discovering navigation from page...\n`);
  const navItems = await findNavItems(page);
  console.log(`Found ${navItems.length} navigation items\n`);
  
  // Filter TownCloud pages and nav items separately
  const relevantTownCloud = townCloudPages.filter(slug => {
    const lower = slug.toLowerCase();
    const keywords = [...NAV_KEYWORDS, 'calandar', 'selectboard', 'selectmen'];
    return keywords.some(keyword => lower.includes(keyword));
  });
  
  const relevantNavItems = navItems.filter(item => {
    const lower = item.toLowerCase();
    const keywords = [...NAV_KEYWORDS, 'calandar', 'selectboard', 'selectmen'];
    return keywords.some(keyword => lower.includes(keyword));
  });
  
  // Combine, prioritizing TownCloud slugs
  const relevantNav = [...relevantTownCloud, ...relevantNavItems];
  
  console.log(`Relevant navigation items (${relevantNav.length}):`);
  for (const item of relevantNav) {
    console.log(`  - ${item}`);
  }
  console.log('');
  
  // Try to navigate to each relevant section
  console.log(`🌐 Exploring sections...\n`);
  
  for (const navText of relevantNav) {
    let currentUrl: string;
    
    // Check if this is from TownCloud API (direct navigation)
    if (townCloudPages.includes(navText)) {
      // Direct navigation to slug
      const targetUrl = `${baseUrl}/${navText}`;
      console.log(`    Navigating to: ${navText}`);
      
      try {
        await page.goto(targetUrl, {
          waitUntil: 'domcontentloaded',
          timeout: 15000,
        });
        await sleep(2000);
        currentUrl = page.url();
      } catch (error) {
        console.log(`  ⚠️  Failed to load: ${navText}\n`);
        continue;
      }
    } else {
      // Go back to homepage before each navigation
      if (page.url() !== homeUrl) {
        await page.goto(homeUrl);
        await sleep(2000);
      }
      
      // Try to click this nav item
      const clicked = await clickNavItem(page, navText);
      if (!clicked) {
        console.log(`  ⚠️  Could not click: ${navText}`);
        continue;
      }
      
      // Wait for page to load
      await page.waitForLoadState('domcontentloaded');
      await sleep(2000);
      
      currentUrl = page.url();
    }
    if (visitedPages.has(currentUrl)) {
      console.log(`  (already visited)\n`);
      continue;
    }
    
    visitedPages.add(currentUrl);
    console.log(`  → ${currentUrl}`);
    
    // Extract meetings from this page
    const pageText = await extractPageText(page);
    const pageMeetings = extractMeetings(pageText, currentUrl);
    allMeetings.push(...pageMeetings);
    
    if (pageMeetings.length > 0) {
      console.log(`  ✅ Found ${pageMeetings.length} meetings`);
    }
    
    if (verbose && pageMeetings.length > 0) {
      for (const meeting of pageMeetings) {
        console.log(`     - ${meeting.board}: ${meeting.date || '?'} ${meeting.time || '?'}`);
      }
    }
    
    console.log('');
    
    // Look for sub-navigation (board pages, etc.)
    if (navText.toLowerCase().includes('board') || navText.toLowerCase().includes('committee')) {
      console.log(`  🔍 Looking for sub-pages...`);
      
      const subLinks = await page.evaluate(() => {
        const links: { text: string; href: string }[] = [];
        document.querySelectorAll('a').forEach(link => {
          const text = link.textContent?.trim();
          const href = link.getAttribute('href');
          if (text && href && text.length > 0 && text.length < 100) {
            links.push({ text, href });
          }
        });
        return links;
      });
      
      const boardLinks = subLinks.filter(link => {
        const lower = link.text.toLowerCase();
        return ['select', 'planning', 'zoning', 'conservation', 'budget', 'board', 'committee'].some(kw => lower.includes(kw));
      });
      
      console.log(`  Found ${boardLinks.length} potential board links`);
      
      // Visit up to 5 board pages
      for (const link of boardLinks.slice(0, 5)) {
        try {
          console.log(`    Checking: ${link.text}`);
          
          await page.goto(link.href.startsWith('http') ? link.href : baseUrl + link.href, {
            waitUntil: 'domcontentloaded',
            timeout: 15000,
          });
          await sleep(2000);
          
          const boardUrl = page.url();
          if (visitedPages.has(boardUrl)) continue;
          
          visitedPages.add(boardUrl);
          
          const boardText = await extractPageText(page);
          const boardMeetings = extractMeetings(boardText, boardUrl);
          allMeetings.push(...boardMeetings);
          
          if (boardMeetings.length > 0) {
            console.log(`      ✅ ${boardMeetings.length} meetings`);
          }
        } catch (error) {
          console.log(`      ⚠️  Failed to load`);
        }
      }
      
      console.log('');
      
      // Go back to main section
      await page.goto(currentUrl);
      await sleep(1000);
    }
  }
  
  await browser.close();
  
  // Deduplicate meetings
  const uniqueMeetings = Array.from(
    new Map(
      allMeetings
        .filter(m => m.date || m.time) // Only keep meetings with at least date or time
        .map(m => [`${m.board}|${m.date}|${m.time}`, m])
    ).values()
  );
  
  console.log(`\n📊 Results:\n`);
  console.log(`Pages visited: ${visitedPages.size}`);
  console.log(`Unique meetings found: ${uniqueMeetings.length}\n`);
  
  // Analyze patterns
  const patterns = analyzePatterns(uniqueMeetings);
  
  // Group by board
  const byBoard: { [board: string]: Meeting[] } = {};
  for (const meeting of uniqueMeetings) {
    if (!byBoard[meeting.board]) {
      byBoard[meeting.board] = [];
    }
    byBoard[meeting.board].push(meeting);
  }
  
  // Print summary
  for (const [board, meetings] of Object.entries(byBoard)) {
    console.log(`${board}: ${meetings.length} meetings`);
    if (patterns[board]) {
      console.log(`  Pattern: ${patterns[board]}`);
    }
  }
  
  // Save results
  const timestamp = new Date().toISOString().split('T')[0];
  const outputDir = output || "town-profiles";
  await fs.mkdir(outputDir, { recursive: true });
  
  const jsonPath = path.join(outputDir, `${town.toLowerCase()}-interactive-${timestamp}.json`);
  const mdPath = path.join(outputDir, `${town.toLowerCase()}-interactive-${timestamp}.md`);
  
  const result = {
    town,
    extractedAt: new Date().toISOString(),
    sourceUrl: url,
    pagesVisited: Array.from(visitedPages),
    meetings: uniqueMeetings,
    recurringPatterns: patterns,
  };
  
  await fs.writeFile(jsonPath, JSON.stringify(result, null, 2));
  
  // Generate markdown
  let md = `# ${town} Meeting Calendar (Interactive Crawl)\n\n`;
  md += `**Extracted:** ${timestamp}\n`;
  md += `**Source:** ${url}\n`;
  md += `**Pages Visited:** ${visitedPages.size}\n\n`;
  md += `---\n\n`;
  
  for (const [board, meetings] of Object.entries(byBoard)) {
    md += `## ${board}\n\n`;
    
    if (patterns[board]) {
      md += `**Pattern:** ${patterns[board]}\n\n`;
    }
    
    md += `**Meetings:**\n\n`;
    for (const mtg of meetings) {
      md += `- `;
      if (mtg.date) md += `**${mtg.date}**`;
      if (mtg.time) md += ` at ${mtg.time}`;
      if (mtg.location) md += ` - ${mtg.location}`;
      md += `\n`;
      if (mtg.description) {
        md += `  > ${mtg.description}\n`;
      }
    }
    md += `\n`;
  }
  
  if (Object.keys(byBoard).length === 0) {
    md += `*No meetings with dates/times found.*\n\n`;
    md += `**Pages visited:**\n\n`;
    for (const url of Array.from(visitedPages).slice(0, 20)) {
      md += `- ${url}\n`;
    }
  }
  
  md += `\n---\n\n`;
  md += `*Automatically extracted by interactive crawler with JavaScript navigation.*\n`;
  
  await fs.writeFile(mdPath, md);
  
  console.log(`\n✅ COMPLETE`);
  console.log(`JSON: ${jsonPath}`);
  console.log(`Markdown: ${mdPath}\n`);
}

// CLI
program
  .name("interactive-town-crawler")
  .description("Interactive crawler that navigates JavaScript sites like a human")
  .requiredOption("--town <name>", "Town name")
  .requiredOption("--url <url>", "Town website URL")
  .option("--output <dir>", "Output directory", "town-profiles")
  .option("--verbose", "Verbose output")
  .action(async (opts) => {
    try {
      await crawlInteractive({
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
