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

### Situation Anchoring & Topic Continuity
The chat system includes guardrails to maintain topic continuity across follow-up questions, preventing the AI from drifting to unrelated but high-signal documents (e.g., switching from a boardwalk ADA vote to an enforcement case).

**Key Components**:
- `server/chatV2/situationExtractor.ts` - Heuristic-based entity extraction and situation tracking
- `server/chatV2/driftDetector.ts` - Post-generation drift detection using semantic coverage
- `server/chatV2/chatConfig.ts` - Configuration options for tuning the feature

**How It Works**:
1. **Situation Extraction**: When users ask about specific situations (events, properties, cases), entities are extracted and stored in `chatSessions.situationContext`
2. **Topic-Prior Re-ranking**: Retrieved chunks are scored for topic relevance and re-ranked to prefer on-topic content
3. **Strict System Prompt**: Synthesis prompt includes topic continuity rules preventing unrelated case substitution
4. **Drift Detection**: Post-generation check identifies off-topic entities; if drift is detected, answer is regenerated with stronger anchoring

**Configuration Options** (in `chatConfig.ts`):
- `ENABLE_SITUATION_ANCHORING` - Enable/disable the feature (default: true)
- `SITUATION_MATCH_WEIGHT` - Weight for topic relevance in re-ranking (default: 0.3)
- `MIN_ON_TOPIC_CHUNK_RATIO` - Minimum ratio of on-topic chunks (default: 0.4)
- `ENABLE_DRIFT_DETECTION` - Enable post-generation drift check (default: true)
- `MAX_DRIFT_REGENERATION_ATTEMPTS` - Max regeneration attempts (default: 1)

### Legal Salience Biasing
The two-lane retrieval system includes legal salience detection to improve answers for legal/liability/compliance questions.

**How It Works**:
1. **Salience Detection**: `computeLegalSalience()` analyzes the user question for legal keywords (liability, ADA, RSA, compliance, etc.) and patterns ("can they", "is this allowed", "what law")
2. **Dynamic Lane Tuning**: When salience >= 0.5:
   - State lane K increases by 4 (from 8 to 12)
   - State context cap increases by 2 (from 5 to 7)
   - State chunks receive a small score boost (0.12 * salience)
3. **Guaranteed State Coverage**: Ensures at least 3 state chunks in merged results when salience is high
4. **Prompt Enhancement**: Adds legal framework instructions requesting the AI to include an "Applicable legal framework (NH + federal)" section

**Key Files**:
- `server/chatV2/twoLaneRetrieve.ts` - Contains `computeLegalSalience()` and dynamic retrieval logic
- `server/chatV2/unifiedPipeline.ts` - Contains `buildLegalFrameworkInstructions()` for prompt enhancement

### V3 Pipeline Quality Improvements (January 2026)
Major improvements to answer quality, tiering, and retrieval:

**Synthesizer Format Spec**:
- New 5-section format: Bottom line → What we know (from sources) → What the law generally requires → What changes / what the decision affects (or "How this typically works in NH") → Unknowns that matter
- Dynamic section 4 title: Uses "What changes..." when facts contain explicit action/vote/decision, otherwise "How this typically works in NH"
- Hard caps: 500 words max, bullet limits (5/5/4/4), no bullet > 20 words
- Temperature reduced to 0.2 for conciseness
- Citation discipline: `[USER]` only in "What we know", `[Sx]` required in law section when state chunks exist
- Topic continuity rules: No speculation, no "assumes it refers to...", no force-fitting prior context

**Situation Relevance Gating** (January 2026):
- Prevents "sticky context" leakage where prior conversation topics leak into unrelated questions
- **Generalized design** - no hardcoded example terms; works for any municipal governance topics
- `DOMAIN_CATEGORIES` in `situationExtractor.ts` defines generic domains: budget, zoning, personnel, elections, public_safety, infrastructure, environmental, development
- `computeQuestionSituationMatch()` scores question-context relevance:
  - +1 for each situation entity appearing in question
  - +0.5 for partial word matches on significant words
  - +0.5 for title keyword overlap
  - +1 for generic explicit references ("that vote", "the project", "going back to")
  - +1.5 for dynamic explicit entity references ("the [stored entity]")
  - -2 penalty when question domain differs from situation domain AND no entity overlap
- `hasExplicitEntityReference()` dynamically checks for "the/that/this [entity]" patterns
- Gate threshold: `useSituationContext = (score >= 2)`
- **History filtering**: When gated, conversation history is also cleared (`historyForSynthesis = []`)
- Logged: `situationGated`, `situationScore`, `situationReason`, `historyCleared`
- When gated, planner/retriever/synthesizer see no stored situation context AND no conversation history

**Anti-bridging Patterns**:
- Audit detects "assumes it refers to", "assuming this relates to" patterns
- Rejection triggers repair generation for cleaner answers

**Format Validation & Repair**:
- `validateAnswerFormat()` in `audit.ts` checks word count, heading order, bullet counts, citation requirements
- Rejects LLM tail phrases ("next steps", "consult counsel", "you may wish to")
- `hardTruncateAnswer()` fallback for failed repairs
- `getTierCFallback()` for minimal valid answers when repair fails

**Tiering Improvements**:
- New tier rubric using `distinctStateDocs` and `authoritativeStatePresent`
- Tier A: stateCount >= 4 AND (authoritativeState OR distinctDocs >= 2) AND alignment >= 0.30
- Tier B: stateCount >= 2 AND alignment >= 0.20
- Never drop below Tier B when legalSalience >= 0.6 and stateCount >= 2

**Authority Detection**:
- Robust RSA pattern matching in both title AND content: `/\bRSA\s+\d+/i`
- NHMA detection in combined text
- Official source patterns: DOJ, NHDES, Secretary of State, Attorney General

**Early Exit Logic**:
- For legal questions (legalSalience >= 0.6), require better state coverage before early exit
- Must have: distinctStateDocs >= 2 OR authoritativeStatePresent
- Plus: stateCount >= minState (4) AND legalTopicCoverage >= 0.5
- Non-legal questions use basic chunk count threshold

**State Lane Deduplication**:
- `dedupeChunksByDocument()` normalizes titles for strict deduplication
- `distinctStateDocs` count used for tiering and early exit decisions
- Prevents duplicate document inflation of coverage metrics

**Debug Fields**:
- Synthesis: wordCount, headingsInOrder, stateCitationCount, lawSectionHasStateCitations, llmTailsFound
- Retrieval: distinctStateDocs, distinctLocalDocs, earlyExitReason, legalSalience, authoritativeStatePresent

### Build & Deployment
The application uses Vite for frontend development and esbuild for backend bundling. It is designed for single-server deployment, serving static files and the API, with external managed PostgreSQL and environment variable-based configuration.

## External Dependencies

### Third-Party Services
1.  **Google Gemini API**: AI capabilities for Q&A and document grounding.
2.  **Neon PostgreSQL**: Serverless PostgreSQL database hosting.
3.  **Google Fonts CDN**: Delivers Inter and JetBrains Mono fonts.

### Key NPM Packages
*   **Frontend**: `react`, `react-dom`, `@tanstack/react-query`, `wouter`, `@radix-ui/*`, `tailwindcss`, `zod`, `react-hook-form`.
*   **Backend**: `express`, `drizzle-orm`, `@neondatabase/serverless`, `@google/genai`, `bcryptjs`, `jsonwebtoken`, `multer`, `pdf-parse`, `mammoth`, `tesseract.js`, `pdf-poppler`.
*   **Development**: `vite`, `tsx`, `esbuild`, `drizzle-kit`, `typescript`.

### OCR Pipeline (January 2026)
Automatic OCR detection and processing for scanned PDFs:

**Configuration (Environment Variables):**
- `OCR_ENABLED`: Enable/disable OCR processing (default: `true`)
- `OCR_PROVIDER`: OCR provider to use (`tesseract` or `none`, default: `tesseract`)
- `OCR_MIN_CHAR_THRESHOLD`: Minimum character count to skip OCR (default: `1200`)

**How it works:**
1. When files are uploaded, text extraction is attempted using pdf-parse
2. If extracted text is below the threshold (likely a scanned PDF), the document is flagged for OCR
3. A background worker processes queued documents using Tesseract.js
4. PDF pages are converted to images using pdf-poppler, then OCR'd
5. Extracted OCR text replaces the preview text for LLM analysis

**Database Columns (file_blobs table):**
- `extracted_text_char_count`: Character count from initial extraction
- `needs_ocr`: Boolean flag for documents requiring OCR
- `ocr_status`: Status (`none`, `queued`, `processing`, `completed`, `failed`, `blocked`)
- `ocr_text`: Full OCR-extracted text
- `ocr_text_char_count`: Character count from OCR
- `ocr_failure_reason`: Error message if OCR fails
- `ocr_queued_at`, `ocr_started_at`, `ocr_completed_at`: Timestamps

**Admin API Endpoints:**
- `GET /api/admin/ocr/queue`: List documents needing OCR
- `POST /api/admin/ocr/queue/:blobId`: Manually queue a document for OCR
- `GET /api/admin/ocr/status/:blobId`: Get OCR status for a document