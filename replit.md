# OPENCouncil - NH Municipal Governance Assistant

## Overview
OPENCouncil is an AI-powered assistant designed for New Hampshire elected officials and municipal workers. Its primary purpose is to provide instant, accurate answers to governance questions. It achieves this by synthesizing information using Google's Gemini AI and performing semantic searches over official municipal documents. The project's vision is to enhance local governance efficiency and transparency by making municipal information easily accessible and actionable.

## User Preferences
Preferred communication style: Simple, everyday language.

## System Architecture

### Frontend
The frontend is built with React and TypeScript, utilizing Vite, `shadcn/ui`, and Tailwind CSS for a modern, responsive user interface. State management is handled by TanStack Query, and client-side routing uses `wouter`.

### Backend
The backend is an Express.js application written in TypeScript, providing a RESTful API. It includes JWT for authentication, bcrypt for password hashing, and Multer for file uploads, ensuring secure and efficient data handling.

### Data Storage
PostgreSQL is the primary database, accessed via Neon and Drizzle ORM. It stores various municipal data including chat sessions, documents, and document chunks with pgvector embeddings for efficient retrieval.

### Retrieval Backend
A hybrid retrieval system combines pgvector-based semantic search with PostgreSQL full-text search. This system uses Reciprocal Rank Fusion (RRF) to merge results, and incorporates temporal re-ranking and document-type weighting for enhanced relevance.

### AI Integration
Google Gemini is central to the system, providing capabilities for answer synthesis, embedding generation, metadata extraction, and sophisticated query planning for multi-query retrieval.

### Chat Pipeline (V3)
The V3 chat pipeline implements a self-reflective RAG (Retrieval Augmented Generation) approach. It processes user queries through stages including situation relevance gating, planning, hybrid retrieval, and AI-powered synthesis. It also features a conditional "second hop" retrieval for refining answers when initial context is insufficient.

### Document Ingestion Pipeline (V2)
This pipeline manages document lifecycle from upload to indexing, featuring duplicate detection, AI-powered metadata suggestion, and a multi-tier town detection system.

### OCR Pipeline
A dual-provider OCR system uses Tesseract.js for low-text PDFs and AWS Textract for production-grade asynchronous OCR, ensuring comprehensive text extraction from diverse document formats.

### Persistent Object Storage
Document files are stored in Replit Object Storage, providing scalable and secure storage for all municipal documents.

### Crawler / Data Collection
A sophisticated crawler system is responsible for data collection, featuring multi-strategy discovery (sitemaps, BFS, CMS-specific enhancements), hybrid "Fast Lane / Heavy Lane" architecture for resilient fetching, interstitial detection, and crash resilience. It supports both town-level and state-level document collection, including Google Drive and CourtListener API integrations.

### OC Research Module
The OC Research tab provides analytical tools to extract insights from municipal data, such as analyzing Planning Board and ZBA meeting minutes to identify site plan approval friction patterns and generate predictive insights using a 3-stage Map-Reduce Gemini pipeline.

## External Dependencies

1.  **Google Gemini API**: For AI functionalities like answer synthesis, embedding generation, and metadata extraction.
2.  **Neon PostgreSQL**: Database hosting with pgvector extension.
3.  **Google Fonts CDN**: For web fonts.
4.  **AWS Textract**: For production-grade OCR processing.
5.  **Web Scraping API (ZenRows/Scrapfly)**: For handling protected websites during crawling.
6.  **Google Drive API v3**: For crawling public Google Drive folders.
7.  **CourtListener REST API**: For fetching NH Supreme Court slip opinions.