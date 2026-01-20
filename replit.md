# OPENCouncil - NH Municipal Governance Assistant

## Overview
OPENCouncil is an AI-powered assistant designed for New Hampshire elected officials and municipal workers. It provides instant, accurate answers to governance questions by leveraging Google's Gemini AI with file search capabilities over official municipal documents. The system aims to streamline access to information, eliminate manual document searches, and empower municipal workers with quick, accurate insights. It features a ChatGPT-style chat interface for end-users and a secure admin panel for document management, including an advanced ingestion pipeline with duplicate detection and AI-powered metadata extraction. The project's ambition is to significantly improve efficiency and accessibility of municipal information, setting a new standard for local government support.

## User Preferences
Preferred communication style: Simple, everyday language.

## System Architecture

### Frontend
The frontend is built with React and TypeScript using Vite, `shadcn/ui` (Radix UI primitives), and Tailwind CSS for a professional and accessible design. State management uses TanStack Query, and client-side routing is handled by `wouter`.

### Backend
An Express.js application written in TypeScript provides a RESTful API. Key features include JWT authentication for admin routes, bcrypt for password hashing, and Multer for file uploads (PDF, DOCX, TXT).

### Data Storage
PostgreSQL serves as the primary database, accessed via Neon's serverless driver and Drizzle ORM. The schema includes tables for `admins`, `chatSessions`, `chatMessages`, and a comprehensive document ingestion system with `fileBlobs`, `logicalDocuments`, `documentVersions`, and `ingestionJobs`. Drizzle Kit manages database migrations.

### AI Integration
Google Gemini's File Search feature is integrated to provide AI capabilities, enabling grounded responses with citations from a single, persistent store of municipal documents. Documents are chunked for optimal search relevance.

### V2 Document Ingestion Pipeline
This pipeline features a staged workflow: files are uploaded, hashed for duplicate detection, text extracted, and LLM-suggested metadata is generated. Admins review, edit, link, and approve or reject documents before final validation and indexing into Gemini File Search. The pipeline also includes heuristic detection for meeting minutes and enhanced town detection using a three-tier fallback system.

### Simplified Unified Chat Pipeline (Chat v2)
The chat pipeline was simplified to ensure robust and concise answers. It features:
- **Two-lane parallel retrieval**: Simultaneous local (town-specific) and statewide (RSA/NHMA) document searches.
- **Chunk merging**: Deduplication and merging of retrieval results.
- **Single synthesis**: One LLM call to synthesize answers (targeting 800-1500 characters).
- **Follow-up generation**: Suggestion of simple follow-up questions.
This iteration removed complex routing, evidence coverage gates, and character caps for a more direct approach.

### Town Preference & Recent Minutes Updates
The system supports persistent town preferences for users and chat sessions, with a priority cascade for resolving town context. API endpoints manage town lists, preference updates, and feeds of recently ingested meeting minutes.

### Chat File Upload
Users can attach documents (PDF, DOCX, TXT up to 25MB) to chat messages for AI analysis. The system extracts text from these files and includes it in the LLM prompt for grounded responses.

### Situation Anchoring & Topic Continuity
This feature prevents the AI from drifting off-topic during follow-up questions. It extracts entities to track the conversation's context, re-ranks retrieved chunks based on topic relevance, and uses a strict system prompt to maintain continuity. A drift detection mechanism identifies and prompts regeneration for off-topic answers.

### Legal Salience Biasing
The two-lane retrieval system incorporates legal salience detection. When a query is identified as legally salient, it dynamically adjusts retrieval parameters (e.g., increases state lane K, context cap) and ensures a minimum coverage of state-level documents. The AI prompt is also enhanced to include an "Applicable legal framework" section in responses.

### V3 Pipeline Quality Improvements
Major improvements focus on answer quality, tiering, and retrieval:
- **Synthesizer Format Spec**: A new 5-section format with strict length and citation rules, reduced temperature for conciseness, and dynamic section titles.
- **Situation Relevance Gating**: Prevents "sticky context" leakage by evaluating question-context relevance and clearing conversation history when unrelated.
- **Anti-bridging Patterns**: Audit detects and repairs phrases that assume unrelated context.
- **Format Validation & Repair**: Checks answer format against strict rules, with repair attempts and fallback mechanisms.
- **Tiering Improvements**: Enhanced rubric for answer quality based on distinct state documents and authoritative sources.
- **Authority Detection**: Robust RSA and NHMA pattern matching for improved legal context.
- **Early Exit Logic**: Improved conditions for early exit in legal questions, ensuring sufficient state coverage.
- **State Lane Deduplication**: Ensures accurate distinct state document counts for tiering.

### Build & Deployment
The application uses Vite for frontend development and esbuild for backend bundling. It is designed for single-server deployment, serving static files and the API, leveraging external managed PostgreSQL and environment variable-based configuration.

### OCR Pipeline
An automatic OCR detection and processing system is implemented for scanned PDFs. If initial text extraction yields low character counts, documents are flagged for OCR. A background worker uses Tesseract.js to process these documents, converting PDF pages to images for OCR, and storing the extracted text for LLM analysis.

**OCR Re-indexing**: After successful OCR extraction, documents are automatically re-indexed into the Gemini File Search RAG system. The worker checks if the ingestion job is indexed before attempting reindex; if not yet indexed, the document will be picked up by the batch reindex endpoint. The `ocr_reindexed_at` column tracks which documents have been re-indexed. A "Re-index OCR" button in the admin UI allows batch re-indexing of completed OCR documents in batches of 20.

## External Dependencies

### Third-Party Services
1.  **Google Gemini API**: Provides core AI capabilities for Q&A and document grounding.
2.  **Neon PostgreSQL**: Hosts the serverless PostgreSQL database.
3.  **Google Fonts CDN**: Delivers web fonts (Inter, JetBrains Mono) for consistent typography.

### Key NPM Packages
*   **Frontend**: `react`, `react-dom`, `@tanstack/react-query`, `wouter`, `@radix-ui/*`, `tailwindcss`, `zod`, `react-hook-form`.
*   **Backend**: `express`, `drizzle-orm`, `@neondatabase/serverless`, `@google/genai`, `bcryptjs`, `jsonwebtoken`, `multer`, `pdf-parse`, `mammoth`, `tesseract.js`.
*   **Development**: `vite`, `tsx`, `esbuild`, `drizzle-kit`, `typescript`.