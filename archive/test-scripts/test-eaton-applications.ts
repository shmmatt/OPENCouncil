import { chromium } from 'playwright';

async function test() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  
  await page.goto('https://www.eatonnh.gov/applications/', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2000);
  
  // Extract document links
  const docs = await page.evaluate(() => {
    const urls: string[] = [];
    const docExtensions = ['.pdf', '.doc', '.docx', '.xls', '.xlsx'];
    
    document.querySelectorAll('a[href]').forEach(link => {
      const href = link.getAttribute('href');
      const text = link.textContent?.trim() || '';
      
      if (href) {
        const lower = href.toLowerCase();
        if (docExtensions.some(ext => lower.includes(ext))) {
          urls.push(`"${text}": ${href}`);
        } else if (href.includes('/wp-content/uploads/')) {
          urls.push(`"${text}" (wp-uploads): ${href}`);
        }
      }
    });
    
    return urls;
  });
  
  console.log('Documents found on /applications/ page:');
  docs.forEach(doc => console.log(doc));
  console.log(`\nTotal: ${docs.length} documents`);
  
  await browser.close();
}

test().catch(console.error);
