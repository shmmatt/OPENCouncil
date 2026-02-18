# Town Profile System

## Overview

Synthesized "Town Profile" documents that contain operational information extracted from town websites. These documents solve the Tier C problem by providing clean, structured sources for common questions about office hours, meeting schedules, contacts, services, etc.

## Problem Solved

**Before:** Pipeline retrieved historical meeting minutes when users asked "When is the next meeting?" → Tier C answers  
**After:** Pipeline retrieves town profile with current meeting schedule → Tier A answers

## Architecture

### 1. **Schema** (`shared/town-profile-schema.ts`)
TypeScript interface defining the structure:
- Town hall (address, phone, hours)
- Boards & committees (meeting schedules, contacts)
- Departments (staff, phone, email, hours)
- Services (trash, recycling, transfer station)
- Recreation (beaches, parks, programs)
- Taxes (rates, due dates, payment methods)
- Permits (fees, requirements, contacts)
- Voting (polling locations, registration)

### 2. **Crawler** (`scripts/crawl-town-profile.ts`)
Script that:
1. Crawls town website (multiple pages)
2. Extracts content
3. Uses LLM (Gemini) to extract structured data
4. Generates JSON + Markdown outputs

**Usage:**
```bash
npm run crawl:town -- --town Ossipee --url https://www.ossipee.org
```

**Output:**
- `town-profiles/{town}-profile-{date}.json` - Structured data
- `town-profiles/{town}-profile-{date}.md` - Human-readable document

### 3. **Review Workflow**
1. Crawler generates profile
2. Admin reviews markdown file for accuracy
3. Admin approves → upload to document ingestion
4. Index as logical document: `{Town} Town Profile - {Date}`
5. Set category: `town_profile` or `contact_info`

### 4. **Indexing Strategy**
Index the **markdown file** (not JSON) because:
- Human-readable
- Contains all info in natural language
- Pipeline can easily retrieve relevant sections
- Markdown formatting improves readability

## Advantages Over Raw HTML Indexing

| Raw HTML Pages | Synthesized Profile |
|----------------|---------------------|
| Low signal-to-noise | High signal-to-noise |
| Info scattered across 5-10 pages | All in one place |
| Stale content mixed with current | Current info only |
| Navigation, ads, scripts | Just facts |
| Partial retrieval ("contact on page A, hours on page B") | Complete retrieval |

## Current Status

### ✅ Complete:
- Schema defined
- Crawler script written
- JSON → Markdown converter
- Demo profile created (Ossipee, manual)

### ⚠️ Blocked:
- Automated crawling (Cloudflare blocks bots)

### Options:
1. **Manual creation** (quick win) - Create profiles manually from town websites
2. **Headless browser** - Use Playwright/Puppeteer to bypass Cloudflare
3. **Professional scraping service** - Use service with residential proxies
4. **AI web agent** - Use tool like Browser Use to navigate and extract

## Quick Win: Manual Profiles

**Recommended approach for MVP:**
1. Manually create profiles for Ossipee + Conway (2-3 hours each)
2. Index them as documents
3. Re-run comprehensive test
4. Measure Tier C → Tier B/A improvements
5. Automate later once proven valuable

**Why:**
- Proves concept quickly
- No scraping infrastructure needed
- Can iterate on schema based on real usage
- 2-3 profiles cover 90% of test questions

## Expected Impact

### Test Questions Improved:
- **Meetings:** "When is next meeting?" → Tier C → A (100% improvement)
- **Contact:** "Office hours?" → Tier C → A (100% improvement)
- **Services:** "Trash pickup day?" → Tier C → B (significant improvement)
- **Taxes:** "When are taxes due?" → Tier C → A (100% improvement)

### Overall Target:
- **Current:** 0% Tier A, 24% Tier B, 76% Tier C
- **After profiles:** 20% Tier A, 50% Tier B, 30% Tier C

## Files

```
shared/
  town-profile-schema.ts       # TypeScript schema + converter

scripts/
  crawl-town-profile.ts         # Crawler script (Cloudflare-blocked)
  test-profile-conversion.ts    # Test JSON → MD conversion

town-profiles/
  ossipee-profile-2026-02-05-manual.json  # Demo JSON
  ossipee-profile-2026-02-05-manual.md    # Demo markdown (READY TO INDEX)
  README.md                               # This file
```

## Next Steps

### Option A: Quick Win (Recommended)
1. Manually create Conway profile (copy Ossipee template)
2. Upload both markdown files to document ingestion
3. Index as "Ossipee Town Profile - February 2026"
4. Re-run comprehensive test on meeting/contact/tax questions
5. Measure improvement

### Option B: Automate
1. Add headless browser (Playwright) to crawler
2. Handle Cloudflare challenge
3. Test on Ossipee, Conway sites
4. Schedule monthly re-crawl
5. Build admin review UI

## Maintenance

**Frequency:** Monthly (or quarterly)
- Town info changes slowly
- Meeting schedules change annually
- Office hours rarely change
- Staff turnover is infrequent

**Process:**
1. Re-crawl or manually update
2. Review changes
3. Upload new version
4. Index as current version (supersedes old)

## Cost

**Storage:** ~10KB per profile (negligible)  
**Indexing:** 1 document per town (no extra cost)  
**Maintenance:** 1-2 hours per town per quarter

## Questions?

See demo file: `ossipee-profile-2026-02-05-manual.md`

Test conversion: `npm run tsx scripts/test-profile-conversion.ts`

Ready to index and test!
