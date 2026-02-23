# OPENCouncil - NH Municipal Governance Assistant

## Overview
OPENCouncil is an AI-powered assistant for New Hampshire elected officials and municipal workers. It delivers instant, accurate answers to governance questions by utilizing Google's Gemini AI for answer synthesis and pgvector-based semantic search over official municipal documents. The system provides a ChatGPT-style chat interface for end-users and a secure admin panel for document management, featuring an advanced ingestion pipeline with duplicate detection and AI-powered metadata extraction.

## User Preferences
Preferred communication style: Simple, everyday language.

## System Architecture

### Frontend
The frontend is built with React and TypeScript, using Vite for tooling. It leverages `shadcn/ui` (built on Radix UI primitives) and Tailwind CSS for styling. State management is handled by TanStack Query, and client-side routing uses `wouter`.

### Backend
The backend is an Express.js application written in TypeScript, exposing a RESTful API. It uses JWT for authentication in admin routes, bcrypt for password hashing, and Multer for handling file uploads (PDF, DOCX, TXT). Routes are organized into domain-specific routers.

### Data Storage
PostgreSQL is used as the primary database, accessed via Neon's serverless driver and Drizzle ORM. The schema includes tables for `admins`, `chatSessions`, `chatMessages`, `fileBlobs`, `logicalDocuments`, `documentVersions`, `ingestionJobs`, `documentChunks` (with pgvector for embeddings), and `embeddingJobs`. Drizzle Kit manages database migrations.

### Retrieval Backend (pgvector)
Documents are transformed into 768-dimensional vectors using Google Gemini's `text-embedding-004` model and stored in PostgreSQL with the pgvector extension. A two-lane retrieval system performs parallel town-specific and statewide semantic searches.

### AI Integration
Google Gemini is integrated for several core functionalities:
- **Answer synthesis**: Part of the V3 chat pipeline.
- **Embedding generation**: Creates vector representations of documents.
- **Metadata extraction**: Aids in organizing ingested documents.
- **Query planning**: Generates multi-query retrieval plans.
pgvector serves as the sole retrieval backend, with Gemini solely for synthesis, embedding, and metadata.

### Chat Pipeline (V3)
The V3 chat pipeline (`server/chatV2/chatOrchestratorV3.ts`) processes user queries through four main stages:
1.  **Situation Relevance Gating**: Initial assessment of query relevance.
2.  **Planning**: Generates an IssueMap and RetrievalPlanV3.
3.  **Retrieval**: Executes pgvector two-lane semantic search.
4.  **Synthesis**: Generates an answer using Gemini, with RecordStrength tiering.
5.  **Audit**: Validates format, detects drift, and performs repairs.

### Document Ingestion Pipeline (V2)
This pipeline follows a staged workflow: document upload, hashing, text extraction, AI-powered metadata suggestion, admin review, approval/rejection, and indexing. It includes features for detecting meeting minutes and a three-tier town detection system.

### OCR Pipeline (Dual-Provider)
The system supports two OCR providers:
-   **Tesseract.js**: Used by a background worker for low-text PDFs.
-   **AWS Textract**: The primary production-grade asynchronous OCR pipeline for S3-sourced documents. It uses a state machine to manage jobs from queuing to materialization, involving precheck workers and polling workers for text extraction and storage.

### Persistent Object Storage
Document files are stored in Replit Object Storage, with paths starting `/replit-objstore`. Legacy local paths are supported for backward compatibility.

### Crawler / Data Collection
A comprehensive crawler system is in place for data collection (`server/services/crawlerEngine.ts`). Features include:
- **Multi-strategy discovery**: Sitemap parsing, known path probing, breadth-first crawling (depth 5), iframe/embed extraction, external link detection
- **CMS-specific enhancements**: CivicPlus DocumentCenter/AgendaCenter deep crawl with pagination; CivicPlus `/node/{id}/minutes` archive deep crawl with automatic year-page queuing (2013–current); WordPress Media API integration
- **CivicPlus redirect resolution**: URLs like `/{board}/minutes/minutes-{NNN}` and `/{board}/agenda/agenda-{NNN}` are redirect URLs that resolve to actual PDFs at `/sites/g/files/...`. The crawler detects these, uses ZenRows `resolveRedirectViaAPI()` to extract the `Zr-Final-Url` and cookies (headers only, body discarded), then downloads the PDF locally via `fetchDocumentWithCookies()` — the "Extract & Toss" pattern.
- **Hybrid Fast Lane / Heavy Lane architecture**: Default HTTP fetch ("Fast Lane") with enriched headers and rotating UA pool (8 browser variants). When a domain returns 403/429 or protection markers (CAPTCHA/Cloudflare/Turnstile), it's automatically flagged for the "Heavy Lane" — a third-party Web Scraping API (`server/services/scrapingApiClient.ts`). Once flagged, all subsequent requests for that domain route through the API. Requires `SCRAPING_API_KEY` env var (ZenRows/Scrapfly compatible).
- **Interstitial detection and bypass**: Document downloads check Content-Type before saving — if a document URL returns `text/html` instead of the expected binary type, it's flagged as an interstitial trap. The "Extract & Toss" strategy renders the interstitial via the scraping API with JS execution, extracts the final download URL and session cookies, then performs the binary download locally with those cookies attached.
- **Stale run cleanup**: On server startup, crawl runs stuck as "running" for over 30 minutes are automatically marked as failed. Admin panel has "Force Clear" buttons for manually clearing stale runs.
- **Hardened fetching**: 3-attempt retry with backoff, www/non-www fallback, protection detection (Cloudflare/Akamai/CAPTCHA)
- **Attribution tracking**: Each discovered document tracked with source page and discovery strategy via Map-based deduplication
- **Run status taxonomy**: Three-tier status system: `completed` (clean run or negligible errors), `completed_with_errors` (amber — high failure rate, all downloads failed, or many docs blocked by protection), `failed` (red — site completely blocked or unhandled crash). Status reason persisted in `summary.statusReason` and `error_message` column. Rich end-of-crawl summary logs with duration, coverage rate, download success rate, failure breakdown, protection stats.
- **Crash resilience**: Unhandled exceptions in the crawl loop are caught, logged with stack trace, and persisted to the DB with `CRASH:` prefix in `error_message`. Periodic progress updates also persist logs to DB, so even mid-crawl crashes preserve diagnostic data.
- **Log persistence**: Crawl logs stored in `crawler_runs.logs` jsonb column (up to 2000 entries), viewable via expandable run rows in admin UI
- **Batch operations**: "Crawl All Towns" button triggers all active towns with staggered start
- **Analytics dashboard**: Document coverage, CMS distribution, strategy breakdown, per-town bar charts
- **Admin panel**: `client/src/pages/admin-crawler.tsx` with Towns, Runs (with log viewer), Analytics, and State Sources tabs
- **State source crawling**: Separate pipeline for NH state agency documents with configurable target paths and link patterns

## External Dependencies

### Third-Party Services
1.  **Google Gemini API**: Used for answer synthesis, embedding generation, and metadata extraction.
2.  **Neon PostgreSQL**: Provides the database with the pgvector extension for vector search.
3.  **Google Fonts CDN**: Used for web fonts (Inter, JetBrains Mono).
4.  **AWS Textract**: For production-grade asynchronous OCR processing.
5.  **Web Scraping API** (ZenRows/Scrapfly): Heavy Lane for protected sites. Requires `SCRAPING_API_KEY` env var.

### Key NPM Packages
*   **Frontend**: `react`, `react-dom`, `@tanstack/react-query`, `wouter`, `@radix-ui/*`, `tailwindcss`, `zod`, `react-hook-form`.
*   **Backend**: `express`, `drizzle-orm`, `@neondatabase/serverless`, `@google/genai`, `bcryptjs`, `jsonwebtoken`, `multer`, `pdf-parse`, `mammoth`, `tesseract.js`.