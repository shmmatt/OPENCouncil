# OPENCouncil - NH Municipal Governance Assistant

## Overview
OPENCouncil is an AI-powered assistant for New Hampshire elected officials and municipal workers. It provides instant, grounded answers to governance questions by leveraging Google's Gemini AI with file search capabilities over official municipal documents. The system aims to streamline access to information, eliminate manual document searches, and empower municipal workers with quick, accurate insights. It features a ChatGPT-style chat interface for end-users and a secure admin panel for document management, including an advanced ingestion pipeline with duplicate detection and AI-powered metadata extraction.

## User Preferences
Preferred communication style: Simple, everyday language.

## System Architecture

### Frontend
The frontend uses React and TypeScript with Vite, `shadcn/ui` (Radix UI primitives), and Tailwind CSS for a professional, accessible design. State management is handled by TanStack Query for server state and `wouter` for client-side routing.

### Backend
The backend is an Express.js application written in TypeScript, providing a RESTful API for chat and admin functions. It includes JWT authentication for admin routes, bcrypt for password hashing, and Multer for file uploads (PDF, DOCX, TXT).

### Data Storage
PostgreSQL is the primary database, accessed via Neon's serverless driver and Drizzle ORM. The schema supports `admins`, `chatSessions`, `chatMessages`, and a comprehensive v2 document ingestion system including `fileBlobs`, `logicalDocuments`, `documentVersions`, and `ingestionJobs`. Drizzle Kit manages migrations.

### AI Integration
Google Gemini is integrated for AI capabilities, specifically its File Search feature. A single, persistent File Search store holds municipal documents, enabling grounded responses with citations. Documents are chunked for optimal search relevance.

### V2 Document Ingestion Pipeline
The pipeline features a staged ingestion workflow:
1.  **Upload & Analyze**: Files are uploaded, hashed for duplicate detection, text extracted, and LLM suggests metadata.
2.  **Admin Review**: Admins review, edit, link, and approve or reject documents.
3.  **Approve**: Final metadata is validated.
4.  **Index**: Document uploaded to Gemini File Search, `DocumentVersion` created, and legacy record for backward compatibility.

### Meeting Minutes Detection
The ingestion pipeline includes heuristic detection for meeting minutes based on filenames and content patterns. It extracts specific metadata like `isMinutes`, `meetingDate`, and `meetingType`. Chat retrieval prioritizes `meeting_minutes` for relevant queries.

### Enhanced Town Detection
A three-tier fallback system extracts and finalizes town information: LLM-extracted, heuristic detection from text, and admin-provided hints. An LLM prompt is enhanced to use hints intelligently and handle NH town naming conventions.

### Simplified Unified Chat Pipeline (Chat v2)
The chat pipeline was drastically simplified to fix truncated response issues. The new architecture:

**Pipeline Flow**:
1. **Two-lane parallel retrieval** - Local (town-specific) and statewide (RSA/NHMA) document searches run simultaneously via `Promise.all`
2. **Chunk merging** - Results are deduplicated and merged
3. **Single synthesis** - One LLM call synthesizes the answer (target 800-1500 characters)
4. **Follow-up generation** - Simple follow-up questions are suggested

**Removed Components**:
- Router stage (no simple vs complex branching)
- Evidence coverage gate
- Critic stage  
- Answer policy system / character caps
- Answer mode (deep/standard) feature

**Key Files**:
- `server/chatV2/unifiedPipeline.ts` - Main unified pipeline
- `server/chatV2/twoLaneRetrieve.ts` - Two-lane parallel retrieval logic
- `server/chatV2/chatV2Route.ts` - Simplified route handler

**Model Registry** (`server/llm/modelRegistry.ts`):
- Used for synthesis model selection
- `getModelForStage('complexSynthesis')` returns the model for answer generation

### Town Preference & Recent Minutes Updates
The system supports persistent town preferences for anonymous users and chat sessions. A priority cascade resolves town preference for retrieval. API endpoints provide lists of available towns, allow preference updates, and offer public/admin feeds of recently ingested meeting minutes. The chat sidebar includes a town selector and a "Recent Minutes Updates" section.

### Chat File Upload
Users can attach documents (PDF, DOCX, TXT up to 25MB) to chat messages for AI analysis. The system:
1. Extracts text from uploaded files using existing file processing utilities (pdf-parse, mammoth)
2. Includes the extracted text in the LLM prompt for document-grounded responses
3. Stores attachment metadata (filename, mimeType, extractedText) in the chat_messages table
4. Provides UI affordances including an attach button (paperclip icon), selected file display, and error handling for unsupported file types

### Build & Deployment
The application uses Vite for frontend development and esbuild for backend bundling. It is designed for single-server deployment, serving static files and the API, with external managed PostgreSQL and environment variable-based configuration.

## External Dependencies

### Third-Party Services
1.  **Google Gemini API**: AI capabilities for Q&A and document grounding.
2.  **Neon PostgreSQL**: Serverless PostgreSQL database hosting.
3.  **Google Fonts CDN**: Delivers Inter and JetBrains Mono fonts.

### Key NPM Packages
*   **Frontend**: `react`, `react-dom`, `@tanstack/react-query`, `wouter`, `@radix-ui/*`, `tailwindcss`, `zod`, `react-hook-form`.
*   **Backend**: `express`, `drizzle-orm`, `@neondatabase/serverless`, `@google/genai`, `bcryptjs`, `jsonwebtoken`, `multer`, `pdf-parse`, `mammoth`.
*   **Development**: `vite`, `tsx`, `esbuild`, `drizzle-kit`, `typescript`.