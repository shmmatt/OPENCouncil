# OPENCouncil Batch Embedding Pipeline

**Architecture shift: From "script mentality" to "data engineering"**

This pipeline handles 200k+ documents without memory issues by:
1. **Offloading compute to Google** - Batch API processes embeddings on their servers
2. **Streaming locally** - No large arrays, no OOM
3. **PostgreSQL COPY** - Bulk import is 10x faster than INSERT

## The 3-Phase Pipeline

```
┌─────────────┐      ┌─────────────┐      ┌─────────────┐
│   EXPORT    │  →   │    EMBED    │  →   │   INGEST    │
│  (Node.js)  │      │ (Gemini)    │      │   (COPY)    │
│             │      │             │      │             │
│ Stream docs │      │ Batch API   │      │ Load into   │
│ to .jsonl   │      │ (24h async) │      │ pgvector    │
└─────────────┘      └─────────────┘      └─────────────┘
     Local              Google              PostgreSQL
```

## Phase 1: Export (`export-to-jsonl.ts`)

Streams documents from Neon into a `.jsonl` file formatted for Gemini Batch API.

```bash
npx tsx batch-pipeline/export-to-jsonl.ts --county carroll
```

Output: `data/carroll-county-export.jsonl`

## Phase 2: Embed (Gemini Batch API)

Upload the .jsonl to Google Cloud, they process it, you download results.

```bash
# See BATCH-API-GUIDE.md for full instructions
gcloud ai gemini batch-embeddings create \
  --input-file=data/carroll-county-export.jsonl \
  --output-file=data/carroll-county-embeddings.jsonl
```

**Key benefits:**
- 50% cheaper than real-time API
- No memory pressure (runs on Google's servers)
- Handles any volume

## Phase 3: Ingest (`ingest-embeddings.ts`)

Streams the embeddings file into PostgreSQL using COPY.

```bash
npx tsx batch-pipeline/ingest-embeddings.ts --input data/carroll-county-embeddings.jsonl
```

## Directory Structure

```
batch-pipeline/
├── README.md                 # This file
├── BATCH-API-GUIDE.md        # Gemini Batch API instructions
├── export-to-jsonl.ts        # Phase 1: Export documents
├── ingest-embeddings.ts      # Phase 3: Load embeddings
└── utils/
    ├── chunker.ts            # Text chunking logic
    └── db.ts                 # Database connection
data/
├── carroll-county-export.jsonl      # Phase 1 output
└── carroll-county-embeddings.jsonl  # Phase 2 output (from Google)
```

## Partitioning Strategy (Future)

For statewide scale (200k+ docs), partition by county:

```sql
-- Create partitioned table
CREATE TABLE document_chunks_partitioned (
    LIKE document_chunks INCLUDING ALL
) PARTITION BY LIST (county);

-- Create county partitions
CREATE TABLE document_chunks_carroll PARTITION OF document_chunks_partitioned
    FOR VALUES IN ('carroll');
CREATE TABLE document_chunks_strafford PARTITION OF document_chunks_partitioned
    FOR VALUES IN ('strafford');
-- etc.
```

This lets queries filter to a single partition (instant) vs scanning 1M+ vectors.

## Cost Estimates

| County | Docs | Chunks (~5/doc) | Batch API Cost |
|--------|------|-----------------|----------------|
| Carroll | 7,436 | ~37,000 | ~$0.15 |
| All NH (10 counties) | ~200,000 | ~1,000,000 | ~$4.00 |

Batch API is 50% cheaper than real-time embedContent.
