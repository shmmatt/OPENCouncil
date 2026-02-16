# Efficiency Improvements for Full County Crawl

**Date**: 2026-02-13  
**Context**: Jackson test successful (399 docs, 17 min), preparing for full county re-crawl

---

## 📊 Jackson Test Analysis

**Metrics:**
- Runtime: 17 minutes
- Pages visited: 240 (exceeded 200 limit)
- Docs discovered: 399 (vs 105 baseline, 280% improvement)
- Upload success: 96% (385/399)
- Failures: 4 (1% - all WordPress `/files/` attachment URLs)

**Insights:**
- Sitemap fix works perfectly (8 → 1,008 URLs)
- 200 page limit is appropriate (Jackson needed 240, but got majority)
- Minimal failures (1%)
- State tracking working correctly

---

## 🚀 Improvements for Full Crawl

### 1. Increase Page Limit ✅
**Current**: `--max-pages 100` (batch mode)  
**Proposed**: `--max-pages 200`  

**Rationale:**
- Jackson test showed 240 pages needed for full coverage
- Most towns have <200 pages in sitemap
- Larger towns (Albany, Freedom, Madison) likely need 200+

**Implementation:**
```typescript
// batch-universal-v2-crawler.ts line 87
'--max-pages',
'200', // Was 100
```

### 2. Smart Town Ordering 🆕
**Current**: Alphabetical order  
**Proposed**: Small towns first, large towns last

**Rationale:**
- Get quick wins early
- Large towns (Albany, Freedom, Madison) take longer
- Better progress visibility

**Implementation:**
```typescript
// Sort by sitemap size (from database)
const orderedTowns = await getTownsSortedBySize(); // Ascending
```

### 3. Increase Timeout for Large Towns ✅
**Current**: 20 minutes for all towns  
**Proposed**: 30 minutes for WordPress towns, 20 for others

**Rationale:**
- WordPress towns have more URLs (1,000+ vs 300)
- Jackson took 17 min for 399 docs
- Large WordPress towns (Albany, Freedom) might need 25-30 min

**Implementation:**
```typescript
const timeout = isWordPress ? 30 * 60 * 1000 : 20 * 60 * 1000;
```

### 4. Parallel Town Processing 🆕
**Current**: Sequential (one town at a time)  
**Proposed**: 2 towns in parallel

**Rationale:**
- CPU/network underutilized with sequential processing
- 2 parallel = ~50% time savings
- 3+ might cause resource contention

**Implementation:**
```typescript
// Run in batches of 2
for (let i = 0; i < towns.length; i += 2) {
  await Promise.allSettled([
    crawlTown(towns[i]),
    crawlTown(towns[i + 1]),
  ]);
}
```

**Risk**: Browser resource contention (2 Playwright instances)  
**Mitigation**: Monitor first batch, reduce to sequential if issues

### 5. Skip Hart's Location 🆕
**Current**: Included in batch  
**Proposed**: Skip (has known shell escaping bug)

**Rationale:**
- Shell escaping bug not yet fixed
- Will fail and waste time
- Fix separately, manual crawl later

**Implementation:**
```typescript
const towns = CARROLL_COUNTY_TOWNS.filter(t => t.name !== "Hart's Location");
```

### 6. Better Progress Reporting 🆕
**Current**: Basic console output  
**Proposed**: Running totals + ETA

**Implementation:**
```typescript
console.log(`\n📊 Progress: ${completed}/${total} towns`);
console.log(`   Docs discovered: ${totalDocs.toLocaleString()}`);
console.log(`   Time elapsed: ${elapsed.toFixed(1)} min`);
console.log(`   ETA: ${eta.toFixed(0)} min remaining`);
```

---

## 🎯 Priority Improvements

### Must Have (implement now):
1. ✅ Increase page limit to 200
2. ✅ Increase timeout to 30 min for WordPress
3. ✅ Skip Hart's Location

### Nice to Have (implement if time):
4. 🔄 Smart town ordering
5. 🔄 Better progress reporting

### Future Optimization (not now):
6. ⏸️ Parallel processing (needs testing)

---

## 📝 Implementation Plan

### Step 1: Update Batch Crawler
```bash
# Edit scripts/batch-universal-v2-crawler.ts
- Line 87: Change max-pages 100 → 200
- Line 101: Add CMS-aware timeout (20 → 30 for WordPress)
- Line 27: Filter out Hart's Location
```

### Step 2: Test Single Large Town
```bash
# Test on Albany (large WordPress, 2,198 docs in S3)
npm run crawl:universal:v2 -- --town Albany --url https://albanynh.org --max-pages 200
```

### Step 3: Run Full Batch
```bash
npm run crawl:universal:v2:batch
```

**Expected metrics:**
- Towns: 17/18 (excluding Hart's)
- Total time: ~5-6 hours (17 towns × 20 min avg)
- Docs discovered: ~9,000+ (target: 10,000)
- Success rate: 94%+ (16/17 towns)

### Step 4: Verify Results
```bash
npm run state:inspect -- --all
npm run verify:s3 -- --all
```

---

## 🔮 Expected Outcomes

### Before (with bug):
- WordPress towns: 0 docs
- Total discovered: ~3,500 (non-WordPress only)
- Coverage: ~35%

### After (with fix):
- WordPress towns: 6,000+ docs
- Total discovered: 9,000-10,000 docs
- Coverage: 90-95%

### By CMS:
- WordPress (9 towns): 0 → 6,000+ docs
- CivicPlus (4 towns): 2,390 docs (no change)
- Custom (5 towns): 1,091 docs (no change)

---

## 🧪 Testing Strategy

### Option A: Test One More Large Town (Albany)
**Pros:**
- Validates fix on largest WordPress site
- Identifies any issues before batch
- Albany has 2,198 docs in S3 (baseline)

**Cons:**
- Adds 30 min to timeline
- Delays full batch

### Option B: Run Full Batch Immediately
**Pros:**
- Faster to completion
- Jackson test already validated fix
- Can resume if issues occur

**Cons:**
- Risk of batch-wide issues
- Harder to diagnose problems

**Recommendation**: **Option B** - Jackson test was thorough, fix is solid, batch has checkpoint/resume

---

## 💡 Additional Insights

### WordPress `/files/` Attachment URLs
**Issue**: 4 failures in Jackson, all `/files/` URLs without `.pdf` extension  
**Example**: `https://www.jackson-nh.gov/zoning-board-adjustment/files/variance-application-2024-0`  
**Fix needed**: Follow redirects, detect final filename from Content-Disposition header  
**Priority**: Low (1% failure rate acceptable for now)

### Page Visit Efficiency
**Observation**: Jackson visited 240 pages but only found docs on ~20% (48 pages)  
**Improvement**: Could skip pages without document links (save time)  
**Implementation**: After sitemap parsing, pre-filter URLs to only those likely to have docs  
**Priority**: Medium (would save ~50% of page visits)

### Checkpoint Frequency
**Current**: Every 20 pages  
**Observation**: Worked perfectly (no data loss)  
**Change needed**: None - frequency is appropriate

---

## 📋 Implementation Checklist

- [ ] Update batch crawler page limit (100 → 200)
- [ ] Add CMS-aware timeout (WordPress: 30 min)
- [ ] Filter out Hart's Location
- [ ] (Optional) Test Albany before full batch
- [ ] Run full county batch crawl
- [ ] Monitor progress (check logs every 30 min)
- [ ] Verify results with state:inspect and verify:s3
- [ ] Document final metrics

---

**Status**: Ready to implement  
**Next**: Update batch crawler, run full county crawl  
**Timeline**: ~6 hours for full batch  
**Expected result**: 9,000+ documents discovered (90%+ coverage)
