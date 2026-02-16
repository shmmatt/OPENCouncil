import { chromium } from "playwright";

async function discoverKeywordLinks(page: any, baseUrl: string): Promise<string[]> {
  const links = await page.evaluate((base: string) => {
    const keywords = [
      'agenda', 'minute', 'form', 'ordinance', 'download', 'document',
      'regulation', 'policy', 'report', 'budget'
    ];
    const urls: string[] = [];
    
    document.querySelectorAll('a[href]').forEach(link => {
      const href = link.getAttribute('href');
      const text = (link.textContent || '').toLowerCase();
      const hrefLower = (href || '').toLowerCase();
      
      if (href && keywords.some(kw => hrefLower.includes(kw) || text.includes(kw))) {
        let fullUrl = href;
        if (href.startsWith('/')) {
          fullUrl = base + href;
        } else if (!href.startsWith('http')) {
          fullUrl = base + '/' + href;
        }
        
        // Same domain only
        try {
          const baseHost = new URL(base).hostname;
          const linkHost = new URL(fullUrl).hostname;
          if (baseHost === linkHost) {
            urls.push(fullUrl);
          }
        } catch (e) {}
      }
    });
    
    return [...new Set(urls)];
  }, baseUrl.replace(/\/$/, ''));
  
  return links;
}

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
      
      if (href.includes('/AgendaCenter/ViewFile/') || 
          href.includes('/DocumentCenter/View/') ||
          href.includes('/FormCenter/')) {
        urls.push(href);
      }
    });
    
    return urls;
  }, baseUrl.replace(/\/$/, ''));
  
  return [...new Set(links)];
}

async function test() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const baseUrl = "https://www.townofbartlett.nh.gov";
  
  console.log("Loading homepage...");
  await page.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(2000);
  
  console.log("\nStep 1: Finding keyword links...");
  const keywordLinks = await discoverKeywordLinks(page, baseUrl);
  console.log(`Found ${keywordLinks.length} keyword links:`);
  keywordLinks.forEach(l => console.log(`  ${l}`));
  
  console.log("\nStep 2: Visiting AgendaCenter...");
  await page.goto(`${baseUrl}/AgendaCenter`, { waitUntil: 'domcontentloaded', timeout: 15000 });
  await page.waitForTimeout(2000);
  
  const docs = await extractDocumentLinks(page, baseUrl);
  console.log(`Found ${docs.length} document links on AgendaCenter`);
  console.log("First 10:");
  docs.slice(0, 10).forEach(d => console.log(`  ${d}`));
  
  await browser.close();
}

test().catch(console.error);
