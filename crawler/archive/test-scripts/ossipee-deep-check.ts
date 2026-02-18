import { chromium } from "playwright";

async function deepCheck() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
  });
  
  console.log("Loading Ossipee with Cloudflare bypass...");
  await page.goto("https://www.ossipee.org", { 
    waitUntil: "networkidle", 
    timeout: 30000 
  });
  await page.waitForTimeout(5000); // Extra time for Cloudflare
  
  // Check what we actually got
  const title = await page.title();
  console.log(`Page title: ${title}`);
  
  const bodyText = await page.evaluate(() => document.body.innerText);
  console.log(`\nBody text length: ${bodyText.length} chars`);
  console.log(`First 200 chars: ${bodyText.substring(0, 200)}`);
  
  // Look for ANY links
  const allLinks = await page.evaluate(() => {
    const links: string[] = [];
    document.querySelectorAll('a[href]').forEach(link => {
      const href = link.getAttribute('href');
      const text = (link.textContent || '').trim();
      if (href && text) {
        links.push(`${text.substring(0, 40)} → ${href}`);
      }
    });
    return links.slice(0, 20);
  });
  
  console.log(`\nAll links found (${allLinks.length}):`);
  allLinks.forEach(link => console.log(`  ${link}`));
  
  // Try known paths from previous investigation
  const knownPaths = ['/documents', '/minutes', '/boards', '/selectmen'];
  
  for (const path of knownPaths) {
    try {
      console.log(`\nTrying: https://www.ossipee.org${path}`);
      const response = await page.goto(`https://www.ossipee.org${path}`, {
        waitUntil: "domcontentloaded",
        timeout: 10000
      });
      await page.waitForTimeout(2000);
      
      const status = response?.status();
      console.log(`  Status: ${status}`);
      
      if (status === 200) {
        const text = await page.evaluate(() => document.body.innerText);
        if (!text.includes('404') && text.length > 200) {
          console.log(`  ✓ Valid page (${text.length} chars)`);
          
          const pdfs = await page.evaluate(() => {
            const links: string[] = [];
            document.querySelectorAll('a[href]').forEach(link => {
              const href = link.getAttribute('href');
              if (href && href.toLowerCase().includes('.pdf')) {
                links.push(href);
              }
            });
            return links.slice(0, 5);
          });
          
          if (pdfs.length > 0) {
            console.log(`  Found ${pdfs.length} PDFs:`);
            pdfs.forEach(pdf => console.log(`    ${pdf}`));
          }
        }
      }
    } catch (error: any) {
      console.log(`  Error: ${error.message}`);
    }
  }
  
  await browser.close();
}

deepCheck().catch(console.error);
