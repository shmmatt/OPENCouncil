#!/usr/bin/env tsx
import { chromium } from 'playwright-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';

chromium.use(StealthPlugin());

async function main() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  
  console.log('🔍 Testing: https://moultonboroughnh.gov/AgendaCenter\n');
  
  await page.goto('https://moultonboroughnh.gov/AgendaCenter', { 
    waitUntil: 'domcontentloaded',
    timeout: 15000 
  });
  
  console.log('⏳ Waiting 5s for JS to render...');
  await page.waitForTimeout(5000);
  
  // Check what's on the page
  const results = await page.evaluate(() => {
    const results: any = {};
    
    // Check for CivicPlus row structures
    results.catAgendaRow = document.querySelectorAll('.catAgendaRow').length;
    results.catDocumentRow = document.querySelectorAll('.catDocumentRow').length;
    results.catFormRow = document.querySelectorAll('.catFormRow').length;
    
    // Check for ViewFile links
    const viewFileLinks: string[] = [];
    document.querySelectorAll('a[href*="ViewFile"]').forEach((a) => {
      viewFileLinks.push((a as HTMLAnchorElement).href);
    });
    results.viewFileLinks = viewFileLinks.slice(0, 10); // First 10
    results.viewFileLinkCount = viewFileLinks.length;
    
    // Check for PDF links
    const pdfLinks: string[] = [];
    document.querySelectorAll('a[href*=".pdf"]').forEach((a) => {
      pdfLinks.push((a as HTMLAnchorElement).href);
    });
    results.pdfLinks = pdfLinks.slice(0, 10);
    results.pdfLinkCount = pdfLinks.length;
    
    // Get all links
    results.totalLinks = document.querySelectorAll('a[href]').length;
    
    // Sample first 20 links
    const sampleLinks: string[] = [];
    document.querySelectorAll('a[href]').forEach((a, idx) => {
      if (idx < 20) {
        sampleLinks.push((a as HTMLAnchorElement).href);
      }
    });
    results.sampleLinks = sampleLinks;
    
    return results;
  });
  
  console.log('\n📊 Page Analysis:\n');
  console.log(`  CivicPlus row selectors:`);
  console.log(`    .catAgendaRow: ${results.catAgendaRow}`);
  console.log(`    .catDocumentRow: ${results.catDocumentRow}`);
  console.log(`    .catFormRow: ${results.catFormRow}`);
  console.log(`\n  Document links:`);
  console.log(`    ViewFile links: ${results.viewFileLinkCount}`);
  console.log(`    PDF links: ${results.pdfLinkCount}`);
  console.log(`    Total links: ${results.totalLinks}`);
  
  if (results.viewFileLinks.length > 0) {
    console.log(`\n  Sample ViewFile links:`);
    results.viewFileLinks.forEach((link: string) => console.log(`    ${link}`));
  }
  
  if (results.pdfLinks.length > 0) {
    console.log(`\n  Sample PDF links:`);
    results.pdfLinks.forEach((link: string) => console.log(`    ${link}`));
  }
  
  console.log(`\n  First 20 links on page:`);
  results.sampleLinks.forEach((link: string) => console.log(`    ${link}`));
  
  await browser.close();
}

main().catch(console.error);
