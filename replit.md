# OPENCouncil - NH Municipal Governance Assistant

## Overview
OPENCouncil is an AI-powered assistant designed for New Hampshire elected officials and municipal workers. It provides instant, accurate answers to governance questions by leveraging Google's Gemini AI for answer synthesis, with pgvector-based semantic search over official municipal documents. The system features a ChatGPT-style chat interface for end-users and a secure admin panel for document management, including an advanced ingestion pipeline with duplicate detection and AI-powered metadata extraction.

## User Preferences
Preferred communication style: Simple, everyday language.

## Recent Changes
- **2026-02-21**: Added Bot Integration endpoints for external crawler bots. New endpoints: `POST /:townSlug/upload-url` (presigned S3 upload URLs), `POST /:townSlug/documents` (single doc registration), `POST /:townSlug/documents/batch` (batch registration up to 100 docs), `POST /:townSlug/runs/report` (crawl run summary reporting). Same endpoints mirrored for state sources under `/state-sources/:slug/`. Includes S3 path convention docs, duplicate detection by URL hash, automatic town stats updates, and complete bot workflow guide with pseudocode example. API spec updated at `crawler/CRAWLER-INTEL-API.md` with full Bot Integration Guide section.
- **2026-02-21**: Added State Source system for statewide document crawling. New schema: `crawler_state_sources`, `crawler_state_source_runs`, `crawler_state_documents` tables. Full CRUD API at `/api/crawler-intel/state-sources` with source registration, profile editing, crawl triggering, document/run history. Fleet summary now includes state source stats. Seeded 6 NH state sources: General Court (RSAs), DRA (budget guidance), DES (environmental regs), OSI (planning guidance), SOS (admin rules), NHMA (municipal handbooks). Admin UI: new "State Sources" tab in Crawler Management with source dashboard, detail view, profile editor, and crawl triggering. API spec updated at `crawler/CRAWLER-INTEL-API.md`.
- **2026-02-21**: Enhanced Crawler Intelligence API with fleet automation, focused crawls, and structured errors. New endpoints: `GET /fleet/status` (all towns ranked by staleness), `GET /fleet/summary` (aggregate stats), `GET /fleet/next-batch` (priority-ordered crawl queue), `POST /towns` (register new towns), `GET /:townSlug/quick-check` (lightweight reassessment check). Extended `POST /:townSlug/crawl` with `targetPaths`, `linkPatterns` (for gap-driven focused crawls), and `callbackUrl` (webhook on completion). All errors now use structured format: `{ error: { code, message, retryable, retryAfterSeconds } }`.
- **2026-02-21**: Added Crawler Intelligence API (`/api/crawler-intel`) for bot-driven crawl automation. Endpoints: town briefing (consolidated state), coverage assessment trigger, gap analysis, bot-triggered crawls (triggerType: "bot"), run history with failure breakdowns, document inventory. API spec at `crawler/CRAWLER-INTEL-API.md`. Route: `server/routes/crawlerIntel.ts`. Optional auth via `CRAWLER_BOT_API_KEY` env var.
- **2026-02-21**: Added structured failure tracking to crawler: FailureType classification (http_404, timeout, captcha_blocked, etc.), per-page error collection, failure counts by type in run summaries, repeat-failure flagging in admin UI. Schema: `shared/crawler-schema.ts`, Crawler: `crawler/scripts/crawler-v3.ts`, UI: `client/src/pages/admin-crawler.tsx`.
- **2026-02-20**: Crawler document deduplication: consolidated 20,356 crawler_documents rows down to 14,593 by merging absolute URLs onto file_blob_id-linked rows and removing redundant duplicates. Fixed UUID vs town-name detection bug in `resolveUrlByStemCandidates`. Added file_blobs fallback in `getCrawledUrlByFileBlobId` for blobs without crawler_document entries. Pagination suffix stripping (`_N`) enables stem-based URL matching across document pages.
- **2026-02-20**: Clickable source citations in chat: pgvectorRetrieveAdapter encodes `fileBlobId` in `[blob:uuid]` prefix format, sources.ts resolves crawled URLs via crawler_documents+crawler_towns join with relative URL normalization, and displays canonical titles from logical_documents. Local docs link to original town website URLs; statewide docs show titles without links.
- **2026-02-20**: Added Crawler Management admin page (`/admin/crawler`) with town dashboard, document/URL inventory browser, run history, town profile editor, and crawl triggering. Backend: `server/storage/crawler.ts` + `server/routes/crawler.ts`. Frontend: `client/src/pages/admin-crawler.tsx`. Added Crawler nav link to admin documents page.
- **2026-02-19**: Full document lifecycle tracking: Added embedding lifecycle columns to `file_blobs` (`content_hash`, `embedding_status`, `chunk_count`, `embedded_at`). Added `file_blob_id` to `document_chunks` and `crawler_documents` for end-to-end lineage. Backfilled 5,842 crawler_documents→file_blobs links and 3,297 content hashes.
- **2026-02-19**: Rewrote batch export/ingest scripts to source from `file_blobs` (source of truth), write `file_blob_id` into chunk metadata, update `embedding_status` lifecycle, and log to `embedding_jobs` table.
- **2026-02-19**: Added version detection script (`crawler/batch-pipeline/version-detect.ts`) for content hash-based change detection and stale chunk cleanup.
- **2026-02-19**: Added Pipeline Status dashboard tab to admin OCR pipeline page showing end-to-end lifecycle funnel (discovered → downloaded → text extracted → exported → indexed).
- **2026-02-19**: Fixed critical schema mismatch — Drizzle `documentChunks` schema now matches actual DB (serial IDs, `document_id`, JSONB `metadata`). All semantic search uses JSONB path expressions for filtering.
- **2026-02-19**: Rewired chat route to use V3 pipeline (`runChatV3Pipeline`) instead of old `askQuestionWithFileSearch`. pgvector retrieval is now fully operational end-to-end.
- **2026-02-19**: Made town filters case-insensitive in embeddingStorage to handle mixed-case data ("Ossipee"/"ossipee", "statewide"/"Statewide").
- **2026-02-18**: Removed Gemini File Search fallback entirely — pgvector is the sole retrieval backend. Gemini is used only for answer synthesis, embedding generation, and metadata extraction.
- **2026-02-18**: Added thin/empty retrieval logging so synthesis stage is aware when source material is limited (Tier C handling).
- **2026-02-18**: Split monolithic `server/routes.ts` (1767 lines) into domain-specific routers under `server/routes/` (admin, ingestion, ocr, storage, chat, preferences).
- **2026-02-18**: Removed dead Prisma schema and dependencies. Drizzle ORM is the sole ORM.
- **2026-02-18**: Fixed 20+ LSP type errors across pgvectorRetrieval, storeResolver, twoLaneRetrieve, routes, embeddingStorage.
- **2026-02-18**: Consolidated crawler-related files (scripts, batch-pipeline, town-profiles, crawl-logs, archive, docs) into `crawler/` directory.

## System Architecture

### Frontend
React + TypeScript using Vite, `shadcn/ui` (Radix UI primitives), and Tailwind CSS. State management with TanStack Query, client-side routing via `wouter`.

### Backend
Express.js (TypeScript) with RESTful API. JWT authentication for admin routes, bcrypt for password hashing, Multer for file uploads (PDF, DOCX, TXT).

**Route Organization** (split into domain routers under `server/routes/`):
- `admin.ts` - Admin auth, document CRUD, bulk upload
- `ingestion.ts` - Ingestion job lifecycle (approve, reject, index, batch-index)
- `ocr.ts` - OCR queue management, status, reprocessing
- `storage.ts` - Storage migration, S3-Gemini sync
- `chat.ts` - Chat sessions, messages, config
- `preferences.ts` - Town preferences, updates/minutes, meta endpoints

### Data Storage
PostgreSQL via Neon's serverless driver and **Drizzle ORM** (sole ORM). Schema includes `admins`, `chatSessions`, `chatMessages`, `fileBlobs`, `logicalDocuments`, `documentVersions`, `ingestionJobs`, `documentChunks` (pgvector), and `embeddingJobs`. Drizzle Kit manages migrations.

### Retrieval Backend (pgvector)
Documents are embedded as 768-dimensional vectors (Gemini text-embedding-004) stored in PostgreSQL via pgvector. The two-lane retrieval system performs parallel local (town-specific) and statewide semantic search.

**Key files**:
- `server/chatV2/pgvectorRetrieveAdapter.ts` - Adapts pgvector search to the V3 pipeline's `V3RetrievalResult` format
- `server/services/embeddingStorage.ts` - pgvector CRUD and semantic search queries
- `server/services/embeddingService.ts` - Embedding generation via Gemini API
- `server/services/pgvectorRetrieval.ts` - Lower-level pgvector retrieval utilities

### AI Integration
Google Gemini is used for:
- **Answer synthesis** (V3 pipeline: Plan → Retrieve → Synthesize → Audit)
- **Embedding generation** (text-embedding-004, 768 dimensions)
- **Metadata extraction** during document ingestion
- **Query planning** (V3 planner for multi-query retrieval plans)

pgvector is the sole retrieval backend. Gemini File Search has been fully removed from the retrieval path.

### Chat Pipeline (V3)
The V3 pipeline (`server/chatV2/chatOrchestratorV3.ts`) runs:
1. **Stage 0**: Situation relevance gating
2. **Stage 1**: Planning (IssueMap + RetrievalPlanV3)
3. **Stage 2**: Retrieval (pgvector two-lane semantic search)
4. **Stage 3**: Synthesis (Gemini, with RecordStrength tiering)
5. **Stage 4**: Audit (format validation, drift detection, repair)

### V2 Document Ingestion Pipeline
Staged workflow: upload → hash → extract text → LLM metadata suggestion → admin review → approve/reject → index. Includes meeting minutes detection and three-tier town detection.

### OCR Pipeline (Dual-Provider)
Two OCR providers are supported:

**Tesseract.js (legacy)**: Background worker in `server/workers/ocrWorker.ts` detects low-text PDFs, processes via Tesseract OCR, and triggers re-indexing.

**AWS Textract (primary)**: Production-grade async OCR pipeline for S3-sourced documents:
- **State machine**: queued → prechecked → textract_running → materialized (or skipped_native / failed)
- **Worker A (Precheck)**: Claims `queued` jobs via `SKIP LOCKED`, validates PDF magic bytes, extracts native text. If native chars >= 1000, marks `skipped_native`. Otherwise starts Textract async job.
- **Worker B (Poll + Materialize)**: Polls Textract `GetDocumentTextDetection`, assembles LINE blocks into text, writes gzipped `.txt.gz` artifact to `derived/text/<docId>.txt.gz` in S3, updates `fileBlobs.ocrText` and marks `materialized`.
- **Key files**: `server/services/textractPipeline.ts`, `server/workers/textractWorker.ts`, `server/storage/ocrJobs.ts`
- **DB table**: `ocr_jobs` (dedicated job queue with priority, backoff, Textract job ID tracking)
- **API routes**: `/api/ocr/textract/stats`, `/api/ocr/textract/enqueue`, `/api/ocr/textract/jobs`, `/api/ocr/textract/reset-stuck`
- **Requires**: `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` secrets; IAM permissions for `s3:GetObject`, `s3:PutObject`, `textract:Start/GetDocumentTextDetection`

### Persistent Object Storage
Document files stored in Replit Object Storage (`server/services/blobStorage.ts`). Paths starting with `/replit-objstore` use cloud storage; legacy local paths supported for backward compatibility.

### Crawler / Data Collection
All crawler-related code, scripts, logs, and data are organized under `crawler/`:
- `crawler/scripts/` - Crawling scripts, analysis tools, monitoring
- `crawler/batch-pipeline/` - Batch embedding and OCR pipeline
- `crawler/town-profiles/` - Per-town document profiles and crawl results
- `crawler/crawl-logs/` - Crawl execution logs
- `crawler/archive/` - Legacy crawlers and migration scripts

**Admin Crawler Management** (`/admin/crawler`):
- Full admin panel for managing crawl jobs, viewing town state, and triggering crawls
- Schema in `shared/crawler-schema.ts`: `crawlerTowns`, `crawlerRuns`, `crawlerDocuments`, `crawlerUrls`, `crawlerSitemaps`
- Storage layer: `server/storage/crawler.ts`
- API routes: `server/routes/crawler.ts` (mounted at `/api/admin/crawler/`)
- Frontend: `client/src/pages/admin-crawler.tsx`
- Features: Town dashboard with stats, document/URL inventory browser, run history, town profile editor (CMS type, custom paths, max pages), crawl triggering

## External Dependencies

### Third-Party Services
1. **Google Gemini API**: Answer synthesis, embedding generation, metadata extraction
2. **Neon PostgreSQL** (with pgvector extension): Database + vector search
3. **Google Fonts CDN**: Web fonts (Inter, JetBrains Mono)

### Key NPM Packages
* **Frontend**: `react`, `react-dom`, `@tanstack/react-query`, `wouter`, `@radix-ui/*`, `tailwindcss`, `zod`, `react-hook-form`
* **Backend**: `express`, `drizzle-orm`, `@neondatabase/serverless`, `@google/genai`, `bcryptjs`, `jsonwebtoken`, `multer`, `pdf-parse`, `mammoth`, `tesseract.js`
* **Development**: `vite`, `tsx`, `esbuild`, `drizzle-kit`, `typescript`
