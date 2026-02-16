# Smart Crawler Improvements - Round 2

Based on batch crawl analysis, implemented 5 critical fixes:

## 1. Fixed Thorough Mode Bug ✓
**Problem:** Strategy 2 (navigation) was skipped when homepage failed to load, even in `--thorough` mode.

**Impact:** 4 towns (Brookfield, Ossipee, Sandwich, Tuftonboro) stopped after Strategy 1 with 0 docs.

**Fix:** 
- In thorough mode, try to load homepage again before running navigation
- If still fails, proceed with sitemap strategy
- Remove `homepageLoaded` requirement when `--thorough` is enabled

## 2. Improved WordPress Menu Extraction ✓
**Problem:** Madison (WordPress) extracted 0 navigation links despite successful CMS detection.

**Impact:** 1 town got 0 docs despite being a valid WordPress site.

**Fix:**
- Added aggressive menu expansion: hover, click, and force-display submenus
- Expanded selectors to include: `.sub-menu`, `.dropdown-menu`, `.submenu`, etc.
- Added fallback: if < 5 nav links found, extract all same-domain page links
- Increased wait time from 1s to 2s for menu animations

## 3. Enhanced Categorization ✓
**Problem:** 61% of documents categorized as "misc" - poor granularity.

**Impact:** Difficult to assess coverage quality (e.g., do we have meeting minutes or just forms?).

**Fix:** Added new categories:
- `warrants` (town warrants)
- `annual-reports` (town annual reports)
- `policies` (town policies)
- `tax-documents` (tax rates, tax info)
- Improved priority order (check specific first, generic last)

## 4. Better Cloudflare Handling ✓
**Problem:** Stealth plugin sometimes insufficient; some requests still blocked.

**Impact:** Tuftonboro went from 94 docs (earlier test) to 0 docs (batch).

**Fix:**
- Increased initial wait from 3s to 5s
- Added retry loop: 3 attempts × 10s each = 30s total wait
- Added network idle fallback after retries
- Better error logging (shows which attempt failed)

## 5. Added Sitemap Extraction (Strategy 2.5) ✓
**Problem:** Some sites store documents on pages not linked from navigation.

**Impact:** Missing documents that are in sitemap but not in menus.

**Fix:**
- New Strategy 2.5: Parse sitemap.xml
- Filter for promising URLs (document, minute, agenda, form, board, meeting)
- Visit up to 30 sitemap pages
- Extract documents from each
- Runs after navigation, or if navigation can't run

## Expected Results

### Zero-Doc Towns (Before):
- Brookfield: 0 → Should find docs if they exist
- Madison: 0 → Should find nav links now
- Ossipee: 0 → Should retry homepage and try sitemap
- Sandwich: 0 → Should try sitemap
- Tuftonboro: 0 → Should handle Cloudflare better

### Low Coverage Towns:
- Wakefield: 7 → Should improve with sitemap
- Hart's Location: 35 → Should improve with sitemap

### Category Distribution (Before):
- misc: 61% → Should drop to 40-50%
- minutes: 20%
- agendas: 11%

### Category Distribution (After):
- misc: 40-50% (reduced)
- minutes: 20%
- agendas: 11%
- annual-reports: ~5% (new)
- warrants: ~2% (new)
- tax-documents: ~1% (new)

## Testing Plan

1. Test Madison individually (WordPress menu fix)
2. Test Tuftonboro individually (Cloudflare + sitemap)
3. Re-run full batch with `--thorough`
4. Compare results
5. Analyze improvements
