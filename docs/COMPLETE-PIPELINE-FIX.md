# Complete Pipeline Fix - Single Source of Truth

**Date**: 2026-02-15  
**Status**: IN PROGRESS  
**Goal**: Stop dubbing around. Build a fully operating pipeline that works.

## The Problem

We have **THREE conflicting sources of truth**:
1. **S3 bucket** - Unknown # of files from old crawls (Conway, Ossipee, others?)
2. **Database `crawlerDocuments`** - Partially populated from V2 crawls
3. **V3 discovery results** - 10,198 URLs discovered, not yet tracked

This causes:
- ❌ No way to know if V3 discoveries are new or duplicates
- ❌ Can't do incremental crawls (no baseline)
- ❌ Risk breaking existing Conway/Ossipee indices
- ❌ Wasting tokens re-crawling known docs

## The Solution: Complete Integration (4 Steps)

### Step 1: Establish S3 as Ground Truth (NOW)
**Goal**: Know exactly what exists, where it is, and what's tracked

```bash
# 1a. Full S3 audit
node -r dotenv/config ./node_modules/.bin/tsx scripts/verify-s3-state.ts --all > reports/s3-audit-$(date +%s).txt

# 1b. Backfill S3 → Database
node -r dotenv/config ./node_modules/.bin/tsx scripts/backfill-s3-to-db.ts --all

# 1c. Verify reconciliation
node -r dotenv/config ./node_modules/.bin/tsx scripts/verify-s3-state.ts --all
```

**Expected Outcome**:
- Every S3 file has a `crawlerDocuments` record with `status='uploaded'`
- Database knows about all existing docs (Conway, Ossipee, and any others)
- Clear baseline for incremental crawls

### Step 2: Complete V3 State Integration (15 min)
**Goal**: V3 crawler creates database records during discovery

**Files to modify**:
- `scripts/crawler-v3.ts` - Add `recordDocument()` calls (~30 lines)

**Changes**:
```typescript
// In sitemap strategy (~line 120)
for (const doc of documents) {
  if (config.enableStateTracking && town) {
    await recordDocument(db, town, doc.url, doc.title);
  }
}

// In known paths strategy (~line 140)
for (const doc of documents) {
  if (config.enableStateTracking && town) {
    await recordDocument(db, town, doc.url, doc.title);
  }
}

// In breadth-first strategy (~line 170)
for (const doc of documents) {
  if (config.enableStateTracking && town) {
    await recordDocument(db, town, doc.url, doc.title);
  }
}
```

**Test**:
```bash
# Test on NEW town (not Conway/Ossipee)
tsx scripts/crawler-v3.ts --town="Berlin" --enableStateTracking

# Verify database records created
psql -d opencouncil -c "SELECT COUNT(*), status FROM crawler_documents WHERE town_slug='berlin' GROUP BY status;"
```

### Step 3: Run Integrated V3 on All Towns (45 min)
**Goal**: Discover all documents with state tracking enabled

```bash
# Run batch crawler with state tracking
tsx scripts/batch-v3-parallel.ts --enableStateTracking --concurrency=4

# Expected: Database gets records for all discovered docs with status='discovered'
```

**Outcome**:
- 10,198+ documents tracked in `crawlerDocuments`
- Status = `discovered` for new docs
- Status = `uploaded` for existing S3 docs (from Step 1)

### Step 4: Download & Upload New Documents (automated)
**Goal**: Download discovered docs, upload to S3, update status

**Already built**: `server/workers/downloadWorker.ts`

```bash
# Process all discovered documents
tsx server/workers/downloadWorker.ts --status="discovered" --batchSize=50

# Or process by town
tsx server/workers/downloadWorker.ts --town="moultonborough" --status="discovered"
```

**Features**:
- ✅ Checks S3 before downloading (skips duplicates)
- ✅ Generates S3 keys matching existing structure
- ✅ Updates status: `discovered` → `downloaded` → `uploaded`
- ✅ Retry logic for failed downloads

## Complete Pipeline (Post-Fix)

```
┌─────────────────────────────────────────────────────────────┐
│                      WEEKLY CRON JOB                         │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│  1. V3 Crawler (with state tracking)                         │
│     - Runs on all NH towns                                   │
│     - Records discoveries in crawlerDocuments                │
│     - Status: discovered                                     │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│  2. Download Worker                                          │
│     - Queries: WHERE status='discovered'                     │
│     - Checks S3 before download                              │
│     - Uploads to S3 with correct key structure               │
│     - Status: discovered → uploaded                          │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│  3. Metadata Extraction (EXISTING)                           │
│     - server/services/metadataExtraction.ts                  │
│     - Extracts text, dates, categories                       │
│     - Status: uploaded → extracted                           │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│  4. RAG Ingestion (EXISTING)                                 │
│     - server/services/ingestionWorker.ts                     │
│     - Chunks, embeds, stores in Gemini                       │
│     - Status: extracted → ingested                           │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
                 ✅ Available in Chat App

```

## Backwards Compatibility

**Critical**: Must not break existing Conway/Ossipee indices

**S3 Key Format** (preserved):
```
s3://opencouncil-municipal-docs/
  ├── conway/
  │   ├── agendas/
  │   │   ├── planning-board/
  │   │   │   ├── 2024/
  │   │   │   │   └── meeting-2024-03-15.pdf
  │   │   │   └── 2025/
  │   │   └── selectboard/
  │   └── minutes/
  └── ossipee/
      └── ...
```

**How we ensure this**:
- `generateS3Key()` in `crawlerStateExtensions.ts` matches existing logic
- `extractDocumentMetadata()` parses category/board/year from URLs
- Test on NEW towns first (Berlin, Sandwich, etc.)
- Verify S3 keys before mass upload

## Success Criteria

- [ ] **S3 audit complete**: Know exact file count per town
- [ ] **Database reconciled**: Every S3 file has a record
- [ ] **V3 state tracking working**: Discoveries create DB records
- [ ] **Download worker tested**: Successfully uploads new docs
- [ ] **Incremental crawls work**: Re-running V3 skips known docs
- [ ] **Conway/Ossipee untouched**: Existing files still accessible
- [ ] **Pipeline automated**: Weekly cron job handles everything

## Monitoring & Maintenance

**Weekly checks**:
```bash
# 1. How many new docs this week?
psql -d opencouncil -c "
  SELECT town_slug, COUNT(*) 
  FROM crawler_documents 
  WHERE discovered_at > NOW() - INTERVAL '7 days' 
  GROUP BY town_slug 
  ORDER BY COUNT(*) DESC;
"

# 2. Any stuck in discovered status?
psql -d opencouncil -c "
  SELECT town_slug, COUNT(*) 
  FROM crawler_documents 
  WHERE status='discovered' 
  AND discovered_at < NOW() - INTERVAL '2 days'
  GROUP BY town_slug;
"

# 3. S3 sync status
tsx scripts/verify-s3-state.ts --all | grep "Reconciliation:"
```

## Next Immediate Actions

1. ✅ S3 audit running (verify-s3-state.ts)
2. ⏳ Review audit results
3. ⏳ Run backfill-s3-to-db.ts
4. ⏳ Complete V3 state integration (~30 lines)
5. ⏳ Test on Berlin or new town
6. ⏳ Deploy to all Carroll County
7. ⏳ Set up automated workers

---

**No more incremental steps. This is the complete fix.**
