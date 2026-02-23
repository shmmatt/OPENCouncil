# OPENCouncil - NH Municipal Governance Assistant

## Overview
OPENCouncil is an AI-powered assistant for New Hampshire elected officials and municipal workers. It delivers instant, accurate answers to governance questions by utilizing Google's Gemini AI for answer synthesis and pgvector-based semantic search over official municipal documents. The system provides a ChatGPT-style chat interface for end-users and a secure admin panel for document management, featuring an advanced ingestion pipeline with duplicate detection and AI-powered metadata extraction.

## User Preferences
Preferred communication style: Simple, everyday language.

## System Architecture

### Frontend
The frontend is built with React and TypeScript, using Vite for tooling. It leverages `shadcn/ui` (built on Radix UI primitives) and Tailwind CSS for styling. State management is handled by TanStack Query, and client-side routing uses `wouter`.

### Backend
The backend is an Express.js application written in TypeScript, exposing a RESTful API. It uses JWT for authentication in admin routes, bcrypt for password hashing, and Multer for handling file uploads (PDF, DOCX, TXT). Routes are organized into domain-specific routers.

### Data Storage
PostgreSQL is used as the primary database, accessed via Neon's serverless driver and Drizzle ORM. The schema includes tables for `admins`, `chatSessions`, `chatMessages`, `fileBlobs`, `logicalDocuments`, `documentVersions`, `ingestionJobs`, `documentChunks` (with pgvector for embeddings), and `embeddingJobs`. Drizzle Kit manages database migrations.

### Retrieval Backend (pgvector)
Documents are transformed into 768-dimensional vectors using Google Gemini's `text-embedding-004` model and stored in PostgreSQL with the pgvector extension. A two-lane retrieval system performs parallel town-specific and statewide semantic searches.

### AI Integration
Google Gemini is integrated for several core functionalities:
- **Answer synthesis**: Part of the V3 chat pipeline.
- **Embedding generation**: Creates vector representations of documents.
- **Metadata extraction**: Aids in organizing ingested documents.
- **Query planning**: Generates multi-query retrieval plans.
pgvector serves as the sole retrieval backend, with Gemini solely for synthesis, embedding, and metadata.

### Chat Pipeline (V3)
The V3 chat pipeline (`server/chatV2/chatOrchestratorV3.ts`) processes user queries through four main stages:
1.  **Situation Relevance Gating**: Initial assessment of query relevance.
2.  **Planning**: Generates an IssueMap and RetrievalPlanV3.
3.  **Retrieval**: Executes pgvector two-lane semantic search.
4.  **Synthesis**: Generates an answer using Gemini, with RecordStrength tiering.
5.  **Audit**: Validates format, detects drift, and performs repairs.

### Document Ingestion Pipeline (V2)
This pipeline follows a staged workflow: document upload, hashing, text extraction, AI-powered metadata suggestion, admin review, approval/rejection, and indexing. It includes features for detecting meeting minutes and a three-tier town detection system.

### OCR Pipeline (Dual-Provider)
The system supports two OCR providers:
-   **Tesseract.js**: Used by a background worker for low-text PDFs.
-   **AWS Textract**: The primary production-grade asynchronous OCR pipeline for S3-sourced documents. It uses a state machine to manage jobs from queuing to materialization, involving precheck workers and polling workers for text extraction and storage.

### Persistent Object Storage
Document files are stored in Replit Object Storage, with paths starting `/replit-objstore`. Legacy local paths are supported for backward compatibility.

### Crawler / Data Collection
A comprehensive crawler system is in place for data collection. This includes an in-house server-side crawler engine that handles discovery and download, supports state source crawling, and features an admin panel for managing crawl jobs, viewing town status, and triggering crawls. It includes structured failure tracking and document deduplication.

## External Dependencies

### Third-Party Services
1.  **Google Gemini API**: Used for answer synthesis, embedding generation, and metadata extraction.
2.  **Neon PostgreSQL**: Provides the database with the pgvector extension for vector search.
3.  **Google Fonts CDN**: Used for web fonts (Inter, JetBrains Mono).
4.  **AWS Textract**: For production-grade asynchronous OCR processing.

### Key NPM Packages
*   **Frontend**: `react`, `react-dom`, `@tanstack/react-query`, `wouter`, `@radix-ui/*`, `tailwindcss`, `zod`, `react-hook-form`.
*   **Backend**: `express`, `drizzle-orm`, `@neondatabase/serverless`, `@google/genai`, `bcryptjs`, `jsonwebtoken`, `multer`, `pdf-parse`, `mammoth`, `tesseract.js`.