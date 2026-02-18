#!/usr/bin/env tsx
import { chromium } from 'playwright-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';

chromium.use(StealthPlugin());

async function main() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const baseUrl = 'https://moultonboroughnh.gov';
  
  console.log('🔍 Testing extraction logic on AgendaCenter\n');
  
  await page.goto('https://moultonboroughnh.gov/AgendaCenter', { 
    waitUntil: 'domcontentloaded',
    timeout: 15000 
  });
  
  console.log('⏳ Waiting 5s for JS...');
  await page.waitForTimeout(5000);
  
  // Run the EXACT extraction logic from the crawler
  const links = await page.evaluate((baseArg) => {
    const urls: string[] = [];
    const docExts = ['.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.txt', '.rtf'];
    const imageExts = ['.jpg', '.jpeg', '.png', '.gif', '.svg', '.webp', '.bmp'];
    const curr = window.location.href;
    
    // CivicPlus-specific: Extract from row structures
    const civicPlusRows = document.querySelectorAll('.catAgendaRow, .catDocumentRow, .catFormRow, [data-type="document"], [data-type="agenda"]');
    
    console.log(`[Browser] Found ${civicPlusRows.length} CivicPlus rows`);
    
    if (civicPlusRows.length > 0) {
      civicPlusRows.forEach((row, rowIdx) => {
        const rowLinks = row.querySelectorAll('a[href]');
        console.log(`[Browser] Row ${rowIdx}: ${rowLinks.length} links`);
        
        rowLinks.forEach((link, linkIdx) => {
          let href = link.getAttribute('href');
          if (!href || href.includes('PreviousVersions')) {
            console.log(`[Browser] Row ${rowIdx} Link ${linkIdx}: skipped (no href or PreviousVersions)`);
            return;
          }
          
          const originalHref = href;
          
          try {
            const u = new URL(href, curr);
            if (u.hostname !== new URL(baseArg).hostname) {
              console.log(`[Browser] Row ${rowIdx} Link ${linkIdx}: skipped (wrong hostname ${u.hostname})`);
              return;
            }
            href = u.href;
          } catch (e) {
            console.log(`[Browser] Row ${rowIdx} Link ${linkIdx}: URL parse error`);
            return;
          }
          
          // CivicPlus ViewFile links are always documents
          if (href.includes('/ViewFile/') || 
              (href.includes('/View/') && href.match(/\/\d+$/))) {
            console.log(`[Browser] Row ${rowIdx} Link ${linkIdx}: MATCHED ViewFile - ${href}`);
            urls.push(href);
          } else {
            console.log(`[Browser] Row ${rowIdx} Link ${linkIdx}: NO MATCH - ${href}`);
          }
        });
      });
      
      console.log(`[Browser] Total extracted from CivicPlus rows: ${urls.length}`);
    }
    
    return [...new Set(urls)];
  }, baseUrl);
  
  console.log(`\n✅ Extraction returned ${links.length} documents\n`);
  
  if (links.length > 0) {
    console.log('First 10 extracted:');
    links.slice(0, 10).forEach(link => console.log(`  ${link}`));
  } else {
    console.log('❌ NO DOCUMENTS EXTRACTED!\n');
    console.log('Check browser console logs above for details.');
  }
  
  await browser.close();
}

main().catch(console.error);
