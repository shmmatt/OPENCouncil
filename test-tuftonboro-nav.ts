import { chromium } from 'playwright';

async function test() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  
  await page.goto('https://www.tuftonboronh.gov', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(15000); // Long wait for Cloudflare
  
  // Check title
  const title = await page.title();
  console.log('Page title:', title);
  
  // Extract ALL links
  const allLinks = await page.evaluate(() => {
    const links: string[] = [];
    document.querySelectorAll('a[href]').forEach(link => {
      const href = link.getAttribute('href');
      const text = (link.textContent || '').trim();
      if (href && text) {
        links.push(`${text}: ${href}`);
      }
    });
    return links;
  });
  
  console.log('\nAll links found:');
  allLinks.slice(0, 30).forEach(link => console.log(link));
  console.log(`\nTotal links: ${allLinks.length}`);
  
  await browser.close();
}

test().catch(console.error);
