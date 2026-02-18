import { chromium } from "playwright";

async function testBrookfield() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  });
  
  console.log("Testing Brookfield with longer Cloudflare wait...\n");
  
  await page.goto("https://www.brookfieldnh.gov/minutes-and-agendas", {
    waitUntil: "networkidle",
    timeout: 60000
  });
  console.log("Initial page loaded, waiting 10 seconds for Cloudflare...");
  await page.waitForTimeout(10000);
  
  console.log(`\nPage URL: ${page.url()}`);
  console.log(`Page Title: ${await page.title()}\n`);
  
  // Check body content to see if we got through
  const bodyText = await page.evaluate(() => document.body.innerText);
  console.log(`Body text length: ${bodyText.length} chars`);
  console.log(`First 300 chars:\n${bodyText.substring(0, 300)}\n`);
  
  // Look for document links
  const docLinks = await page.evaluate(() => {
    const links: string[] = [];
    document.querySelectorAll('a[href]').forEach(link => {
      const href = link.getAttribute('href');
      if (href && (
        href.includes('.pdf') || 
        href.includes('/files/') ||
        href.includes('/ViewFile/') ||
        href.includes('/AgendaCenter/')
      )) {
        links.push(href);
      }
    });
    return [...new Set(links)];
  });
  
  console.log(`Found ${docLinks.length} document links`);
  if (docLinks.length > 0) {
    console.log("First 10:");
    docLinks.slice(0, 10).forEach(link => console.log(`  ${link}`));
  }
  
  await browser.close();
}

testBrookfield().catch(console.error);
