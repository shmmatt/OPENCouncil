import { chromium } from "playwright";

async function investigateOssipee() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  
  console.log("Loading Ossipee homepage...");
  await page.goto("https://www.ossipee.org", { 
    waitUntil: "domcontentloaded", 
    timeout: 30000 
  });
  await page.waitForTimeout(3000); // Cloudflare bypass
  
  console.log("\nLooking for document-related links...");
  const links = await page.evaluate(() => {
    const keywords = ['document', 'minute', 'agenda', 'meeting', 'board'];
    const found: { text: string; href: string }[] = [];
    
    document.querySelectorAll('a[href]').forEach(link => {
      const text = (link.textContent || '').toLowerCase().trim();
      const href = link.getAttribute('href') || '';
      
      if (keywords.some(kw => text.includes(kw) || href.toLowerCase().includes(kw))) {
        found.push({ text: text.substring(0, 60), href });
      }
    });
    
    return found.slice(0, 15);
  });
  
  console.log(`Found ${links.length} relevant links:`);
  links.forEach((link, i) => {
    console.log(`${i + 1}. "${link.text}" → ${link.href}`);
  });
  
  // Try to visit a document page
  if (links.length > 0) {
    const testLink = links.find(l => l.href.includes('minutes') || l.href.includes('documents'));
    if (testLink) {
      console.log(`\nVisiting: ${testLink.href}`);
      
      try {
        await page.goto(testLink.href, { 
          waitUntil: "domcontentloaded", 
          timeout: 15000 
        });
        await page.waitForTimeout(2000);
        
        console.log("\nChecking for PDF links on this page...");
        const pdfLinks = await page.evaluate(() => {
          const pdfs: string[] = [];
          document.querySelectorAll('a[href]').forEach(link => {
            const href = link.getAttribute('href');
            if (href && (href.toLowerCase().includes('.pdf') || href.includes('/download/'))) {
              pdfs.push(href);
            }
          });
          return pdfs.slice(0, 10);
        });
        
        console.log(`Found ${pdfLinks.length} PDF/download links:`);
        pdfLinks.forEach(link => console.log(`  - ${link}`));
        
        // Check if links are direct or interstitial
        if (pdfLinks.length > 0) {
          const testPdf = pdfLinks[0];
          console.log(`\nTesting first link: ${testPdf}`);
          
          // Check if it's a full URL or relative
          let fullUrl = testPdf;
          if (!testPdf.startsWith('http')) {
            const baseUrl = new URL(page.url());
            fullUrl = new URL(testPdf, baseUrl.href).href;
          }
          
          console.log(`Full URL: ${fullUrl}`);
          
          // Try to follow it
          const response = await page.goto(fullUrl, { 
            waitUntil: "domcontentloaded",
            timeout: 10000 
          });
          
          await page.waitForTimeout(2000);
          
          const contentType = response?.headers()['content-type'] || 'unknown';
          const finalUrl = page.url();
          
          console.log(`Content-Type: ${contentType}`);
          console.log(`Final URL: ${finalUrl}`);
          
          if (contentType.includes('pdf')) {
            console.log("✓ Direct PDF link");
          } else if (contentType.includes('html')) {
            console.log("⚠ HTML page (likely interstitial)");
            
            // Look for actual PDF link on interstitial page
            const actualPdf = await page.evaluate(() => {
              const meta = document.querySelector('meta[http-equiv="refresh"]');
              if (meta) {
                const content = meta.getAttribute('content');
                if (content) {
                  const match = content.match(/url=([^'"]+)/);
                  if (match) return match[1];
                }
              }
              
              // Look for download button/link
              const downloadLink = document.querySelector('a[href*=".pdf"], a[href*="/download/"], button[onclick*=".pdf"]');
              if (downloadLink) {
                return downloadLink.getAttribute('href') || downloadLink.getAttribute('onclick');
              }
              
              return null;
            });
            
            if (actualPdf) {
              console.log(`Found actual PDF on interstitial: ${actualPdf}`);
            }
          }
        }
        
      } catch (error: any) {
        console.log(`Error visiting page: ${error.message}`);
      }
    }
  }
  
  await browser.close();
}

investigateOssipee().catch(console.error);
