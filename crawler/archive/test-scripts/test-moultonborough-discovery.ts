#!/usr/bin/env tsx
/**
 * Test Moultonborough discovery to understand why only 1 doc found
 */

import { chromium } from 'playwright';

async function test() {
  console.log('Testing Moultonborough document discovery...\n');
  
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });
  
  const page = await browser.newPage({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    viewport: { width: 1920, height: 1080 }
  });
  
  // Test homepage
  console.log('1. Testing homepage...');
  try {
    await page.goto('https://moultonboroughnh.gov', { 
      waitUntil: 'domcontentloaded', 
      timeout: 15000 
    });
    console.log('   ✅ Homepage loaded');
    console.log('   URL:', page.url());
    console.log('   Title:', await page.title());
  } catch (error) {
    console.log('   ❌ Homepage failed:', error instanceof Error ? error.message : 'Unknown');
  }
  
  // Test a few sitemap URLs
  console.log('\n2. Testing sitemap URLs...');
  const testUrls = [
    'https://moultonboroughnh.gov/AgendaCenter',
    'https://moultonboroughnh.gov/DocumentCenter',
    'https://moultonboroughnh.gov/FormCenter',
  ];
  
  for (const url of testUrls) {
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 10000 });
      
      // Look for document links
      const docLinks = await page.$$eval('a[href*=".pdf"], a[href*="/Document/"], a[href*="/download/"]', 
        links => links.map(a => (a as HTMLAnchorElement).href)
      );
      
      console.log(`   ${url}`);
      console.log(`      Found ${docLinks.length} document links`);
      if (docLinks.length > 0) {
        console.log(`      Examples: ${docLinks.slice(0, 3).join(', ')}`);
      }
    } catch (error) {
      console.log(`   ❌ ${url}: ${error instanceof Error ? error.message : 'Unknown'}`);
    }
  }
  
  // Test actual document URL
  console.log('\n3. Testing specific document URL...');
  const testDocUrl = 'https://moultonboroughnh.gov/AgendaCenter/ViewFile/Agenda/_05202024-1609';
  try {
    const response = await page.goto(testDocUrl, { waitUntil: 'domcontentloaded', timeout: 10000 });
    console.log('   Status:', response?.status());
    console.log('   Content-Type:', response?.headers()['content-type']);
    
    const content = await page.content();
    const isPdf = content.includes('%PDF') || response?.headers()['content-type']?.includes('pdf');
    console.log('   Is PDF:', isPdf);
  } catch (error) {
    console.log('   ❌ Failed:', error instanceof Error ? error.message : 'Unknown');
  }
  
  await browser.close();
  console.log('\n✅ Test complete');
}

test().catch(console.error);
