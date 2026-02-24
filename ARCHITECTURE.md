# OPENCouncil — Technical Architecture Reference

> AI-powered governance assistant for New Hampshire municipal officials. Delivers instant, cited answers about local ordinances, budgets, meeting minutes, and state law (RSA) by combining semantic search over official documents with Google Gemini synthesis.

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Frontend | React 18 + TypeScript, Vite, Tailwind CSS, shadcn/ui (Radix), TanStack Query v5, wouter |
| Backend | Express.js (TypeScript), Multer (file uploads), bcryptjs + JWT (admin auth) |
| Database | Neon PostgreSQL + pgvector extension, Drizzle ORM, Drizzle Kit (migrations) |
| AI | Google Gemini (`gemini-2.5-flash` fast / `gemini-3-flash-preview` high-quality, `gemini-embedding-001` for 768-dim embeddings) |
| Object Storage | Replit Object Storage (document files), AWS S3 (crawler uploads) |
| OCR | Tesseract.js (background worker), AWS Textract (production async pipeline) |
| Scraping | ZenRows/Scrapfly API (protected sites), Google Drive API v3 (public folders) |

---

## File Structure

```
shared/
  schema.ts                    # Drizzle tables, Zod schemas, TypeScript types (source of truth)
  crawler-schema.ts            # Crawler-specific tables (crawlerTowns, crawlerRuns, crawlerDocuments, etc.)
  town-profile-schema.ts       # TownProfile interface (structured town operational data)
  chatNotices.ts               # Chat notice types (warnings, info banners shown to users)

server/
  app.ts                       # Express app setup, middleware chain, worker startup
  index-dev.ts                 # Dev entry point (Vite dev server + Express)
  index-prod.ts                # Production entry point (static serving + Express)
  routes.ts                    # Creates HTTP server, delegates to routes/index.ts
  storage.ts                   # IStorage interface (backward-compat wrapper → modular storage)
  gemini-store.ts              # Gemini File Search store management

  routes/
    index.ts                   # Mounts all route groups
    admin.ts                   # Admin CRUD, login, JWT auth
    chat.ts                    # Chat session CRUD (create/list/get sessions)
    ingestion.ts               # Document ingestion pipeline (upload → review → approve → index)
    ocr.ts                     # OCR pipeline management (Textract state machine)
    crawler.ts                 # Crawler admin API (towns, runs, documents, batch ops)
    crawlerIntel.ts            # Crawler intelligence/assessment endpoints
    storage.ts                 # File download/serve endpoints
    preferences.ts             # User town preference, anonymous identity
    adminUsageRoutes.ts        # LLM cost analytics, usage dashboards
    adminChatAnalyticsRoutes.ts # Chat quality analytics
    debugChatRoutes.ts         # Debug/test endpoints for chat pipeline
    chatTestRoutes.ts          # Golden set test runner

  chatV2/
    chatV2Route.ts             # POST /api/chat/v2/sessions/:id/messages — main chat endpoint
    chatOrchestratorV3.ts      # V3 pipeline orchestrator (stages 0-4)
    router.ts                  # Question classifier (answer type detection)
    plannerV3.ts               # Stage 1: IssueMap + RetrievalPlanV3 generation
    twoLaneRetrieve.ts         # Two-lane retrieval (local + statewide parallel search)
    pgvectorRetrieveAdapter.ts # Adapts retrieval plan → pgvector queries
    synthesizerV3.ts           # Stage 3: Gemini synthesis with RecordStrength tiering
    audit.ts                   # Stage 4: Format validation, drift detection, repair
    simpleAnswer.ts            # Simple path (Gemini File Search grounding)
    complexAnswer.ts           # Complex path with structured synthesis
    composedFirstAnswer.ts     # First-message-in-session special handling
    critic.ts                  # Answer quality scoring
    driftDetector.ts           # Detects when answer drifts from retrieved evidence
    evidenceGate.ts            # Gates answers on evidence availability
    situationExtractor.ts      # Extracts/matches situation context for topic continuity
    sessionSourceDetector.ts   # Detects user-pasted content (articles, minutes)
    scopeUtils.ts              # Scope notes, notices for town/state context
    generateFollowups.ts       # Suggested follow-up question generation
    sources.ts                 # Citation mapping
    types.ts                   # All pipeline types (IssueMap, RecordStrength, etc.)
    chatConfig.ts              # V2 config constants
    chatConfigV3.ts            # V3 config constants

  services/
    embeddingService.ts        # Gemini embedding generation (768-dim, batch support)
    embeddingPipeline.ts       # Full embedding pipeline (chunk → embed → store)
    embeddingStorage.ts        # pgvector CRUD, semantic search, two-lane search
    pgvectorRetrieval.ts       # Enriches search results with document metadata
    metadataExtraction.ts      # AI-powered metadata suggestion from document text
    fileProcessing.ts          # PDF/DOCX/TXT text extraction
    ingestionWorker.ts         # Background ingestion processing
    ingestionDiscovery.ts      # Duplicate detection during ingestion
    blobStorage.ts             # Replit Object Storage abstraction
    crawlerEngine.ts           # Main crawler (~1900 lines, multi-phase discovery + download)
    crawlerState.ts            # Crawler DB state management
    crawlerStateExtensions.ts  # S3 key generation, metadata extraction
    scrapingApiClient.ts       # ZenRows/Scrapfly API client (Heavy Lane)
    googleDriveClient.ts       # Google Drive API v3 client
    textractPipeline.ts        # AWS Textract async OCR state machine
    s3Sync.ts                  # S3 document sync utilities
    s3GeminiSync.ts            # S3 → Gemini File Search sync
    storeResolver.ts           # Resolves town → Gemini store mapping
    chatAnalyticsService.ts    # LLM-powered chat session analysis
    adminUsageService.ts       # Usage/cost aggregation queries
    gapAnalysis.ts             # Document coverage gap analysis
    crawlAssessment.ts         # Pre-crawl site assessment

  storage/
    db.ts                      # Neon PostgreSQL connection (drizzle + sql)
    admins.ts                  # Admin CRUD
    chat.ts                    # Chat session/message CRUD
    documents.ts               # LogicalDocument + DocumentVersion CRUD
    fileBlobs.ts               # FileBlob CRUD (with hash-based dedup)
    ingestion.ts               # IngestionJob CRUD
    analytics.ts               # LLM cost logs, events, chat analytics
    users.ts                   # User + UserIdentity + AnonymousUser CRUD
    ocrJobs.ts                 # OCR job queue management
    crawler.ts                 # Crawler state DB operations
    tempUploads.ts             # Temporary upload management
    s3GeminiSync.ts            # S3-Gemini sync tracking

  auth/
    types.ts                   # ActorContext, IdentityRequest
    middleware.ts              # attachUserIdentity, requireUser, requireRole
    anonymous.ts               # Anonymous user cookie management
    tokens.ts                  # JWT creation/verification
    magicLink.ts               # Magic link auth flow
    index.ts                   # Auth barrel export

  workers/
    downloadWorker.ts          # Background file download worker
    ocrWorker.ts               # Tesseract.js OCR background worker
    ocrWorkerUtils.ts          # OCR helper utilities
    textractWorker.ts          # Textract polling/materialization worker

  middleware/
    auth.ts                    # authenticateAdmin JWT middleware
    rateLimiter.ts             # Rate limiting (20 msg/min chat, general API limits)
    usageLimits.ts             # Per-actor daily cost limits ($0.10 anon, $0.50 free, $10 paying)

  llm/
    modelRegistry.ts           # Centralized model selection per pipeline stage with escalation rules
    callLLMWithLogging.ts      # Wrapper: calls Gemini + logs cost to llmCostLogs table
    pricing.ts                 # Token pricing per model

  utils/
    logger.ts                  # Structured logging (logInfo, logWarn, logError, logDebug)
    llmLogging.ts              # LLM request/response logging with cost tracking
    geminiErrors.ts            # Gemini quota/error handling
    fileSearchLogging.ts       # File Search grounding logging

crawler/                         # Operational scripts & batch tooling (not part of Express server)
  batch-pipeline/              # Batch OCR, embedding export/ingest, S3 sync scripts
  scripts/                     # Ad-hoc crawl scripts, analysis, monitoring, store management
  town-profiles/               # Generated structured town profile data

client/src/
  App.tsx                      # Root: QueryClientProvider, Router (wouter Switch)
  main.tsx                     # Entry point
  index.css                    # Tailwind + theme variables

  pages/
    chat.tsx                   # Main chat UI (public-facing)
    admin-login.tsx            # Admin JWT login
    admin-documents.tsx        # Legacy document management
    admin-documents-v2.tsx     # V2 document management (LogicalDocument/Version)
    admin-ingestion.tsx        # Ingestion pipeline review UI
    admin-bulk-upload.tsx      # Bulk file upload
    admin-ocr-pipeline.tsx     # OCR job management
    admin-crawler.tsx          # Crawler management (towns, runs, analytics, logs)
    admin-recent-minutes.tsx   # Recent meeting minutes viewer
    admin-usage.tsx            # LLM cost/usage dashboard
    admin-chat-analytics.tsx   # Chat quality analysis

  components/
    MessageNotices.tsx         # Chat notice rendering (warnings, info)
    ObjectUploader.tsx         # File upload component
    user-status-bar.tsx        # User identity status display
    ui/                        # shadcn/ui components (40+ primitives)

  hooks/
    use-auth.ts                # Auth state hook
    use-upload.ts              # File upload hook
    use-toast.ts               # Toast notifications
    use-mobile.tsx             # Mobile breakpoint detection

  lib/
    queryClient.ts             # TanStack Query client + apiRequest helper
    utils.ts                   # cn() classname utility
```

---

## Data Model (Key Tables)

### Document Pipeline
- **`fileBlobs`** — Physical files with SHA-256 hashes, OCR status, embedding status, storage path
- **`logicalDocuments`** — Logical docs (e.g., "Conway Zoning Ordinance") with town, board, category
- **`documentVersions`** — Versioned uploads linked to logicalDocuments + fileBlobs
- **`ingestionJobs`** — Pipeline tracking: staging → needs_review → approved → indexed
- **`documentChunks`** — Text chunks with 768-dim pgvector embeddings for semantic search
- **`ocrJobs`** — Textract OCR job queue with state machine tracking

### Chat
- **`chatSessions`** — Sessions with user/anon ownership, town preference, situation context, session sources
- **`chatMessages`** — Messages with role, content, citations, optional file attachments

### Identity
- **`users`** — Core identity (role: user/admin/municipal_admin, defaultTown, isPaying)
- **`userIdentities`** — Multi-provider identity mapping (email, magic_link, google, municipal_sso)
- **`anonymousUsers`** — Cookie-based anonymous tracking, linkable to users on signup

### Crawler
- **`crawlerTowns`** — Town registry with URL, CMS type, stats, Drive folder ID
- **`crawlerRuns`** — Run history with status, logs (jsonb), summary stats
- **`crawlerDocuments`** — Individual document tracking (discovered → downloaded → uploaded)

### Analytics
- **`llmCostLogs`** — Per-call cost tracking (stage, model, tokens, USD cost)
- **`events`** — Generic event tracking (chat_message, session_created, scope_change, etc.)
- **`chatAnalytics`** — LLM-generated session analysis (summary, critique, quality scores)

### Enums & Constants
- Categories: `budget`, `zoning`, `meeting_minutes`, `town_report`, `warrant_article`, `ordinance`, `policy`, `planning_board_docs`, `zba_docs`, `licensing_permits`, `cip`, `elections`, `misc_other`
- Towns: 18 NH towns + `statewide` (Carroll County focus)
- Ingestion statuses: `staging` → `needs_review` → `approved`/`rejected` → `indexed`/`index_failed`

---

## API Routes

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| POST | `/api/chat/v2/sessions/:id/messages` | anon/user | Send message, get AI answer (main chat endpoint) |
| POST/GET | `/api/chat/sessions` | anon/user | Create/list chat sessions |
| GET | `/api/chat/sessions/:id/messages` | anon/user | Get session messages |
| GET/POST | `/api/preferences/*` | anon/user | Town preference, anonymous identity |
| POST | `/api/admin/login` | none | Admin JWT login |
| GET/POST/DELETE | `/api/admin/ingestion/*` | admin JWT | Ingestion pipeline management |
| GET/POST | `/api/admin/ocr/*` | admin JWT | OCR pipeline management |
| GET/POST | `/api/admin/crawler/*` | admin JWT | Crawler management |
| GET | `/api/admin/usage/*` | admin JWT | Cost/usage analytics |
| GET | `/api/admin/chat-analytics/*` | admin JWT | Chat quality analytics |
| GET | `/api/admin/documents/*` | admin JWT | Document management |

---

## Chat Pipeline (V3) — How Questions Get Answered

Entry: `POST /api/chat/v2/sessions/:id/messages` → `chatV2Route.ts` → `chatOrchestratorV3.ts`

### Stage 0: Situation Relevance Gate
- Checks if stored situation context (topic continuity) applies to new question
- Prevents "sticky context" leakage (e.g., boardwalk vote appearing in budget questions)
- Uses heuristic keyword/entity matching (`situationExtractor.ts`)

### Stage 1: Plan (`plannerV3.ts`)
- Gemini generates an **IssueMap**: entities, legal topics, legal salience score, requested output type
- Creates a **RetrievalPlanV3**: separate local queries (town-specific) and state queries (RSA/statewide)
- Each query gets a purpose label and priority

### Stage 2: Retrieve (`pgvectorRetrieveAdapter.ts` → `twoLaneRetrieve.ts`)
- **Two-lane parallel search**: local lane (town-filtered) + state lane (statewide docs)
- Each query from the plan is embedded via `gemini-embedding-001` and searched against pgvector
- Results deduplicated, scored by similarity, merged with coverage tracking
- Typically returns 5-15 chunks per lane

### Stage 3: Synthesize (`synthesizerV3.ts`)
- Computes **RecordStrength** tier: `STRONG` (high similarity, multiple sources) / `MODERATE` / `THIN` / `NONE`
- RecordStrength controls answer confidence, hedging language, and length
- Gemini generates structured answer with: markdown content, assumptions, limitations, follow-ups
- Answer type routing: `QUICK_PROCESS` (120-220 words), `EXPLAINER` (180-320 words), `RISK_DISPUTE` (250-450 words)
- Render style: `PROSE` (default civic memo style) or `LIST` (when user asks for checklist/steps)

### Stage 4: Audit (`audit.ts`)
- Format validation (markdown structure, length bounds)
- Drift detection — checks if answer strays from retrieved evidence
- Optional repair pass if audit fails
- Selects better of original vs. repaired answer

### Output
Returns `ChatV2Response`: message content, answer metadata (complexity, critic scores), source citations, suggested follow-ups.

---

## Crawler System

Entry: `server/services/crawlerEngine.ts` (~1900 lines)

### Discovery Phases
1. **Phase 1**: Sitemap parsing (`/sitemap.xml`)
2. **Phase 2**: Known path probing (common municipal URL patterns)
3. **Phase 3**: CMS-specific deep crawl
   - 3a: CivicPlus DocumentCenter/AgendaCenter with pagination
   - 3b: CivicPlus minutes archive (`/node/{id}/minutes`) with year-page queuing
   - 3c: Google Drive folder enumeration (recursive, via Drive API v3)
4. **Phase 4**: Breadth-first spider (depth 5) with link extraction

### Download Pipeline
- **Fast Lane**: Direct HTTP fetch with rotating UA pool (8 browser variants)
- **Heavy Lane**: ZenRows/Scrapfly API for 403/429/CAPTCHA-protected sites (auto-flagged per domain)
- **Interstitial bypass**: Detects HTML returned for document URLs, renders via API, extracts real download URL
- **CivicPlus redirect resolution**: "Extract & Toss" pattern — resolves redirect via API headers, downloads PDF locally with cookies

### Resilience
- Incremental discovery persistence (batch upserts to DB during each phase)
- Status-rank protection: `discovered` < `failed` < `uploaded` (re-discovery never downgrades)
- Crash resilience with periodic progress persistence
- Resume Downloads mode (skips discovery, retries failed/discovered documents)
- Stale run cleanup on server startup

### Storage
- Documents uploaded to S3 (`opencouncil-municipal-docs` bucket)
- S3 keys follow pattern: `{town-slug}/{category}/{board}/{year}/{filename}`

---

## Embedding / RAG Pipeline

1. **Text Extraction**: PDF (pdf-parse), DOCX (mammoth), TXT (direct read), OCR fallback
2. **Chunking**: ~2000 chars per chunk, 200 char overlap (`embeddingPipeline.ts`)
3. **Embedding**: `gemini-embedding-001` model, 768 dimensions, batch size 100
4. **Storage**: `document_chunks` table with pgvector column, indexed for cosine similarity
5. **Search**: `semanticSearch()` and `twoLaneSemanticSearch()` in `embeddingStorage.ts`
6. **Change Detection**: Content hash (MD5) on fileBlobs tracks when re-embedding is needed

---

## Auth Model

### Public Users
- Anonymous: Cookie-based (`oc_anon_id`), tracked in `anonymousUsers` table
- Registered: Magic link email auth, stored in `users` + `userIdentities`
- Session token in `oc_session` cookie, verified via JWT

### Admin
- Separate `admins` table with bcrypt password hashes
- JWT-based auth for all `/api/admin/*` routes
- Admin middleware: `authenticateAdmin` (in `server/middleware/auth.ts`)

### Identity Tracking
- Every chat request gets an `ActorContext` (actorType: "user" | "anon", with IDs)
- Anonymous users can be linked to registered users on signup
- All LLM costs and events tracked per-actor

---

## Key Environment Variables

| Variable | Purpose |
|----------|---------|
| `DATABASE_URL` | Neon PostgreSQL connection string |
| `GEM_API_KEY` | Google Gemini API key (synthesis + embeddings) |
| `JWT_SECRET` | Admin JWT signing secret |
| `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` | S3 + Textract access |
| `S3_BUCKET` | S3 bucket for crawler uploads (default: `opencouncil-municipal-docs`) |
| `SCRAPING_API_KEY` | ZenRows/Scrapfly API key (Heavy Lane) |
| `GOOGLE_DRIVE_API_KEY` | Google Drive API key (Drive folder crawling) |

---

## Request Middleware Chain

Every request flows through (in order, configured in `server/app.ts`):
1. `express.json()` + `express.urlencoded()` + `cookieParser()`
2. `generalApiLimiter` — rate limiting for all API routes
3. `attachAnonymousIdentity` — reads/creates `oc_anon_id` cookie, creates `anonymousUsers` row
4. `attachUserIdentity` — reads `oc_session` cookie, verifies JWT, attaches `req.actor`
5. Route-specific middleware: `authenticateAdmin` (admin JWT), `chatMessageLimiter` (20/min), `checkUsageLimits` (daily cost caps)

Workers started on boot: `startOcrWorker()` (Tesseract), `startTextractWorkers()` (Textract polling)

---

## LLM Model Registry

Centralized in `server/llm/modelRegistry.ts`. Two-tier model regime:

| Stage | Default Model | Escalation |
|-------|--------------|------------|
| router, retrievalPlanner, followups, critic, evidenceGate | `gemini-2.5-flash` (fast) | — |
| simpleAnswer, complexSummary, complexSynthesis | `gemini-3-flash-preview` (high-quality) | Escalated for composed answers or user artifacts |
| degraded | `gemini-2.5-flash` | Fallback on errors |

All models overridable via env vars (`MODEL_ROUTER`, `MODEL_PLANNER`, etc.)

---

## Conventions & Patterns

- **Types first**: All data models defined in `shared/schema.ts` with Drizzle tables + Zod insert schemas + TypeScript types
- **Thin routes**: Route handlers validate with Zod, delegate to storage layer or services
- **Modular storage**: `server/storage/` has per-domain modules (admins, chat, documents, etc.)
- **Structured logging**: All server logs use `logInfo`/`logWarn`/`logError`/`logDebug` from `server/utils/logger.ts` with structured metadata objects
- **LLM cost tracking**: Every Gemini call logged to `llmCostLogs` with stage, model, token counts, USD cost
- **Frontend data fetching**: TanStack Query with default fetcher — just set `queryKey: ['/api/...']`, no custom `queryFn` needed
- **Frontend mutations**: Use `apiRequest` from `@lib/queryClient` for POST/PATCH/DELETE, then invalidate by queryKey
- **Test IDs**: All interactive/meaningful elements get `data-testid` attributes
- **No Docker**: Runs on Replit's NixOS environment with `npm run dev` (Vite dev server + Express backend on same port)
