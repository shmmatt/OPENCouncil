# Crawler Intelligence API

Base URL: `/api/crawler-intel`

## Authentication

If `CRAWLER_BOT_API_KEY` is set in the environment, all requests must include:
```
Authorization: Bearer <CRAWLER_BOT_API_KEY>
```
If the env var is not set, the API is open (development mode).

---

## Workflow: Assess → Plan → Crawl → Review

1. **Get Briefing** — Call `GET /:townSlug/briefing` to understand the current state
2. **Refresh Assessment** (if stale) — Call `POST /:townSlug/assess` if the assessment is >24h old
3. **Review Gaps** — Call `GET /:townSlug/gaps` to see prioritized coverage gaps with search hints
4. **Trigger Crawl** — Call `POST /:townSlug/crawl` with appropriate mode/maxPages
5. **Monitor Progress** — Poll `GET /:townSlug/runs/:runId` until status is `completed` or `failed`
6. **Review Results** — Call `GET /:townSlug/briefing` again to see updated coverage

---

## Endpoints

### GET /towns

List all registered towns with overview stats.

**Response:**
```json
{
  "towns": [
    {
      "id": "uuid",
      "name": "Ossipee",
      "slug": "ossipee",
      "url": "https://www.ossipee.org",
      "cms": "Custom",
      "status": "active",
      "population": 4372,
      "totalDocuments": 55,
      "totalUploaded": 0,
      "consecutiveFailures": 0,
      "lastRunStatus": "completed",
      "lastRunDate": "2026-02-20T...",
      "urlCount": 200,
      "documentsByStatus": { "uploaded": 500, "failed": 3 }
    }
  ]
}
```

---

### GET /:townSlug/briefing

Consolidated intelligence briefing for a town. Returns everything the bot needs in one call.

**URL Parameters:**
- `townSlug` — Town slug (e.g., `ossipee`) or name (e.g., `Ossipee`)

**Response Fields:**
- `town` — Town config (id, name, url, cms, population, status, maxPages, customPaths, etc.)
- `documentStats` — Total tracked documents + predicted counts by category
- `coverage` — Latest coverage assessment (overallScore, estimated vs predicted counts, category scores, notes)
- `gaps` — Gap analysis with prioritized gaps, target paths, and link text patterns
- `recentRuns` — Last 10 crawl runs with full summaries including failure breakdowns
- `failurePatterns` — Aggregated failure patterns across recent runs (recurring error types, recent error URLs)
- `_meta` — Briefing metadata (generation time, assessment age in hours, usage hints)

**Response Example (abbreviated):**
```json
{
  "town": {
    "id": "uuid",
    "name": "Ossipee",
    "slug": "ossipee",
    "url": "https://www.ossipee.org",
    "cms": "Custom",
    "population": 4372,
    "maxPages": null,
    "customPaths": null
  },
  "documentStats": {
    "totalTracked": 807,
    "populationBasedPrediction": {
      "meeting_minutes": 512,
      "agendas": 358,
      "ordinances": 31,
      "budgets": 24,
      "annual_reports": 8,
      "forms_applications": 25,
      "newsletters": 48,
      "zoning": 15,
      "plans_studies": 12,
      "policies_procedures": 10,
      "elections": 16,
      "other": 51
    }
  },
  "coverage": {
    "overallScore": "66.50",
    "assessedAt": "2026-02-20T19:55:53.777Z",
    "estimated": { "meeting_minutes": 453, "agendas": 10, ... },
    "predicted": { "meeting_minutes": 512, "agendas": 358, ... },
    "categoryScores": {
      "agendas": { "score": 3, "rating": "poor", "estimated": 10, "predicted": 358 },
      "meeting_minutes": { "score": 88, "rating": "excellent", "estimated": 453, "predicted": 512 }
    }
  },
  "gaps": {
    "overallScore": 66.5,
    "topPriority": "agendas",
    "gaps": [
      {
        "category": "agendas",
        "label": "Agendas",
        "priority": "critical",
        "predicted": 358,
        "found": 10,
        "deficit": 348,
        "score": 3,
        "rating": "poor",
        "searchHints": [
          { "strategy": "path_patterns", "patterns": ["/agendas", "/AgendaCenter", ...] },
          { "strategy": "link_text", "patterns": ["agenda", "meeting agenda", ...] }
        ]
      }
    ],
    "targetPaths": ["https://www.ossipee.org/agendas", ...],
    "linkPatterns": ["agenda", "meeting agenda", ...]
  },
  "recentRuns": [
    {
      "id": "uuid",
      "mode": "full",
      "triggerType": "bot",
      "status": "completed",
      "pagesVisited": 150,
      "documentsDiscovered": 45,
      "documentsUploaded": 12,
      "documentsFailed": 3,
      "summary": {
        "failuresByType": { "http_404": 2, "timeout": 1 },
        "errors": [{ "url": "...", "error": "HTTP 404", "failureType": "http_404" }]
      }
    }
  ],
  "failurePatterns": {
    "patterns": [
      { "type": "http_404", "label": "Not Found (404)", "totalOccurrences": 5, "appearsInRuns": 3, "isRecurring": true }
    ],
    "recentErrors": [{ "url": "...", "error": "HTTP 404", "failureType": "http_404", "runId": "uuid" }],
    "totalRunsAnalyzed": 8
  },
  "_meta": {
    "briefingGeneratedAt": "2026-02-21T...",
    "assessmentAge": 24,
    "hint": "Use POST /:townSlug/assess to refresh coverage assessment, POST /:townSlug/crawl to trigger a crawl"
  }
}
```

---

### POST /:townSlug/assess

Trigger a fresh coverage assessment using LLM-based filename classification. This can take 1-5 minutes for towns with many documents.

**Response:**
```json
{
  "message": "Coverage assessment completed for Ossipee",
  "assessment": {
    "overallScore": "66.50",
    "estimated": { ... },
    "predicted": { ... },
    "categoryScores": { ... }
  }
}
```

---

### GET /:townSlug/gaps

Get prioritized coverage gaps with actionable search hints for filling them.

**Requires:** A coverage assessment must exist (run `POST /:townSlug/assess` first if not).

**Response:**
```json
{
  "townId": "uuid",
  "townName": "Ossipee",
  "overallScore": 66.5,
  "topPriority": "agendas",
  "gaps": [
    {
      "category": "agendas",
      "label": "Agendas",
      "priority": "critical",
      "predicted": 358,
      "found": 10,
      "deficit": 348,
      "searchHints": [
        { "strategy": "path_patterns", "patterns": ["/agendas", "/AgendaCenter"] },
        { "strategy": "link_text", "patterns": ["agenda", "meeting agenda"] },
        { "strategy": "cms_api", "patterns": ["/AgendaCenter/Search?..."] }
      ]
    }
  ],
  "targetPaths": ["https://www.ossipee.org/agendas", ...],
  "linkPatterns": ["agenda", ...]
}
```

**Priority Levels:** `critical` (score < 20), `high` (< 40), `medium` (< 60), `low` (< 80)

---

### POST /:townSlug/crawl

Trigger a crawl for a town. The crawl runs as a background process and results are tracked through the standard run pipeline.

**Request Body (all optional):**
```json
{
  "mode": "full",
  "maxPages": 200
}
```

- `mode`: `"full"` (default) | `"incremental"` | `"manual"`
- `maxPages`: Override maximum pages to visit

**Response:**
```json
{
  "message": "Crawl started for Ossipee",
  "runId": "uuid",
  "mode": "full",
  "maxPages": 200,
  "triggerType": "bot",
  "hint": "Poll GET /:townSlug/runs/<runId> for status updates"
}
```

**Important:** Bot-triggered crawls are recorded with `triggerType: "bot"` so they can be distinguished from manual runs in the admin dashboard.

---

### GET /:townSlug/runs

List crawl runs for a town with full summaries.

**Query Parameters:**
- `limit` — Max results (default 20, max 100)
- `offset` — Pagination offset

**Response:**
```json
{
  "runs": [
    {
      "id": "uuid",
      "mode": "full",
      "triggerType": "bot",
      "status": "completed",
      "startedAt": "2026-02-21T...",
      "completedAt": "2026-02-21T...",
      "pagesVisited": 150,
      "documentsDiscovered": 45,
      "documentsDownloaded": 40,
      "documentsUploaded": 12,
      "documentsFailed": 3,
      "errorMessage": null,
      "summary": {
        "byCategory": {},
        "newDocuments": 12,
        "duplicates": 28,
        "failuresByType": { "http_404": 2, "timeout": 1 },
        "errors": [{ "url": "...", "error": "HTTP 404", "failureType": "http_404" }]
      }
    }
  ],
  "total": 8
}
```

---

### GET /:townSlug/runs/:runId

Get details of a specific run including comparison stats.

**Response:**
```json
{
  "id": "uuid",
  "status": "completed",
  "summary": { ... },
  "comparison": {
    "newDocuments": 12,
    "alreadyKnown": 500,
    "failed": 3
  }
}
```

---

### GET /:townSlug/documents

List discovered documents for a town.

**Query Parameters:**
- `limit` — Max results (default 100, max 500)
- `offset` — Pagination offset
- `status` — Filter by status: `discovered`, `downloaded`, `uploaded`, `failed`
- `search` — Search by filename or URL

**Response:**
```json
{
  "documents": [
    {
      "id": "uuid",
      "url": "https://...",
      "filename": "2024-selectmen-minutes.pdf",
      "category": "meeting_minutes",
      "status": "uploaded",
      "mimeType": "application/pdf",
      "sizeBytes": 102400,
      "discoveredAt": "2026-02-20T..."
    }
  ],
  "total": 807
}
```

---

## Document Categories

The system classifies documents into these categories:
- `meeting_minutes` — Board/committee meeting minutes
- `agendas` — Meeting agendas and packets
- `ordinances` — Town ordinances and regulations
- `budgets` — Budget documents, audits, warrants
- `annual_reports` — Annual town reports
- `forms_applications` — Permits, forms, applications
- `newsletters` — Town newsletters and bulletins
- `zoning` — Zoning maps, regulations
- `plans_studies` — Master plans, studies
- `policies_procedures` — Town policies
- `elections` — Election-related documents
- `other` — Uncategorized

## Failure Types

Crawl errors are classified into these types:
- `http_404` — Not Found
- `http_403` — Forbidden
- `http_5xx` — Server Error (500/502/503/504)
- `timeout` — Page load timeout
- `connection_refused` — Server refused connection
- `ssl_error` — SSL/TLS certificate error
- `dns_error` — DNS resolution failed
- `parse_error` — HTML/content parse error
- `download_failed` — Download or connection reset
- `captcha_blocked` — CAPTCHA or bot detection
- `too_large` — File exceeds size limit
- `unsupported_format` — Unsupported file format
- `unknown` — Unclassified error

## Run Statuses

- `running` — Crawl is in progress
- `completed` — Crawl finished successfully
- `failed` — Crawl encountered a fatal error
- `timeout` — Crawl exceeded time limit

## CMS Types

Known CMS platforms that affect crawl strategy:
- `CivicPlus` — Uses AgendaCenter API, DocumentCenter
- `WordPress` — Standard WP paths
- `Revize` — Revize CMS patterns
- `Custom` — Custom/unknown platform
