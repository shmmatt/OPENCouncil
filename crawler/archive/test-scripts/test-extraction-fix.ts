#!/usr/bin/env tsx
/**
 * Test the fixed extraction logic
 */

import { chromium } from 'playwright-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';

chromium.use(StealthPlugin());

async function testExtraction(url: string) {
  console.log(`\nTesting: ${url}`);
  console.log('='.repeat(70));
  
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });
  
  const page = await browser.newPage({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    viewport: { width: 1920, height: 1080 }
  });
  
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
    await page.waitForTimeout(3000);
    
    // Use the fixed extraction logic
    const docs = await page.evaluate((baseArg) => {
      const urls = [];
      const curr = window.location.href;
      
      // CivicPlus-specific: Extract from row structures
      const civicPlusRows = document.querySelectorAll('.catAgendaRow, .catDocumentRow, .catFormRow');
      console.log(`Found ${civicPlusRows.length} CivicPlus rows`);
      
      if (civicPlusRows.length > 0) {
        civicPlusRows.forEach(row => {
          row.querySelectorAll('a[href]').forEach((link) => {
            let href = link.getAttribute('href');
            if (!href || href.includes('PreviousVersions')) return;
            
            try {
              const u = new URL(href, curr);
              if (u.hostname !== new URL(baseArg).hostname) return;
              href = u.href;
            } catch {
              return;
            }
            
            if (href.includes('/ViewFile/') || 
                (href.includes('/View/') && href.match(/\/\d+$/))) {
              urls.push(href);
            }
          });
        });
      }
      
      return [...new Set(urls)];
    }, url.split('/').slice(0, 3).join('/'));
    
    console.log(`✅ Found ${docs.length} unique documents`);
    
    if (docs.length > 0) {
      console.log('\nSample documents (first 10):');
      docs.slice(0, 10).forEach((doc, i) => {
        console.log(`  ${i+1}. ${doc}`);
      });
    }
    
    return docs.length;
    
  } catch (error) {
    console.log(`❌ Error: ${error instanceof Error ? error.message : 'Unknown'}`);
    return 0;
  } finally {
    await browser.close();
  }
}

async function main() {
  const results = await testExtraction('https://moultonboroughnh.gov/AgendaCenter');
  
  console.log('\n' + '='.repeat(70));
  console.log(`RESULT: ${results} documents extracted`);
  console.log('Expected: ~116 (from debug script)');
  console.log(results >= 50 ? '✅ PASS' : '❌ FAIL');
}

main().catch(console.error);
