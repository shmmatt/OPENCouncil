# V3 Integration Plan - SAFE & COMPATIBLE

## CRITICAL CONSTRAINTS ⚠️

1. **DO NOT BREAK EXISTING CHAT APP**
   - Conway and Ossipee indices already exist
   - Existing S3 structure must be respected
   - Existing Gemini stores must remain intact

2. **EXISTING S3 STRUCTURE (MUST MATCH)**
   ```
   s3://opencouncil-municipal-docs/
     ├── conway/
     │   ├── minutes/
     │   │   ├── Board_of_Selectmen/
     │   │   │   ├── 2024/
     │   │   │   │   └── document.pdf
     │   │   │   └── 2023/
     │   │   └── Planning_Board/
     │   ├── agendas/
     │   ├── ordinances/
     │   └── reports/
     └── ossipee/
         └── (same structure)
   ```

3. **EXISTING DATABASE TABLES**
   - `crawlerDocuments` - Document discovery & status tracking
   - `s3_gemini_sync` - Sync to Gemini File Search (legacy)
   - `fileBlobs` + `logicalDocuments` + `documentVersions` (v2 pipeline)

## Integration Architecture

```
┌────────────────────────────────────────────────────┐
│            V3 CRAWLER (scripts/crawler-v3.ts)      │
│  • Discovers document URLs                        │
│  • Calls recordDocument() for each URL            │
│  • Status: 'discovered'                           │
└────────────────────────────────────────────────────┘
                     ↓
┌────────────────────────────────────────────────────┐
│         DOWNLOAD WORKER (server/workers/          │
│                          downloadWorker.ts)        │
│  • Polls for status='discovered'                  │
│  • Downloads document from URL                    │
│  • Generates S3 key matching existing structure   │
│  • Uploads to S3                                  │
│  • Updates status='uploaded', stores s3Key        │
└────────────────────────────────────────────────────┘
                     ↓
┌────────────────────────────────────────────────────┐
│       GEMINI SYNC (existing s3Sync.ts)            │
│  • Picks up new S3 files                          │
│  • Creates s3_gemini_sync records                 │
│  • Existing ingestionWorker processes as before   │
└────────────────────────────────────────────────────┘
```

## S3 Key Generation Strategy

### Priority 1: Extract from URL patterns
```typescript
// CivicPlus: /AgendaCenter/ViewFile/Minutes/_01022026-991
// Extract: board=unknown, category=minutes, date=01022026

// DocumentCenter: /DocumentCenter/View/4145/Board-of-Selectmen-Agenda-Packet-020326pdf
// Extract: board=Board_of_Selectmen, category=agendas, date=020326
```

### Priority 2: Use filename heuristics
```typescript
// "Board-of-Selectmen-Minutes-2024-01-15.pdf"
// Extract: board=Board_of_Selectmen, category=minutes, year=2024
```

### Priority 3: Default structure
```typescript
// If can't determine category/board:
// s3://bucket/{town}/documents/uncategorized/{year}/{filename}
```

## Implementation Steps

### Step 1: V3 Integration (SAFE - no breaking changes)

**Modify `scripts/crawler-v3.ts`:**
```typescript
import { 
  ensureTown, 
  recordDocument, 
  startRun, 
  completeRun 
} from '../server/services/crawlerState';

// At start of crawl
const townRecord = await ensureTown({
  name: config.town,
  slug: slugify(config.town),
  url: config.url,
  status: 'active'
});

const runId = await startRun(townRecord.id, 'full');

// After discovering docs
for (const docUrl of discoveredDocs) {
  await recordDocument({
    townId: townRecord.id,
    url: docUrl,
    urlHash: hashUrl(docUrl),
    filename: extractFilename(docUrl),
    discoveredAt: new Date(),
    discoveredFrom: pageUrl,
    status: 'discovered'
  });
}

// At end
await completeRun(runId, {
  documentsDiscovered: discoveredDocs.size,
  pagesVisited,
  status: 'completed'
});
```

### Step 2: Download Worker (NEW - no conflicts)

**Create `server/workers/downloadWorker.ts`:**
```typescript
import { db, eq, and } from '../storage/db';
import { crawlerDocuments, crawlerTowns } from '../../shared/crawler-schema';
import { S3Client, PutObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import { hashUrl, generateS3Key } from '../services/crawlerState';

const S3_BUCKET = 'opencouncil-municipal-docs';
const s3 = new S3Client({ region: 'us-east-1' });

export async function processDiscoveredDocuments(limit = 10) {
  // Get documents with status='discovered'
  const docs = await db.query.crawlerDocuments.findMany({
    where: eq(crawlerDocuments.status, 'discovered'),
    with: { town: true },
    limit
  });
  
  for (const doc of docs) {
    try {
      // 1. Download document
      const response = await fetch(doc.url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 OPENCouncil/1.0'
        }
      });
      
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      
      const buffer = Buffer.from(await response.arrayBuffer());
      const contentType = response.headers.get('content-type') || 'application/pdf';
      
      // 2. Generate S3 key matching existing structure
      const s3Key = generateS3Key({
        town: doc.town.slug,
        url: doc.url,
        filename: doc.filename,
        discoveredFrom: doc.discoveredFrom
      });
      
      // 3. Check if already exists in S3 (deduplication)
      try {
        await s3.send(new HeadObjectCommand({
          Bucket: S3_BUCKET,
          Key: s3Key
        }));
        
        // Already exists - just update status
        await db.update(crawlerDocuments)
          .set({
            status: 'uploaded',
            s3Key,
            s3UploadedAt: new Date(),
            sizeBytes: buffer.length,
            mimeType: contentType
          })
          .where(eq(crawlerDocuments.id, doc.id));
        
        continue;
      } catch {
        // Doesn't exist - upload
      }
      
      // 4. Upload to S3
      await s3.send(new PutObjectCommand({
        Bucket: S3_BUCKET,
        Key: s3Key,
        Body: buffer,
        ContentType: contentType,
        Metadata: {
          sourceUrl: doc.url,
          town: doc.town.slug,
          discoveredAt: doc.discoveredAt.toISOString()
        }
      }));
      
      // 5. Update status
      await db.update(crawlerDocuments)
        .set({
          status: 'uploaded',
          s3Key,
          s3UploadedAt: new Date(),
          sizeBytes: buffer.length,
          mimeType: contentType
        })
        .where(eq(crawlerDocuments.id, doc.id));
      
      console.log(`[DownloadWorker] ✅ ${doc.town.slug}: ${s3Key}`);
      
    } catch (error) {
      console.error(`[DownloadWorker] ❌ ${doc.url}:`, error);
      
      await db.update(crawlerDocuments)
        .set({
          status: 'failed',
          errorMessage: error instanceof Error ? error.message : 'Unknown error'
        })
        .where(eq(crawlerDocuments.id, doc.id));
    }
  }
  
  return { processed: docs.length };
}
```

### Step 3: S3 Key Generation (CRITICAL - must match existing)

**Add to `server/services/crawlerState.ts`:**
```typescript
export interface S3KeyParams {
  town: string; // slug format: "conway", "ossipee"
  url: string;
  filename: string;
  discoveredFrom?: string | null;
}

/**
 * Generate S3 key matching existing structure:
 * {town}/{category}/[{board}/][{year}/]{filename}
 */
export function generateS3Key(params: S3KeyParams): string {
  const { town, url, filename, discoveredFrom } = params;
  
  // Extract metadata from URL and filename
  const metadata = extractDocumentMetadata(url, filename, discoveredFrom);
  
  // Build path components
  const parts = [town];
  
  // Category (required)
  parts.push(metadata.category || 'documents');
  
  // Board (optional, but common)
  if (metadata.board) {
    parts.push(metadata.board);
  }
  
  // Year (optional)
  if (metadata.year) {
    parts.push(metadata.year);
  }
  
  // Filename (sanitized)
  const sanitizedFilename = sanitizeFilename(filename);
  parts.push(sanitizedFilename);
  
  return parts.join('/');
}

function extractDocumentMetadata(url: string, filename: string, source?: string | null) {
  const lower = url.toLowerCase();
  const filenameLower = filename.toLowerCase();
  
  let category = 'documents'; // default
  let board: string | undefined;
  let year: string | undefined;
  
  // Detect category from URL or filename
  if (lower.includes('minute') || filenameLower.includes('minute')) {
    category = 'minutes';
  } else if (lower.includes('agenda') || filenameLower.includes('agenda')) {
    category = 'agendas';
  } else if (lower.includes('ordinance') || filenameLower.includes('ordinance')) {
    category = 'ordinances';
  } else if (lower.includes('budget') || filenameLower.includes('budget')) {
    category = 'budget';
  } else if (lower.includes('report') || filenameLower.includes('report')) {
    category = 'reports';
  }
  
  // Extract board from filename patterns
  const boardPatterns = [
    /board[_\-\s]of[_\-\s]selectmen/i,
    /select[_\-\s]board/i,
    /planning[_\-\s]board/i,
    /zoning[_\-\s]board/i,
    /budget[_\-\s]committee/i,
    /conservation[_\-\s]commission/i,
    /school[_\-\s]board/i
  ];
  
  for (const pattern of boardPatterns) {
    const match = filename.match(pattern);
    if (match) {
      // Normalize: "Board of Selectmen" -> "Board_of_Selectmen"
      board = match[0].replace(/[\s\-]+/g, '_').replace(/^_|_$/g, '');
      // Title case each word
      board = board.split('_').map(w => 
        w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()
      ).join('_');
      break;
    }
  }
  
  // Extract year (2020-2099)
  const yearMatch = filename.match(/\b(20\d{2})\b/);
  if (yearMatch) {
    year = yearMatch[1];
  }
  
  return { category, board, year };
}

function sanitizeFilename(filename: string): string {
  // Remove or replace problematic characters
  return filename
    .replace(/[^\w\-\.]/g, '_') // Replace non-word chars with underscore
    .replace(/_+/g, '_') // Collapse multiple underscores
    .replace(/^_|_$/g, ''); // Trim underscores
}
```

### Step 4: Existing Pipeline Integration (NO CHANGES NEEDED)

**Existing `s3Sync.ts` already:**
- Scans S3 for new files
- Extracts metadata from paths
- Creates `s3_gemini_sync` records
- Uploads to town-specific Gemini stores

**No changes needed** - it will automatically pick up new S3 files!

## Testing Plan (CRITICAL - test before production)

### Phase 1: Single Document Test
1. Run V3 on test town (NOT Conway/Ossipee)
2. Verify `crawlerDocuments` record created
3. Run download worker manually
4. Verify S3 key matches pattern
5. Verify file uploaded correctly
6. Verify existing Conway/Ossipee unchanged

### Phase 2: Small Batch Test
1. Run V3 on Freedom (1,657 docs discovered)
2. Run download worker (limit 10)
3. Verify S3 structure correct
4. Verify metadata extraction works
5. Verify no conflicts with existing data

### Phase 3: Full Integration Test
1. Run download worker on all Freedom docs
2. Let existing s3Sync pick up files
3. Verify Gemini ingestion works
4. Test Freedom chat queries
5. Verify Conway/Ossipee still work

### Phase 4: Production Deployment
1. Run V3 on remaining Carroll County towns
2. Monitor download worker
3. Monitor S3 storage
4. Monitor Gemini costs
5. Monitor chat app health

## Rollback Plan

If anything breaks:
1. **Stop download worker immediately**
2. Check Conway/Ossipee chat - still working?
3. If not, rollback S3 changes (delete new town folders)
4. If yes, debug new town integration only

## Success Criteria

- [x] V3 discovers documents ✅
- [ ] V3 records to `crawlerDocuments` table
- [ ] Download worker downloads & uploads to S3
- [ ] S3 keys match existing structure
- [ ] Existing Conway/Ossipee chat still works
- [ ] New town chats work after ingestion
- [ ] No data corruption or conflicts
