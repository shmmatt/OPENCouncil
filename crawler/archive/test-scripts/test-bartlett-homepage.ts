import { chromium } from "playwright";

async function test() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  
  await page.goto("https://www.townofbartlett.nh.gov", {
    waitUntil: "domcontentloaded",
    timeout: 30000
  });
  
  await page.waitForTimeout(2000);
  
  // Find all links with keywords
  const links = await page.evaluate(() => {
    const keywords = ['agenda', 'minute', 'form', 'ordinance', 'download', 'document'];
    const urls: string[] = [];
    
    document.querySelectorAll('a[href]').forEach(link => {
      const href = link.getAttribute('href');
      const text = link.textContent?.toLowerCase() || '';
      
      if (href && keywords.some(kw => href.toLowerCase().includes(kw) || text.includes(kw))) {
        urls.push(href);
      }
    });
    
    return [...new Set(urls)];
  });
  
  console.log("Found links with keywords:");
  links.forEach(link => console.log(`  ${link}`));
  
  await browser.close();
}

test();
