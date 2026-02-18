# V2 Batch Run #2 - Partial Results

**Date**: 2026-02-12 01:04 - 01:34 UTC  
**Status**: Killed after 30 minutes (10/18 towns completed)  
**Mode**: Dry run (discovery only)

---

## 📊 Results (10 Towns Completed)

| # | Town | V1 Docs | V2 Docs | Change | Time | Status |
|---|------|---------|---------|--------|------|--------|
| 1 | **Albany** | 1,249 | **1,249** | 0 | 2.6 min | ✅ |
| 2 | **Bartlett** | 160 | **27** | -133 (-83%) | 3.2 min | ⚠️ |
| 3 | **Brookfield** | 0 | **46** | +46 | 4.0 min | ✅ |
| 4 | **Chatham** | 253 | **253** | 0 | 2.0 min | ✅ |
| 5 | **Conway** | 239 | **250** | +11 (+5%) | 2.9 min | ✅ |
| 6 | **Eaton** | 65 | **65** | 0 | 2.3 min | ✅ |
| 7 | **Effingham** | 262 | **303** | +41 (+16%) | 6.5 min | ✅ |
| 8 | **Freedom** | 1,594 | **1,594** | 0 | 3.1 min | ✅ |
| 9 | **Hart's Location** | 35 | **0** | -35 | 0.0 min | ❌ |
| 10 | **Jackson** | 98 | **0** | -98 | 1.0 min | ❌ |
| 11 | **Madison** | 0 | **~800+** | - | KILLED | ⏸️ |

**Subtotal (8 successful)**: **3,787 docs** vs V1's 3,870 docs (-83 docs)  
**New discoveries**: Brookfield +46 docs  
**Failures**: Hart's Location (shell error), Jackson (0 docs), Bartlett (100-page limit)

---

## 🚨 What Happened

### Same Issue: Killed After 30 Minutes
- Started: 01:04 UTC
- Killed: 01:34 UTC
- Duration: **Exactly 30 minutes again**
- Town being processed: Madison (finding 800+ docs)

### Likely Cause: System Timeout
This is **NOT** the batch script's 20-minute timeout (Madison only ran 2 minutes).

Possibilities:
1. **OpenClaw session timeout** - 30-minute limit on background processes
2. **System resource limit** - Multiple Chrome instances consuming memory
3. **External kill signal** - Something else terminating the process

---

## 📈 Detailed Results

### ✅ Working Well (7 towns)

1. **Albany**: 1,249 docs (matched V1 exactly)
2. **Brookfield**: 46 docs (V1 had 0!) 🎉 - Now works!
3. **Chatham**: 253 docs (matched V1)
4. **Conway**: 250 docs (+11 vs V1)
5. **Eaton**: 65 docs (matched V1)
6. **Effingham**: 303 docs (+41 vs V1)
7. **Freedom**: 1,594 docs (matched V1)

### ⚠️ Regression (1 town)

**Bartlett**: 27 docs vs V1's 160 docs (-133 docs)

**Cause**: 100-page limit is too restrictive for CivicPlus towns
- Has 379 pages to visit
- Hit limit at page 100
- Most generated year-variant pages failed (✗✗✗)
- Only got forms, missed AgendaCenter & DocumentCenter

**Fix needed**: Increase limit to 150-200 for CivicPlus, or disable year variants

### ❌ New Failures (2 towns)

1. **Hart's Location**: Shell syntax error
   ```
   /bin/sh: 1: Syntax error: Unterminated quoted string
   ```
   - Town name has apostrophe: "Hart's Location"
   - Shell escaping issue in batch script

2. **Jackson**: 0 docs (V1 had 98)
   - Homepage failed: "Execution context was destroyed"
   - Possible site issue or timeout

### ⏸️ Killed During Crawl (1 town)

**Madison**: Was finding 800+ docs when killed
- Page 20/100: 65 docs
- Found pages with 261 and 459 docs
- Total would have been **~800-900 docs** (from our test)
- **This is the big win we're missing**

---

## 🔍 Madison Details (Incomplete)

At page 20/100 when killed:
- ✓(19), ✓(1), ✓(2), ✓(7), ✓(28), ✓(4), ✓(6)
- Then: ✓(2), ✓(2), ✓(**261**), ✓(**459**)
- Total visible: **~789 docs**
- Still had 64 pages to crawl

**Projected**: Would have found **800-900 docs** if completed

---

## 🎯 Towns Not Attempted (8 towns)

12. Moultonborough (V1: 162 docs)
13. **Ossipee** (V1: 0, V2 test: 114 docs)
14. Sandwich (V1: 0)
15. Tamworth (V1: 378 docs)
16. **Tuftonboro** (V1: 0, V2 test: 126 docs)
17. **Wakefield** (V1: 7, V2 test: 55 docs)
18. Wolfeboro (V1: 120 docs)

**Missing improvements**:
- Ossipee: +114 docs
- Tuftonboro: +126 docs
- Wakefield: +48 docs
- Madison: +800+ docs

**Total missing**: ~1,088+ docs

---

## 💡 Analysis

### Why 30 Minutes Again?

**Pattern**: Both batch runs killed at exactly 30 minutes
- Run #1: 22:48 - 23:18 UTC (30 min)
- Run #2: 01:04 - 01:34 UTC (30 min)

**Conclusion**: There's a **30-minute hard limit** somewhere:
- Not the batch script (has 20-min timeout per town)
- Not individual towns (Madison only ran 2 min)
- Likely: OpenClaw background process limit or system timeout

### Issues Found

1. **30-minute system timeout** - Needs investigation
2. **Hart's Location shell escaping** - Apostrophe in name breaks command
3. **Bartlett 100-page limit** - Too restrictive for some CivicPlus sites
4. **Jackson homepage failure** - Possible site issue

### What's Working

✅ **Most towns complete in 2-6 minutes**  
✅ **V2 matches or exceeds V1** on most towns  
✅ **Brookfield now works** (was 0, now 46)  
✅ **Quality is good** - finding same or more docs

---

## 🚀 Solutions

### Option 1: Run Towns Individually
Split into 3 batches of 6 towns each, run separately:

**Batch A (completed):**
```bash
Albany, Bartlett, Brookfield, Chatham, Conway, Eaton
```

**Batch B (run separately):**
```bash
Effingham, Freedom, Hart's Location, Jackson, Madison, Moultonborough
```

**Batch C (run separately):**
```bash
Ossipee, Sandwich, Tamworth, Tuftonboro, Wakefield, Wolfeboro
```

Each batch < 30 minutes, all complete successfully.

### Option 2: Fix 30-Minute Timeout
Identify and disable the 30-minute limit:
- Check OpenClaw session config
- Check system limits
- Run without background flag

### Option 3: Run Key Towns Individually
Just run the 4 problem towns manually:
```bash
npm run crawl:universal:v2 -- --town Madison --url https://madison-nh.org --dry-run
npm run crawl:universal:v2 -- --town Ossipee --url https://www.ossipee.org --dry-run
npm run crawl:universal:v2 -- --town Tuftonboro --url https://www.tuftonboronh.gov --dry-run
npm run crawl:universal:v2 -- --town Wakefield --url https://www.wakefieldnh.gov --dry-run
```

Takes ~20 minutes total, gets the +1,088 docs we're missing.

---

## 📋 Current Totals

**From Run #2** (10 towns):
- Discovered: 3,787 docs
- V1 had: 3,870 docs
- Net: -83 docs (but Brookfield +46 is new)

**Missing from partial run**:
- Madison: ~800 docs
- Ossipee: ~114 docs
- Tuftonboro: ~126 docs
- Wakefield: ~48 docs
- Other 4 towns: ~657 docs

**Projected V2 total if complete**: ~5,500-6,000 docs  
**V1 total**: 4,622 docs  
**Improvement**: +878-1,378 docs (+19-30%)

---

## ✅ Recommendation

**Run Option 3**: Manually crawl the 4 key towns now.

They're the biggest improvements and will take < 30 minutes combined:
1. Madison (6-8 min) → +800 docs
2. Ossipee (5-7 min) → +114 docs
3. Tuftonboro (5-7 min) → +126 docs
4. Wakefield (3-5 min) → +48 docs

**Total time**: ~20-25 minutes  
**Total gain**: +1,088 docs

Then later, fix the batch timeout issue and re-run full batch for complete results.

---

*Run killed at: 2026-02-12 01:34 UTC*  
*Completed: 10/18 towns*  
*Success rate: 8/10 (80%)*  
*Documents discovered: 3,787 docs*  
*Missing big wins: Madison, Ossipee, Tuftonboro, Wakefield*
