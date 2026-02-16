/**
 * Debug page content - see what's actually rendered
 */
import { chromium } from "playwright";

const url = process.argv[2] || "https://conwaynh.gov/calandar";

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  
  console.log(`Loading: ${url}\n`);
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await new Promise(resolve => setTimeout(resolve, 3000));
  
  console.log("=== PAGE TEXT ===\n");
  const text = await page.evaluate(() => document.body.innerText);
  console.log(text.substring(0, 5000));
  
  console.log("\n\n=== IFRAMES ===\n");
  const iframes = await page.locator('iframe').count();
  console.log(`Found ${iframes} iframes`);
  
  for (let i = 0; i < iframes; i++) {
    const src = await page.locator('iframe').nth(i).getAttribute('src');
    console.log(`  [${i}] ${src}`);
  }
  
  await browser.close();
})();
