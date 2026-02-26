import { chromium } from 'playwright';

async function test() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  
  await page.goto('https://www.eatonnh.gov', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2000);
  
  // Expand WordPress menus
  await page.evaluate(() => {
    document.querySelectorAll('.menu-item-has-children, .menu > li, nav li').forEach(item => {
      if (item instanceof HTMLElement) {
        item.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
        item.classList.add('hover', 'focus', 'active');
      }
    });
  });
  
  await page.waitForTimeout(1000);
  
  // Extract all links
  const links = await page.evaluate(() => {
    const allLinks: string[] = [];
    document.querySelectorAll('a[href]').forEach(link => {
      const href = link.getAttribute('href');
      const text = link.textContent?.trim() || '';
      if (href) {
        allLinks.push(`${text}: ${href}`);
      }
    });
    return allLinks;
  });
  
  console.log('All links found:');
  links.forEach(link => console.log(link));
  
  await browser.close();
}

test().catch(console.error);
