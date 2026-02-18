import { chromium } from "playwright";

const ZERO_TOWNS = [
  { name: "Brookfield", url: "https://brookfieldnh.org" },
  { name: "Chatham", url: "https://www.chathamnh.org" },
  { name: "Eaton", url: "https://eatonnh.org" },
  { name: "Freedom", url: "https://freedomnh.org" },
  { name: "Jackson", url: "https://www.jackson-nh.gov" },
  { name: "Ossipee", url: "https://www.ossipee.org" },
  { name: "Sandwich", url: "https://sandwichnh.org" },
  { name: "Tuftonboro", url: "https://www.tuftonboronh.gov" },
  { name: "Wakefield", url: "https://www.wakefieldnh.gov" },
  { name: "Wolfeboro", url: "https://wolfeboronh.us" },
];

async function investigateTown(town: { name: string; url: string }) {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  
  console.log(`\n${"=".repeat(70)}`);
  console.log(`${town.name.toUpperCase()}: ${town.url}`);
  console.log("=".repeat(70));
  
  try {
    await page.goto(town.url, { waitUntil: "domcontentloaded", timeout: 15000 });
    await page.waitForTimeout(2000);
    
    // Check for CMS indicators
    const cmsInfo = await page.evaluate(() => {
      const html = document.documentElement.outerHTML;
      const indicators: string[] = [];
      
      // CMS detection
      if (html.includes('civicplus') || html.includes('CivicPlus')) indicators.push('CivicPlus');
      if (html.includes('towncloud') || html.includes('TownCloud')) indicators.push('TownCloud');
      if (html.includes('wordpress') || html.includes('wp-content')) indicators.push('WordPress');
      if (html.includes('drupal')) indicators.push('Drupal');
      if (html.includes('joomla')) indicators.push('Joomla');
      if (html.includes('wix.com')) indicators.push('Wix');
      if (html.includes('squarespace')) indicators.push('Squarespace');
      if (html.includes('revize')) indicators.push('Revize');
      if (html.includes('granicus')) indicators.push('Granicus');
      
      return indicators;
    });
    
    console.log(`CMS: ${cmsInfo.length > 0 ? cmsInfo.join(', ') : 'Unknown/Custom'}`);
    
    // Look for document-related links
    const docLinks = await page.evaluate(() => {
      const keywords = ['document', 'minute', 'agenda', 'form', 'ordinance', 'download', 'pdf'];
      const links: { text: string; href: string }[] = [];
      
      document.querySelectorAll('a[href]').forEach(link => {
        const text = (link.textContent || '').toLowerCase().trim();
        const href = link.getAttribute('href') || '';
        
        if (keywords.some(kw => text.includes(kw) || href.toLowerCase().includes(kw))) {
          links.push({ text: text.substring(0, 50), href });
        }
      });
      
      return links.slice(0, 10);
    });
    
    console.log(`Found ${docLinks.length} document-related links:`);
    docLinks.forEach(link => {
      console.log(`  - "${link.text}" → ${link.href}`);
    });
    
    // Check for iframes (external embeds)
    const iframes = await page.evaluate(() => {
      const frames: string[] = [];
      document.querySelectorAll('iframe').forEach(iframe => {
        const src = iframe.getAttribute('src');
        if (src) frames.push(src);
      });
      return frames;
    });
    
    if (iframes.length > 0) {
      console.log(`Iframes found (${iframes.length}):`);
      iframes.forEach(src => console.log(`  - ${src}`));
    }
    
  } catch (error: any) {
    console.log(`ERROR: ${error.message}`);
  }
  
  await browser.close();
}

async function main() {
  console.log("INVESTIGATING ZERO-DOCUMENT TOWNS\n");
  
  for (const town of ZERO_TOWNS) {
    await investigateTown(town);
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
}

main().catch(console.error);
