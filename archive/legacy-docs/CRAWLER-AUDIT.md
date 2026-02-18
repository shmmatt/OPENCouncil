# Universal Document Crawler Audit
**Date**: 2026-02-11
**Auditor**: Marvin

## Current State
The `universal-document-crawler.ts` is closest to working correctly, but has specific fixable issues.

**Test results**:
- ✅ Eaton: 0 → 74 docs (WordPress) 
- ✅ Freedom: 1,498 → 1,595 docs (WordPress)
- ❌ Tuftonboro: 0 docs (Cloudflare blocked)
- ❌ Wakefield: 0 docs (Cloudflare blocked)
- ❌ Ossipee: 0 docs (Cloudflare blocked)
- ❌ Madison: 0 docs (WordPress, but 0 nav links extracted despite visible PDFs on homepage)
- ❌ Sandwich: 0 docs (homepage timeout)

## Critical Issues & Fixes

### 🔴 Issue #1: Strategy Order Wrong
**Problem**: Homepage → Nav Links → Sitemap → High-value paths
- If homepage fails to load (Cloudflare), navigation extraction gets 0 links
- Site crawl effectively stops even though sitemap might work

**Fix**: **Sitemap-first strategy**
```typescript
// NEW ORDER:
1. Try sitemap.xml FIRST (doesn't need browser, pure fetch)
2. Add sitemap URLs to visit queue
3. Then try homepage for nav links
4. If homepage blocked, we already have sitemap pages to visit
```

**Impact**: Solves towns where homepage is Cloudflare-blocked but sitemap works

---

### 🔴 Issue #2: Cloudflare Wait Strategy Insufficient
**Problem**: 
- Current: Wait 5s initially, then 3 retries × 10s = 30s total
- Tuftonboro still blocked after 30s
- Logic only waits on initial homepage, not per-page

**Fix A**: **Headless=false for Cloudflare sites**
```typescript
// Detect Cloudflare in first 5s
if (title.includes('just a moment')) {
  // Relaunch in headful mode
  await browser.close();
  browser = await chromium.launch({ headless: false });
  // Cloudflare is less aggressive against real browsers
}
```

**Fix B**: **Per-page Cloudflare handling**
```typescript
// In page visit loop, add Cloudflare detection
async function visitPageSafe(page, url) {
  await page.goto(url, ...);
  
  let title = await page.title();
  if (title.includes('just a moment')) {
    await sleep(15000); // Single long wait
    title = await page.title();
    if (title.includes('just a moment')) {
      return null; // Give up on this page
    }
  }
  
  return page;
}
```

**Fix C**: **Residential proxy rotation** (advanced)
- Use proxy service (Bright Data, Oxylabs)
- Costs $$$ but guaranteed to bypass Cloudflare

**Recommended**: Try Fix A (headful mode) first, then Fix B if that doesn't work

---

### 🟡 Issue #3: Madison Navigation Extraction Returns 0 Links
**Problem**: WordPress site with visible PDFs on homepage, but `extractAllNavigationLinks()` returns 0 links

**Possible causes**:
1. Menu is hidden/collapsed and click handlers aren't triggering
2. Menu uses different selectors than expected
3. Links are loaded via AJAX after page load

**Fix**: **More aggressive expansion + fallback**
```typescript
async function extractAllNavigationLinks(page: Page, baseUrl: string): Promise<string[]> {
  // Current code tries to expand menus...
  
  // ADD: Wait longer for AJAX
  await sleep(2000); // was 1000
  
  // ADD: Try clicking every possible toggle
  await page.evaluate(() => {
    // Click EVERYTHING that might be a menu toggle
    const toggles = [
      'button', '[role="button"]', '.toggle', '.expand',
      '[class*="menu"]', '[class*="nav"]', '[class*="toggle"]',
      '[aria-expanded="false"]', '[aria-haspopup]'
    ];
    
    toggles.forEach(sel => {
      document.querySelectorAll(sel).forEach(el => {
        if (el instanceof HTMLElement) {
          try { 
            el.click();
            el.dispatchEvent(new Event('click', { bubbles: true }));
          } catch {}
        }
      });
    });
  });
  
  await sleep(2000);
  
  // EXISTING: Extract from nav selectors
  const links = await page.evaluate(...);
  
  // ADD: Fallback - if < 5 links found, scrape ALL same-domain page links
  if (links.length < 5) {
    console.log('   Warning: Low nav link count, using fallback extraction');
    const allLinks = await page.evaluate((baseArg) => {
      const urls = [];
      document.querySelectorAll('a[href]').forEach(link => {
        const href = link.getAttribute('href');
        if (href && !href.startsWith('#') && !href.startsWith('mailto:')) {
          try {
            const u = new URL(href, window.location.href);
            if (u.hostname === new URL(baseArg).hostname) {
              // Exclude file extensions
              if (!u.pathname.match(/\.(pdf|jpg|png|gif|doc)$/i)) {
                urls.push(u.href);
              }
            }
          } catch {}
        }
      });
      return [...new Set(urls)];
    }, baseArg);
    
    return allLinks;
  }
  
  return links;
}
```

---

### 🟡 Issue #4: Limited Page Visit Count (100 default)
**Problem**: Large towns (Freedom found 1,595 docs) might have documents spread across 200+ pages

**Fix**: **Increase default, make it adaptive**
```typescript
// OLD: --max-pages default = 100
// NEW: --max-pages default = 200, with adaptive limit

// If we're finding lots of docs, keep going
if (stats.discovered.size > 100 && pagesVisited >= maxPages) {
  console.log('   High doc count, extending page limit by 50');
  maxPages += 50;
}
```

---

### 🟡 Issue #5: No Verification That Documents Download
**Problem**: URLs might point to:
- JavaScript-generated PDFs
- Pages that require POST requests
- Interstitial pages with multiple redirects

**Fix**: **Add content-type validation**
```typescript
async function downloadDocument(...) {
  // ... existing download code ...
  
  // VERIFY downloaded file is actually a PDF/document
  if (localPath) {
    const buffer = await fs.readFile(localPath);
    const first4 = buffer.toString('utf8', 0, 4);
    
    // PDF signature: %PDF
    // ZIP signature (docx/xlsx): PK
    if (first4.startsWith('%PDF') || first4.startsWith('PK')) {
      return localPath;
    }
    
    // If it's HTML, we probably got an interstitial page
    if (buffer.toString('utf8', 0, 100).includes('<html')) {
      console.warn(`Warning: ${filename} appears to be HTML, not a document`);
      await fs.unlink(localPath);
      return null;
    }
    
    return localPath;
  }
  
  return null;
}
```

---

### 🟢 Issue #6: Sitemap Pattern Recognition Too Limited
**Problem**: Only generates year patterns from `/archive/YYYY` format

**Fix**: **Expand pattern recognition**
```typescript
// Recognize more patterns:
// /minutes/2024, /board/planning/2024, /documents/meeting/2024
const yearPatterns = [
  /\/(\d{4})\/?$/,           // /2024
  /\/(\d{4})\/[^\/]+$/,      // /2024/january
  /[?&]year=(\d{4})/         // ?year=2024
];

for (const url of sitemapUrls) {
  for (const pattern of yearPatterns) {
    const match = url.match(pattern);
    if (match) {
      // Generate variants
    }
  }
}
```

---

### 🟢 Issue #7: No Resume Capability
**Problem**: If crawler crashes on town 10/18, you have to restart from beginning

**Fix**: **State file tracking**
```typescript
// Before crawling, check state file
const stateFile = `./crawl-state/${town}.json`;
let visited = new Set();
let discovered = new Set();

try {
  const state = JSON.parse(await fs.readFile(stateFile, 'utf8'));
  visited = new Set(state.visited);
  discovered = new Set(state.discovered);
  console.log(`📂 Resuming: ${visited.size} pages visited, ${discovered.size} docs found`);
} catch {
  // Fresh start
}

// Periodically save state
if (pagesVisited % 10 === 0) {
  await fs.writeFile(stateFile, JSON.stringify({
    visited: Array.from(visited),
    discovered: Array.from(discovered),
    lastUpdate: new Date().toISOString()
  }));
}
```

---

## Recommended Implementation Order

### Phase 1: Critical Fixes (Do Now)
1. ✅ **Fix #1**: Sitemap-first strategy
2. ✅ **Fix #2**: Headful mode for Cloudflare
3. ✅ **Fix #3**: Better nav extraction with fallback

**Test on**: Ossipee (Cloudflare), Madison (0 nav links), Tuftonboro (Cloudflare)

### Phase 2: Robustness (Do Next)
4. ✅ **Fix #4**: Increase page limit to 200
5. ✅ **Fix #5**: Document content-type validation
6. ✅ **Fix #6**: Expanded sitemap patterns

**Test on**: Full Carroll County batch

### Phase 3: Production Ready (Do Before Statewide)
7. ✅ **Fix #7**: Resume capability
8. ✅ **Add**: Batch mode with parallel processing
9. ✅ **Add**: Error reporting and retry logic

---

## Success Criteria

After fixes, we should see:
- ✅ **Ossipee**: 0 → 50+ docs (has documents, just Cloudflare-blocked)
- ✅ **Madison**: 0 → 100+ docs (WordPress, should have minutes/forms)
- ✅ **Tuftonboro**: 0 → 30+ docs (small town, but has documents)
- ✅ **18/18 Carroll County towns** with >0 documents (unless truly empty)
- ✅ **Average 200+ docs per town** (currently ~257 average for successful towns)

---

## Files to Create/Modify

1. **scripts/universal-document-crawler-v2.ts** - Fixed version
2. **scripts/batch-universal-crawler.ts** - Batch runner
3. **scripts/test-cloudflare-towns.ts** - Test script for blocked towns
4. **crawl-state/** - State directory for resume capability

---

## Next Step

**Build `universal-document-crawler-v2.ts` with Phase 1 fixes**, then test on:
1. Madison (nav extraction)
2. Ossipee (Cloudflare + sitemap-first)
3. Tuftonboro (Cloudflare + headful)

Ready to implement?
