#!/usr/bin/env tsx
/**
 * Test CivicPlus JS waiting and document extraction
 */

import { chromium } from 'playwright-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';

chromium.use(StealthPlugin());

async function extractWithJSWait(url: string) {
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
    // Load page
    console.log('1. Loading page...');
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
    console.log('   ✅ Page loaded');
    
    // Initial document count
    let docs = await page.$$eval('a[href*=".pdf"], a[href*="/ViewFile/"], a[href*="/Document/"]', 
      links => links.map(a => (a as HTMLAnchorElement).href)
    );
    console.log(`   Found ${docs.length} documents immediately`);
    
    // Wait for JS
    console.log('\n2. Waiting for JS rendering (3s)...');
    await page.waitForTimeout(3000);
    
    // Scroll to trigger lazy loading
    console.log('3. Scrolling to trigger lazy loading...');
    await page.evaluate(() => {
      window.scrollTo(0, document.body.scrollHeight);
    });
    await page.waitForTimeout(2000);
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(1000);
    
    // Click load more buttons
    console.log('4. Clicking "Load More" buttons...');
    const clicked = await page.evaluate(() => {
      const selectors = [
        'button',
        'a.load-more',
        '[class*="load-more"]',
        '[class*="show-more"]',
        '[class*="pagination"] a'
      ];
      
      let count = 0;
      selectors.forEach(sel => {
        document.querySelectorAll(sel).forEach(el => {
          const text = el.textContent?.toLowerCase() || '';
          if (text.includes('load') || text.includes('more') || text.includes('next')) {
            if (el instanceof HTMLElement) {
              try {
                el.click();
                count++;
              } catch {}
            }
          }
        });
      });
      return count;
    });
    console.log(`   Clicked ${clicked} buttons`);
    
    if (clicked > 0) {
      await page.waitForTimeout(3000);
    }
    
    // Final document count
    docs = await page.$$eval('a[href*=".pdf"], a[href*="/ViewFile/"], a[href*="/Document/"]', 
      links => links.map(a => (a as HTMLAnchorElement).href)
    );
    
    const uniqueDocs = Array.from(new Set(docs));
    console.log(`\n✅ Final result: ${uniqueDocs.length} unique documents`);
    
    if (uniqueDocs.length > 0) {
      console.log('\nSample documents:');
      uniqueDocs.slice(0, 10).forEach((doc, i) => {
        console.log(`  ${i+1}. ${doc}`);
      });
    }
    
    return uniqueDocs.length;
    
  } catch (error) {
    console.log(`\n❌ Error: ${error instanceof Error ? error.message : 'Unknown'}`);
    return 0;
  } finally {
    await browser.close();
  }
}

async function main() {
  const testUrls = [
    'https://moultonboroughnh.gov/AgendaCenter',
    'https://moultonboroughnh.gov/DocumentCenter',
    'https://www.wakefieldnh.gov/AgendaCenter',
  ];
  
  const results: Record<string, number> = {};
  
  for (const url of testUrls) {
    const count = await extractWithJSWait(url);
    results[url] = count;
    await new Promise(resolve => setTimeout(resolve, 2000));
  }
  
  console.log('\n' + '='.repeat(70));
  console.log('SUMMARY');
  console.log('='.repeat(70));
  Object.entries(results).forEach(([url, count]) => {
    console.log(`${url}: ${count} docs`);
  });
  
  const total = Object.values(results).reduce((a, b) => a + b, 0);
  console.log(`\nTotal: ${total} documents across all pages`);
}

main().catch(console.error);
