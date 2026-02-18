import { chromium } from "playwright";

async function test() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  
  await page.goto("https://conwaynh.gov/documents", {
    waitUntil: "domcontentloaded",
    timeout: 30000
  });
  
  await page.waitForTimeout(3000);
  
  const links = await page.evaluate(() => {
    const urls: string[] = [];
    document.querySelectorAll('a[href]').forEach(link => {
      const href = link.getAttribute('href');
      if (href && (href.includes('.pdf') || href.includes('.doc') || href.includes('.xls'))) {
        urls.push(href);
      }
    });
    return urls;
  });
  
  console.log("Found PDF/Doc links:", links.length);
  console.log("First 10:", links.slice(0, 10));
  
  await browser.close();
}

test();
