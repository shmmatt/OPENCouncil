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
  
  console.log('Loading Wakefield homepage...');
  await page.goto('https://www.wakefieldnh.gov', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(20000); // Long wait
  
  const title = await page.title();
  console.log('Page title:', title);
  
  // Check for any links
  const allLinks = await page.evaluate(() => {
    return Array.from(document.querySelectorAll('a[href]')).map(a => ({
      text: (a.textContent || '').trim().substring(0, 50),
      href: a.getAttribute('href')
    })).slice(0, 20);
  });
  
  console.log('\nFirst 20 links:');
  allLinks.forEach(link => console.log(`${link.text}: ${link.href}`));
  
  // Check for any obvious document links
  const docLinks = await page.evaluate(() => {
    const links: string[] = [];
    document.querySelectorAll('a[href]').forEach(a => {
      const href = a.getAttribute('href') || '';
      if (href.includes('.pdf') || href.includes('document') || href.includes('files')) {
        links.push(href);
      }
    });
    return links.slice(0, 10);
  });
  
  console.log('\nDocument-related links:');
  docLinks.forEach(link => console.log(link));
  
  await browser.close();
}

test().catch(console.error);
