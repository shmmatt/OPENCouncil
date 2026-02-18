# OPENCouncil - NH Municipal Governance Assistant

## Overview
OPENCouncil is an AI-powered assistant designed for New Hampshire elected officials and municipal workers. It provides instant, accurate answers to governance questions by leveraging Google's Gemini AI for answer synthesis, with pgvector-based semantic search over official municipal documents. The system features a ChatGPT-style chat interface for end-users and a secure admin panel for document management, including an advanced ingestion pipeline with duplicate detection and AI-powered metadata extraction.

## User Preferences
Preferred communication style: Simple, everyday language.

## Recent Changes
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

### OCR Pipeline
Automatic OCR for scanned PDFs using Tesseract.js. Background worker detects low-text PDFs, processes via OCR, and triggers re-indexing into the embedding system.

### Persistent Object Storage
Document files stored in Replit Object Storage (`server/services/blobStorage.ts`). Paths starting with `/replit-objstore` use cloud storage; legacy local paths supported for backward compatibility.

### Crawler / Data Collection
All crawler-related code, scripts, logs, and data are organized under `crawler/`:
- `crawler/scripts/` - Crawling scripts, analysis tools, monitoring
- `crawler/batch-pipeline/` - Batch embedding and OCR pipeline
- `crawler/town-profiles/` - Per-town document profiles and crawl results
- `crawler/crawl-logs/` - Crawl execution logs
- `crawler/archive/` - Legacy crawlers and migration scripts

## External Dependencies

### Third-Party Services
1. **Google Gemini API**: Answer synthesis, embedding generation, metadata extraction
2. **Neon PostgreSQL** (with pgvector extension): Database + vector search
3. **Google Fonts CDN**: Web fonts (Inter, JetBrains Mono)

### Key NPM Packages
* **Frontend**: `react`, `react-dom`, `@tanstack/react-query`, `wouter`, `@radix-ui/*`, `tailwindcss`, `zod`, `react-hook-form`
* **Backend**: `express`, `drizzle-orm`, `@neondatabase/serverless`, `@google/genai`, `bcryptjs`, `jsonwebtoken`, `multer`, `pdf-parse`, `mammoth`, `tesseract.js`
* **Development**: `vite`, `tsx`, `esbuild`, `drizzle-kit`, `typescript`
