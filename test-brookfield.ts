import { chromium } from "playwright";

async function testBrookfield() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  
  console.log("Testing Brookfield - Minutes and Agendas page\n");
  
  await page.goto("https://www.brookfieldnh.gov/minutes-and-agendas", {
    waitUntil: "domcontentloaded",
    timeout: 30000
  });
  await page.waitForTimeout(3000); // Cloudflare bypass
  
  console.log(`Page URL: ${page.url()}`);
  console.log(`Page Title: ${await page.title()}\n`);
  
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
  
  console.log(`Found ${docLinks.length} document-related links:`);
  docLinks.slice(0, 20).forEach(link => console.log(`  ${link}`));
  
  // Also test the /files/ page
  console.log("\n\nTesting Brookfield - Files page\n");
  
  await page.goto("https://www.brookfieldnh.gov/files/", {
    waitUntil: "domcontentloaded",
    timeout: 30000
  });
  await page.waitForTimeout(3000);
  
  console.log(`Page URL: ${page.url()}`);
  
  const fileLinks = await page.evaluate(() => {
    const links: string[] = [];
    document.querySelectorAll('a[href]').forEach(link => {
      const href = link.getAttribute('href');
      const text = (link.textContent || '').trim();
      if (href && (
        href.includes('.pdf') || 
        href.includes('/files/') ||
        href.includes('budget') ||
        href.includes('minute')
      )) {
        links.push(`${text.substring(0, 40)} → ${href}`);
      }
    });
    return [...new Set(links)].slice(0, 20);
  });
  
  console.log(`Found ${fileLinks.length} file links:`);
  fileLinks.forEach(link => console.log(`  ${link}`));
  
  await browser.close();
}

testBrookfield().catch(console.error);
