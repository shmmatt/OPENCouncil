# OPENCouncil - NH Municipal Governance Assistant

## Overview
OPENCouncil is an AI-powered assistant designed for New Hampshire's elected officials and municipal workers. Its primary purpose is to provide instant and accurate answers to governance-related questions. It achieves this by combining Google's Gemini AI for answer synthesis with a pgvector-based semantic search across official municipal documents. The system features a user-friendly ChatGPT-style interface and a secure administrative panel for document management, including an advanced ingestion pipeline with duplicate detection and AI-driven metadata extraction. The project aims to improve accessibility to municipal information and streamline decision-making processes for local government.

## User Preferences
Preferred communication style: Simple, everyday language.

## System Architecture

### Design and Technology Choices
The frontend is built with React and TypeScript, utilizing Vite, `shadcn/ui` (Radix UI), and Tailwind CSS for a modern, responsive user experience. State management uses TanStack Query, and client-side routing is handled by `wouter`.

The backend is an Express.js application in TypeScript, offering a RESTful API. It secures admin routes with JWT authentication and uses bcrypt for password hashing. File uploads (PDF, DOCX, TXT) are managed by Multer.

PostgreSQL, accessed via Neon's serverless driver and Drizzle ORM, serves as the primary data store. The database schema includes tables for managing admins, chat sessions, documents (`fileBlobs`, `logicalDocuments`, `documentVersions`), ingestion and embedding jobs, document chunks (with pgvector for embeddings), and chat templates. Drizzle Kit handles database migrations.

### Core Features and Implementations
**Retrieval Backend (Hybrid: pgvector + Full-Text Search)**: Implements a hybrid retrieval system combining semantic search (pgvector cosine similarity for conceptual matching) and keyword search (PostgreSQL full-text search). Results are merged using Reciprocal Rank Fusion (RRF). It also incorporates temporal re-ranking and document-type weighting based on query focus.

**AI Integration**: Google Gemini is central for answer synthesis, document embedding generation (`gemini-embedding-001`), metadata extraction during ingestion, and advanced query planning for retrieval.

**Chat Pipeline (V3 - Self-Reflective RAG)**: A five-stage pipeline processes user queries: Situation Relevance Gating, Planning (generating an IssueMap and RetrievalPlanV3), Retrieval (executing hybrid search), Synthesis (generating answers with Gemini and structured output, enforcing JSON schema), and an optional Conditional Second Hop for re-retrieval if initial context is insufficient. An Audit stage validates and repairs output.

**Document Ingestion Pipeline (V2)**: Manages document lifecycle from upload and hashing to AI-powered metadata suggestion, admin review, and indexing. Includes features for meeting minute detection and a three-tier town detection system.

**OCR Pipeline (Dual-Provider)**: Supports Tesseract.js for low-text PDFs via background workers and AWS Textract for production-grade asynchronous OCR. OCR workers are gated behind `ENABLE_OCR_WORKERS=true` env var to prevent memory overhead during normal serving.

**Persistent Object Storage**: Document files are stored in Replit Object Storage.

**Crawler / Data Collection**: A robust crawler engine supports multi-strategy discovery (sitemaps, BFS), CMS-specific enhancements (CivicPlus, WordPress), and handles redirects and interstitial pages. It features a "Hybrid Fast Lane / Heavy Lane" architecture for resilient fetching, including third-party Web Scraping API integration for protected sites. The crawler ensures crash resilience, incremental discovery persistence, and includes a "Resume Downloads" mode. It also supports state source crawling (e.g., OPD, DES, DRA, NHMA, RSAs, Admin Rules, Supreme Court, Fire/Building Code, DOT) and Google Drive folder crawling. Integrates with the CourtListener API for Supreme Court opinions.

**Security**: Utilizes Helmet for security headers and `sanitize-html` for XSS protection. An error boundary is implemented in the frontend.

**User Feedback System**: Allows users to provide thumbs up/down feedback on AI responses, which is stored and available for admin analytics.

**UI/UX Design Decisions**:
- Landing page uses voter-focused copy ("Don't Read the Town Warrant. Ask It.") rather than B2B SaaS language
- AI responses always start with a TL;DR section of 2-3 bold bullet points for scannability
- Inline citations (`[L1]`, `[S1]`) render as color-coded badges (sky blue for local, violet for state) with tooltips showing source document details
- Chat header shows "OPENCouncil | {Town}" in a single clean line
- Usage indicator shows human-readable text ("X% used · Guest/Free/Pro") instead of a progress bar
- Chat empty state displays 5 clickable example queries to reduce friction for first-time users

**Batch Analysis & Review Runs**: Supports batch analysis of chat data with Gemini-generated executive summaries, stored in `chat_review_runs`.

## External Dependencies

### Third-Party Services
1.  **Google Gemini API**: For AI-powered answer synthesis, embedding generation, and metadata extraction.
2.  **Neon PostgreSQL**: Provides the serverless PostgreSQL database with pgvector extension.
3.  **Google Fonts CDN**: For web fonts.
4.  **AWS Textract**: For production-grade OCR processing.
5.  **Web Scraping API** (e.g., ZenRows/Scrapfly): Used for robust web scraping of protected sites.
6.  **Google Drive API v3**: For crawling publicly shared Google Drive folders.
7.  **CourtListener REST API**: Used to fetch NH Supreme Court opinions.

### Key NPM Packages
*   **Frontend**: `react`, `react-dom`, `@tanstack/react-query`, `wouter`, `@radix-ui/*`, `tailwindcss`, `zod`, `react-hook-form`.
*   **Backend**: `express`, `drizzle-orm`, `@neondatabase/serverless`, `@google/genai`, `bcryptjs`, `jsonwebtoken`, `multer`, `pdf-parse`, `mammoth`, `tesseract.js`.