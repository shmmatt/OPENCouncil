# OPENCouncil - NH Municipal Governance Assistant

## Overview
OPENCouncil is an AI-powered assistant designed to support New Hampshire elected officials and municipal workers. Its core function is to provide instant, accurate answers to governance questions by leveraging Google's Gemini AI and performing semantic searches over official municipal documents. The project aims to improve local governance efficiency and transparency by making municipal information readily accessible and actionable.

## User Preferences
Preferred communication style: Simple, everyday language.

## System Architecture

### Frontend
The frontend uses React, TypeScript, Vite, `shadcn/ui`, and Tailwind CSS for a responsive UI. State management is handled by TanStack Query, and client-side routing by `wouter`.

### Backend
The backend is an Express.js application in TypeScript, offering a secure RESTful API with JWT authentication, bcrypt for password hashing, and Multer for file uploads.

### Data Storage
PostgreSQL, hosted on Neon and utilizing Drizzle ORM, stores chat sessions, documents, and document chunks with pgvector embeddings.

### Retrieval Backend
A hybrid retrieval system combines pgvector-based semantic search with PostgreSQL full-text search. It uses Reciprocal Rank Fusion (RRF) and incorporates temporal re-ranking and document-type weighting.

### AI Integration
Google Gemini powers answer synthesis, embedding generation, metadata extraction, and multi-query planning.

### Chat Pipeline (V3)
The V3 chat pipeline implements a self-reflective RAG approach with three-lane parallel retrieval (Local, Statewide, and SAU). It processes queries through situation relevance gating, planning, hybrid retrieval, and AI-powered synthesis. It includes conditional "second hop" retrieval and optimizes for latency with parallel retrieval, SSE streaming, and asynchronous follow-up generation. The SAU lane activates for school-related questions, querying documents across an SAU's member towns and distinguishing between town and SAU actions in synthesis.

### Document Ingestion Pipeline (V2)
This pipeline manages document lifecycle from upload to indexing, including duplicate detection, AI-powered metadata suggestion, and a multi-tier town detection system.

### OCR Pipeline
A dual-provider OCR system uses Tesseract.js for low-text PDFs and AWS Textract for production-grade asynchronous OCR.

### Persistent Object Storage
Document files are stored in Replit Object Storage.

### Crawler / Data Collection
A sophisticated crawler system collects data using multi-strategy discovery (sitemaps, BFS, CMS-specific enhancements) and a hybrid "Fast Lane / Heavy Lane" architecture. It supports town-level, state-level, and SAU-level document collection, including integrations with Google Drive and CourtListener API. The SAU crawling infrastructure extends this to school district websites, linking documents to member towns and integrating with the embedding pipeline.

### OC Research Module
The OC Research tab provides analytical tools, including a Development Friction Report. This report uses an LLM-driven pipeline to analyze meeting documents, extract structured JSON data from agenda items, perform entity resolution, classify applications, and compute statistical insights such as time-to-decision, friction categories, and a representation gap. It generates narrative insights using Gemini and supports re-analysis of existing data. Key output components include summary statistics, a funnel visualization, representation gap analysis, residential vs. commercial timelines, an attrition curve, days added by constraint, and top friction triggers. Reports can be exported as PDF or CSV.

### Chat Review System
The chat review system uses Gemini 3.1 Pro for deep, architecture-aware analysis of chat sessions. It includes an architecture context injected into the reviewer LLM, performs per-session analysis to identify gap categories, pipeline stage attribution, critical domain errors, and generates prompting/pipeline suggestions. A batch rollup aggregates analyses into an improvement roadmap.

## External Dependencies

*   **Google Gemini API**: For AI functionalities like answer synthesis, embedding generation, and metadata extraction.
*   **Neon PostgreSQL**: Database hosting with pgvector extension.
*   **Google Fonts CDN**: For web fonts.
*   **AWS Textract**: For production-grade OCR processing.
*   **Web Scraping API (ZenRows/Scrapfly)**: For handling protected websites during crawling.
*   **Google Drive API v3**: For crawling public Google Drive folders.
*   **CourtListener REST API**: For fetching NH Supreme Court slip opinions.