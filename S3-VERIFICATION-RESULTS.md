# S3 Verification Results - Complete ✅
**Date**: 2026-02-13  
**Tool**: `scripts/verify-s3-state.ts`  
**Command**: `npm run verify:s3 -- --all`

---

## 🎯 Executive Summary

**Total S3 Files**: **10,114** documents across 17 Carroll County towns  
**Database Records**: **41** (Brookfield test only)  
**Matched**: **0** (0%)  
**Orphans**: **10,114** (100%) - Files in S3, not in database  
**Missing**: **0** - Files in database, not in S3

---

## ✅ Expected Result

**This is the CORRECT state** given our architecture:

1. **Previous full crawl** uploaded ~10,000 documents to S3 (before state tracking)
2. **State tracking** added later (2026-02-12)
3. **Dry-run batch** populated sitemaps/runs but NOT individual document records
4. **Brookfield** has 41 records from our test crawl (but they don't match S3 keys)

**Result**: All S3 files are "orphans" because they predate the database tracking system.

---

## 📊 Results by Town

| Rank | Town | S3 Files | DB Records | Status |
|------|------|----------|------------|--------|
| 1 | **Albany** | 2,198 | 0 | 🟡 All orphans |
| 2 | **Conway** | 1,710 | 0 | 🟡 All orphans |
| 3 | **Freedom** | 1,531 | 0 | 🟡 All orphans |
| 4 | **Madison** | 1,394 | 0 | 🟡 All orphans |
| 5 | **Ossipee** | 640 | 0 | 🟡 All orphans |
| 6 | **Effingham** | 572 | 0 | 🟡 All orphans |
| 7 | **Tamworth** | 462 | 0 | 🟡 All orphans |
| 8 | **Chatham** | 410 | 0 | 🟡 All orphans |
| 9 | **Wolfeboro** | 291 | 0 | 🟡 All orphans |
| 10 | **Moultonborough** | 263 | 0 | 🟡 All orphans |
| 11 | **Eaton** | 166 | 0 | 🟡 All orphans |
| 12 | **Tuftonboro** | 146 | 0 | 🟡 All orphans |
| 13 | **Bartlett** | 126 | 0 | 🟡 All orphans |
| 14 | **Jackson** | 105 | 0 | 🟡 All orphans |
| 15 | **Wakefield** | 65 | 0 | 🟡 All orphans |
| 16 | **Brookfield** | 33 | 41 | 🔴 Mismatch |
| 17 | **Sandwich** | 2 | 0 | 🟡 All orphans |
| — | **Hart's Location** | — | 0 | ❌ Not in DB |

**Total**: **10,114 files** in S3

---

## 📁 S3 Content by Category

Top categories across all towns:

| Category | Files | Percentage |
|----------|-------|------------|
| **Minutes** | ~2,500 | 25% |
| **Misc** | ~4,000 | 40% |
| **Forms** | ~500 | 5% |
| **Agendas** | ~300 | 3% |
| **Reports** | ~200 | 2% |
| **Ordinances** | ~100 | 1% |
| **Budget** | ~100 | 1% |
| **Other** | ~2,400 | 23% |

**Note**: "Misc" is high due to aggressive categorization during initial crawl.

---

## 🔍 Notable Findings

### 1. Brookfield - Database Mismatch
- **S3**: 33 files
- **DB**: 41 records (from test crawl)
- **Issue**: Database records don't match S3 keys (different paths/naming)
- **Cause**: Test crawl used different S3 key format

### 2. Hart's Location - Not in Database
- Town not in `crawler_towns` table yet
- Shell escaping issue prevented crawl
- Needs manual entry or crawl fix

### 3. Sandwich - Minimal Content
- Only 2 files in S3 (likely test/garbage files)
- Site was unreachable during batch crawl
- Needs investigation

### 4. Albany & Freedom - Large Collections
- Albany: 2,198 docs (largest)
- Freedom: 1,531 docs
- High doc counts expected (populated towns)

---

## 🎯 What This Means

### ✅ Good News

1. **S3 is populated** - 10,000+ documents from previous crawl
2. **No missing files** - Nothing marked as uploaded that isn't in S3
3. **Verification tool works** - Can reconcile S3 vs DB anytime

### ⚠️ Current State

1. **Zero reconciliation** - Expected, since DB tracking came later
2. **No document-level tracking** - Can't query docs by category/year/board
3. **No deduplication** - Can't detect if we re-upload same doc

---

## 🚀 Path Forward (3 Options)

### Option A: Backfill Database from S3 ✅ **Recommended**

**What**: Create database records for all 10,114 existing S3 files

**How**:
1. Build `scripts/backfill-s3-to-db.ts`
2. For each S3 file:
   - Parse category, board, year from path
   - Calculate URL hash
   - Create `crawler_documents` record with `status='uploaded'`
3. Run on all towns

**Pros**:
- Complete historical record
- Enables deduplication
- Enables queries by category/year/board

**Cons**:
- Takes time (~30 min to process 10k records)
- S3 paths may not perfectly map to URL hashes

**Timeline**: 1 day

---

### Option B: Accept Orphans, Track New Only

**What**: Leave historical uploads as "orphans", only track new documents

**How**:
- Do nothing
- Next full crawl (not dry-run) will populate DB for new docs
- Historical docs remain untracked

**Pros**:
- Zero work required
- Simpler architecture

**Cons**:
- Can't query historical docs
- No deduplication for 10k existing docs
- Incomplete data

**Timeline**: Immediate

---

### Option C: Re-Crawl Everything (Full Mode)

**What**: Re-run full batch crawl without `--dry-run`

**How**:
1. Delete batch checkpoint
2. Run `npm run crawl:universal:v2:batch --resume --max-pages 100`
3. Crawler will:
   - Discover documents
   - Download if not in S3
   - Record each doc in database

**Pros**:
- Fresh, complete records
- Matches exactly what was crawled
- No parsing ambiguity

**Cons**:
- Takes 1.5-3 hours
- Re-downloads existing docs (wasteful)
- Network/bandwidth heavy

**Timeline**: 3 hours

---

## 💡 Recommendation: Option A (Backfill)

**Why**:
- Fast (30 min vs 3 hours)
- Efficient (no re-downloading)
- Complete historical record
- Enables all database queries

**Implementation**:
```bash
# Build the backfill script
npm run backfill:s3

# Run on all towns
npm run backfill:s3 -- --all

# Verify
npm run verify:s3 -- --all
```

**Expected outcome after backfill**:
- Total DB Records: 10,114
- Matched: 10,114 (100%)
- Orphans: 0
- Missing: 0

---

## 🛠️ Verification Tool Usage

**View single town**:
```bash
npm run verify:s3 -- conway
```

**View all towns**:
```bash
npm run verify:s3 -- --all
```

**Verbose mode** (show matched files):
```bash
npm run verify:s3 -- conway -v
```

---

## 📊 Sample Town Detail

### Conway (1,710 files)

**By Category**:
- Minutes: 646 files (38%)
- Misc: 368 files (22%)
- Document: 224 files (13%)
- Forms: 65 files (4%)
- Reports: 42 files (2%)
- Permits: 26 files (2%)
- Other: 339 files (19%)

**Years Covered**: 2009-2026  
**Boards**: Selectmen, Planning, ZBA, Conservation, etc.

---

## 🔗 Files Created

**Verification Tool**:
- `scripts/verify-s3-state.ts` - Main verification script
- `S3-VERIFICATION-RESULTS.md` - This report

**Package Scripts**:
```json
"verify:s3": "tsx --env-file=.env scripts/verify-s3-state.ts"
```

**Usage Examples**:
```bash
npm run verify:s3 -- conway          # Single town
npm run verify:s3 -- --all           # All towns
npm run verify:s3 -- conway -v       # Verbose
```

---

## 📈 Success Metrics

**Verification Tool** ✅:
- ✅ Lists all S3 files
- ✅ Compares with database
- ✅ Identifies orphans/missing
- ✅ Shows category breakdown
- ✅ Generates recommendations
- ✅ Batch processing (all towns)

**Current State** ✅:
- ✅ 10,114 S3 files confirmed
- ✅ All towns scanned (17/18)
- ✅ Zero missing files
- ✅ Baseline established

---

## ⏭️ Next Steps

### 1. Build Backfill Tool (Today)
```bash
scripts/backfill-s3-to-db.ts
```
Parse S3 paths → Create DB records

### 2. Run Backfill (1 hour)
```bash
npm run backfill:s3 -- --all
```

### 3. Re-Verify (5 min)
```bash
npm run verify:s3 -- --all
```
Should show 100% reconciliation

### 4. Hart's Location (Manual)
```bash
npm run crawl:universal:v2 -- --town "Hart's Location" --url https://hartslocation.com
```

### 5. Full Production Crawl (Week 4)
Re-run without dry-run to capture new docs + update state

---

**Status**: ✅ S3 verification complete  
**Next**: Build backfill tool to reconcile 10,114 orphan files  
**Timeline**: Backfill by end of day, ready for incremental crawls tomorrow  
