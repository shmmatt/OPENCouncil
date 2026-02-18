# Universal Document Crawler V2 - Build Summary

**Date**: 2026-02-11  
**Status**: ✅ Built and ready for testing

## What Was Built

### 1. universal-document-crawler-v2.ts
Complete rewrite with all critical fixes from the audit:

#### ✅ Fix #1: Sitemap-First Strategy
- Fetches sitemap.xml **before** loading homepage
- Doesn't require browser (pure fetch)
- If homepage fails (Cloudflare), we already have sitemap URLs to visit
- Generates year variants (e.g., if sitemap has `/archive/2025`, generates 2015-2024)

#### ✅ Fix #2: Headful Mode for Cloudflare
- Launches in headless mode initially
- Tests for Cloudflare on first page load
- If detected, **relaunches in headful mode** (real visible browser)
- Cloudflare is less aggressive against real browsers
- Per-page Cloudflare handling: waits 15s per page if blocked

#### ✅ Fix #3: Better Nav Extraction with Fallback
- More aggressive menu expansion:
  - Hovers over menu items
  - Clicks ALL possible toggles (buttons, aria-expanded, etc.)
  - Force-displays hidden submenus
  - Waits 2 seconds for AJAX
- **Fallback**: If < 5 nav links found, scrapes ALL same-domain page links
- Solves Madison WordPress issue

#### ✅ Fix #4: Increased Page Limits
- Default: 200 pages (was 100)
- **Adaptive limit**: If finding lots of docs, extends by 50 pages automatically

#### ✅ Fix #5: Document Content Validation
- Validates downloaded files are actually documents
- Checks file signatures:
  - PDF: `%PDF`
  - Office docs: `PK` (zip signature)
  - HTML: Rejects (interstitial pages)
- Prevents uploading garbage to S3

#### ✅ Fix #6: Expanded Sitemap Patterns
- Recognizes multiple year patterns:
  - `/2024` (end of path)
  - `/2024/january` (year in middle)
  - `?year=2024` (query param)
- Generates variants for past 10 years

### 2. test-v2-crawler.ts
Test script for problematic towns:
- Madison (WordPress, 0 nav links)
- Ossipee (Cloudflare)
- Tuftonboro (Cloudflare)
- Wakefield (Cloudflare)
- Sandwich (homepage timeout)

Runs all 5 towns in sequence and reports results.

### 3. Updated package.json
- Fixed duplicate `crawl:smart` entry
- Added `crawl:universal:v2` command

---

## Usage

### Test Single Town
```bash
# Dry run (discovery only, no download)
npm run crawl:universal:v2 -- --town Madison --url https://madison-nh.org --dry-run

# Full crawl with download/upload
npm run crawl:universal:v2 -- --town Madison --url https://madison-nh.org

# Custom page limit
npm run crawl:universal:v2 -- --town Madison --url https://madison-nh.org --max-pages 300
```

### Test All Problem Towns
```bash
cd OPENCouncil
tsx scripts/test-v2-crawler.ts
```

This will test all 5 previously failed towns and show a summary.

---

## Expected Results

| Town | V1 Result | V2 Expected | Issue Fixed |
|------|-----------|-------------|-------------|
| **Madison** | 0 docs | 100+ docs | Nav extraction fallback |
| **Ossipee** | 0 docs | 50+ docs | Sitemap-first + headful mode |
| **Tuftonboro** | 0 docs | 30+ docs | Headful mode for Cloudflare |
| **Wakefield** | 0 docs | 20+ docs | Sitemap-first |
| **Sandwich** | 0 docs | 10+ docs | Sitemap fallback |

**Overall**: 5/5 towns should now return documents (previously 0/5)

---

## Key Improvements Summary

### Strategy Order (Critical)
**Before**: Homepage → Nav → Sitemap → Pages  
**After**: **Sitemap → Homepage → Nav → Pages**

If homepage fails, crawler still has sitemap URLs to work with.

### Cloudflare Handling (Critical)
**Before**: Wait 30s in headless mode  
**After**: Detect Cloudflare → **Relaunch in headful mode** (visible browser)

Cloudflare challenges are much easier in real browsers.

### Navigation Extraction (Critical)
**Before**: Extract from nav selectors, fail if 0 links  
**After**: Aggressive expansion + **fallback to all page links**

Solves sites where nav is hidden/dynamic.

### Robustness (Important)
- ✅ 200 page limit (was 100)
- ✅ Adaptive limit extends if finding lots of docs
- ✅ Document validation (rejects HTML interstitials)
- ✅ Multiple year pattern recognition
- ✅ Better error handling and logging

---

## Testing Plan

### Phase 1: Single Town Tests (Now)
1. **Madison** - Test nav extraction fallback
   ```bash
   npm run crawl:universal:v2 -- --town Madison --url https://madison-nh.org --dry-run
   ```
   Expected: 100+ docs

2. **Ossipee** - Test Cloudflare + sitemap-first
   ```bash
   npm run crawl:universal:v2 -- --town Ossipee --url https://www.ossipee.org --dry-run
   ```
   Expected: 50+ docs

3. **Tuftonboro** - Test headful mode
   ```bash
   npm run crawl:universal:v2 -- --town Tuftonboro --url https://www.tuftonboronh.gov --dry-run
   ```
   Expected: 30+ docs

### Phase 2: Batch Test (If Phase 1 Passes)
```bash
tsx scripts/test-v2-crawler.ts
```

Expected: 5/5 towns with documents

### Phase 3: Full Carroll County (If Phase 2 Passes)
- Create batch-universal-v2-crawler.ts
- Run all 18 Carroll County towns
- Compare with V1 results
- Target: 18/18 towns with documents (was 13/18)

---

## Success Criteria

After V2 implementation:
- ✅ **All 5 zero-doc towns** now return documents
- ✅ **Madison**: >100 docs (WordPress with visible PDFs)
- ✅ **Ossipee**: >50 docs (has extensive documents, just blocked)
- ✅ **18/18 Carroll County towns** with documents (currently 13/18)
- ✅ **No manual town-specific hacks** required

---

## Files Created/Modified

### Created
1. `scripts/universal-document-crawler-v2.ts` - Main crawler
2. `scripts/test-v2-crawler.ts` - Test suite
3. `CRAWLER-AUDIT.md` - Full audit analysis
4. `V2-CRAWLER-README.md` - This file

### Modified
1. `package.json` - Fixed duplicate entry, added v2 command

---

## Next Steps

1. **Test Madison** (easiest - WordPress, should work with fallback)
2. **Test Ossipee** (Cloudflare + sitemap-first)
3. **Test Tuftonboro** (hardest - persistent Cloudflare)
4. If all 3 pass → run full test suite
5. If full test passes → build batch crawler
6. Deploy to all Carroll County towns

---

## Rollback Plan

If V2 performs worse than V1:
- Keep V1 as default (`crawl:universal`)
- Use V2 only for specific problem towns
- Investigate which fix caused regression

---

## Cost Estimate

**Per town crawl** (headful mode):
- Time: 10-20 minutes
- Network: 100-500 MB
- Compute: Minimal (local browser)

**Full batch** (18 towns):
- Time: 3-6 hours
- Network: 2-8 GB
- Cost: $0 (local compute)

---

Ready to test! Start with Madison.
