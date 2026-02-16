# Pipeline Execution Plan - 2026-02-15

**Status**: IN PROGRESS  
**Started**: 02:59 UTC  
**Goal**: Complete operating pipeline from crawl → S3 → RAG

## Current Status

### ✅ Completed
- S3 audit: 12,181 files, 100% reconciled with database
- V3 duplicate analysis: 55% duplicates, **45% NEW (4,843 docs)**
- State tracking implementation: Complete and tested
- Database schema: Ready

### 🔄 IN PROGRESS (Started 02:59 UTC)
**Stage 1: V3 Batch Crawl with State Tracking**
```bash
tsx scripts/batch-v3-parallel.ts
```
- Running on all 18 Carroll County towns
- 4 concurrent crawlers
- Expected duration: 30-45 minutes
- Expected output: 10,864 documents discovered
  - 6,021 marked as 'uploaded' (already in S3)
  - 4,843 marked as 'discovered' (new)

### ⏳ QUEUED

**Stage 2: Download & Upload New Documents**
```bash
tsx server/workers/downloadWorker.ts --status=discovered --batchSize=50
```
- Processes all 'discovered' documents
- Downloads PDFs from town websites
- Uploads to S3 with correct structure
- Updates status: discovered → uploaded
- Expected duration: 2-3 hours (4,843 docs)

**Stage 3: Metadata Extraction**
```bash
tsx server/services/metadataExtraction.ts --status=uploaded --limit=1000
```
- Extracts text, dates, categories from PDFs
- Updates status: uploaded → extracted
- Uses existing logic (no changes needed)

**Stage 4: RAG Ingestion**
```bash
tsx server/services/ingestionWorker.ts --status=extracted --limit=500
```
- Chunks, embeds, stores in Gemini
- Updates status: extracted → ingested
- Uses existing logic (no changes needed)

## Database Flow

```
crawlerDocuments table:
  
  discovered (NEW)     ←  V3 crawler records NEW docs
      ↓
  uploaded (EXISTING)  ←  V3 crawler marks duplicates OR download worker completes
      ↓
  extracted            ←  Metadata extraction completes
      ↓
  ingested             ←  RAG ingestion completes
```

## Key Metrics (Expected)

| Stage | Input | Output | Duration |
|-------|-------|--------|----------|
| V3 Crawl | 18 towns | 10,864 records | 45 min |
| Download | 4,843 discovered | 4,843 uploaded | 2-3 hrs |
| Metadata | 4,843 uploaded | 4,843 extracted | 1-2 hrs |
| Ingestion | 4,843 extracted | 4,843 ingested | 2-3 hrs |
| **TOTAL** | | **4,843 new docs in RAG** | **6-9 hrs** |

## Monitoring

**Check progress**:
```bash
# Crawl progress
tail -f /tmp/batch-crawl.log

# Database status
psql -d opencouncil -c "
  SELECT status, COUNT(*) 
  FROM crawler_documents 
  GROUP BY status 
  ORDER BY status;
"

# S3 file count
aws s3 ls s3://opencouncil-municipal-docs/ --recursive | wc -l
```

**Expected database progression**:
```
After Stage 1 (Crawl):
  discovered: 4,843
  uploaded: 6,021

After Stage 2 (Download):
  discovered: 0
  uploaded: 10,864

After Stage 3 (Metadata):
  uploaded: 0
  extracted: 10,864

After Stage 4 (Ingestion):
  extracted: 0
  ingested: 10,864
```

## Error Handling

**If download worker fails**:
- Check logs: `downloadWorker.log`
- Retry specific town: `tsx server/workers/downloadWorker.ts --town=<slug> --status=discovered`
- Failed docs stay in 'discovered' status for manual review

**If metadata extraction fails**:
- Check existing logs
- Retry: Re-run with `--status=uploaded`
- Failed docs can be skipped or retried

## Backwards Compatibility

**Conway/Ossipee Protection**:
- ✅ S3 keys match existing structure
- ✅ Database tracks all existing files
- ✅ No overwrites (S3 check before upload)
- ✅ Existing indices remain functional

**S3 Structure Preserved**:
```
s3://opencouncil-municipal-docs/
  conway/agendas/planning-board/2024/meeting-2024-03-15.pdf
  ossipee/minutes/selectboard/2025/minutes-2025-01-10.pdf
  moultonborough/forms/building-permit-application.pdf
```

## Success Criteria

- [ ] All 18 towns crawled successfully
- [ ] 10,864 documents recorded in database
- [ ] 4,843 new documents downloaded to S3
- [ ] All documents extracted and ingested
- [ ] Conway/Ossipee indices still working
- [ ] Chat app can query new documents

## Next: Weekly Automation

Once manual pipeline succeeds, set up cron:

```yaml
# Cron schedule (weekly)
schedule:
  - "0 2 * * 0"  # Sundays at 2 AM

jobs:
  1. V3 crawl (all NH towns)
  2. Download worker (discovered → uploaded)
  3. Metadata extraction (uploaded → extracted)
  4. RAG ingestion (extracted → ingested)
```

---

**Current Action**: Monitoring Stage 1 (V3 Batch Crawl)  
**ETA to completion**: ~7-9 hours from now (~10:00-12:00 UTC)
