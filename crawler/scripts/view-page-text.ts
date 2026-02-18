/**
 * Simple page text viewer to diagnose what's on a page
 */
import { chromium } from "playwright";

const url = process.argv[2];
if (!url) {
  console.error("Usage: tsx view-page-text.ts <url>");
  process.exit(1);
}

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await new Promise(resolve => setTimeout(resolve, 2000));
  
  const text = await page.evaluate(() => document.body.innerText);
  console.log(text);
  
  await browser.close();
})();
