# Crawler Sitemap Fix - Investigation & Solution

**Date**: 2026-02-13  
**Issue**: Jackson & Moultonborough showing 0 documents discovered in V2 crawls  
**Impact**: 9/18 towns (50%), 6,674/10,155 documents (66%)

---

## 🔍 Investigation Summary

### Initial Symptoms
- Jackson (WordPress): 105 docs in S3, but 0 found in recent crawl
- Moultonborough (CivicPlus): 263 docs in S3, but 0 found in recent crawl

### Root Cause Analysis

#### Problem 1: Sitemap Index Not Handled (WordPress)

**Current crawler behavior:**
```javascript
// scripts/universal-document-crawler-v2.ts (lines 210-227)
async function parseSitemap(baseUrl: string): Promise<string[]> {
  const xml = await response.text();
  const urlMatches = xml.matchAll(/<loc>(.*?)<\/loc>/g);
  const urls = Array.from(urlMatches).map(match => match[1]);
  return urls;
}
```

**What's wrong:**
- WordPress uses **sitemap indexes** (`/sitemap.xml` → points to sub-sitemaps)
- Current parser extracts ALL `<loc>` tags without checking if they're sub-sitemaps
- For Jackson: Returns 8 XML URLs instead of 1,008 actual page URLs
- Crawler visits XML files, finds no documents, marks run complete with 0 docs

**Example (Jackson):**
```
/sitemap.xml (sitemap index)
  ├── /wp-sitemap-posts-page-1.xml (88 page URLs) ← NEVER VISITED
  ├── /wp-sitemap-posts-post-1.xml (21 post URLs) ← NEVER VISITED
  └── /wp-sitemap-posts-tribe_events-1.xml (871 event URLs) ← NEVER VISITED
```

**Affected towns (9 WordPress sites, 6,674 documents):**
1. Albany: 2,198 docs
2. Freedom: 1,531 docs
3. Madison: 1,394 docs
4. Effingham: 572 docs
5. Tamworth: 462 docs
6. Chatham: 410 docs
7. Jackson: 105 docs
8. Sandwich: 2 docs
9. Hart's Location: 0 docs (also has other issues)

#### Problem 2: URL Tracking Not Recording Visits (CivicPlus?)

**Moultonborough symptom:**
- Sitemap parsed: 320 URLs
- `crawler_urls` table: **0 records**
- Crawler completed but never recorded URL visits

**Hypothesis:** Bug in `recordUrl()` state tracking or page visit loop

---

## ✅ Solution

### Fix 1: Recursive Sitemap Parser

**New implementation** (`scripts/sitemap-parser-improved.ts`):

**Key features:**
1. **Detect sitemap indexes**: Check for `<sitemapindex>` tag
2. **Recursive fetching**: Follow sub-sitemaps up to depth 3
3. **Filter XML URLs**: Exclude `.xml` files from final results
4. **Deduplication**: Remove duplicate URLs
5. **Visit tracking**: Prevent re-fetching same sitemap

**Results (tested):**
- **Jackson**: 8 URLs → **1,008 URLs** (12,600% improvement!)
- **Moultonborough**: 320 URLs → 320 URLs (already working)

**Implementation:**
```typescript
async function parseSitemapRecursive(
  url: string,
  visited = new Set<string>(),
  currentDepth = 0,
  maxDepth = 3
): Promise<SitemapResult> {
  if (currentDepth >= maxDepth || visited.has(url)) {
    return { urls: [], sitemapsProcessed: 0, depth: currentDepth };
  }
  
  visited.add(url);
  const xml = await response.text();
  
  if (xml.includes('<sitemapindex')) {
    // Recursively fetch sub-sitemaps
    const subSitemaps = extractLocTags(xml);
    const allUrls = await Promise.all(
      subSitemaps.map(sub => parseSitemapRecursive(sub, visited, currentDepth + 1, maxDepth))
    );
    return flatten(allUrls);
  } else {
    // Extract URLs, filter out .xml files
    const urls = extractLocTags(xml).filter(url => !url.endsWith('.xml'));
    return { urls, sitemapsProcessed: 1, depth: currentDepth };
  }
}
```

### Fix 2: Investigate URL Recording Bug

**Next steps:**
1. Add debug logging to `recordUrl()` in `crawlerState.ts`
2. Test Moultonborough crawl with verbose state logging
3. Check if issue is in state manager or crawler page loop
4. Verify `crawler_urls` table receives inserts

---

## 📊 Expected Impact

### Before Fix
- WordPress towns: 0 docs discovered on V2 crawls
- 6,674 documents invisible to incremental crawler
- Manual re-crawl required for all WordPress sites

### After Fix
- WordPress towns: Full sitemap coverage (1,000+ URLs per site)
- All documents discoverable on incremental crawls
- Sitemap diffing will detect new/removed pages

### Projected Document Discovery (Jackson test)
**Current state:**
- Sitemap: 8 XML URLs
- Pages visited: 0
- Documents found: 0

**With fix:**
- Sitemap: 1,008 page URLs
- Pages visited: ~200 (with --max-pages 200)
- Documents found: ~100-150 (based on S3 baseline of 105)

---

## 🚀 Implementation Plan

### Phase 1: Replace Sitemap Parser ✅ DONE
- [x] Build improved parser (`sitemap-parser-improved.ts`)
- [x] Test on Jackson (WordPress with index)
- [x] Test on Moultonborough (CivicPlus single sitemap)
- [ ] Replace `parseSitemap()` in `universal-document-crawler-v2.ts`
- [ ] Add npm script for testing: `npm run test:sitemap <url>`

### Phase 2: Test Single Town
- [ ] Run Jackson crawl with new parser (not dry-run)
- [ ] Verify documents discovered
- [ ] Check state tracking (URLs, documents, run stats)
- [ ] Compare results to S3 baseline (105 docs)

### Phase 3: Batch Re-Crawl WordPress Towns
- [ ] Run batch crawl on all 9 WordPress towns
- [ ] Verify document discovery rates
- [ ] Update town stats
- [ ] Compare to S3 baselines

### Phase 4: Investigate Moultonborough Bug
- [ ] Add debug logging to URL recording
- [ ] Run test crawl with verbose output
- [ ] Fix identified issue
- [ ] Re-test Moultonborough

### Phase 5: Generalize Improvements
**Other potential issues to investigate:**
1. **CivicPlus dynamic content**: Some pages may require JS rendering
2. **Document link patterns**: Are we catching all PDF/DOC links?
3. **Deep page limits**: Are 200 pages enough for large sites?
4. **Navigation fallback**: Does it trigger when needed?

---

## 🧪 Testing Strategy

### Test 1: Single Town (Jackson)
```bash
npm run crawl -- jackson --max-pages 200
npm run state:inspect -- jackson
npm run verify:s3 -- jackson
```

**Success criteria:**
- Documents discovered: >50 (target: 100-150)
- Sitemap URLs: >1000
- State recorded: URLs + documents + run
- S3 reconciliation: >80% match

### Test 2: WordPress Batch
```bash
# Create script: batch-wordpress-towns.ts
npm run batch:wordpress -- --max-pages 200
```

**Success criteria:**
- 8/9 towns successful (Hart's Location has other issues)
- Total documents discovered: >5,000 (target: 6,000+)
- Average documents per town: >600

### Test 3: Full Carroll County Re-Crawl
```bash
npm run batch:all -- --max-pages 200
```

**Success criteria:**
- 17/18 towns successful (Hart's Location)
- Total documents discovered: >9,000 (target: 10,000+)
- Improvement over V2 dry-run: +5,000 documents

---

## 📈 Success Metrics

### Immediate (Phase 1-2)
- [ ] Jackson: 0 → 100+ docs discovered
- [ ] Sitemap parser handles indexes correctly
- [ ] No regressions on non-WordPress towns

### Short-term (Phase 3-4)
- [ ] All WordPress towns finding documents
- [ ] Moultonborough URL recording fixed
- [ ] State management working across all CMS types

### Long-term (Phase 5)
- [ ] 95%+ document coverage across all towns
- [ ] Incremental crawler detects new documents weekly
- [ ] Zero manual intervention required

---

## 🔗 Related Files

**Implementation:**
- `scripts/sitemap-parser-improved.ts` - New recursive parser ✅
- `scripts/universal-document-crawler-v2.ts` - Main crawler (needs update)
- `server/services/crawlerState.ts` - State management

**Analysis:**
- `scripts/cms-analysis.ts` - Document counts by CMS
- `scripts/check-sitemap-urls.ts` - Sitemap URL inspection
- `scripts/verify-s3-state.ts` - S3 reconciliation

**Documentation:**
- `BATCH-STATE-POPULATION-RESULTS.md` - V2 dry-run results
- `V2-CRAWLER-README.md` - V2 design decisions
- `CRAWLER-ARCHITECTURE-PLAN.md` - Overall architecture

---

## 💡 Key Insights

1. **Sitemap indexes are common**: All 9 WordPress sites use them
2. **Simple regex is insufficient**: Need proper XML parsing logic
3. **Recursive fetching is essential**: WordPress can have 2-3 sitemap levels
4. **State tracking must be robust**: URL recording failure is silent
5. **Test problem towns first**: Faster iteration, better diagnosis

---

**Status**: Phase 1 complete, ready for Phase 2 testing  
**Next**: Replace `parseSitemap()` in crawler and test Jackson
