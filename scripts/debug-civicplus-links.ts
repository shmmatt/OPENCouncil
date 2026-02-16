#!/usr/bin/env tsx
/**
 * Debug: What links are being extracted from CivicPlus pages?
 */

import { chromium } from 'playwright-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';

chromium.use(StealthPlugin());

async function debugLinks(url: string) {
  console.log(`\n${'='.repeat(70)}`);
  console.log(`Debugging: ${url}`);
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
    
    // Get ALL links
    const allLinks = await page.$$eval('a[href]', links => 
      links.map(a => ({
        href: (a as HTMLAnchorElement).href,
        text: a.textContent?.trim().substring(0, 50) || '',
        classes: a.className
      }))
    );
    
    console.log(`\nTotal links on page: ${allLinks.length}`);
    
    // Filter for document-like links
    const docPatterns = [
      /\.pdf$/i,
      /\/ViewFile\//i,
      /\/Document\//i,
      /\/DocumentCenter\//i,
      /\/AgendaCenter\//i
    ];
    
    const docLinks = allLinks.filter(link => 
      docPatterns.some(pattern => pattern.test(link.href))
    );
    
    console.log(`Document-like links: ${docLinks.length}\n`);
    
    if (docLinks.length > 0) {
      console.log('Sample document links:');
      docLinks.slice(0, 20).forEach((link, i) => {
        console.log(`${i+1}. ${link.href}`);
        console.log(`   Text: "${link.text}"`);
        console.log(`   Classes: ${link.classes}`);
      });
    }
    
    // Check for specific CivicPlus structures
    console.log('\nCivicPlus-specific elements:');
    
    const structures = {
      '.catAgendaRow': await page.$$('.catAgendaRow'),
      '[data-type="document"]': await page.$$('[data-type="document"]'),
      '.document-row': await page.$$('.document-row'),
      '.agenda-row': await page.$$('.agenda-row'),
      '[class*="document-link"]': await page.$$('[class*="document-link"]'),
      'table.catAgendaTable': await page.$$('table.catAgendaTable'),
    };
    
    for (const [selector, elements] of Object.entries(structures)) {
      if (elements.length > 0) {
        console.log(`   ${selector}: ${elements.length} elements found`);
      }
    }
    
  } catch (error) {
    console.log(`Error: ${error instanceof Error ? error.message : 'Unknown'}`);
  } finally {
    await browser.close();
  }
}

async function main() {
  const testUrls = [
    'https://moultonboroughnh.gov/AgendaCenter',
    'https://moultonboroughnh.gov/DocumentCenter',
    'https://moultonboroughnh.gov/',
  ];
  
  for (const url of testUrls) {
    await debugLinks(url);
    await new Promise(resolve => setTimeout(resolve, 2000));
  }
}

main().catch(console.error);
