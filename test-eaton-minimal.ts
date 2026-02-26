import { chromium } from 'playwright';

async function test() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  
  console.log('Testing Eaton document extraction...\n');
  
  // Test 1: Visit applications page
  console.log('1. Visiting /applications/ page...');
  await page.goto('https://www.eatonnh.gov/applications/', { 
    waitUntil: 'domcontentloaded',
    timeout: 15000 
  });
  await page.waitForTimeout(2000);
  
  // Test 2: Extract documents using the EXACT same code from the crawler
  console.log('2. Extracting documents...');
  const docs = await page.evaluate((base) => {
    const urls: string[] = [];
    const docExtensions = ['.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.txt', '.rtf'];
    const currentUrl = window.location.href;
    
    function makeAbsolute(href) {
      if (!href || href.startsWith('#') || href.startsWith('javascript:') || 
          href.startsWith('mailto:') || href.startsWith('tel:')) {
        return null;
      }
      
      try {
        const url = new URL(href, currentUrl);
        const baseHost = new URL(base).hostname;
        if (baseHost !== url.hostname) return null;
        return url.href;
      } catch (e) {
        return null;
      }
    }
    
    // Extract from <a> tags
    document.querySelectorAll('a[href]').forEach((link) => {
      const href = makeAbsolute(link.getAttribute('href')!);
      if (!href) return;
      
      const lower = href.toLowerCase();
      
      // Direct document extensions
      if (docExtensions.some((ext) => lower.includes(ext))) {
        urls.push(href);
        return;
      }
      
      // WordPress uploads directory
      if (href.includes('/wp-content/uploads/')) {
        urls.push(href);
        return;
      }
    });
    
    return urls;
  }, 'https://www.eatonnh.gov');
  
  console.log(`3. Found ${docs.length} documents\n`);
  
  if (docs.length > 0) {
    console.log('First 5 documents:');
    docs.slice(0, 5).forEach(doc => console.log(`   ${doc}`));
  } else {
    console.log('ERROR: No documents found! This should have found 32+ PDFs.');
  }
  
  await browser.close();
}

test().catch(console.error);
