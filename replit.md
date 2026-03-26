# OPENCouncil - NH Municipal Governance Assistant

## Overview
OPENCouncil is an AI-powered assistant designed to support New Hampshire elected officials and municipal workers. It provides instant, accurate answers to governance questions by leveraging Google's Gemini AI and performing semantic searches over official municipal documents. The project aims to improve local governance efficiency and transparency by making municipal information readily accessible and actionable. Key capabilities include comprehensive document search, AI-powered research, document gap identification, and content generation for community engagement, offering a business vision of revolutionizing local government operations and community engagement through AI.

## User Preferences
Preferred communication style: Simple, everyday language.

## System Architecture

### Frontend
The frontend is built with React, TypeScript, Vite, `shadcn/ui`, and Tailwind CSS, utilizing TanStack Query for state management and `wouter` for routing. The UI/UX prioritizes clarity and ease of use, leveraging modern web development best practices.

### Backend
The backend uses Express.js with TypeScript, providing a secure RESTful API with JWT authentication, bcrypt for password hashing, and Multer for file uploads.

### Data Storage & Retrieval
PostgreSQL, hosted on Neon and using Drizzle ORM, stores chat sessions, documents, and document chunks with pgvector embeddings. A hybrid retrieval system combines pgvector-based semantic search with PostgreSQL full-text search, enhanced by Reciprocal Rank Fusion (RRF), temporal re-ranking, and document-type weighting.

### AI Integration
Google Gemini powers answer synthesis, embedding generation, metadata extraction, multi-query planning, and various analytical tools. Different Gemini model tiers are strategically used for specific tasks to optimize performance and quality, including `FLASH`, `HIGH_QUALITY`, `SUMMARY_MODEL`, and `Content Generation MODEL`.

### Chat Pipeline (V3)
This pipeline implements a self-reflective RAG approach with three-lane parallel retrieval (Local, Statewide, SAU) and situation relevance gating. It optimizes for latency with parallel retrieval, SSE streaming, and asynchronous follow-up generation. Performance optimizations include batch embedding, batch enrichment, and efficient SSE flushing.

### Document Ingestion & OCR
The V2 ingestion pipeline manages document lifecycle, including duplicate detection, AI-powered metadata suggestion, and multi-tier town detection. A dual-provider OCR system uses Tesseract.js and AWS Textract. Documents are stored in Replit Object Storage.

### Crawler / Data Collection
A sophisticated crawler uses multi-strategy discovery (sitemaps, BFS, CMS-specific enhancements) and a hybrid "Fast Lane / Heavy Lane" architecture for town-level, state-level, and SAU-level document collection. An incremental crawling system efficiently discovers new documents without full re-crawls, supported by a stateless scheduler.

### OC Research Module
This module provides two analytical tools:
1. **Universal Municipal Intelligence Engine** — A multi-board dynamic BI dashboard supporting Planning Board, Zoning Board, Select Board, and Budget Committee. Admins select a town, board type, optional date range, and enter a free-form analysis prompt. A four-phase Gemini MapReduce pipeline (Phase 0: dynamic schema generation via Flash, Phase 1: document retrieval from file_blobs, Phase 2: batched extraction with Flash, Phase 3: synthesis with Pro) generates a dynamic dashboard of stat cards, bar charts, and narrative summaries rendered by `DynamicReportRenderer`. **Reports are persisted to the `research_reports` table** (with `reportType='dynamic'`) including board type, date range, prompt, and document count. A "Past Reports" history UI lets admins reload previous reports instantly without re-running the pipeline. Reports can also be deleted.
2. **Development Friction Report** — Uses LLM-driven pipelines to analyze Planning Board/ZBA meeting documents, extract site plan approval data, perform entity resolution, and compute statistical insights.

Key files: `server/routes/research.ts` (endpoints + pipeline), `client/src/pages/admin-research.tsx` (tab UI), `client/src/components/research/DynamicReportRenderer.tsx` (widget renderer), `shared/schema.ts` (shared types).

### Document Gaps Tracker
The system automatically flags missing documents when retrieval failures occur in the chat pipeline, creating records for administrative management.

### Chat Review System
Utilizes Gemini 3.1 Pro for deep, architecture-aware analysis of chat sessions to identify gap categories, attribute pipeline stage errors, and generate improvement suggestions.

### Content Generation & Town Feed
A content generation pipeline extracts engaging topics from meeting minutes, enriches them with historical context, and generates polished summaries for a central, infinite-scroll Town Feed. This includes a workflow for admins to generate and publish feed items from documents and chat conversations, with features like cursor-based pagination, user-preferred town filtering, atomic upvote toggling, and suggested question chips.

### Feed Automation Pipeline (Task #19)
A two-tier automated feed pipeline fires fire-and-forget after every document version is indexed (`isCurrent=true`):

**Tier 1 — Automated Digest** (`feedType='automated_digest'`, status=`published`):
- Generates a 150-250 word factual wire-service digest from any minutes document.
- Auto-published immediately — no admin action required.

**Tier 2 — Feature Article Draft** (`feedType='automated_feature'`, status=`draft`):
- Only triggered when any topic scores `publicFriction > 6 OR financialImpact > 6`.
- LLM returns Smart Brevity article text + `headerImagePrompt` (strict JSON schema enforced on both Tier 1 and Tier 2 calls).
- Draft row is **written to DB immediately** before image generation (image failure never loses the draft).
- Attempts AI header image generation using the LLM-provided `headerImagePrompt`; patches `headerImageUrl` if successful.
- Admin reviews via the Publishing Inbox (`GET /api/admin/content/inbox`) and approves (`POST /api/admin/content/feed-items/:id/approve`) or rejects (`POST /api/admin/content/feed-items/:id/reject`).

**Schema additions** (`town_feed_items`): `feed_type`, `header_image_url`, `automation_source_version_id`.

**New endpoints**:
- `GET /api/admin/content/inbox` — list draft automated_feature items awaiting review
- `POST /api/admin/content/feed-items/:id/approve` — approve draft → published
- `POST /api/admin/content/feed-items/:id/reject` — reject draft
- `GET /api/content/feed-images/:filename` — serve AI-generated header images

Key files: `server/services/feedAutomation.ts`, `server/routes/ingestion.ts` (hook points), `server/routes/contentGeneration.ts` (inbox endpoints), `migrations/0007_feed_automation.sql`.

### Deep Dive Mode
A semi-agentic research feature that chains multiple reasoning loops to produce comprehensive analyses. It uses an orchestrator to plan research, execute tools (RAG, web search with a two-phase Google Search Grounding approach), synthesize findings, and self-score for quality, iterating as needed. This mode focuses on narrative-focused prompts to produce cohesive, thematic research reports.

### Promotions Hub
An outbound growth engine generates omni-channel social media content, email copy, and trackable deep links from published Town Feed items, enabling "zero-click to chat" acquisition.

### Document Viewer & Citation Linking
A document viewer provides pre-signed URLs for internal documents, with intelligent citation linking and title formatting.

### UI Design System — Civic Ledger Redesign
The public-facing UI uses a "Civic Ledger" visual identity:
- **Color palette**: Deep Navy primary (`hsl 205 61% 26%`), soft slate background (`hsl 210 33% 97%`), pure white cards.
- **Typography**: Public Sans (headlines — `font-headline` class) + Inter (body — `font-body` class) loaded from Google Fonts.
- **Layout shell**: `CivicLayout` component (`client/src/components/CivicLayout.tsx`) wraps all public routes using Shadcn Sidebar primitives. It renders a left sidebar with nav items, plus a top bar with "OPENCOUNCIL" branding and global search. Admin routes bypass this shell entirely.
- **Feed page** (`/feed`): "The Civic Ledger" masthead header with "Official Publication" badge and date pill above the TownFeedComponent.
- **Chat page** (`/chat`): Secondary session-list panel inside the main content area, "Civic Ledger Assistant" header, floating centered pill input with gradient fade and action links beneath it.
- **Message bubbles**: User messages use sky-tinted background (`bg-sky-50`); assistant messages use `bg-card`. Timestamps show role labels: "RESIDENT • HH:MM" / "CIVIC LEDGER • HH:MM".
- **Admin pages**: Completely unmodified — no Civic Ledger shell or color tokens applied.

### Board Extraction Architecture (Task #31)

Board identification uses a **header-only extraction** approach: `suggestMetadataFromPreview` sends only the first 1,000 characters of document text to the LLM. This is intentional — board names that appear in body text (ex-officio member listings, appeal notices like "The Selectmen have a right to appeal...", or references to other boards' meetings) are not reliable signals. The document letterhead/title in the first 1–3 lines is the only authoritative source.

- **Fast path** (`canSkipLlm`): Documents with high-confidence heuristic results (board detected in header regex, meeting date found, `isMinutes=true`) skip the LLM entirely — no API cost.
- **LLM path**: Only called when heuristics are incomplete. Uses `gemini-2.5-flash` with the 1,000-char prompt.
- **Backfill script**: `crawler/scripts/reboard-all-minutes.ts` — re-runs header extraction on all historical `meeting_minutes` documents. Supports `--dry-run`, `--town=X`, `--limit=N`. Run after any future prompt changes to apply corrections to existing records. For docs with `meetingDate >= 2026-02-01`, the script deletes stale feed items (awaited) before calling `enrichDocumentMetadata` to regenerate — preventing the race condition where enrichment skips an item it thinks already exists.

## External Dependencies

*   **Google Gemini API**: For core AI functionalities.
*   **Neon PostgreSQL**: Database hosting with pgvector.
*   **Google Fonts CDN**: For web fonts.
*   **AWS Textract**: For production-grade OCR.
*   **Web Scraping API (ZenRows/Scrapfly)**: For protected website crawling.
*   **Google Drive API v3**: For crawling public Google Drive folders.
*   **CourtListener REST API**: For NH Supreme Court slip opinions.
*   **Brave Search API**: For web search in Deep Dive mode.