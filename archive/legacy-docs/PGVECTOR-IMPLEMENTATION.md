# pgvector Implementation Guide

## Overview

This document describes the complete pgvector implementation for OPENCouncil's chat and ingestion systems. This replaces Gemini File Search with our own embedding database, giving us:

- **No storage limits** (Gemini had 10GB limit)
- **No per-query costs** (only pay for embedding generation)
- **Full control** over retrieval quality
- **Better performance** (~200-300ms queries)
- **Scalability** for all NH towns

## Architecture

### Components

1. **Database Tables** (`shared/schema.ts`)
   - `document_chunks` - Stores text chunks with 768-dim embeddings
   - `embedding_jobs` - Tracks embedding generation status

2. **Services**
   - `embeddingService.ts` - Generates embeddings via Gemini
   - `embeddingStorage.ts` - Database operations and search
   - `pgvectorRetrieval.ts` - Chat pipeline integration

3. **Integration Points**
   - `twoLaneRetrieve.ts` - Modified to use pgvector when enabled
   - `ingestionWorker.ts` - Auto-generates embeddings for new docs

4. **Migration**
   - `migrate-to-pgvector.ts` - Embeds all existing documents

## Feature Flag

The system is controlled by the `USE_PGVECTOR` environment variable:

```bash
USE_PGVECTOR=true   # Use pgvector
USE_PGVECTOR=false  # Use Gemini File Search (fallback)
```

When enabled, the chat pipeline will:
1. Attempt pgvector retrieval first
2. Fall back to Gemini if pgvector fails
3. Log all operations for monitoring

## Deployment

### Prerequisites

- PostgreSQL database with pgvector extension support (Neon DB)
- Gemini API key for embedding generation
- Docker environment for production

### Automated Deployment

Run the deployment script:

```bash
cd /home/ubuntu/.openclaw/workspace/OPENCouncil
./scripts/deploy-pgvector.sh
```

This script will:
1. Generate and run database migrations
2. Create pgvector extension and indexes
3. Enable `USE_PGVECTOR` flag in `.env`
4. Build and deploy Docker containers
5. Optionally run migration for existing documents

### Manual Deployment Steps

If you prefer manual deployment:

#### 1. Generate Database Migration

```bash
npm run db:generate
npm run db:migrate
```

#### 2. Enable pgvector Extension

```sql
CREATE EXTENSION IF NOT EXISTS vector;

CREATE INDEX document_chunks_embedding_idx 
ON document_chunks 
USING hnsw (embedding vector_cosine_ops);

CREATE INDEX document_chunks_town_idx ON document_chunks (town);
CREATE INDEX document_chunks_category_idx ON document_chunks (category);
```

#### 3. Enable Feature Flag

Add to `.env`:
```bash
USE_PGVECTOR=true
```

#### 4. Rebuild Docker Containers

```bash
sudo docker compose build
sudo docker compose down
sudo docker compose up -d
```

#### 5. Migrate Existing Documents

```bash
sudo docker compose exec api npx tsx scripts/migrate-to-pgvector.ts
```

## Migration Script Details

The `migrate-to-pgvector.ts` script:

- Processes all current document versions
- Skips already-embedded documents
- Chunks text content (1000 chars, 200 char overlap)
- Generates embeddings in batches of 10 documents
- Creates HNSW indexes for fast search
- Provides detailed progress reporting

### Migration Stats

Expected for ~700 documents:
- Total chunks: ~3,500-5,000
- Processing time: ~10-15 minutes
- Cost: < $0.05
- Success rate: 90%+ (some docs have no text)

## Testing

### 1. Verify pgvector is Active

Check logs after asking a question:

```bash
sudo docker logs app-api-1 -f | grep pgvector
```

Expected output:
```
[twoLaneRetrieve] Using pgvector retrieval (feature flag enabled)
[pgvectorRetrieval] Two-lane query: "..." (town: Ossipee)
[pgvectorRetrieval] Retrieved 14 local + 6 statewide chunks (avg similarity: 0.812, 269ms)
```

### 2. Check Embedding Stats

Run this query:

```sql
SELECT 
  town,
  COUNT(DISTINCT document_version_id) as doc_count,
  COUNT(*) as chunk_count
FROM document_chunks
GROUP BY town
ORDER BY chunk_count DESC;
```

### 3. Test Semantic Search

```typescript
import { generateQueryEmbedding } from "./server/services/embeddingService";
import { semanticSearch } from "./server/services/embeddingStorage";

const embedding = await generateQueryEmbedding("zoning regulations");
const results = await semanticSearch(embedding, {
  town: "Ossipee",
  limit: 10,
});

console.log(`Found ${results.length} results`);
results.forEach(r => {
  console.log(`${r.similarity.toFixed(3)}: ${r.chunk.content.slice(0, 100)}...`);
});
```

## Monitoring

### Key Metrics

1. **Query Performance**
   - Target: <300ms per query
   - Watch for: Slow queries (>500ms)

2. **Similarity Scores**
   - Target: >0.7 average
   - Watch for: Low scores (<0.5) = poor retrieval

3. **Coverage**
   - Target: 90%+ documents embedded
   - Watch for: Failed embedding jobs

### Log Messages

Look for these in production logs:

**Success:**
```
[pgvectorRetrieval] Retrieved 14 local + 6 statewide chunks (avg similarity: 0.812, 269ms)
```

**Fallback:**
```
[twoLaneRetrieve] pgvector retrieval failed, falling back to Gemini
```

**Errors:**
```
[embeddingStorage] Semantic search failed
```

## Ingestion Pipeline

New documents automatically get embeddings:

1. Document is uploaded/ingested
2. `createUnifiedDocumentEntry()` creates document version
3. If `USE_PGVECTOR=true`, embeddings are generated
4. Chunks are inserted into `document_chunks`
5. `embedding_jobs` tracks completion

**Non-blocking:** If embedding generation fails, document ingestion still succeeds.

## Cost Analysis

### Embedding Generation

- Model: `text-embedding-004` (Gemini)
- Cost: ~$0.000125 per 1,000 tokens
- Average document: ~2,000 tokens
- **Per document: ~$0.00025**

### Query Costs

- **pgvector:** $0 per query (just database CPU)
- **Gemini File Search:** ~$0.01-0.05 per query

### Savings

For 1,000 queries/day:
- Gemini: $10-50/day = $300-1,500/month
- pgvector: $0/day = $0/month (after initial embedding)

**ROI:** Pays for itself after ~1 day of production usage.

## Rollback Plan

### Quick Rollback (Keep Embeddings)

1. Disable feature flag:
   ```bash
   sed -i 's/USE_PGVECTOR=true/USE_PGVECTOR=false/' .env
   sudo docker compose restart api
   ```

2. System reverts to Gemini File Search
3. Embeddings remain in database for future use

### Full Rollback (Remove Changes)

1. Revert code changes:
   ```bash
   git checkout HEAD -- server/chatV2/twoLaneRetrieve.ts
   git checkout HEAD -- server/services/ingestionWorker.ts
   ```

2. Rebuild and deploy:
   ```bash
   sudo docker compose build
   sudo docker compose up -d
   ```

3. Optionally drop tables:
   ```sql
   DROP TABLE IF EXISTS document_chunks CASCADE;
   DROP TABLE IF EXISTS embedding_jobs CASCADE;
   ```

## Troubleshooting

### Issue: No pgvector messages in logs

**Cause:** Feature flag not enabled or build didn't include changes

**Fix:**
```bash
grep USE_PGVECTOR .env  # Should show =true
sudo docker compose restart api
```

### Issue: "relation document_chunks does not exist"

**Cause:** Migration didn't run

**Fix:**
```bash
npm run db:migrate
# Or manually create tables (see schema.ts)
```

### Issue: "function vector_cosine_ops does not exist"

**Cause:** pgvector extension not enabled

**Fix:**
```sql
CREATE EXTENSION IF NOT EXISTS vector;
```

### Issue: Low similarity scores (<0.5)

**Cause:** Text chunking or query not optimized

**Fix:**
- Adjust `CHUNK_SIZE` in embeddingService.ts
- Tune `similarityThreshold` in pgvectorRetrieval.ts
- Review query rewriting in twoLaneRetrieve.ts

### Issue: Migration script fails

**Cause:** Usually missing text content or API rate limits

**Fix:**
- Check logs for specific document failures
- Re-run migration (it skips completed docs)
- Adjust batch size if hitting rate limits

## Performance Tuning

### 1. Chunk Size

Current: 1000 chars with 200 char overlap

- **Smaller chunks** = More precise, slower
- **Larger chunks** = More context, less precise

### 2. Similarity Threshold

Current: 0.5

- **Higher threshold** = Fewer, higher quality results
- **Lower threshold** = More results, some noise

### 3. Index Type

Current: HNSW (fast, approximate)

Alternative: IVFFlat (slower, more accurate)

```sql
-- Switch to IVFFlat
DROP INDEX document_chunks_embedding_idx;
CREATE INDEX document_chunks_embedding_idx 
ON document_chunks 
USING ivfflat (embedding vector_cosine_ops)
WITH (lists = 100);
```

### 4. Lane Split

Current: 70% local, 30% statewide (14 + 6 chunks)

Adjust in `pgvectorRetrieval.ts`:
```typescript
const localLimit = options.limit ? Math.ceil(options.limit * 0.7) : 14;
const statewideLimit = options.limit ? Math.floor(options.limit * 0.3) : 6;
```

## Next Steps

1. **Deploy to Production** - Run deployment script
2. **Monitor Performance** - Watch logs for 24-48 hours
3. **Tune Thresholds** - Adjust based on real queries
4. **Scale to All Towns** - Run migration for remaining towns
5. **Remove Gemini Dependency** - Once confident, remove fallback code

## Files Modified/Created

### New Files
- `server/services/embeddingService.ts`
- `server/services/embeddingStorage.ts`
- `server/services/pgvectorRetrieval.ts`
- `scripts/migrate-to-pgvector.ts`
- `scripts/deploy-pgvector.sh`

### Modified Files
- `shared/schema.ts` - Added pgvector tables
- `server/chatV2/twoLaneRetrieve.ts` - Added pgvector integration
- `server/services/ingestionWorker.ts` - Added auto-embedding

### Configuration
- `.env` - Added `USE_PGVECTOR=true`

## Support

For issues or questions:
- Check logs: `sudo docker logs app-api-1 -f`
- Review this documentation
- Check migration stats with embedding queries
- Test with known good queries

## Success Criteria

✅ All containers running
✅ pgvector extension enabled
✅ Migration completed successfully
✅ Queries use pgvector (check logs)
✅ Response times <300ms
✅ Similarity scores >0.7
✅ No fallback to Gemini (unless error)

---

**Status:** Ready for deployment
**Last Updated:** 2026-02-18
**Version:** 1.0
