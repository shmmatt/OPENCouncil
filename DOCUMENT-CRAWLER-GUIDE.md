## 📚 Document Crawler System - Complete Guide

**Purpose:** Automatically discover, download, categorize, and ingest all public documents from Carroll County town websites into OPENCouncil.

---

## 🎯 What It Does

The document crawler:
1. **Discovers** all PDFs and documents on town websites
2. **Categorizes** them (minutes, budgets, forms, ordinances, etc.)
3. **Extracts metadata** (board name, year, document type)
4. **Uploads to S3** with proper structure
5. **Triggers ingestion** into town-specific Gemini stores

---

## 📦 System Architecture

```
Town Website
    ↓
Document Crawler (finds all PDFs/docs)
    ↓
S3 Bucket (opencouncil-municipal-docs)
    ↓
Discovery Service (scans S3, adds to DB queue)
    ↓
Ingestion Worker (uploads to Gemini File Search)
    ↓
Town-Specific Vector Stores
    ↓
OPENCouncil Chat API
```

---

## 🗂️ S3 Structure

Documents are organized by this convention:

```
s3://opencouncil-municipal-docs/
  ├── conway/
  │   ├── minutes/
  │   │   ├── select_board/
  │   │   │   └── 2024/
  │   │   │       └── selectmen_minutes_2024-01-15.pdf
  │   │   └── planning/
  │   │       └── 2024/
  │   ├── budget/
  │   │   └── 2024/
  │   ├── forms/
  │   └── ordinance/
  ├── ossipee/
  │   └── ...
  └── [other towns]/
```

**Pattern:** `{town}/{category}/{board?}/{year?}/{filename}.pdf`

---

## 📋 Document Categories

Auto-detected based on filename and URL patterns:

| Category | Examples |
|----------|----------|
| `minutes` | Board meeting minutes |
| `budget` | Town budgets, warrant articles, financial reports |
| `ordinance` | Zoning ordinances, bylaws, regulations |
| `zoning` | Zoning maps, land use documents |
| `planning` | Master plans, site plans |
| `election` | Ballots, voting information |
| `form` | Permit applications, license forms |
| `report` | Annual town reports |
| `agenda` | Meeting agendas |
| `policy` | Town policies, procedures |
| `misc_other` | Unclassified documents |

---

## 🚀 Usage

### Single Town Crawl

```bash
# Crawl one town
npm run crawl:documents -- --town Conway --url https://conwaynh.gov/

# With options
npm run crawl:documents -- \
  --town Ossipee \
  --url https://www.ossipee.org/ \
  --max 200 \              # Max documents (default: 500)
  --dry-run                # Test without downloading

# Re-download existing files
npm run crawl:documents -- \
  --town Conway \
  --url https://conwaynh.gov/ \
  --no-skip-existing
```

### Batch Crawl All Towns

```bash
# Crawl all 16 successful Carroll County towns
npm run crawl:documents:batch

# This will:
# 1. Read carroll-county-towns.json
# 2. Filter to towns with successful profiles
# 3. Crawl each town's documents
# 4. Upload to S3
# 5. Generate summary report
```

---

## 🔄 Ingestion Pipeline

After documents are in S3, run the ingestion pipeline:

### Step 1: Discovery
Scans S3 and adds new files to the database queue:

```bash
npm run ingest:discover

# This creates database entries with status="pending"
```

### Step 2: Process Queue
Uploads pending files to Gemini File Search stores:

```bash
npm run ingest:worker

# This:
# - Gets or creates town-specific Gemini stores
# - Uploads PDFs to Gemini
# - Updates database status to "synced"
# - Handles errors and retries
```

### Step 3: All-in-One
Run both discovery and processing:

```bash
npm run ingest:all
```

---

## 📊 Expected Results

### Per Town Document Counts (Estimates)

| Town | Estimated Documents |
|------|---------------------|
| Conway | 500-1000 |
| Ossipee | 300-500 |
| Wolfeboro | 400-600 |
| Moultonborough | 300-500 |
| Other towns | 100-300 each |

**Total:** ~5,000-8,000 documents across Carroll County

### By Category

| Category | % of Total |
|----------|------------|
| Minutes | 40-50% |
| Forms | 15-20% |
| Budget/Financial | 10-15% |
| Ordinances | 5-10% |
| Other | 20-30% |

---

## 🔧 How It Works

### Document Discovery

The crawler visits these common paths on each town site:
- `/` (homepage)
- `/documents`
- `/minutes`
- `/agendas`
- `/boards`
- `/selectboard`
- `/planning`
- `/budget`
- `/forms`
- `/elections`

It extracts all links ending in `.pdf`, `.doc`, `.docx`, `.xls`, `.xlsx`

### Categorization Logic

**Pattern matching on filename + URL:**
- `minutes` → keyword: "minutes", "mtg", "meeting"
- `budget` → keyword: "budget", "warrant", "appropriation"
- `ordinance` → keyword: "ordinance", "regulation", "bylaw"
- etc.

**Board detection:**
- `select_board` → "select board", "selectmen"
- `planning` → "planning board"
- `zoning` → "zoning", "ZBA"
- etc.

**Year extraction:**
- Regex: `/20\d{2}/` (2000-2099)
- Extracted from filename or URL path

### S3 Upload

Files are uploaded with:
- **Key:** `{town}/{category}/{board?}/{year?}/{filename}`
- **Metadata:** Upload timestamp, crawler version
- **Content-Type:** `application/pdf` or `application/octet-stream`

### Database Schema

`s3_gemini_sync` table tracks each document:

```typescript
{
  s3Key: "conway/minutes/select_board/2024/file.pdf",
  geminiStoreId: "stores/abc123...",
  geminiDocumentId: "files/xyz789...",
  town: "conway",
  category: "minutes",
  board: "select_board",
  year: "2024",
  status: "synced", // pending | synced | failed
  syncedAt: "2026-02-09T..."
}
```

---

## 🎓 Advanced Usage

### Target Specific Document Types

Modify the crawler to focus on specific categories:

```bash
# Edit document-crawler.ts
# Comment out unwanted paths in pagesToCrawl array
# Or add new specific paths
```

### Custom Categorization

Add new categories in `CATEGORY_PATTERNS`:

```typescript
const CATEGORY_PATTERNS = {
  // ... existing ...
  tax: /tax|property\s*card/i,
  assessment: /assessment|appraisal/i,
};
```

### Retry Failed Documents

Documents that fail to upload are logged. To retry:

```bash
# Check the summary JSON for failed documents
cat town-profiles/conway-documents-2026-02-09.json

# Re-run with --no-skip-existing to retry all
npm run crawl:documents -- \
  --town Conway \
  --url https://conwaynh.gov/ \
  --no-skip-existing
```

---

## 📈 Monitoring & Validation

### Check S3 Upload Status

```bash
# List files for a town
aws s3 ls s3://opencouncil-municipal-docs/conway/ --recursive | head -20

# Count files by category
aws s3 ls s3://opencouncil-municipal-docs/conway/minutes/ --recursive | wc -l
```

### Check Database Status

```sql
-- Count documents by status
SELECT status, COUNT(*) 
FROM s3_gemini_sync 
GROUP BY status;

-- Documents by town
SELECT town, COUNT(*) 
FROM s3_gemini_sync 
GROUP BY town 
ORDER BY COUNT(*) DESC;

-- Failed uploads
SELECT s3_key, error_message 
FROM s3_gemini_sync 
WHERE status = 'failed' 
LIMIT 20;
```

### Check Gemini Stores

```bash
# List all stores (via admin dashboard or API)
# Each town should have its own store:
# - "OPENCouncil - Conway"
# - "OPENCouncil - Ossipee"
# etc.
```

---

## 🐛 Troubleshooting

### Problem: No documents found

**Cause:** Town website structure doesn't match expected paths  
**Solution:**
1. Visit town website manually
2. Find where documents are located
3. Add those paths to `pagesToCrawl` in document-crawler.ts
4. Re-run

### Problem: Downloads fail

**Cause:** Cloudflare blocking, timeouts, or authentication required  
**Solution:**
- Crawler uses Playwright (handles Cloudflare)
- Increase timeout in downloadDocument()
- Some towns require login (skip those docs)

### Problem: Wrong categories

**Cause:** Pattern matching too broad/narrow  
**Solution:**
- Check `CATEGORY_PATTERNS` in document-crawler.ts
- Adjust regex patterns
- Add more specific patterns first (checked in order)

### Problem: S3 upload fails

**Cause:** AWS credentials, permissions, or network  
**Solution:**
```bash
# Check AWS credentials
aws sts get-caller-identity

# Check S3 access
aws s3 ls s3://opencouncil-municipal-docs/

# Verify bucket exists
aws s3api head-bucket --bucket opencouncil-municipal-docs
```

### Problem: Ingestion worker hangs

**Cause:** Gemini API rate limits or large PDF processing  
**Solution:**
- Worker processes in small batches (5 at a time)
- Gemini has rate limits (~60 files/min)
- Large PDFs take longer to process
- Check logs for specific errors

---

## 🔐 Security & Privacy

### Public Documents Only

The crawler only downloads publicly accessible documents. No authentication or login bypass.

### Sensitive Information

Some towns may accidentally publish documents with:
- Personal information (redaction failures)
- Confidential data
- Non-public records

**Policy:** If discovered, notify town clerk immediately and delete from S3.

### Rate Limiting

The crawler includes delays between requests:
- 500ms between documents
- 10 seconds between towns (batch mode)

This prevents overwhelming small town servers.

---

## 📊 Performance

### Single Town Crawl
- **Time:** 5-20 minutes depending on document count
- **Network:** ~100-500 MB download per town
- **S3 upload:** ~100-500 MB upload per town

### Batch Crawl (16 Towns)
- **Time:** 2-4 hours total
- **Network:** ~2-8 GB total
- **Documents:** ~5,000-8,000 files

### Ingestion Processing
- **Time:** 4-8 hours for full batch (Gemini rate limits)
- **Rate:** ~5-10 documents per minute
- **Cost:** Gemini pricing for file storage

---

## 🎯 Roadmap

### Phase 1: Initial Deployment ✅
- [x] Build document crawler
- [x] Integrate with S3
- [x] Auto-categorization
- [ ] Batch crawl Carroll County

### Phase 2: Ingestion
- [ ] Run discovery on all S3 docs
- [ ] Process ingestion queue
- [ ] Verify town stores created
- [ ] Test retrieval in chat

### Phase 3: Testing & Validation
- [ ] Re-run golden set tests
- [ ] Measure quality improvement
- [ ] Identify gaps
- [ ] Manual review sample docs

### Phase 4: Maintenance
- [ ] Weekly re-crawl for new docs
- [ ] Monitor ingestion queue
- [ ] Handle document updates
- [ ] Expand to other counties

---

## 📞 Support

**Files:**
- Crawler: `/scripts/document-crawler.ts`
- Batch: `/scripts/batch-crawl-documents.ts`
- Ingestion: `/server/services/ingestionDiscovery.ts`
- S3 Sync: `/server/services/s3Sync.ts`

**Commands:**
- Single town: `npm run crawl:documents -- --town <Name> --url <URL>`
- Batch: `npm run crawl:documents:batch`
- Discovery: `npm run ingest:discover`
- Processing: `npm run ingest:worker`

**Next Steps:**
1. Test on one town (Conway)
2. Review results
3. Run batch crawl
4. Process ingestion queue
5. Test chat improvements

---

🚀 **Ready to populate OPENCouncil with all of Carroll County's public documents!**
