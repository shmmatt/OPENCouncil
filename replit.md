# OPENCouncil - NH Municipal Governance Assistant

## Overview
OPENCouncil is an AI-powered assistant designed to support New Hampshire elected officials and municipal workers. It provides instant, accurate answers to governance questions by leveraging Google's Gemini AI and performing semantic searches over official municipal documents. The project aims to improve local governance efficiency and transparency by making municipal information readily accessible and actionable. Key capabilities include comprehensive document search, AI-powered research, document gap identification, and content generation for community engagement.

## User Preferences
Preferred communication style: Simple, everyday language.

## System Architecture

### Frontend
The frontend is built with React, TypeScript, Vite, `shadcn/ui`, and Tailwind CSS, utilizing TanStack Query for state management and `wouter` for routing.

### Backend
The backend uses Express.js with TypeScript, providing a secure RESTful API with JWT authentication, bcrypt for password hashing, and Multer for file uploads.

### Data Storage & Retrieval
PostgreSQL, hosted on Neon and using Drizzle ORM, stores chat sessions, documents, and document chunks with pgvector embeddings. A hybrid retrieval system combines pgvector-based semantic search with PostgreSQL full-text search, enhanced by Reciprocal Rank Fusion (RRF), temporal re-ranking, and document-type weighting.

### AI Integration
Google Gemini powers answer synthesis, embedding generation, metadata extraction, multi-query planning, and various analytical tools.

**Model tiers** (defined in `server/llm/modelRegistry.ts`):
- `FAST` → `gemini-3.1-flash-lite` — default for all chat pipeline stages (router, planner, synthesizer, followups, etc.)
- `HIGH_QUALITY` → `gemini-3-flash-preview` — used for escalated synthesis
- `SUMMARY_MODEL` → `gemini-3.1-pro-preview` — used only for feed summary generation (in `contentGeneration.ts`)
- Content generation `MODEL` → `gemini-3.1-flash-lite` — topic extraction, story-worthiness, curiosity questions

**Thinking config**: Synthesizer uses `thinkingLevel: "HIGH"`, follow-up generator uses `thinkingLevel: "LOW"`.

### Chat Pipeline (V3)
This pipeline implements a self-reflective RAG approach with three-lane parallel retrieval (Local, Statewide, SAU) and situation relevance gating. It optimizes for latency with parallel retrieval, SSE streaming, and asynchronous follow-up generation. It includes conditional "second hop" retrieval and specific prose word limits for different response types.

### Document Ingestion & OCR
The V2 ingestion pipeline manages document lifecycle, including duplicate detection, AI-powered metadata suggestion, and multi-tier town detection. A dual-provider OCR system uses Tesseract.js and AWS Textract. Documents are stored in Replit Object Storage.

### Crawler / Data Collection
A sophisticated crawler uses multi-strategy discovery (sitemaps, BFS, CMS-specific enhancements) and a hybrid "Fast Lane / Heavy Lane" architecture for town-level, state-level, and SAU-level document collection, including integrations with Google Drive and CourtListener API.

### OC Research Module
This module provides analytical tools like the Development Friction Report, which uses LLM-driven pipelines to analyze meeting documents, extract structured data, perform entity resolution, and compute statistical insights such as time-to-decision and friction categories.

### Document Gaps Tracker
The system automatically flags missing documents when retrieval failures occur in the chat pipeline. It creates records with user queries and detected gap descriptions, supporting admin management of gap statuses.

### Chat Review System
Utilizes Gemini 3.1 Pro for deep, architecture-aware analysis of chat sessions to identify gap categories, attribute pipeline stage errors, and generate improvement suggestions.

### Content Generation & Town Feed
A content generation pipeline extracts engaging topics from meeting minutes, enriches them with historical context, and generates polished summaries for a central, infinite-scroll Town Feed at `/feed`.

**Town Feed Features:**
- Cursor-based infinite scroll pagination with `(publishedAt, id)` tie-breaker for deterministic ordering
- User preferred town filtering via `users.preferredTowns` (JSONB). Town preference picker shown to new authenticated users
- Atomic upvote toggle ("Important") using database transactions with SQL-level `upvoteCount` increment/decrement (race-safe)
- `userUpvotes` table with unique `(userId, feedItemId)` constraint prevents duplicate votes
- Optimistic UI updates for upvotes via React Query cache manipulation (no feed refetch/jumping)
- Suggested question chips on each post open a slide-out chat drawer from the right
- Chat drawer uses URL state (`?chat=open&feedId=X`) with `pushState`/`popstate` so browser Back closes the drawer without navigating away; feed scroll position preserved since component stays mounted
- "High Impact" badge (secondary variant, TrendingUp icon) on items with topic scores >= 8
- Markdown rendering in feed card summaries via ReactMarkdown with remarkGfm; truncation closes unclosed bold markers
- Template promo cards interleaved every 5th position
- Admin content page enhanced with keyword search, status/town filters, sortable columns, table/card view toggle, and payload editor (including topicEmoji)

**Key files:** `client/src/components/TownFeed.tsx`, `client/src/pages/feed-layout.tsx`, `server/routes/feed.ts`, `server/storage/userUpvotes.ts`, `server/storage/townFeed.ts`

### Promotions Hub
An outbound growth engine generates omni-channel social media content, email copy, and trackable deep links from published Town Feed items, enabling "zero-click to chat" acquisition. LLMs generate content and video scripts, maintaining an objective tone.

### Document Viewer & Citation Linking
A document viewer provides pre-signed URLs for internal documents. Citation linking handles source URLs and internal viewer fallbacks, with citation marker validation and intelligent title formatting.

### Deep Dive Mode
A semi-agentic research feature that chains multiple reasoning loops to produce comprehensive analyses. It uses an orchestrator to plan research, execute tools (RAG, news crawl, web search), synthesize findings, and self-score for quality, iterating as needed.

## External Dependencies

*   **Google Gemini API**: For core AI functionalities.
*   **Neon PostgreSQL**: Database hosting with pgvector.
*   **Google Fonts CDN**: For web fonts.
*   **AWS Textract**: For production-grade OCR.
*   **Web Scraping API (ZenRows/Scrapfly)**: For protected website crawling.
*   **Google Drive API v3**: For crawling public Google Drive folders.
*   **CourtListener REST API**: For NH Supreme Court slip opinions.
*   **Brave Search API**: For web search in Deep Dive mode.
*   **Jina Reader**: For content extraction from web search results.