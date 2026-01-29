# S3 to Gemini File Search Sync

Syncs documents from S3 to Gemini File Search stores with database tracking to avoid re-uploading.

## Overview

This feature pulls PDF documents from S3 (organized by town), extracts metadata from paths, and uploads them to town-specific Gemini File Search stores. It tracks sync status in the database to:
- Avoid re-uploading already synced files
- Track failed uploads for retry
- Provide sync status visibility

## Components

### Database Table: `s3_gemini_sync`

Tracks synced files:
- `s3_key` - S3 object key (unique)
- `gemini_store_id` - Which Gemini store it's in
- `gemini_document_id` - Document ID after upload
- `town`, `category`, `board`, `year` - Extracted metadata
- `status` - 'pending' | 'synced' | 'failed'
- `synced_at` - When successfully synced

### Service: `/server/services/s3GeminiSync.ts`

Functions:
- `listS3Town(town)` - List all PDFs for a town from S3
- `getSyncStatus(town)` - Return {total, synced, pending} counts
- `syncTown(town, options)` - Sync pending files
- `extractMetadataFromPath(s3Key)` - Extract metadata from S3 path

### Storage: `/server/storage/s3GeminiSync.ts`

Database operations for sync tracking.

### API Endpoints

All require admin authentication (Bearer token).

#### GET `/api/admin/s3-sync/status?town=conway`
Get sync status for a town.

Response:
```json
{
  "town": "conway",
  "storeId": "fileSearchStores/opencouncil-conway-1knojndjgr4v",
  "s3Total": 924,
  "dbTotal": 5,
  "synced": 5,
  "pending": 0,
  "failed": 0
}
```

#### POST `/api/admin/s3-sync/run`
Trigger sync for a town.

Request:
```json
{
  "town": "conway",
  "limit": 50,
  "dryRun": false
}
```

Response:
```json
{
  "total": 50,
  "uploaded": 48,
  "skipped": 0,
  "failed": 2,
  "errors": [
    {"key": "conway/...", "error": "..."}
  ]
}
```

#### GET `/api/admin/s3-sync/files?town=conway&limit=100`
List S3 files with extracted metadata (for debugging).

## Setup

### 1. Run the Migration

```bash
# Using Drizzle
npx drizzle-kit push

# Or run the SQL directly
psql $DATABASE_URL -f migrations/0001_s3_gemini_sync.sql
```

### 2. Configure Environment

Required environment variables:
- `GEMINI_API_KEY` - Google AI API key
- `DATABASE_URL` - PostgreSQL connection string
- `AWS_ACCESS_KEY_ID` - AWS credentials (optional if using IAM roles)
- `AWS_SECRET_ACCESS_KEY` - AWS credentials
- `AWS_REGION` - AWS region (default: us-east-1)
- `S3_BUCKET` - S3 bucket name (default: opencouncil-municipal-docs)

### 3. Pre-configured Stores

Conway store is pre-configured:
```typescript
const TOWN_STORES = {
  conway: "fileSearchStores/opencouncil-conway-1knojndjgr4v",
};
```

New stores will be created automatically for other towns.

## S3 Path Convention

Documents should be organized as:
```
s3://bucket/town/category/[board/][year/]filename.pdf
```

Examples:
- `conway/minutes/Board_of_Selectmen/2024/01-15-2024-minutes.pdf`
- `conway/budget/2024-budget-proposal.pdf`
- `ossipee/zoning/zoning-ordinance.pdf`

## Testing

### Using the Test Script

```bash
# Check status
npx tsx scripts/test-s3-sync.ts conway status

# List files
npx tsx scripts/test-s3-sync.ts conway list 20

# Dry run
npx tsx scripts/test-s3-sync.ts conway dry-run 5

# Actually sync
npx tsx scripts/test-s3-sync.ts conway sync 5
```

### Using curl

```bash
# Get auth token
TOKEN=$(curl -s -X POST http://localhost:5000/api/admin/login \
  -H "Content-Type: application/json" \
  -d '{"email":"admin@example.com","password":"..."}' | jq -r .token)

# Check status
curl -s "http://localhost:5000/api/admin/s3-sync/status?town=conway" \
  -H "Authorization: Bearer $TOKEN" | jq

# Run sync
curl -s -X POST "http://localhost:5000/api/admin/s3-sync/run" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"town":"conway","limit":5}' | jq
```

## Error Handling

- Failed uploads are marked with `status='failed'` and `error_message`
- Run sync again to retry failed files
- Use `resetFailedSyncs(town)` to reset all failed records to pending
