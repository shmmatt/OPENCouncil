# OPENCouncil - NH Municipal Governance Assistant

## Overview

OPENCouncil is an AI-powered assistant designed for New Hampshire elected officials and municipal workers. The application provides instant answers to governance questions by leveraging Google's Gemini AI with file search capabilities grounded in official municipal documents. The system features a ChatGPT-style chat interface for end users and a secure admin panel for document management.

**Core Purpose:** Enable municipal workers to quickly find answers to governance questions without manually searching through extensive document libraries.

**Target Users:** 
- New Hampshire elected officials and municipal employees (chat interface)
- Administrators who manage the document repository (admin panel)

## User Preferences

Preferred communication style: Simple, everyday language.

## System Architecture

### Frontend Architecture

**Framework:** React with TypeScript using Vite as the build tool

**UI Component System:** shadcn/ui (Radix UI primitives) with Tailwind CSS for styling
- Design system follows a hybrid approach combining ChatGPT-like chat patterns with Linear/Fluent-inspired admin interfaces
- Custom design tokens defined in `client/src/index.css` with light mode color system
- Typography uses Inter font for primary text and JetBrains Mono for monospace needs

**State Management:** 
- TanStack Query (React Query) for server state management and caching
- Local component state for UI interactions
- Token-based authentication state stored in localStorage

**Routing:** Wouter (lightweight client-side routing)

**Key Routes:**
- `/chat` - Main chat interface (default)
- `/admin/login` - Admin authentication
- `/admin/documents` - Document management dashboard
- `/admin/bulk-upload` - Bulk document upload with AI metadata suggestions

**Design Rationale:** 
The choice of shadcn/ui provides a professional, accessible component library that can be customized while maintaining consistency. Vite offers fast development builds. The lightweight stack (Wouter vs React Router, TanStack Query for data fetching) keeps bundle sizes small while providing necessary functionality.

### Backend Architecture

**Framework:** Express.js with TypeScript running on Node.js

**API Design:** RESTful endpoints with JSON payloads

**Key Endpoints:**
- `POST /api/admin/login` - Admin authentication with bcrypt password verification
- `GET /api/admin/documents` - Retrieve document list (protected)
- `POST /api/admin/documents/upload` - Upload documents to Gemini File Search (protected)
- `DELETE /api/admin/documents/:id` - Remove documents (protected)
- `POST /api/admin/bulk-upload/analyze` - Upload multiple files, extract text preview, and get AI-suggested metadata (protected)
- `POST /api/admin/bulk-upload/finalize` - Confirm metadata and upload files to Gemini File Search (protected)
- `POST /api/chat/sessions` - Create new chat session
- `GET /api/chat/sessions` - List all chat sessions
- `GET /api/chat/sessions/:id/messages` - Retrieve messages for a session
- `POST /api/chat/messages` - Send message and get AI response

**File Upload Handling:** Multer middleware configured to accept PDF, DOCX, and TXT files up to 100MB

**Authentication & Authorization:**
- JWT-based authentication for admin routes
- Custom middleware (`authenticateAdmin`) validates tokens on protected endpoints
- Bcrypt for password hashing (10 rounds)
- 7-day token expiration
- Environment variables required: `JWT_SECRET`, `ADMIN_EMAIL`, `ADMIN_PASSWORD`

**Admin Initialization:** 
On server startup, `ensureAdminExists()` creates the initial admin account if it doesn't exist, using credentials from environment variables.

**Design Rationale:**
Express provides flexibility and a mature ecosystem. JWT tokens enable stateless authentication suitable for this single-admin use case. The separation of admin and public routes allows for future expansion of user roles.

### Data Storage

**Database:** PostgreSQL accessed via Neon serverless driver

**ORM:** Drizzle ORM for type-safe database operations

**Schema Design:**

1. **admins** - Administrator accounts
   - `id` (UUID primary key)
   - `email` (unique)
   - `passwordHash` (bcrypt)
   - `createdAt`

2. **documents** - Uploaded municipal documents
   - `id` (UUID primary key)
   - `filename` (storage filename)
   - `originalName` (user-provided name)
   - `fileSearchFileId` (Gemini File Search reference)
   - `fileSearchStoreId` (Gemini File Search store reference)
   - `category`, `town`, `board`, `year`, `notes` (metadata for organization)
   - `createdAt`

3. **chatSessions** - User conversation contexts
   - `id` (UUID primary key)
   - `title` (conversation name)
   - `createdAt`, `updatedAt`

4. **chatMessages** - Individual chat messages
   - `id` (UUID primary key)
   - `sessionId` (foreign key to chatSessions with CASCADE delete)
   - `role` (user/assistant)
   - `content` (message text)
   - `citations` (JSON string of source documents)
   - `createdAt`

5. **tempUploads** - Temporary file storage during bulk upload analysis
   - `id` (UUID primary key)
   - `filename` (storage filename)
   - `originalName` (user-provided name)
   - `filePath` (path to temp file on disk)
   - `previewText` (extracted text for AI analysis)
   - `suggestedCategory`, `suggestedTown`, `suggestedBoard`, `suggestedYear`, `suggestedNotes` (AI-suggested metadata)
   - `createdAt`

**Migration Strategy:** Drizzle Kit with migrations stored in `/migrations` directory

**Connection Configuration:**
- Uses Neon's WebSocket-based serverless driver for edge compatibility
- Connection pooling via `@neondatabase/serverless` Pool
- WebSocket constructor configured for Node.js environment

**Design Rationale:**
PostgreSQL provides ACID compliance and relational integrity crucial for maintaining conversation context and document metadata. Drizzle ORM offers excellent TypeScript integration and type safety without the overhead of heavier ORMs. The CASCADE delete on chat messages ensures data consistency when sessions are removed.

### AI Integration (Google Gemini)

**API Client:** `@google/genai` SDK

**Core Features:**

1. **File Search Store Management:**
   - Single persistent File Search store for all municipal documents
   - Store ID cached in memory and persisted via document records
   - Lazy creation on first document upload

2. **Document Processing:**
   - Files uploaded to Gemini File Search with chunking configuration:
     - `max_tokens_per_chunk: 200`
     - `max_overlap_tokens: 20`
   - White space-based chunking for better semantic boundaries
   - Operation polling with 30-attempt maximum to await processing completion

3. **Chat Functionality:**
   - Uses File Search-enabled Gemini models
   - Maintains conversation history for context
   - Returns grounded responses with document citations
   - Citation metadata includes chunk references and confidence scores

**File Processing Flow:**
1. Admin uploads document via web interface
2. File saved to local `/uploads` directory
3. Document uploaded to Gemini File Search store
4. File metadata stored in PostgreSQL with Gemini file ID
5. Local file retained for potential re-processing

**Chat Query Flow:**
1. User sends message through chat interface
2. Backend retrieves conversation history from database
3. Message sent to Gemini with File Search context
4. AI response includes citations from indexed documents
5. Message and response saved to database with citation metadata

**Environment Configuration:**
- `GEMINI_API_KEY` - Required for all Gemini API operations

**Design Rationale:**
Google Gemini's File Search provides grounded responses crucial for municipal governance questions where accuracy is paramount. The chunking configuration balances between context preservation and search granularity. Storing both the file in uploads and the Gemini file ID allows for recovery and re-indexing if needed. The single shared File Search store simplifies management while enabling cross-document queries.

**Alternatives Considered:**
- OpenAI with Assistants API: Rejected due to higher cost and similar capabilities
- Self-hosted RAG with embeddings: Rejected due to infrastructure complexity for a municipal use case
- Gemini Vertex AI: Rejected due to increased setup complexity vs API

**Pros:**
- Managed infrastructure reduces maintenance burden
- Built-in citation tracking for transparency
- Scalable document processing
- Pay-per-use pricing model

**Cons:**
- Vendor lock-in to Google
- API rate limits may impact high-traffic scenarios
- Requires internet connectivity (no offline mode)

### Build & Deployment

**Development Mode:**
- Vite dev server with HMR for frontend
- tsx with nodemon-style reloading for backend
- Separate entry points: `server/index-dev.ts`

**Production Build:**
- Frontend: Vite builds to `dist/public`
- Backend: esbuild bundles to `dist/index.js` as ESM module
- Single Node.js process serves both static files and API

**Environment Variables Required:**
- `DATABASE_URL` - PostgreSQL connection string
- `GEMINI_API_KEY` - Google Gemini API key
- `JWT_SECRET` - JWT signing secret
- `ADMIN_EMAIL` - Initial admin account email
- `ADMIN_PASSWORD` - Initial admin account password

**Deployment Strategy:**
Designed for single-server deployment with:
- Static file serving via Express
- Database via managed PostgreSQL (Neon)
- No CDN or edge requirements
- Minimal infrastructure footprint suitable for municipal budgets

## External Dependencies

### Third-Party Services

1. **Google Gemini API**
   - Purpose: AI-powered question answering with document grounding
   - Integration: REST API via `@google/genai` SDK
   - Cost: Pay-per-request (token-based pricing)
   - Required: Yes (core functionality)

2. **Neon PostgreSQL**
   - Purpose: Serverless PostgreSQL database hosting
   - Integration: WebSocket-based connection via `@neondatabase/serverless`
   - Cost: Usage-based with generous free tier
   - Required: Yes (any PostgreSQL can substitute)

3. **Google Fonts CDN**
   - Purpose: Inter and JetBrains Mono font delivery
   - Integration: CSS import in `client/index.html`
   - Cost: Free
   - Required: No (fonts could be self-hosted)

### Key NPM Packages

**Frontend:**
- `react` & `react-dom` - UI framework
- `@tanstack/react-query` - Server state management
- `wouter` - Client-side routing
- `@radix-ui/*` - Accessible UI primitives (20+ packages)
- `tailwindcss` - Utility-first CSS framework
- `zod` - Schema validation
- `react-hook-form` - Form state management

**Backend:**
- `express` - Web server framework
- `drizzle-orm` - Type-safe ORM
- `@neondatabase/serverless` - PostgreSQL driver
- `@google/genai` - Gemini AI SDK
- `bcryptjs` - Password hashing
- `jsonwebtoken` - JWT authentication
- `multer` - File upload handling

**Development:**
- `vite` - Frontend build tool
- `tsx` - TypeScript execution for development
- `esbuild` - Backend bundler
- `drizzle-kit` - Database migration tool
- `typescript` - Type system

### Database Schema Management

- **Tool:** Drizzle Kit
- **Migration Location:** `/migrations` directory
- **Schema Source:** `shared/schema.ts`
- **Push Command:** `npm run db:push` (development schema sync)

### Authentication Dependencies

- JWT tokens with 7-day expiration
- Bcrypt with 10 salt rounds for password hashing
- No external authentication providers (self-contained)

## V2 Document Pipeline

### Overview

The v2 document pipeline introduces a staged ingestion workflow with duplicate detection, LLM-powered metadata extraction, admin review, and versioning. This system runs alongside the legacy document upload and maintains full backwards compatibility.

### Key Routes

- `/admin/ingestion` - v2 ingestion pipeline with upload, review, and approval workflow
- `/admin/documents-v2` - v2 documents listing with version history

### New Database Tables

1. **fileBlobs** - Raw file storage with SHA-256 hashing
   - `id` (UUID primary key)
   - `rawHash` (SHA-256 of file content for duplicate detection)
   - `previewHash` (SHA-256 of extracted text for near-duplicate detection)
   - `originalFilename`, `storagePath`, `mimeType`, `sizeBytes`
   - `previewText` (extracted text for LLM analysis)
   - `createdAt`

2. **logicalDocuments** - Logical document entities
   - `id` (UUID primary key)
   - `canonicalTitle` (main document title)
   - `category`, `town`, `board` (metadata)
   - `currentVersionId` (reference to current version)
   - `createdAt`, `updatedAt`

3. **documentVersions** - Individual versions of documents
   - `id` (UUID primary key)
   - `documentId` (foreign key to logicalDocuments)
   - `fileBlobId` (foreign key to fileBlobs)
   - `year`, `notes` (version-specific metadata)
   - `fileSearchStoreName`, `fileSearchDocumentName` (Gemini File Search references)
   - `isCurrent` (boolean flag for current version)
   - `supersedesVersionId` (tracks version lineage)
   - `createdAt`

4. **ingestionJobs** - Tracks files through the ingestion pipeline
   - `id` (UUID primary key)
   - `fileBlobId` (foreign key to fileBlobs)
   - `status` (`needs_review`, `approved`, `indexed`, `rejected`)
   - `suggestedMetadata`, `finalMetadata` (JSON)
   - `duplicateWarning` (duplicate detection result)
   - `documentId`, `documentVersionId` (links to final records)
   - `createdAt`, `updatedAt`

### Pipeline Flow

1. **Upload & Analyze** (`POST /api/admin/ingestion/analyze`)
   - Files uploaded and stored in `uploads/blobs/`
   - SHA-256 hash computed for duplicate detection
   - Text extracted (PDF via pdf-parse, DOCX via mammoth, TXT directly)
   - LLM analyzes text and suggests metadata
   - Ingestion job created with status `needs_review`

2. **Admin Review** (UI at `/admin/ingestion`)
   - Admin reviews suggested metadata
   - Can edit category, town, board, year, notes
   - Can link to existing document or create new one
   - Approve or reject the document

3. **Approve** (`POST /api/admin/ingestion/jobs/:jobId/approve`)
   - Creates or links LogicalDocument
   - Validates and stores final metadata
   - Updates job status to `approved`

4. **Index** (`POST /api/admin/ingestion/jobs/:jobId/index`)
   - Uploads to Gemini File Search
   - Creates DocumentVersion with File Search references
   - Sets version as current (demotes previous versions)
   - Creates legacy document record for backwards compatibility
   - Updates job status to `indexed`

### Services

- **fileProcessing.ts** - SHA-256 hashing, text extraction, duplicate detection
- **metadataExtraction.ts** - LLM-powered metadata suggestion and validation

### Backwards Compatibility

- Legacy `/api/admin/documents` endpoint continues to work
- Chat endpoint searches the same Gemini File Search store
- v2 index flow also creates legacy document record
- Both v1 and v2 documents are searchable through chat