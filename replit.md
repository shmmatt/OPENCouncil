# OPENCouncil - NH Municipal Governance Assistant

## Overview
OPENCouncil is an AI-powered assistant designed to support New Hampshire elected officials and municipal workers. Its core function is to provide instant, accurate answers to governance questions by leveraging Google's Gemini AI and performing semantic searches over official municipal documents. The project aims to improve local governance efficiency and transparency by making municipal information readily accessible and actionable.

## User Preferences
Preferred communication style: Simple, everyday language.

## System Architecture

### Frontend
The frontend is built with React, TypeScript, Vite, `shadcn/ui`, and Tailwind CSS, ensuring a modern and responsive user interface. State management uses TanStack Query, and client-side routing is handled by `wouter`.

### Backend
The backend is an Express.js application written in TypeScript, providing a secure RESTful API with JWT for authentication, bcrypt for password hashing, and Multer for file uploads.

### Data Storage
PostgreSQL, hosted on Neon and accessed via Drizzle ORM, stores chat sessions, documents, and document chunks with pgvector embeddings for efficient retrieval.

### Retrieval Backend
A hybrid retrieval system combines pgvector-based semantic search with PostgreSQL full-text search. It uses Reciprocal Rank Fusion (RRF) to merge results, incorporating temporal re-ranking and document-type weighting for enhanced relevance.

### AI Integration
Google Gemini powers answer synthesis, embedding generation, metadata extraction, and sophisticated query planning for multi-query retrieval.

### Chat Pipeline (V3)
The V3 chat pipeline implements a self-reflective RAG (Retrieval Augmented Generation) approach with **three-lane parallel retrieval**: Local, Statewide, and SAU (School Administrative Unit). It processes user queries through stages including situation relevance gating, planning, hybrid retrieval, and AI-powered synthesis. It also features a conditional "second hop" retrieval for refining answers and optimizes for latency through parallel retrieval, streaming responses via Server-Sent Events (SSE), and asynchronous follow-up generation.

#### SAU Lane (Third Retrieval Lane)
SAUs (School Administrative Units) are regional school districts that span multiple NH towns and administer a large share of local property taxes. The SAU lane enables retrieval of school-related documents across all member towns of a user's SAU.

- **Town-to-SAU Mapping** (`server/chatV2/sauMapping.ts`): Maps NH towns to their SAU IDs (e.g., "Ossipee" → "SAU 49") and provides inverse lookups (SAU → member towns). Covers Carroll, Coos, Grafton, and Belknap counties.
- **Intent-Based Gating** (`shouldTriggerSauLane()`): The SAU lane only activates when the user's question involves school/education topics (keywords: budget, tax, school, education, SAU, superintendent, school board, tuition, adequacy aid, etc.).
- **Multi-Town Retrieval**: When active, the SAU lane queries documents tagged with any member town of the SAU using the existing `towns[]` filter in the pgvector search.
- **Citation Labels**: SAU documents use `[A1]`, `[A2]`, etc. (A for Administrative unit), distinct from `[L1]` (Local) and `[S1]` (State).
- **Synthesis**: The synthesizer explicitly distinguishes between town/municipal actions and SAU/school district actions in its guidance to the LLM.

### Document Ingestion Pipeline (V2)
This pipeline manages the document lifecycle from upload to indexing, featuring duplicate detection, AI-powered metadata suggestion, and a multi-tier town detection system.

### OCR Pipeline
A dual-provider OCR system utilizes Tesseract.js for low-text PDFs and AWS Textract for production-grade asynchronous OCR, ensuring comprehensive text extraction from various document formats.

### Persistent Object Storage
Document files are stored in Replit Object Storage, providing scalable and secure storage.

### Crawler / Data Collection
A sophisticated crawler system collects data using multi-strategy discovery (sitemaps, BFS, CMS-specific enhancements) and a hybrid "Fast Lane / Heavy Lane" architecture for resilient fetching. It supports town-level, state-level, and SAU-level document collection, including integrations with Google Drive and CourtListener API.

**County Coverage:** Carroll, Coos, Grafton, and Belknap counties (northern NH and Lakes Region). County town data files live in `crawler/scripts/{county}-county-towns.json`. New counties can be seeded into the database via `npx tsx crawler/scripts/seed-new-counties.ts`.

**Crawl Queue:** The crawler engine enforces a max of 3 concurrent crawls (`MAX_CONCURRENT_CRAWLS` in `server/services/crawlerEngine.ts`). Batch crawls (trigger-all, county batch) use `enqueueCrawl()` which queues excess towns and auto-dequeues as slots free up. Queue status is available via `GET /api/admin/crawler/queue` and clearable via `POST /api/admin/crawler/queue/clear`. The admin panel shows county filtering, batch county crawl buttons, and a queue status badge.

**Town Name Registry:** `NH_TOWNS` in `shared/schema.ts` is the single source of truth for all known NH town names. All other files (chatV2 router, simpleAnswer, etc.) import from there — no duplicate lists.

#### SAU Crawling Infrastructure
SAU (School Administrative Unit) crawling follows the same patterns as town/state crawling but targets school district websites.

**Database Tables** (`shared/crawler-schema.ts`):
- `crawler_sau_sources`: Master registry of SAU sources (name, slug, sauId, baseUrl, memberTowns JSON, county, targetPaths, linkPatterns, excludePatterns, maxPages, status, crawl stats)
- `crawler_sau_source_runs`: Run history per SAU source (mode, status, stats)
- `crawler_sau_documents`: Document registry (url, urlHash unique, title, s3Key, category, status, fileBlobId FK)

**Storage Layer** (`server/storage/crawlerSau.ts`): Full CRUD for SAU sources, runs, and documents.

**Engine Functions** (`server/services/crawlerEngine.ts`):
- `startSauCrawl(source, options)` / `executeSauCrawl()`: 5-phase crawl (sitemap → known paths → BFS → document download → file_blob bridging)
- `generateSauS3Key(slug, url, filename)`: S3 key pattern `sau/{slug}/{subpath}/{filename}`
- `bridgeSauDocToFileBlob(sauDocId)`: Bridges SAU docs to main file_blobs table for embedding pipeline

**Crawl State** (`server/services/crawlerState.ts`): Extended with `recordSauDocument`, `batchRecordSauDocuments`, `getAllSauDocumentUrls`, `getResumableSauDocuments`, `updateSauRunProgress`.

**API Routes** (`server/routes/crawlerIntel.ts`):
- `GET/POST /api/crawler-intel/sau-sources`: List/create SAU sources
- `GET/PATCH /api/crawler-intel/sau-sources/:slug`: Get/update single source
- `GET /api/crawler-intel/sau-sources/:slug/documents`: List documents
- `GET /api/crawler-intel/sau-sources/:slug/runs`: Run history
- `POST /api/crawler-intel/sau-sources/:slug/crawl`: Trigger crawl
- `GET /api/crawler-intel/sau-sources/:slug/progress`: Live crawl progress
- `POST /api/crawler-intel/sau-sources/:slug/abort`: Abort active crawl

**Seeded Carroll County SAUs** (via `server/scripts/seed-sau-sources.ts`):
- SAU 9 (Mt. Washington Valley): Conway, Albany, Bartlett, Chatham, Eaton, Freedom, Hart's Location, Jackson, Madison, Tamworth — https://www.sau9.org
- SAU 49 (Governor Wentworth Regional): Wolfeboro, Ossipee, Tuftonboro, Effingham, Brookfield, New Durham — https://www.gwrsd.org
- SAU 45 (Moultonborough): Moultonborough only — https://www.moultonboroughschool.com
- SAU 2 (Inter-Lakes): Meredith, Center Harbor, Sandwich — https://www.interlakes.org

**Embedding Pipeline Integration** (`server/services/embeddingPipeline.ts`):
- `fetchReadyBlobs` JOINs `crawler_sau_documents` + `crawler_sau_sources` so SAU docs resolve metadata
- SAU documents get tagged with `metadata.sau = "SAU 9"` and `metadata.sourceType = "sau"` in document_chunks
- `embeddingStorage.ts` search functions support filtering by `metadata.sau` field
- `pgvectorRetrieveAdapter.ts` SAU lane passes `sauId` filter for precise SAU document retrieval

**Admin UI**: "SAU Sources" tab in the admin crawler panel (`client/src/pages/admin-crawler.tsx`) with dashboard table, detail view (overview/documents/run history sub-tabs), crawl controls, and config editor.

### OC Research Module
The OC Research tab provides analytical tools for municipal data analysis, including a **Development Friction Report**. This report uses a multi-phase pipeline to:
1.  Retrieve full meeting text documents.
2.  Detect agenda-item boundaries via LLM analysis.
3.  Extract structured JSON data from each agenda item using Gemini.
4.  Perform deterministic entity resolution to deduplicate and merge project timelines, handling address normalization and temporal gaps.
5.  Classify each application by `projectType` (Residential/Commercial/Mixed-Use) and `applicantType` (Citizen/Owner vs Professional) using keyword-based heuristics.
6.  Compute statistical insights including: time-to-decision, friction categories, representation gap (citizen vs. pro outcomes), residential vs. commercial timelines, attrition curve (chronological milestones only), and average days added by constraint.
7.  Generate narrative insights using Gemini based on the computed statistics.
8.  Support re-analysis of existing report data without re-crawling.

#### Key Data Structures
- **Approval Funnel**: Base outcomes (Approved, Denied, Withdrawn/Abandoned) as % of total apps. Overlapping modifiers (Approved w/ Conditions, Approved After Delay, Appeals Filed, Appeal Successes) stored separately in `applicationModifiers`.
- **Attrition Curve**: Chronological milestones only (Pre-Hearing, After 1st Hearing, After Multiple Hearings) with static descriptions.
- **Days Added by Constraint**: `daysAddedByConstraint` correlates friction triggers with avg timeline deltas.
- **Terminology**: "Ghost Projects" renamed to "Withdrawn/Abandoned" throughout.

#### Dashboard Widgets
1. Summary stats grid (Unique Projects, Date Range, Approval Rate)
2. Funnel Visualization + Application Modifiers
3. The Representation Gap (no Delta column)
4. Residential vs. Commercial Timelines (no Top Friction column)
5. The Attrition Curve (descriptions, no example projects)
6. Average Days Added by Constraint (horizontal bar chart)
7. Top Friction Triggers (consolidated from Friction Matrix + Ordinance Hit List)
8. Time-to-Decision (line chart + category breakdown)
9. Predictive Insights
10. Extracted Applications (closed accordion)

Removed: Standard Conditions, Most Contested Projects, State vs. Local Delays.

#### Report Export
- **PDF**: Summary, funnel+modifiers, top friction triggers, time-to-decision trends, days added by constraint, representation gap, project type comparison, attrition curve, YoY trends, predictive insights. No extracted applications in PDF.
- **CSV**: Full applications table (unchanged).
- **Percentage convention**: 0-100 integers, rendered with `${value}%`.

## External Dependencies

*   **Google Gemini API**: For AI functionalities like answer synthesis, embedding generation, and metadata extraction.
*   **Neon PostgreSQL**: Database hosting with pgvector extension.
*   **Google Fonts CDN**: For web fonts.
*   **AWS Textract**: For production-grade OCR processing.
*   **Web Scraping API (ZenRows/Scrapfly)**: For handling protected websites during crawling.
*   **Google Drive API v3**: For crawling public Google Drive folders.
*   **CourtListener REST API**: For fetching NH Supreme Court slip opinions.