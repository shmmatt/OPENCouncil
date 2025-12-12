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

### Scope Preferences (Chat v2)
The chat pipeline detects question scope (local, statewide, mixed, null) using patterns and LLM output. This informs retrieval behavior, allowing strict town filtering for local questions and statewide document search for broader queries. An RSA fallback provides general knowledge answers when no relevant documents are found for statewide legal questions.

### Town Preference & Recent Minutes Updates
The system supports persistent town preferences for anonymous users and chat sessions. A priority cascade resolves town preference for retrieval. API endpoints provide lists of available towns, allow preference updates, and offer public/admin feeds of recently ingested meeting minutes. The chat sidebar includes a town selector and a "Recent Minutes Updates" section.

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