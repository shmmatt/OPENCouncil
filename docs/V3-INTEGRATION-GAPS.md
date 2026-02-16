# V3 Crawler - Integration Gaps & Next Steps

## Current State: Discovery Only ⚠️

**V3 crawler currently:**
- ✅ Discovers document URLs (10,198 found)
- ✅ Works across all CMS types
- ✅ Parallel execution
- ❌ **Does NOT track state in database**
- ❌ **Does NOT download documents to S3**
- ❌ **Does NOT extract metadata**
- ❌ **Does NOT support incremental crawls**

## Existing Infrastructure (Available)

### 1. State Tracking (`server/services/crawlerState.ts`)
- Town registry
- Sitemap tracking & diffing
- Document discovery tracking
- URL visit history
- Crawl run history

### 2. S3 Upload (`server/services/s3Sync.ts`)
- Document download
- S3 storage
- Duplicate detection

### 3. Metadata Extraction (`server/services/metadataExtraction.ts`)
- PDF text extraction
- Meeting detection
- Date extraction
- Board/committee classification

### 4. RAG Ingestion (`server/services/ingestionWorker.ts`)
- Chunking
- Embedding generation
- Vector store indexing

## What's Missing: Integration Layer

### Gap 1: V3 → State Tracking
**Current:** V3 outputs JSON files with discovered URLs
**Needed:** V3 calls `recordDocument()` for each discovered URL

```typescript
// In V3 crawler
for (const docUrl of discoveredDocs) {
  await recordDocument({
    townId: townRecord.id,
    url: docUrl,
    urlHash: hashUrl(docUrl),
    discoveredAt: new Date(),
    source: 'v3-crawler',
    status: 'discovered'
  });
}
```

### Gap 2: State Tracking → S3 Download
**Current:** State tracks URLs, but nothing triggers downloads
**Needed:** Background worker to download new docs

```typescript
// New service: downloadWorker.ts
async function processDiscoveredDocuments() {
  const newDocs = await getDocumentsToDownload(); // status='discovered'
  
  for (const doc of newDocs) {
    const { buffer, contentType } = await downloadDocument(doc.url);
    const s3Key = await uploadToS3(doc.townId, doc.url, buffer);
    
    await updateDocumentStatus(doc.id, 'uploaded', { s3Key });
  }
}
```

### Gap 3: S3 → Metadata Extraction
**Current:** Files in S3, but metadata not extracted
**Needed:** Trigger metadata extraction after upload

```typescript
// After S3 upload
const metadata = await extractMetadata(s3Key);
await updateDocumentMetadata(doc.id, metadata);
```

### Gap 4: Metadata → RAG Ingestion
**Current:** Metadata extracted but not ingested
**Needed:** Trigger ingestion worker

```typescript
// After metadata extraction
await queueForIngestion(doc.id);
```

## Complete Pipeline (End-to-End)

```
┌──────────────────────────────────────────────────────────┐
│                    V3 CRAWLER                            │
│  • Discovers document URLs                               │
│  • Records to database (crawlerDocuments)               │
│  • Marks status='discovered'                            │
└──────────────────────────────────────────────────────────┘
                            ↓
┌──────────────────────────────────────────────────────────┐
│                 DOWNLOAD WORKER                          │
│  • Polls for status='discovered'                        │
│  • Downloads document from URL                          │
│  • Uploads to S3                                        │
│  • Updates status='uploaded', stores s3Key              │
└──────────────────────────────────────────────────────────┘
                            ↓
┌──────────────────────────────────────────────────────────┐
│                METADATA EXTRACTOR                        │
│  • Polls for status='uploaded' with null metadata       │
│  • Extracts text, dates, boards from PDF               │
│  • Updates document metadata                            │
│  • Updates status='processed'                           │
└──────────────────────────────────────────────────────────┘
                            ↓
┌──────────────────────────────────────────────────────────┐
│                  INGESTION WORKER                        │
│  • Polls for status='processed', not ingested           │
│  • Chunks document                                      │
│  • Generates embeddings                                 │
│  • Stores in vector DB (Pinecone/Postgres)             │
│  • Updates status='ingested'                            │
└──────────────────────────────────────────────────────────┘
```

## Required Changes

### 1. Modify V3 Crawler (scripts/crawler-v3.ts)
```typescript
import { recordDocument, ensureTown, startRun, completeRun } from '../server/services/crawlerState';

// At start of crawl
const townRecord = await ensureTown({
  name: config.town,
  slug: slugify(config.town),
  baseUrl: config.url,
  enabled: true
});

const runId = await startRun(townRecord.id, 'full');

// After discovering docs
for (const docUrl of discoveredDocs) {
  await recordDocument({
    townId: townRecord.id,
    url: docUrl,
    urlHash: hashUrl(docUrl),
    discoveredAt: new Date(),
    source: 'v3-crawler',
    status: 'discovered'
  });
}

// At end
await completeRun(runId, { documentsDiscovered: discoveredDocs.size });
```

### 2. Create Download Worker (server/services/downloadWorker.ts)
- Poll for `status='discovered'` documents
- Download from URL
- Upload to S3
- Update status to `'uploaded'`

### 3. Create Metadata Worker (server/services/metadataWorker.ts)
- Poll for `status='uploaded'` with null metadata
- Extract metadata
- Update document record
- Update status to `'processed'`

### 4. Update Ingestion Worker (existing)
- Poll for `status='processed'`, not yet ingested
- Process as normal
- Mark as `'ingested'`

## Incremental Crawls

With state tracking in place:

```typescript
// Weekly crawl - only visit changed pages
const lastRun = await getLastSuccessfulRun(townId);
const knownUrls = await getDiscoveredUrls(townId);

// Only crawl pages we haven't seen
const newUrls = discoveredUrls.filter(u => !knownUrls.has(u));

// Only download new documents
const newDocs = discoveredDocs.filter(d => !await documentExists(d.url));
```

## Immediate Action Items

### Critical (This Week)
1. [ ] **Integrate V3 with state tracking** - Record discovered docs to DB
2. [ ] **Build download worker** - Get docs from URLs to S3
3. [ ] **Connect metadata extraction** - Extract from S3 files
4. [ ] **Test end-to-end** - One town, full pipeline

### Important (Next Week)
5. [ ] **Deploy automated workers** - Cron jobs for download/metadata/ingestion
6. [ ] **Set up incremental crawls** - Weekly updates, not full re-crawls
7. [ ] **Monitor pipeline health** - Dashboard for stuck documents

### Nice to Have
8. [ ] **Backfill existing S3 docs** - Update state DB with what's already in S3
9. [ ] **Build admin UI** - View crawler status, trigger manual crawls
10. [ ] **Add change detection** - Alert when documents are updated/removed

## Success Metrics

### End-to-End Pipeline Working
- [x] V3 discovers URLs ✅
- [ ] URLs recorded to state DB
- [ ] Documents downloaded to S3
- [ ] Metadata extracted and stored
- [ ] Documents ingested to RAG
- [ ] Searchable via OpenCouncil UI

### Weekly Maintenance Working
- [ ] Automated weekly crawls
- [ ] Incremental updates (only new docs)
- [ ] Change detection (updated docs)
- [ ] Health monitoring (stuck docs)

### Coverage Targets
- [ ] 90%+ coverage on all towns (currently 86% Madison, 35% Ossipee)
- [ ] 200+ NH towns fully crawled
- [ ] Weekly updates keeping data fresh

## Estimated Timeline

- **Day 1-2:** V3 state tracking integration + download worker
- **Day 3-4:** Metadata extraction + ingestion pipeline
- **Day 5:** End-to-end testing + bug fixes
- **Week 2:** Automated workers + incremental crawls
- **Week 3:** Backfill existing data + monitoring
- **Week 4:** Production deployment + NH-wide rollout
