import { chromium } from "playwright";

async function extractDocumentLinks(page: any, baseUrl: string): Promise<string[]> {
  const links = await page.evaluate((base: string) => {
    const urls: string[] = [];
    const docExtensions = ['.pdf', '.doc', '.docx', '.xls', '.xlsx'];
    
    // Direct links
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

async function test() {
  console.log("Testing Conway document extraction...\n");
  
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });
  
  const page = await browser.newPage({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
  });
  
  const baseUrl = "https://conwaynh.gov";
  
  console.log("Loading homepage...");
  await page.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(3000);
  
  console.log("Extracting document links...");
  const docs = await extractDocumentLinks(page, baseUrl);
  
  console.log(`\nFound ${docs.length} documents`);
  console.log("\nFirst 10:");
  docs.slice(0, 10).forEach(doc => console.log(`  ${doc}`));
  
  // Try /documents page
  console.log("\n\nTrying /documents page...");
  await page.goto(`${baseUrl}/documents`, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(3000);
  
  const docPageDocs = await extractDocumentLinks(page, baseUrl);
  console.log(`\nFound ${docPageDocs.length} documents on /documents`);
  console.log("\nFirst 10:");
  docPageDocs.slice(0, 10).forEach(doc => console.log(`  ${doc}`));
  
  await browser.close();
}

test().catch(console.error);
