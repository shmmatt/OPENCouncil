import { chromium } from "playwright";

const COMMON_DOC_PATHS = [
  '/documents', '/docs', '/files',
  '/minutes', '/agendas', '/meetings',
];

async function extractDocumentLinks(page: any, baseUrl: string): Promise<string[]> {
  const links = await page.evaluate((base: string) => {
    const urls: string[] = [];
    const docExtensions = ['.pdf', '.doc', '.docx', '.xls', '.xlsx'];
    
    document.querySelectorAll('a[href]').forEach(link => {
      let href = link.getAttribute('href');
      if (!href) return;
      
      if (href.startsWith('/')) {
        href = base + href;
      } else if (!href.startsWith('http')) {
        href = base + '/' + href;
      }
      
      const lower = href.toLowerCase();
      if (docExtensions.some(ext => lower.includes(ext))) {
        urls.push(href);
      }
    });
    
    return urls;
  }, baseUrl.replace(/\/$/, ''));
  
  return [...new Set(links)];
}

async function test() {
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  const page = await browser.newPage();
  
  const baseUrl = "https://conwaynh.gov";
  const visitedPages = new Set<string>();
  const discovered = new Set<string>();
  
  visitedPages.add(baseUrl); // Homepage was visited in Strategy 2
  
  console.log("Strategy 4: Common URL Patterns\n");
  
  const commonUrls = COMMON_DOC_PATHS.map(path => `${baseUrl}${path}`);
  
  for (const testUrl of commonUrls) {
    if (visitedPages.has(testUrl)) {
      console.log(`  ${testUrl} - SKIPPED (already visited)`);
      continue;
    }
    
    try {
      process.stdout.write(`  ${testUrl}... `);
      
      await page.goto(testUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
      await page.waitForTimeout(1500);
      
      const text = await page.evaluate(() => document.body.innerText);
      
      if (text.toLowerCase().includes('404') || text.toLowerCase().includes('not found') || text.length < 200) {
        console.log(`❌ (404 or too short: ${text.length} chars)`);
        continue;
      }
      
      visitedPages.add(testUrl);
      
      const docs = await extractDocumentLinks(page, baseUrl);
      docs.forEach(doc => discovered.add(doc));
      
      console.log(`✅ ${docs.length} docs`);
      
    } catch (error: any) {
      console.log(`❌ ${error.message}`);
    }
  }
  
  console.log(`\nTotal discovered: ${discovered.size}`);
  console.log("\nFirst 10:");
  Array.from(discovered).slice(0, 10).forEach(doc => console.log(`  ${doc}`));
  
  await browser.close();
}

test().catch(console.error);
