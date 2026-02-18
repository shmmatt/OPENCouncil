#!/usr/bin/env tsx
/**
 * Test extraction with EXACT same flow as the crawler
 */
import { chromium } from 'playwright-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import { Page } from 'playwright';

chromium.use(StealthPlugin());

async function extractDocumentLinks(page: Page, baseUrl: string, isCivicPlus: boolean): Promise<string[]> {
  const base = baseUrl.replace(/\/$/, '');
  
  // CivicPlus: Wait for JS
  if (isCivicPlus) {
    console.log('      [CivicPlus] Waiting for JS rendering...');
    await page.waitForTimeout(3000);
  }
  
  const links = await page.evaluate((baseArg) => {
    const urls: string[] = [];
    const curr = window.location.href;
    
    // CivicPlus-specific
    const civicPlusRows = document.querySelectorAll('.catAgendaRow, .catDocumentRow, .catFormRow');
    console.log(`[BROWSER] Found ${civicPlusRows.length} CivicPlus rows`);
    
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
          
          if (href.includes('/ViewFile/')) {
            urls.push(href);
          }
        });
      });
      
      console.log(`[BROWSER] Extracted ${urls.length} docs from CivicPlus rows`);
    }
    
    return [...new Set(urls)];
  }, base);
  
  return links;
}

async function main() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();
  
  // Forward browser console to our console
  page.on('console', msg => {
    if (msg.text().includes('[BROWSER]')) {
      console.log(msg.text());
    }
  });
  
  let baseUrl = 'https://moultonboroughnh.gov';
  
  console.log('🔍 Testing: Moultonborough AgendaCenter\n');
  console.log(`   Initial baseUrl: ${baseUrl}`);
  
  // Load homepage first (like the crawler does)
  console.log('\n📍 Loading homepage...');
  await page.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
  
  // Handle redirects
  const actualBaseUrl = page.url();
  const actualUrl = new URL(actualBaseUrl);
  const originalUrl = new URL(baseUrl);
  
  if (actualUrl.hostname !== originalUrl.hostname) {
    console.log(`   ⚠️  Redirect: ${originalUrl.hostname} → ${actualUrl.hostname}`);
    baseUrl = `${actualUrl.protocol}//${actualUrl.hostname}`;
  }
  
  console.log(`   Final baseUrl: ${baseUrl}`);
  
  // Now visit AgendaCenter
  console.log('\n📍 Loading AgendaCenter...');
  const agendaCenterUrl = `${baseUrl}/AgendaCenter`;
  await page.goto(agendaCenterUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
  
  console.log('   Page loaded, URL:', page.url());
  
  // Extract documents
  console.log('\n📥 Extracting documents...');
  const docs = await extractDocumentLinks(page, baseUrl, true);
  
  console.log(`\n✅ Result: ${docs.length} documents extracted\n`);
  
  if (docs.length > 0) {
    console.log('First 10:');
    docs.slice(0, 10).forEach(d => console.log(`  ${d}`));
  } else {
    console.log('❌ NO DOCUMENTS FOUND');
  }
  
  await browser.close();
}

main().catch(console.error);
