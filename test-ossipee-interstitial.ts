import { chromium } from "playwright";

async function testInterstitial() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  
  const testUrl = "https://www.ossipee.org/board-of-selectmen/files/2022-employee-orginazation-chart-0";
  
  console.log(`Testing interstitial URL: ${testUrl}\n`);
  
  await page.goto(testUrl, { 
    waitUntil: "domcontentloaded", 
    timeout: 15000 
  });
  await page.waitForTimeout(3000);
  
  const contentType = page.url().endsWith('.pdf') ? 'PDF (direct)' : 'HTML (interstitial)';
  console.log(`Page type: ${contentType}`);
  console.log(`Final URL: ${page.url()}`);
  
  // Check for meta refresh or direct PDF link
  const pdfInfo = await page.evaluate(() => {
    // Check for meta refresh
    const meta = document.querySelector('meta[http-equiv="refresh"]');
    if (meta) {
      return { type: 'meta-refresh', content: meta.getAttribute('content') };
    }
    
    // Check for direct download link
    const downloadLink = document.querySelector('a[download], a[href*=".pdf"]');
    if (downloadLink) {
      return { 
        type: 'download-link', 
        href: downloadLink.getAttribute('href'),
        text: downloadLink.textContent?.trim()
      };
    }
    
    // Check if we're already on a PDF
    if (document.contentType === 'application/pdf') {
      return { type: 'direct-pdf' };
    }
    
    // Look for iframe with PDF
    const iframe = document.querySelector('iframe[src]');
    if (iframe) {
      return { type: 'iframe', src: iframe.getAttribute('src') };
    }
    
    return { type: 'unknown', bodyText: document.body.innerText.substring(0, 200) };
  });
  
  console.log(`\nPDF info:`, JSON.stringify(pdfInfo, null, 2));
  
  // Try to get actual PDF URL
  if (pdfInfo.type === 'download-link' && pdfInfo.href) {
    let fullUrl = pdfInfo.href;
    if (!fullUrl.startsWith('http')) {
      const base = new URL(page.url());
      fullUrl = new URL(pdfInfo.href, base.href).href;
    }
    console.log(`\nActual PDF URL: ${fullUrl}`);
    
    // Test if it's really a PDF
    const response = await page.goto(fullUrl, { timeout: 10000 });
    const ct = response?.headers()['content-type'] || '';
    console.log(`Content-Type: ${ct}`);
    
    if (ct.includes('pdf')) {
      console.log("✓ Confirmed PDF");
    }
  }
  
  await browser.close();
}

testInterstitial().catch(console.error);
