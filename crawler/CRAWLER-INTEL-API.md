# Crawler Intelligence API

Base URL: `/api/crawler-intel`

## Authentication

If `CRAWLER_BOT_API_KEY` is set in the environment, all requests must include:
```
Authorization: Bearer <CRAWLER_BOT_API_KEY>
```
If the env var is not set, the API is open (development mode).

---

## Workflows

### Single-Town: Assess > Plan > Crawl > Review

1. **Quick Check** — Call `GET /:townSlug/quick-check` to see if reassessment is needed
2. **Get Briefing** — Call `GET /:townSlug/briefing` to understand the current state
3. **Refresh Assessment** (if recommended) — Call `POST /:townSlug/assess` if quick-check says so
4. **Review Gaps** — Call `GET /:townSlug/gaps` to see prioritized coverage gaps with search hints
5. **Trigger Focused Crawl** — Call `POST /:townSlug/crawl` with `targetPaths` and `linkPatterns` from gap analysis
6. **Monitor Progress** — Poll `GET /:townSlug/runs/:runId` until status is `completed` or `failed`
7. **Review Results** — Call `GET /:townSlug/briefing` again to see updated coverage

### Fleet Automation: Batch > Prioritize > Execute

1. **Get Fleet Summary** — Call `GET /fleet/summary` for aggregate stats across all towns
2. **Get Fleet Status** — Call `GET /fleet/status` for all towns ranked by staleness score
3. **Get Next Batch** — Call `GET /fleet/next-batch?limit=10` for the top N towns needing attention
4. **Register New Towns** — Call `POST /towns` to add towns to the fleet
5. **Execute Batch** — For each town in the batch, follow the single-town workflow above

---

## Error Response Format

All errors use a structured format for deterministic bot handling:

```json
{
  "error": {
    "code": "TOWN_NOT_FOUND",
    "message": "Town 'xyz' not found. Use GET /api/crawler-intel/towns to list available towns.",
    "retryable": false,
    "retryAfterSeconds": 30
  }
}
```

**Error Codes:**
| Code | HTTP | Retryable | Description |
|------|------|-----------|-------------|
| `AUTH_MISSING` | 401 | No | No Authorization header provided |
| `AUTH_INVALID` | 403 | No | Invalid API key |
| `TOWN_NOT_FOUND` | 404 | No | Town slug/name not found |
| `TOWN_EXISTS` | 409 | No | Town already registered |
| `RUN_NOT_FOUND` | 404 | No | Crawl run ID not found |
| `ASSESSMENT_REQUIRED` | 404 | No | No assessment exists; run assess first |
| `ASSESSMENT_FAILED` | 500 | Yes | Assessment LLM call failed |
| `CRAWL_START_FAILED` | 500 | Yes | Crawl process failed to start |
| `INVALID_INPUT` | 400 | No | Request body validation failed |
| `INTERNAL_ERROR` | 500 | Yes | Unexpected server error |

---

## Endpoints

### POST /towns

Register a new town in the crawler fleet.

**Request Body:**
```json
{
  "name": "Dover",
  "url": "https://www.dover.nh.gov",
  "state": "NH",
  "population": 32741,
  "county": "Strafford",
  "cms": "CivicPlus",
  "maxPages": 500
}
```

Required: `name`, `url`. All other fields optional. `state` defaults to `"NH"`.

**Response (201):**
```json
{
  "message": "Town 'Dover' registered successfully",
  "town": {
    "id": "uuid",
    "name": "Dover",
    "slug": "dover",
    "url": "https://www.dover.nh.gov",
    "state": "NH",
    "population": 32741,
    "county": "Strafford",
    "cms": "CivicPlus",
    "status": "active"
  }
}
```

---

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
      "state": "NH",
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

### GET /fleet/status

All towns ranked by staleness score (highest = most urgent). Staleness accounts for days since last crawl, assessment age, consecutive failures, and coverage score.

**Response:**
```json
{
  "towns": [
    {
      "id": "uuid",
      "name": "Moultonborough",
      "slug": "moultonborough",
      "status": "active",
      "coverageScore": 45.2,
      "daysSinceLastCrawl": 14,
      "assessmentAgeHours": 336,
      "consecutiveFailures": 3,
      "totalDocuments": 120,
      "totalUploaded": 100,
      "lastRunStatus": "completed",
      "activeRunId": null,
      "stalenessScore": 83
    }
  ],
  "total": 19,
  "generatedAt": "2026-02-21T..."
}
```

**Staleness Score Formula:**
- No crawl ever: +100
- Days since last crawl: min(days * 3, 60)
- No assessment: +30
- Assessment >168h old: +15
- Coverage <50: +20; <70: +10
- Per consecutive failure: +5

---

### GET /fleet/summary

Aggregate stats across the entire crawler fleet.

**Response:**
```json
{
  "overview": {
    "totalTowns": 19,
    "totalDocuments": 14593,
    "totalUploaded": 13636,
    "totalFailed": 957,
    "totalUrls": 2080,
    "activeRuns": 1
  },
  "coverage": {
    "townsAssessed": 4,
    "averageScore": 57.39,
    "excellentCoverage": 1,
    "poorCoverage": 1,
    "unassessed": 15
  },
  "recentFailures": [
    {
      "townId": "uuid",
      "townName": "Chatham",
      "status": "failed",
      "errorMessage": "Process exited without reporting final status",
      "startedAt": "2026-02-15T..."
    }
  ],
  "generatedAt": "2026-02-21T..."
}
```

---

### GET /fleet/next-batch

Get the top N towns that most urgently need crawling. Filters out paused/disabled towns and towns with active runs.

**Query Parameters:**
- `limit` — Max results (default 10, max 50)

**Response:**
```json
{
  "batch": [
    {
      "id": "uuid",
      "name": "Albany",
      "slug": "albany",
      "url": "https://albanynh.org",
      "cms": "WordPress",
      "population": 759,
      "coverageScore": null,
      "daysSinceLastCrawl": 7,
      "consecutiveFailures": 0,
      "urgencyScore": 76,
      "recommendedMode": "incremental",
      "recommendedMaxPages": 300
    }
  ],
  "totalCandidates": 17,
  "limit": 10,
  "generatedAt": "2026-02-21T..."
}
```

**Urgency Score Formula:**
- No crawl ever: +100
- Days since last crawl: min(days * 3, 60)
- No assessment: +30
- Coverage <50: +25; <70: +12
- Consecutive failures >=3: -20 (deprioritizes chronically broken sites)
- Floor at 0 (can't go negative)
- `recommendedMode`: "full" if never crawled or >14 days stale; "incremental" otherwise
- `recommendedMaxPages`: Uses town override, or 500 for pop>5000, else 300

---

### GET /:townSlug/briefing

Consolidated intelligence briefing for a town. Returns everything the bot needs in one call.

**URL Parameters:**
- `townSlug` — Town slug (e.g., `ossipee`) or name (e.g., `Ossipee`)

**Response Fields:**
- `town` — Town config (id, name, url, cms, population, status, maxPages, customPaths, etc.)
- `documentStats` — Total tracked documents + population-based predicted counts by category
- `coverage` — Latest coverage assessment (overallScore, estimated vs predicted counts, category scores, notes)
- `gaps` — Gap analysis with prioritized gaps, target paths, and link text patterns
- `recentRuns` — Last 10 crawl runs with full summaries including failure breakdowns
- `failurePatterns` — Aggregated failure patterns across recent runs (recurring error types, recent error URLs)
- `_meta` — Briefing metadata (generation time, assessment age in hours, days since last crawl, usage hints)

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
    "estimated": { "meeting_minutes": 453, "agendas": 10 },
    "predicted": { "meeting_minutes": 512, "agendas": 358 },
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
          { "strategy": "path_patterns", "patterns": ["/agendas", "/AgendaCenter"] },
          { "strategy": "link_text", "patterns": ["agenda", "meeting agenda"] }
        ]
      }
    ],
    "targetPaths": ["https://www.ossipee.org/agendas"],
    "linkPatterns": ["agenda", "meeting agenda"]
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
    "daysSinceLastCrawl": 2,
    "hint": "Use POST /:townSlug/assess to refresh coverage assessment, POST /:townSlug/crawl to trigger a crawl"
  }
}
```

---

### GET /:townSlug/quick-check

Lightweight check comparing current document counts against last assessment without calling the LLM. Helps the bot decide whether a full re-assessment is worth the cost.

**Response:**
```json
{
  "townId": "uuid",
  "townName": "Ossipee",
  "currentDocCount": 807,
  "lastAssessment": {
    "docCountAtAssessment": 626,
    "overallScore": "66.50",
    "assessedAt": "2026-02-20T19:55:53.777Z",
    "ageHours": 19
  },
  "docCountDelta": 181,
  "significantChange": true,
  "assessmentStale": false,
  "reassessmentRecommended": true,
  "reason": "Document count changed by 181 since last assessment"
}
```

**Reassessment Logic:**
- `significantChange`: True if |delta| > max(10, 5% of previous count)
- `assessmentStale`: True if no assessment exists or age > 168 hours (7 days)
- `reassessmentRecommended`: True if either condition is met

---

### POST /:townSlug/assess

Trigger a fresh coverage assessment using LLM-based filename classification. This can take 1-5 minutes for towns with many documents.

**Response:**
```json
{
  "message": "Coverage assessment completed for Ossipee",
  "assessment": {
    "overallScore": "66.50",
    "estimated": { "meeting_minutes": 453, "agendas": 10 },
    "predicted": { "meeting_minutes": 512, "agendas": 358 },
    "categoryScores": { "agendas": { "score": 3, "rating": "poor" } }
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
  "targetPaths": ["https://www.ossipee.org/agendas"],
  "linkPatterns": ["agenda"]
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
  "maxPages": 200,
  "targetPaths": ["https://www.ossipee.org/agendas", "https://www.ossipee.org/AgendaCenter"],
  "linkPatterns": ["agenda", "meeting agenda", "agenda packet"],
  "callbackUrl": "https://my-bot.example.com/webhook/crawl-complete"
}
```

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `mode` | string | `"full"` | `"full"`, `"incremental"`, or `"manual"` |
| `maxPages` | number | town default | Override maximum pages to visit |
| `targetPaths` | string[] | — | Priority URLs to visit first (from gap analysis) |
| `linkPatterns` | string[] | — | Link text patterns to follow (from gap analysis) |
| `callbackUrl` | string | — | URL to POST run summary to when crawl completes |

**Response:**
```json
{
  "message": "Crawl started for Ossipee",
  "runId": "uuid",
  "mode": "full",
  "maxPages": 200,
  "triggerType": "bot",
  "targetPaths": ["https://www.ossipee.org/agendas"],
  "linkPatterns": ["agenda", "meeting agenda"],
  "callbackUrl": "https://my-bot.example.com/webhook/crawl-complete",
  "hint": "Poll GET /:townSlug/runs/<runId> for status updates"
}
```

**Gap-Driven Focused Crawl Example:**
```bash
# 1. Get gaps
gaps=$(curl -s /api/crawler-intel/ossipee/gaps)

# 2. Extract targetPaths and linkPatterns from response
# 3. Pass them into the crawl trigger:
curl -X POST /api/crawler-intel/ossipee/crawl \
  -H "Content-Type: application/json" \
  -d '{
    "mode": "full",
    "maxPages": 300,
    "targetPaths": ["https://www.ossipee.org/agendas"],
    "linkPatterns": ["agenda", "meeting agenda"]
  }'
```

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
  "summary": {},
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

## Reference

### Document Categories

| Key | Label |
|-----|-------|
| `meeting_minutes` | Meeting Minutes |
| `agendas` | Agendas |
| `ordinances` | Ordinances & Regulations |
| `budgets` | Budgets & Financial |
| `annual_reports` | Annual/Town Reports |
| `forms_applications` | Forms & Applications |
| `newsletters` | Newsletters & Notices |
| `zoning` | Zoning Documents |
| `plans_studies` | Plans & Studies |
| `policies_procedures` | Policies & Procedures |
| `elections` | Elections & Voting |
| `other` | Other Documents |

### Failure Types

| Key | Label |
|-----|-------|
| `http_404` | Not Found (404) |
| `http_403` | Forbidden (403) |
| `http_5xx` | Server Error (5xx) |
| `timeout` | Timeout |
| `connection_refused` | Connection Refused |
| `ssl_error` | SSL/TLS Error |
| `dns_error` | DNS Resolution Failed |
| `parse_error` | Parse Error |
| `download_failed` | Download Failed |
| `captcha_blocked` | CAPTCHA/Bot Blocked |
| `too_large` | File Too Large |
| `unsupported_format` | Unsupported Format |
| `unknown` | Unknown Error |

### Run Statuses

- `running` — Crawl is in progress
- `completed` — Crawl finished successfully
- `failed` — Crawl encountered a fatal error
- `timeout` — Crawl exceeded time limit

### CMS Types

Known CMS platforms that affect crawl strategy:
- `CivicPlus` — Uses AgendaCenter API, DocumentCenter
- `WordPress` — Standard WP paths
- `Revize` — Revize CMS patterns
- `Custom` — Custom/unknown platform
