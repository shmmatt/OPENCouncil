# OPENCouncil Crawler - Architecture & Improvement Plan
**Date**: 2026-02-12  
**Status**: Planning Phase  
**Goal**: Production-ready autonomous weekly crawler for 200+ NH towns

---

## 🎯 Executive Summary

**Current State**: V2 crawler is working great for one-time full crawls (94.4% success on Carroll County). We need to evolve it for:
1. Weekly autonomous operation
2. Efficient incremental updates (detect new docs only)
3. Comprehensive state tracking
4. Better document coverage
5. Separate server deployment

---

## ✅ What's Working (Keep This!)

### 1. Core Crawler V2 Features
- ✅ Sitemap-first discovery strategy
- ✅ Cloudflare bypass (headful mode)
- ✅ Multi-CMS support (WordPress, CivicPlus, Revize, Custom)
- ✅ Navigation extraction with fallback
- ✅ Redirect detection and handling
- ✅ Document content validation
- ✅ Checkpoint/resume system (individual + batch)

### 2. Upload Pipeline
- ✅ Immediate S3 uploads (reliable)
- ✅ Structured paths: `{town}/{category}/{board}/{year}/{filename}`
- ✅ S3→Gemini sync tracking (database-backed)

### 3. Operational
- ✅ Batch processing with resume capability
- ✅ Progress tracking and logging
- ✅ Error categorization

---

## 🔧 What Needs Building

### Priority 1: State Management System (CRITICAL)

**Problem**: No persistent state means we can't efficiently detect new documents

**Solution**: Multi-layer state tracking

#### Layer 1: Town Metadata
```typescript
// File: state/towns/{town-slug}.json
{
  "name": "Conway",
  "slug": "conway",
  "url": "https://conwaynh.gov",
  "cms": "CivicPlus",
  "lastFullCrawl": "2026-02-12T16:54:54Z",
  "lastIncrementalCrawl": "2026-02-19T08:00:00Z",
  "crawlCount": 5,
  "status": "active" | "failed" | "paused",
  "stats": {
    "totalDocuments": 924,
    "lastCrawlDocs": 15,
    "failureCount": 0
  }
}
```

#### Layer 2: Sitemap Tracking
```typescript
// File: state/sitemaps/{town-slug}.json
{
  "town": "conway",
  "discovered": "2026-02-12T16:54:54Z",
  "lastChecked": "2026-02-19T08:00:00Z",
  "hash": "sha256:abc123...",  // Detect sitemap changes
  "urls": [
    {
      "url": "https://conwaynh.gov/documents",
      "discovered": "2026-02-12T16:54:54Z",
      "lastVisited": "2026-02-19T08:00:00Z",
      "docCount": 45,
      "priority": "high" | "medium" | "low"
    }
  ],
  "stats": {
    "totalUrls": 1523,
    "highValue": 234,  // Matches HIGH_VALUE_PATHS
    "visited": 1523
  }
}
```

#### Layer 3: Document Registry
```typescript
// File: state/documents/{town-slug}.json
{
  "town": "conway",
  "lastUpdated": "2026-02-19T08:00:00Z",
  "documents": [
    {
      "url": "https://conwaynh.gov/documents/minutes-2024-01-15.pdf",
      "urlHash": "sha256:...",  // For deduplication
      "filename": "01-15-2024-minutes.pdf",
      "discovered": "2026-02-12T16:54:54Z",
      "lastChecked": "2026-02-19T08:00:00Z",
      "s3Key": "conway/minutes/Board_of_Selectmen/2024/01-15-2024-minutes.pdf",
      "category": "minutes",
      "board": "Board_of_Selectmen",
      "year": "2024",
      "size": 234567,
      "status": "uploaded" | "pending" | "failed",
      "uploadedAt": "2026-02-12T17:02:15Z",
      "failureReason": null
    }
  ],
  "stats": {
    "total": 924,
    "uploaded": 920,
    "pending": 2,
    "failed": 2
  }
}
```

#### Implementation Plan

**Option A: JSON Files** (Simple, portable)
- ✅ Easy to inspect and debug
- ✅ Version controllable
- ✅ No database dependency
- ❌ Not great for concurrent access
- **Verdict**: Good for MVP, works well for weekly batch crawls

**Option B: SQLite** (Middle ground)
- ✅ Queryable, relational
- ✅ Single file, portable
- ✅ Better for large-scale (200+ towns)
- ❌ Adds dependency
- **Verdict**: Better for production at scale

**Option C: PostgreSQL** (Already have it)
- ✅ Already in stack for S3→Gemini sync
- ✅ Robust, production-ready
- ✅ Can integrate with existing `s3_gemini_sync` table
- ❌ Ties crawler to main app
- **Verdict**: Best for integrated deployment

**Recommendation**: Start with **Option A (JSON)** for MVP, migrate to **Option C (PostgreSQL)** when deploying to separate server.

---

### Priority 2: Incremental Crawl Strategy

**Goal**: Weekly crawls should only fetch *new* documents, not re-crawl everything

#### Strategy: Hybrid Approach

**1. Quick Check (Every Week)**
```
1. Fetch sitemap.xml
2. Compare hash with last known sitemap
3. If unchanged → minimal work
   - Just check high-value paths for new docs
   - Visit 10-20 pages max
4. If changed → targeted crawl
   - Identify new/changed URLs
   - Crawl only those
```

**2. Smart Page Prioritization**
```typescript
// Prioritize pages likely to have new docs
const pagePriorities = {
  high: [
    '/documents', '/minutes', '/agendas',
    '/AgendaCenter', '/DocumentCenter',
    // Pages with dates in last 30 days
  ],
  medium: [
    '/boards', '/forms', '/reports'
  ],
  low: [
    // Historical archives unlikely to change
  ]
};
```

**3. Document Fingerprinting**
```typescript
// Before downloading, check if we've seen it
async function isNewDocument(url: string, size?: number): Promise<boolean> {
  const urlHash = sha256(normalizeUrl(url));
  const existing = documentRegistry.get(urlHash);
  
  if (!existing) return true;
  
  // Optional: HEAD request to check size/last-modified
  if (size && existing.size !== size) return true;
  
  return false;
}
```

**4. Adaptive Crawl Depth**
```typescript
// Adjust based on discovery rate
if (newDocsFound < 5 in last 20 pages) {
  // Stop early - nothing new here
  return;
}
```

#### Implementation: `incremental-crawler.ts`

```typescript
async function incrementalCrawl(town: Town, state: TownState): Promise<CrawlResult> {
  // 1. Check sitemap
  const sitemap = await fetchSitemap(town.url);
  const sitemapChanged = sitemap.hash !== state.sitemap.hash;
  
  if (!sitemapChanged) {
    console.log('Sitemap unchanged, doing quick check...');
    return await quickCheck(town, state);
  }
  
  // 2. Identify new URLs
  const newUrls = sitemap.urls.filter(url => 
    !state.sitemap.urls.find(u => u.url === url)
  );
  
  console.log(`Found ${newUrls.length} new URLs in sitemap`);
  
  // 3. Crawl new + high-priority pages
  const toCrawl = [
    ...newUrls,
    ...state.sitemap.urls
      .filter(u => u.priority === 'high')
      .slice(0, 20) // Top 20 high-priority
  ];
  
  return await crawlUrls(town, toCrawl, state);
}

async function quickCheck(town: Town, state: TownState): Promise<CrawlResult> {
  // Just check top 10 high-priority pages
  const highPriorityPages = state.sitemap.urls
    .filter(u => u.priority === 'high')
    .slice(0, 10);
  
  return await crawlUrls(town, highPriorityPages, state);
}
```

---

### Priority 3: S3 State Verification

**Problem**: We don't know *exactly* what's in S3 or if it matches our expectations

**Solution**: S3 Inventory System

#### Build `verify-s3-state.ts`

```typescript
/**
 * Verifies S3 bucket state:
 * 1. List all files per town
 * 2. Compare with document registry
 * 3. Identify orphans (in S3 but not in registry)
 * 4. Identify missing (in registry but not in S3)
 * 5. Generate reconciliation report
 */

async function verifyTown(town: string): Promise<VerificationReport> {
  // 1. List S3 files
  const s3Files = await listS3Objects(`${town}/`);
  
  // 2. Load document registry
  const registry = await loadDocumentRegistry(town);
  
  // 3. Cross-reference
  const inS3 = new Set(s3Files.map(f => f.Key));
  const inRegistry = new Set(registry.documents.map(d => d.s3Key));
  
  const orphans = [...inS3].filter(k => !inRegistry.has(k));
  const missing = [...inRegistry].filter(k => !inS3.has(k));
  const matched = [...inS3].filter(k => inRegistry.has(k));
  
  return {
    town,
    s3Total: s3Files.length,
    registryTotal: registry.documents.length,
    matched: matched.length,
    orphans: orphans.length,
    missing: missing.length,
    orphanFiles: orphans,
    missingFiles: missing
  };
}
```

#### Run Weekly

```bash
npm run verify:s3 -- --town conway
npm run verify:s3 -- --all  # All Carroll County
```

#### Output Example

```
Conway S3 Verification Report
=============================
S3 Files:           924
Registry Entries:   920
Matched:            918
Orphans:            6   (in S3, not in registry)
Missing:            2   (in registry, not in S3)

Orphans:
  - conway/misc/untitled-2024-01-01.pdf
  - conway/minutes/duplicate-entry.pdf
  ...

Missing (upload failed?):
  - conway/agendas/2024-02-15-agenda.pdf
  - conway/forms/building-permit.pdf

Action Needed:
  - Review orphans: Keep or delete?
  - Retry missing uploads
```

---

### Priority 4: Better Document Coverage

**Problem**: Still not getting all/most documents from all towns

**Known Issues**:
1. **Bartlett regression**: 160 → 27 docs (100-page limit too restrictive)
2. **Some towns have low yields**: May need CMS-specific strategies

#### Solutions

**1. Adaptive Page Limits by CMS**
```typescript
const PAGE_LIMITS = {
  'CivicPlus': 200,  // Lots of year variants
  'WordPress': 150,  // Medium
  'Revize': 150,     // Medium
  'Custom': 100      // Varies, start conservative
};

// In crawler
const maxPages = PAGE_LIMITS[cms] || 100;
```

**2. CMS-Specific Discovery Patterns**

**CivicPlus**: Focus on `/AgendaCenter`, `/DocumentCenter`, `/FormCenter`
```typescript
if (cms === 'CivicPlus') {
  // Add year variants for known patterns
  const centers = ['/AgendaCenter', '/DocumentCenter', '/FormCenter'];
  centers.forEach(center => {
    for (let year = 2024; year >= 2014; year--) {
      queue.add(`${baseUrl}${center}?year=${year}`);
    }
  });
}
```

**WordPress**: Focus on `/wp-content/uploads/{year}/{month}/`
```typescript
if (cms === 'WordPress') {
  const currentYear = new Date().getFullYear();
  for (let year = currentYear; year >= currentYear - 5; year--) {
    for (let month = 1; month <= 12; month++) {
      const m = month.toString().padStart(2, '0');
      queue.add(`${baseUrl}/wp-content/uploads/${year}/${m}/`);
    }
  }
}
```

**3. Deep Link Discovery**
- Parse document pages for links to other documents
- Follow breadcrumb trails
- Check "Related Documents" sections

**4. Manual Town Profiles** (For stubborn cases)
```typescript
// town-profiles/{town-slug}-custom-paths.json
{
  "town": "bartlett",
  "customPaths": [
    "/old-documents-archive",  // Not in sitemap
    "/boards/planning/historical",  // Missed by crawler
    "/media/files/"  // Custom CMS pattern
  ]
}
```

---

### Priority 5: Autonomous Deployment Architecture

**Goal**: Crawler runs on separate server, independently of main app

#### Architecture: Microservice Approach

```
┌─────────────────────────────────────────────────────┐
│           OPENCouncil Main Application              │
│  (Next.js + Express + PostgreSQL + Gemini RAG)      │
│                                                     │
│  - User-facing chat interface                       │
│  - Admin dashboard                                  │
│  - S3 → Gemini sync service                        │
└────────────────┬────────────────────────────────────┘
                 │
                 │ API (state queries, trigger crawls)
                 │
┌────────────────▼────────────────────────────────────┐
│         Document Crawler Service (Separate)         │
│  (Node.js + Playwright + AWS SDK)                   │
│                                                     │
│  Components:                                        │
│  ├─ Weekly cron scheduler                          │
│  ├─ Crawler engine (V2 + incremental)              │
│  ├─ State manager (JSON or SQLite)                 │
│  ├─ S3 uploader                                     │
│  └─ Health check & monitoring                      │
│                                                     │
│  State Storage:                                     │
│  ├─ state/towns/*.json                             │
│  ├─ state/sitemaps/*.json                          │
│  ├─ state/documents/*.json                         │
│  └─ checkpoints/*.json (for resume)                │
└────────────────┬────────────────────────────────────┘
                 │
                 │ Upload documents
                 │
┌────────────────▼────────────────────────────────────┐
│              AWS S3 Bucket                          │
│       opencouncil-municipal-docs                    │
│                                                     │
│  Structure:                                         │
│  /{town}/{category}/{board}/{year}/{filename}      │
└─────────────────────────────────────────────────────┘
```

#### Deployment Options

**Option A: Separate EC2 Instance**
- ✅ Full control
- ✅ Can run headful Chromium
- ✅ Persistent state on EBS
- ❌ Higher cost
- **Cost**: ~$30-50/month (t3.medium or t3.large)

**Option B: AWS Lambda + ECS (Hybrid)**
- Weekly cron → Lambda trigger
- Lambda spawns ECS task (Playwright in container)
- Task runs crawl, uploads to S3, saves state
- ✅ Pay per use
- ❌ More complex setup
- **Cost**: ~$10-20/month

**Option C: Same Server, Separate Process**
- Run crawler as systemd service on same box
- ✅ Simplest to set up
- ✅ Share resources
- ❌ Potential resource contention
- **Cost**: $0 (already have server)

**Recommendation**: Start with **Option C** (same server), migrate to **Option A** (dedicated EC2) when scaling beyond Carroll County.

#### Communication Between Services

**Crawler → Main App**:
```typescript
// POST to main app when crawl completes
fetch('https://opencouncil.app/api/admin/crawler/webhook', {
  method: 'POST',
  headers: { 'Authorization': `Bearer ${WEBHOOK_TOKEN}` },
  body: JSON.stringify({
    event: 'crawl.completed',
    town: 'conway',
    stats: {
      docsFound: 15,
      docsUploaded: 15,
      newDocuments: ['conway/minutes/...', ...]
    }
  })
});
```

**Main App → Crawler**:
```typescript
// Trigger on-demand crawl
fetch('http://localhost:3001/api/crawl', {
  method: 'POST',
  body: JSON.stringify({
    town: 'conway',
    mode: 'incremental' | 'full'
  })
});
```

---

## 🗓️ Implementation Roadmap

### Phase 1: State Management (Week 1-2)
- [ ] Design JSON state schemas (finalize structure)
- [ ] Build `state-manager.ts` (load/save/update state)
- [ ] Update V2 crawler to record state
- [ ] Build S3 verification tool
- [ ] **Deliverable**: Crawl 1-2 towns, verify state files generated correctly

### Phase 2: Incremental Crawling (Week 2-3)
- [ ] Build `incremental-crawler.ts`
- [ ] Implement sitemap diffing
- [ ] Implement document fingerprinting
- [ ] Build adaptive page limits
- [ ] **Deliverable**: Run incremental crawl on Conway (verify only new docs fetched)

### Phase 3: Improve Coverage (Week 3-4)
- [ ] Implement CMS-specific strategies
- [ ] Adaptive page limits by CMS
- [ ] Deep link discovery
- [ ] Re-crawl Bartlett and other low-yield towns
- [ ] **Deliverable**: 90%+ coverage on Carroll County

### Phase 4: Autonomous Scheduler (Week 4-5)
- [ ] Build weekly cron scheduler
- [ ] Health monitoring & alerting
- [ ] Error recovery & retry logic
- [ ] Deploy as systemd service
- [ ] **Deliverable**: Weekly auto-crawl running successfully

### Phase 5: Scale to All NH (Week 5-8)
- [ ] Migrate state to PostgreSQL (if needed)
- [ ] Add all 200+ NH towns to config
- [ ] Optimize batch processing (parallel crawls?)
- [ ] Consider separate EC2 if needed
- [ ] **Deliverable**: All NH towns crawled weekly

---

## 📋 Immediate Next Steps (This Week)

### 1. Fix Outstanding Issues
- [x] Hart's Location shell escaping ← **Do this first**
- [ ] Re-crawl Bartlett with `--max-pages 200`
- [ ] Verify exact S3 document counts

### 2. Build State Management MVP
- [ ] Create `state/` directory structure
- [ ] Write state schema files (copy from above)
- [ ] Build `scripts/state-manager.ts`
- [ ] Update `universal-document-crawler-v2.ts` to save state

### 3. Verify S3 State
- [ ] Build `scripts/verify-s3-state.ts`
- [ ] Run on Conway (largest town, good test)
- [ ] Generate reconciliation report

### 4. Plan Weekly Schedule
- [ ] Decide: What day/time for weekly crawls?
- [ ] How to handle failures? (Retry next day?)
- [ ] Alerting mechanism? (Email? Telegram?)

---

## 🎯 Success Metrics

**Coverage**:
- ✅ 90%+ towns successfully crawled
- ✅ 1,000+ documents per town (on average for larger towns)

**Efficiency**:
- ✅ Incremental crawl < 5 min per town (if no new docs)
- ✅ Full crawl < 30 min per town

**Reliability**:
- ✅ Weekly crawls complete without manual intervention
- ✅ Failed crawls auto-retry
- ✅ State never corrupted/lost

**Completeness**:
- ✅ All discovered documents in S3
- ✅ S3 state matches document registry (100%)
- ✅ All documents ingested into Gemini RAG

---

## 📚 Related Files

**Current Implementation**:
- `scripts/universal-document-crawler-v2.ts` - Core crawler
- `scripts/batch-universal-v2-crawler.ts` - Batch runner
- `scripts/document-uploader-service.ts` - Upload queue service
- `BATCH-CRAWL-FINAL-RESULTS.md` - Latest results

**Documentation**:
- `V2-CRAWLER-README.md` - V2 design decisions
- `DOCUMENT-CRAWLER-GUIDE.md` - Original guide
- `UPLOADER-SERVICE-README.md` - Upload service docs
- `docs/S3_GEMINI_SYNC.md` - S3→Gemini sync

**Memory**:
- `memory/2026-02-12.md` - Today's complete journey
- `AGENTS.md` - Partnership context
- `USER.md` - Matt's details

---

**Next sync**: After you confirm direction, I'll start building the state manager 🚀
