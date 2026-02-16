#!/usr/bin/env tsx
/**
 * Test playwright-extra with stealth plugin for Madison
 */

import { chromium } from 'playwright-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';

chromium.use(StealthPlugin());

async function test() {
  console.log('1. Launching browser with stealth...');
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });
  
  console.log('2. Creating page...');
  const page = await browser.newPage({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    viewport: { width: 1920, height: 1080 }
  });
  
  console.log('3. Going to Madison homepage...');
  try {
    await page.goto('https://madison-nh.org', { 
      waitUntil: 'domcontentloaded', 
      timeout: 30000 
    });
    console.log('4. ✅ Page loaded!');
    console.log('   URL:', page.url());
    console.log('   Title:', await page.title());
  } catch (error) {
    console.log('4. ❌ Failed:', error instanceof Error ? error.message : 'Unknown');
  }
  
  console.log('5. Closing...');
  await browser.close();
  console.log('6. ✅ Done!');
}

test().catch(console.error);
