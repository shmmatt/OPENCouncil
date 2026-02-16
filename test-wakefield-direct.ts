import { chromium } from 'playwright-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';

chromium.use(StealthPlugin());

async function test() {
  const browser = await chromium.launch({ 
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });
  
  const page = await browser.newPage({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  });
  
  // Try known URL patterns directly
  const testUrls = [
    'https://www.wakefieldnh.gov/node/8/minutes/2025',
    'https://www.wakefieldnh.gov/node/8/minutes/2024',
    'https://www.wakefieldnh.gov/node/100/minutes'
  ];
  
  for (const url of testUrls) {
    console.log(`\nTrying: ${url}`);
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForTimeout(10000);
      
      const title = await page.title();
      console.log(`  Title: ${title}`);
      
      if (!title.toLowerCase().includes('just a moment')) {
        // Extract document links
        const docs = await page.evaluate(() => {
          const links: string[] = [];
          document.querySelectorAll('a[href]').forEach(a => {
            const href = a.getAttribute('href') || '';
            if (href.includes('.pdf') || href.includes('.doc') || href.includes('/files/')) {
              links.push(href);
            }
          });
          return links;
        });
        
        console.log(`  Found ${docs.length} document links`);
        docs.slice(0, 5).forEach(doc => console.log(`    ${doc}`));
      } else {
        console.log('  Still blocked by Cloudflare');
      }
    } catch (e: any) {
      console.log(`  Error: ${e.message}`);
    }
  }
  
  await browser.close();
}

test().catch(console.error);
