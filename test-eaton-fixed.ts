import { chromium } from 'playwright';

async function test() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  
  console.log('Testing Eaton document extraction...\n');
  
  console.log('1. Visiting /applications/ page...');
  await page.goto('https://www.eatonnh.gov/applications/', { 
    waitUntil: 'domcontentloaded',
    timeout: 15000 
  });
  await page.waitForTimeout(2000);
  
  console.log('2. Extracting documents...');
  const docs = await page.evaluate((baseArg) => {
    const urls = [];
    const docExts = ['.pdf', '.doc', '.docx', '.xls', '.xlsx'];
    const curr = window.location.href;
    
    document.querySelectorAll('a[href]').forEach((link) => {
      let href = link.getAttribute('href');
      if (!href || href.startsWith('#') || href.startsWith('javascript:') || 
          href.startsWith('mailto:') || href.startsWith('tel:')) return;
      
      try {
        const u = new URL(href, curr);
        const bHost = new URL(baseArg).hostname;
        if (u.hostname !== bHost) return;
        href = u.href;
      } catch {
        return;
      }
      
      const low = href.toLowerCase();
      
      if (docExts.some(ext => low.includes(ext)) || href.includes('/wp-content/uploads/')) {
        urls.push(href);
      }
    });
    
    return [...new Set(urls)];
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
