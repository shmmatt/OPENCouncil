import { chromium } from "playwright";

async function test() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  
  await page.goto("https://www.brookfieldnh.gov/minutes-and-agendas", {
    waitUntil: "networkidle",
    timeout: 60000
  });
  await page.waitForTimeout(10000);
  
  console.log("Extracting ALL links on page...\n");
  
  const allLinks = await page.evaluate(() => {
    const links: { text: string; href: string }[] = [];
    document.querySelectorAll('a[href]').forEach((link) => {
      const href = link.getAttribute('href');
      const text = (link.textContent || '').trim();
      if (href && text) {
        links.push({ text: text.substring(0, 60), href });
      }
    });
    return links;
  });
  
  console.log(`Total links: ${allLinks.length}\n`);
  
  // Filter for likely document links
  const docLinks = allLinks.filter(l => 
    l.href.includes('minute') || 
    l.href.includes('agenda') ||
    l.href.includes('files') ||
    l.href.includes('.pdf') ||
    l.text.toLowerCase().includes('minute') ||
    l.text.toLowerCase().includes('agenda') ||
    l.text.toLowerCase().includes('board')
  );
  
  console.log(`Document-related links: ${docLinks.length}\n`);
  docLinks.forEach(l => {
    console.log(`"${l.text}" → ${l.href}`);
  });
  
  await browser.close();
}

test().catch(console.error);
