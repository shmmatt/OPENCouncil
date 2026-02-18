# Batch Pipeline Status

**Date:** 2026-02-18  
**Phase:** Embedding in progress, OCR pipeline ready

---

## 🔄 Current Progress

**Embedding:** Running via `embed-realtime.ts`
- Rate: ~8.3/sec
- Chunks: 1,330 / 4,579 (29%)
- ETA: ~6 minutes

**Next:** Test retrieval, then start OCR pipeline

---

## ✅ Pipeline Built

Three-phase batch embedding pipeline is complete:

```
batch-pipeline/
├── README.md                 # Architecture overview
├── BATCH-API-GUIDE.md        # Gemini Batch API instructions
├── export-to-jsonl.ts        # Phase 1: Export documents
├── ingest-embeddings.ts      # Phase 3: Load embeddings
├── submit_batch.py           # Python: Submit batch job
├── check_batch.py            # Python: Check job status
├── download_batch.py         # Python: Download results
└── utils/
    ├── chunker.ts            # Text chunking logic
    └── db.ts                 # Database connection
```

---

## 📊 Document Analysis

Ran export and discovered data quality issue:

| Status | Count | % |
|--------|-------|---|
| **has_ocr_text** | 324 | 4.4% |
| **has_preview_text** | 2 | 0% |
| **needs_ocr** (flagged but not done) | 1,756 | 23.6% |
| **no_text** (not processed) | 5,354 | 72% |
| **Total** | 7,436 | 100% |

**Only 326 documents (4.4%) are ready for embedding!**

The rest are PDFs that either:
1. Were never text-extracted
2. Are flagged for OCR but not processed yet

---

## 🔄 Export Test Results

```
📄 Documents processed: 326
📦 Chunks generated: 4,579
⏭️  Skipped (no text): 7,110
📁 Output file: data/export-2026-02-18.jsonl
📊 File size: 8.12 MB
💰 Estimated batch cost: $0.02
```

---

## 🎯 Next Steps

### Option A: Embed What We Have (Quick Win)
1. Submit the 326-doc export to Gemini Batch API
2. Get pgvector working with available data
3. Address OCR backlog separately

**Time:** ~24 hours for batch processing

### Option B: Fix OCR First (Complete Dataset)
1. Run OCR on the 1,756 flagged documents
2. Process the 5,354 un-extracted documents
3. Then run full embedding pipeline

**Time:** Days to weeks depending on OCR approach

### Recommended: Option A First
Get pgvector working with 326 docs (4,579 chunks) as proof of concept. This validates the pipeline end-to-end, then we can scale up with better data.

---

## 📋 Archive Cleanup Summary

Moved 75+ legacy files to `archive/`:
- `archive/legacy-migration-scripts/` - Failed OOM migration attempts
- `archive/legacy-crawlers/` - V1/V2 crawlers (V3 is current)
- `archive/legacy-docs/` - Outdated documentation
- `archive/test-scripts/` - One-off debugging scripts

Scripts folder: **116 → 41 files**

---

## 🛠️ Pipeline Commands

```bash
# Phase 1: Export (already done)
cd OPENCouncil
export $(grep -v '^#' .env | xargs)
npx tsx batch-pipeline/export-to-jsonl.ts

# Phase 2: Submit to Gemini (needs python google-genai)
pip install google-genai
export GEMINI_API_KEY=your_key
python batch-pipeline/submit_batch.py data/export-2026-02-18.jsonl

# Phase 2b: Check status
python batch-pipeline/check_batch.py data/export-2026-02-18_job.txt

# Phase 2c: Download results
python batch-pipeline/download_batch.py data/export-2026-02-18_job.txt

# Phase 3: Ingest into pgvector
npx tsx batch-pipeline/ingest-embeddings.ts --input data/embeddings-2026-02-18.jsonl
```
