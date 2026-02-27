# OPENCouncil - NH Municipal Governance Assistant

## Overview
OPENCouncil is an AI-powered assistant designed for New Hampshire elected officials and municipal workers. Its primary purpose is to provide instant, accurate answers to governance questions. It achieves this by synthesizing information using Google's Gemini AI and performing semantic searches over official municipal documents. The project's vision is to enhance local governance efficiency and transparency by making municipal information easily accessible and actionable.

## User Preferences
Preferred communication style: Simple, everyday language.

## System Architecture

### Frontend
The frontend is built with React and TypeScript, utilizing Vite, `shadcn/ui`, and Tailwind CSS for a modern, responsive user interface. State management is handled by TanStack Query, and client-side routing uses `wouter`.

### Backend
The backend is an Express.js application written in TypeScript, providing a RESTful API. It includes JWT for authentication, bcrypt for password hashing, and Multer for file uploads, ensuring secure and efficient data handling.

### Data Storage
PostgreSQL is the primary database, accessed via Neon and Drizzle ORM. It stores various municipal data including chat sessions, documents, and document chunks with pgvector embeddings for efficient retrieval.

### Retrieval Backend
A hybrid retrieval system combines pgvector-based semantic search with PostgreSQL full-text search. This system uses Reciprocal Rank Fusion (RRF) to merge results, and incorporates temporal re-ranking and document-type weighting for enhanced relevance.

### AI Integration
Google Gemini is central to the system, providing capabilities for answer synthesis, embedding generation, metadata extraction, and sophisticated query planning for multi-query retrieval.

### Chat Pipeline (V3)
The V3 chat pipeline implements a self-reflective RAG (Retrieval Augmented Generation) approach. It processes user queries through stages including situation relevance gating, planning, hybrid retrieval, and AI-powered synthesis. It also features a conditional "second hop" retrieval for refining answers when initial context is insufficient.

### Document Ingestion Pipeline (V2)
This pipeline manages document lifecycle from upload to indexing, featuring duplicate detection, AI-powered metadata suggestion, and a multi-tier town detection system.

### OCR Pipeline
A dual-provider OCR system uses Tesseract.js for low-text PDFs and AWS Textract for production-grade asynchronous OCR, ensuring comprehensive text extraction from diverse document formats.

### Persistent Object Storage
Document files are stored in Replit Object Storage, providing scalable and secure storage for all municipal documents.

### Crawler / Data Collection
A sophisticated crawler system is responsible for data collection, featuring multi-strategy discovery (sitemaps, BFS, CMS-specific enhancements), hybrid "Fast Lane / Heavy Lane" architecture for resilient fetching, interstitial detection, and crash resilience. It supports both town-level and state-level document collection, including Google Drive and CourtListener API integrations.

### OC Research Module
The OC Research tab (`/admin/research`) provides analytical tools for municipal data analysis. The **Development Friction Report** uses a full-document pipeline that:
1. **Phase 1** — Retrieves full meeting text from `logical_documents → document_versions → file_blobs` (bypassing pre-chunked RAG segments), filtering by town, board type (Planning/ZBA), and `isMinutes` flag
2. **Phase 2** — Detects agenda-item boundaries via LLM analysis with heuristic regex fallback, splitting each meeting into discrete application discussions
3. **Phase 3** — Sends each agenda item to Gemini (`gemini-2.5-flash`) for structured JSON extraction of site plan applications, with 15k-char sliding windows for oversized items and 3-concurrent-call throttling
4. **Entity Resolution** (`server/services/entityResolution.ts`) — Deterministic, code-based deduplication (no LLM). Multi-key strategy: address normalization (strips Tax Map/Lot suffixes, normalizes street abbreviations), groups by normalized address then applicant name. Merges timelines, picks chronological outcomes, unions friction categories and meeting references. Date normalization via `parseToISO` handles MM/DD/YYYY, ISO, and written-out date formats. Fallback date extraction from meeting reference strings.
5. **Stats Engine** (`entityResolution.ts`) — Computes: 8-category canonical friction matrix from `frictionCategories` arrays, time-to-decision (avg/median overall + by friction category), frequent flyers (top contested projects), funnel stages, year-over-year trends. All deterministic — no LLM.
6. **Narrative Insights** — Compact stats summary (~2KB) sent to Gemini for 5 data-driven insight paragraphs. Structured JSON response with `responseMimeType: "application/json"`. Fallback to code-generated insights on Gemini failure.
7. **Re-analyze Endpoint** — `POST /api/admin/research/friction-report/:id/reanalyze` re-runs entity resolution + stats + Gemini insights on existing report data without re-crawling. Detects already-deduped data and normalizes dates.

Dashboard shows: Unique Projects (from N appearances), Documents Analyzed, Agenda Items, Date Range, Approval Rate, Site Plan Funnel, Ordinance Heatmap (8-category friction matrix), Time-to-Decision card (avg/median + by-category breakdown), Most Contested Projects (frequent flyers with meeting counts, days elapsed, outcome badges), Predictive Insights (5 narrative paragraphs), and expandable applications table. Data stored in `research_reports` table.

#### Canonical Friction Categories
Procedural/Incomplete, Zoning/Dimensional, Environmental/Drainage, Abutter Pushback, State vs. Local Clash, Traffic/Access, Infrastructure, Other

### Ingestion Scripts (crawler/scripts/)
- `bridge-ossipee-minutes.ts` — Bridges crawled documents in `crawler_documents` to `s3_gemini_sync` for the ingestion pipeline
- `ingest-ossipee-minutes.ts` — Creates `logical_documents` → `document_versions` → `file_blobs` links for crawled Ossipee PB/ZBA documents. Extracts meeting dates from OCR text headers.
- `ingest-all-gapped-docs.ts` — General-purpose backfill script that links ALL gapped crawler_documents (any town) to logical_documents. Extracts board names from crawler metadata, S3 path, filename prefixes, and OCR text headers. Supports `--dry-run`, `--limit=N`, and `--town=Name` flags.
- `classify-unknown-boards.ts` — Gemini-powered classification script for "Unknown Board" minutes documents. Uses `gemini-2.5-flash` with `responseMimeType: "application/json"` to classify board names from OCR text headers and extract meeting dates. Concurrency 2, exponential backoff retries. Successfully classified all 342 Unknown Board docs across 14 towns into 52 distinct board types. Zero Unknown Board minutes remaining.

### Pipeline Fix (crawlerEngine.ts)
- `bridgeToFileBlob` now returns the fileBlobId (was void)
- New `bridgeToLogicalDocument` function creates logical_documents + document_versions entries immediately after file_blob creation
- Called at all 4 `bridgeToFileBlob` call sites (Google Drive duplicates, Drive new downloads, regular duplicates, regular new downloads)
- Prevents future "dark data" — crawled documents are immediately linked to the unified document schema

## External Dependencies

1.  **Google Gemini API**: For AI functionalities like answer synthesis, embedding generation, and metadata extraction.
2.  **Neon PostgreSQL**: Database hosting with pgvector extension.
3.  **Google Fonts CDN**: For web fonts.
4.  **AWS Textract**: For production-grade OCR processing.
5.  **Web Scraping API (ZenRows/Scrapfly)**: For handling protected websites during crawling.
6.  **Google Drive API v3**: For crawling public Google Drive folders.
7.  **CourtListener REST API**: For fetching NH Supreme Court slip opinions.