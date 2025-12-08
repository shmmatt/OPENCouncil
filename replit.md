# OPENCouncil - NH Municipal Governance Assistant

## Overview

OPENCouncil is an AI-powered assistant for New Hampshire elected officials and municipal workers. It provides instant, grounded answers to governance questions using Google's Gemini AI with file search capabilities over official municipal documents. The system features a ChatGPT-style chat interface for end-users and a secure admin panel for document management, including an advanced ingestion pipeline with duplicate detection and AI-powered metadata extraction. The core purpose is to streamline access to information, eliminating the need for manual document searches and empowering municipal workers with quick, accurate governance insights.

## User Preferences

Preferred communication style: Simple, everyday language.

## System Architecture

### Frontend

The frontend is built with React and TypeScript, using Vite for fast development. It leverages `shadcn/ui` (Radix UI primitives) and Tailwind CSS for a professional, accessible design system that combines ChatGPT-like chat patterns with Linear/Fluent-inspired admin interfaces. State management is handled by TanStack Query for server state and local component state for UI interactions, with `wouter` for lightweight client-side routing.

### Backend

The backend is an Express.js application written in TypeScript. It provides a RESTful API for both the chat interface and the admin panel, including document upload, management, and bulk ingestion. Authentication for admin routes uses JWTs with bcrypt for password hashing. File uploads are handled by Multer, accepting PDF, DOCX, and TXT formats. An initial admin account is provisioned on server startup using environment variables.

### Data Storage

PostgreSQL is used as the primary database, accessed via Neon's serverless driver and Drizzle ORM for type-safe operations. The schema includes tables for `admins`, `documents` (legacy), `chatSessions`, `chatMessages`, `tempUploads` (for bulk upload analysis), `fileBlobs` (for v2 raw file storage), `logicalDocuments` (v2 logical entities), `documentVersions` (v2 versioning), and `ingestionJobs` (v2 pipeline tracking). Drizzle Kit manages database migrations.

### AI Integration (Google Gemini)

The application integrates with Google Gemini for AI capabilities, specifically utilizing its File Search feature. A single, persistent File Search store holds all municipal documents, enabling grounded responses with citations in the chat interface. Documents are uploaded with specific chunking configurations (`max_tokens_per_chunk: 200`, `max_overlap_tokens: 20`) for optimal search relevance. The chat functionality maintains conversation history and provides document citations for transparency.

### V2 Document Pipeline

The v2 pipeline introduces a staged ingestion workflow:
1.  **Upload & Analyze:** Files are uploaded, hashed for duplicate detection, text is extracted, and an LLM suggests metadata. An ingestion job is created with `needs_review` status.
2.  **Admin Review:** Admins review and edit suggested metadata, link to existing documents or create new ones, and approve or reject the document.
3.  **Approve:** Final metadata is validated and stored, and the job status is updated to `approved`.
4.  **Index:** The document is uploaded to Gemini File Search, a `DocumentVersion` is created and set as current, and a legacy document record is also created for backward compatibility.

### Meeting Minutes Detection

The ingestion pipeline includes specialized handling for meeting minutes documents:

**Heuristic Detection:**
- Filename patterns: "minutes", "mtg", "meeting" with dates, board abbreviations (pb, bos, zba)
- First-page text patterns: "Meeting Minutes", "Call to Order", "Roll Call", "Members Present"
- Automatic extraction of town, board, and meeting date from document headers

**Minutes-Specific Metadata:**
- `isMinutes`: Boolean flag for minutes documents
- `meetingDate`: ISO date string (YYYY-MM-DD) for the specific meeting
- `meetingType`: "regular", "special", or "work_session"
- `rawDateText`: Original date text from document for debugging

### Enhanced Town Detection

The ingestion pipeline includes enhanced town detection with a three-tier fallback system:

**Heuristic Extraction (`extractTownFromText`):**
- Pattern 1: "TOWN OF OSSIPEE" format (most common in minutes headers)
- Pattern 2: Known NH town names with context patterns (e.g., "Conway, NH", "Ossipee Planning Board")
- Pattern 3: State-level document detection (returns "statewide")

**Admin Upload Hints:**
- `metadataHints` field on ingestion jobs stores admin-provided defaults
- Admin UI includes optional "Default Town" and "Default Board" fields during upload
- These hints are used as fallbacks when AI cannot detect town from document text

**Town Finalization Logic (`finalizeTown`):**
1. LLM-extracted town (highest priority)
2. Heuristic-detected town from document text
3. Admin-provided default town hint
4. Empty string (triggers "No town detected" status note)

**LLM Prompt Enhancement:**
- Opinionated prompt that instructs Gemini to use hints unless text clearly contradicts them
- Explicit rules for handling NH towns (extract just town name, not "Town of" prefix)
- Hints are passed directly to the LLM for more accurate suggestions

**Chat Retrieval:**
- Router and retrieval planner prioritize `meeting_minutes` category for questions about meetings, board decisions, votes, etc.
- Questions like "What did the Planning Board decide on March 5?" automatically search meeting_minutes category
- File Search metadata includes isMinutes and meetingDate for filtering

### Scope Preferences (Chat v2)

The chat pipeline includes intelligent scope detection to distinguish between local (town-specific) and statewide (RSA/NH law) questions:

**Scope Types (`ScopeHint`):**
- `local`: Question specifically about a town/municipality (e.g., "What is Ossipee's budget?")
- `statewide`: Question about NH law, RSAs, or state-level requirements without a specific town
- `mixed`: Question mentions both a specific town AND state law/RSAs
- `null`: Cannot determine scope

**Detection Logic:**
- Pattern-based detection in router.ts using `detectScopeHint()`:
  - RSA patterns: `/\bRSA\b/i`, `/\bRevised Statutes\b/i`, `/\bNH law\b/i`, `/\bstate law\b/i`, etc.
  - Town references: Checks for 50+ NH town names in the question
- LLM also provides a scopeHint in its JSON response
- `combineScopeHints()` merges both signals intelligently (conflicts → "mixed")

**Retrieval Behavior:**
- `local` scope: `allowStatewideFallback = false` (strict town filtering)
- `statewide` scope: `townPreference = undefined`, `allowStatewideFallback = true`
- `mixed` scope: `allowStatewideFallback = true` (search both)

**RSA Fallback (simpleAnswer.ts):**
- When no documents found AND question is RSA-related (`isRSAQuestion()`)
- Generates general knowledge answer without file_search
- Appends statewide disclaimer noting response is not from indexed documents

**Utilities (scopeUtils.ts):**
- `generateStatewideDisclaimer()`: Disclaimer for non-document-based answers
- `generateNoDocsFoundMessage(isRSA)`: Appropriate "no results" message
- `isStatewideScope(scopeHint)`: Check if scope is statewide or mixed

### Build & Deployment

The application supports separate development modes for frontend (Vite) and backend (tsx with hot-reloading). For production, Vite builds the frontend to static assets, and esbuild bundles the backend into a single Node.js ESM module. It is designed for single-server deployment, serving both static files and the API, with external managed PostgreSQL (Neon) and requiring environment variables for configuration (`DATABASE_URL`, `GEMINI_API_KEY`, `JWT_SECRET`, `ADMIN_EMAIL`, `ADMIN_PASSWORD`).

## External Dependencies

### Third-Party Services

1.  **Google Gemini API**: Core AI for question answering and document grounding.
2.  **Neon PostgreSQL**: Serverless PostgreSQL database hosting.
3.  **Google Fonts CDN**: Delivers Inter and JetBrains Mono fonts.

### Key NPM Packages

*   **Frontend**: `react`, `react-dom`, `@tanstack/react-query`, `wouter`, `@radix-ui/*`, `tailwindcss`, `zod`, `react-hook-form`.
*   **Backend**: `express`, `drizzle-orm`, `@neondatabase/serverless`, `@google/genai`, `bcryptjs`, `jsonwebtoken`, `multer`, `pdf-parse`, `mammoth`.
*   **Development**: `vite`, `tsx`, `esbuild`, `drizzle-kit`, `typescript`.

## Observability & Pipeline Logging

The Chat v2 pipeline includes comprehensive structured logging for debugging and observability. Logs are output as JSON to the console and can be filtered by log level.

### Environment Variables

- `LOG_LEVEL`: Controls minimum log level (`debug`, `info`, `warn`, `error`). Default: `info`
- `CHAT_DEBUG_LOGGING`: Set to `1` or `true` to enable verbose debug logs (LLM prompts/responses, File Search queries, etc.). Default: disabled
- `CHAT_LOG_USER_CONTENT`: Set to `1` or `true` to log actual user question text. Default: disabled (only logs question length for privacy)

### Enabling Detailed Logging

For development/debugging:
```bash
CHAT_DEBUG_LOGGING=1
LOG_LEVEL=debug
```

For production (less verbose):
```bash
CHAT_DEBUG_LOGGING=0
LOG_LEVEL=info  # or warn
```

### Log Correlation

Each chat v2 request generates a unique `requestId` (UUID) that is passed through all pipeline stages. This enables end-to-end tracing of a single user question through:
- Router → Simple/Complex path → Retrieval → Draft → Critic → Final answer

Look for `requestId` and `sessionId` fields in log output to correlate logs.

## Chat V2 Pipeline Enhancements

### Source Citations
The pipeline enriches document sources with metadata:
- `SourceCitation` type includes: `id`, `title`, `town`, `year`, `category`, `url`, `meetingDate`, `board`
- Source mapping extracts metadata from `documentVersions` and `logicalDocuments` tables
- Meeting dates are formatted as ISO date strings (YYYY-MM-DD)

### Structured Complex Answers
Complex questions receive structured answers with consistent formatting:
- **At a glance**: 2-3 sentence executive summary (no bullet points)
- **Key numbers**: Relevant budget figures, dates, quantities (bulleted list)
- **Details from recent meetings**: Context from meeting discussions
- Target length: 400-600 words for comprehensive but focused responses

### Recency Bias Detection
The retrieval planner detects questions about "current" or "recent" status:
- Keywords detected: "current", "currently", "recent", "recently", "latest", "now", "today", "this year"
- `preferRecent` flag is set on `RetrievalPlan` when recency intent is detected
- Retrieval prompts are enhanced to prioritize documents from the last 6-12 months

### Gemini Quota Error Handling
Graceful handling of Gemini API rate limit errors (429/RESOURCE_EXHAUSTED):
- `GeminiQuotaExceededError` class in `server/utils/geminiErrors.ts`
- `isQuotaError()` utility detects nested error structures from Gemini
- Quota errors are checked BEFORE fallback responses in all pipeline components
- User receives friendly message: "We're temporarily experiencing high demand..."
- Errors are logged with full context for debugging

### What Gets Logged

**Stage-level logging** (`info` level):
- `chat_v2_request_received`: Entry point with user question
- `chat_v2_response_ready`: Exit point with timing and metadata
- `chat_v2_request_error`: Pipeline errors

**Debug logging** (requires `CHAT_DEBUG_LOGGING=1`):
- `llm_request`: LLM calls with truncated prompts (system + user)
- `llm_response`: LLM responses with truncated output
- `file_search_request`: File Search queries with filters
- `file_search_response`: Retrieved document chunks (truncated snippets)
- Stage outputs: `router_output`, `retrieval_plan`, `simple_answer_result`, `complex_answer_draft`, `critic_result`

### Safety Constraints

The logging system is designed to be privacy-safe:
- API keys and secrets are never logged
- User question content is redacted by default (only logs length). Enable `CHAT_LOG_USER_CONTENT=1` for debugging
- LLM system prompts are truncated (~800 chars)
- LLM responses are truncated (~1500 chars)
- Document snippets are truncated (~200-500 chars)
- Auth tokens and user passwords are never logged

### Logging Utilities Location

- `server/utils/logger.ts`: Core logging functions (`log`, `logInfo`, `logDebug`, `logWarn`, `logError`, `truncate`)
- `server/utils/llmLogging.ts`: LLM-specific logging (`logLlmRequest`, `logLlmResponse`, `logLlmError`)
- `server/utils/fileSearchLogging.ts`: File Search logging (`logFileSearchRequest`, `logFileSearchResponse`)