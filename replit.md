# OPENCouncil - NH Municipal Governance Assistant

## Overview
OPENCouncil is an AI-powered assistant designed to support New Hampshire elected officials and municipal workers. Its core function is to provide instant, accurate answers to governance questions by leveraging Google's Gemini AI and performing semantic searches over official municipal documents. The project aims to improve local governance efficiency and transparency by making municipal information readily accessible and actionable.

## User Preferences
Preferred communication style: Simple, everyday language.

## System Architecture

### Frontend
The frontend is built with React, TypeScript, Vite, `shadcn/ui`, and Tailwind CSS, ensuring a modern and responsive user interface. State management uses TanStack Query, and client-side routing is handled by `wouter`.

### Backend
The backend is an Express.js application written in TypeScript, providing a secure RESTful API with JWT for authentication, bcrypt for password hashing, and Multer for file uploads.

### Data Storage
PostgreSQL, hosted on Neon and accessed via Drizzle ORM, stores chat sessions, documents, and document chunks with pgvector embeddings for efficient retrieval.

### Retrieval Backend
A hybrid retrieval system combines pgvector-based semantic search with PostgreSQL full-text search. It uses Reciprocal Rank Fusion (RRF) to merge results, incorporating temporal re-ranking and document-type weighting for enhanced relevance.

### AI Integration
Google Gemini powers answer synthesis, embedding generation, metadata extraction, and sophisticated query planning for multi-query retrieval.

### Chat Pipeline (V3)
The V3 chat pipeline implements a self-reflective RAG (Retrieval Augmented Generation) approach. It processes user queries through stages including situation relevance gating, planning, hybrid retrieval, and AI-powered synthesis. It also features a conditional "second hop" retrieval for refining answers and optimizes for latency through parallel retrieval, streaming responses via Server-Sent Events (SSE), and asynchronous follow-up generation.

### Document Ingestion Pipeline (V2)
This pipeline manages the document lifecycle from upload to indexing, featuring duplicate detection, AI-powered metadata suggestion, and a multi-tier town detection system.

### OCR Pipeline
A dual-provider OCR system utilizes Tesseract.js for low-text PDFs and AWS Textract for production-grade asynchronous OCR, ensuring comprehensive text extraction from various document formats.

### Persistent Object Storage
Document files are stored in Replit Object Storage, providing scalable and secure storage.

### Crawler / Data Collection
A sophisticated crawler system collects data using multi-strategy discovery (sitemaps, BFS, CMS-specific enhancements) and a hybrid "Fast Lane / Heavy Lane" architecture for resilient fetching. It supports town-level and state-level document collection, including integrations with Google Drive and CourtListener API.

### OC Research Module
The OC Research tab provides analytical tools for municipal data analysis, including a **Development Friction Report**. This report uses a multi-phase pipeline to:
1.  Retrieve full meeting text documents.
2.  Detect agenda-item boundaries via LLM analysis.
3.  Extract structured JSON data from each agenda item using Gemini.
4.  Perform deterministic entity resolution to deduplicate and merge project timelines, handling address normalization and temporal gaps.
5.  Compute statistical insights like time-to-decision, friction categories, and frequent applicants.
6.  Generate narrative insights using Gemini based on the computed statistics.
7.  Support re-analysis of existing report data without re-crawling.

## External Dependencies

*   **Google Gemini API**: For AI functionalities like answer synthesis, embedding generation, and metadata extraction.
*   **Neon PostgreSQL**: Database hosting with pgvector extension.
*   **Google Fonts CDN**: For web fonts.
*   **AWS Textract**: For production-grade OCR processing.
*   **Web Scraping API (ZenRows/Scrapfly)**: For handling protected websites during crawling.
*   **Google Drive API v3**: For crawling public Google Drive folders.
*   **CourtListener REST API**: For fetching NH Supreme Court slip opinions.