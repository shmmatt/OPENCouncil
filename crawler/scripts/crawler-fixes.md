# Crawler Crash Root Causes & Fixes

## Issues Identified

### 1. **Cloudflare Headful Crash** (Ossipee)
**Problem:** Code tries to launch browser with `headless: false` on a headless server
```typescript
browser = await chromium.launch({
  headless: false,  // ❌ CRASHES - no X display on server
  args: [...]
});
```
**Impact:** Any Cloudflare-protected site crashes the crawler
**Solution:** Remove headful relaunch, use stealth mode only

### 2. **CivicPlus Dynamic Content** (Moultonborough, 263 docs exist but only 1 found)
**Problem:** CivicPlus uses JavaScript-rendered content
- AgendaCenter/DocumentCenter pages return 0 links
- Need to wait for JS execution and use API endpoints
**Impact:** 0-1 docs found on CivicPlus sites instead of hundreds
**Solution:** Add CivicPlus API discovery + better JS waiting

### 3. **Timeout/Browser Crashes** (Sandwich)
**Problem:** Homepage timeout → browser closes → crash
**Impact:** Process crashes mid-crawl
**Solution:** Better error recovery, continue on homepage failure

## Baseline Data
- Madison (WordPress): 1,401 docs in S3 ✅ Working
- Moultonborough (CivicPlus): 263 docs in S3 ❌ Only finds 1
- Ossipee (Custom): 655 docs in S3 ❌ Cloudflare crash
- Sandwich (WordPress): 2 docs in S3 ⚠️ Timeout

## Generalized Solutions

### Fix 1: Remove Cloudflare Headful Relaunch
- Keep stealth mode only
- Accept Cloudflare blocks gracefully
- Alternative: Use Xvfb virtual display

### Fix 2: CivicPlus Discovery Strategy
CivicPlus sites have predictable API endpoints:
- `/api/v1/AgendaItems`
- `/api/v1/Documents`
- `/api/v1/Forms`

Add dedicated CivicPlus crawler that:
1. Detects CivicPlus from homepage
2. Queries API endpoints
3. Extracts document URLs from JSON responses

### Fix 3: Better Error Recovery
- Homepage failure → continue with sitemap only
- Browser crash → log and move to next town
- Timeout → save checkpoint and resume

## Implementation Priority
1. **Immediate:** Remove headful launch (prevents crashes)
2. **High:** Add CivicPlus API discovery (unlocks 500+ docs per town)
3. **Medium:** Better error recovery
