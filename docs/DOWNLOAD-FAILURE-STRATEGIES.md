# Download Failure Strategies

**Date**: 2026-02-15  
**Context**: First batch download run showing ~9-10% failure rate

## Current Failure Breakdown (407 failures from 4,300 processed)

### By Error Type
- **352 × HTTP 403** (Forbidden) - 86% of failures
- **34 × HTTP 503** (Service Unavailable) - 8% of failures  
- **20 × HTTP 404** (Not Found) - 5% of failures
- **Timeouts** - 1% of failures

### By Domain (Top Offenders)
1. **ossipee.org**: 149 failures (403 Forbidden)
2. **tuftonboronh.gov**: 109 failures (403 Forbidden)
3. **wakefieldnh.gov**: 57 failures (403 Forbidden)
4. **brookfieldnh.gov**: 38 failures (403 Forbidden)
5. **townofbartlett.nh.gov**: 34 failures (503 Service Unavailable)

## Root Causes

### 1. Bot Detection / Rate Limiting (403s)
**Problem**: Towns using CivicPlus or similar CMSs detect automated downloads
**Evidence**: Multiple rapid requests from same IP triggering WAF/bot protection

### 2. Server Overload (503s)
**Problem**: Small town servers can't handle our request volume
**Evidence**: Bartlett's DocumentCenter returning 503s when overwhelmed

### 3. Broken Links (404s)
**Problem**: Crawled URLs that no longer exist or were typos
**Evidence**: URLs like `Jan20.pdf.pdf` (double extension)

## Improvement Strategies

### Strategy 1: Per-Domain Rate Limiting ⭐ (High Priority)

**Implement domain-based request queuing**:
```typescript
const domainQueues = new Map<string, Array<Download>>();
const domainLastRequest = new Map<string, number>();
const MIN_DELAY_PER_DOMAIN = 5000; // 5 seconds between requests to same domain

async function downloadWithDomainRateLimit(url: string) {
  const domain = new URL(url).hostname;
  const lastRequest = domainLastRequest.get(domain) || 0;
  const timeSinceLastRequest = Date.now() - lastRequest;
  
  if (timeSinceLastRequest < MIN_DELAY_PER_DOMAIN) {
    await new Promise(r => setTimeout(r, MIN_DELAY_PER_DOMAIN - timeSinceLastRequest));
  }
  
  const result = await downloadDocument(url);
  domainLastRequest.set(domain, Date.now());
  return result;
}
```

**Benefits**:
- Prevents overwhelming single servers
- Respects implicit rate limits
- Reduces 403/503 errors dramatically

**Expected Impact**: 403s drop from 352 → ~50, 503s drop to near zero

---

### Strategy 2: Browser Automation for 403s ⭐ (High Priority)

**Use Playwright for sites that block fetch()**:
```typescript
async function downloadViaBrowser(url: string) {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
  });
  
  const response = await page.goto(url);
  const buffer = await response.body();
  
  await browser.close();
  return buffer;
}
```

**When to use**: After 403 failure, retry with Playwright

**Benefits**:
- Full browser context bypasses most bot detection
- JavaScript execution if needed
- Proper headers/cookies

**Expected Impact**: 403s drop from 352 → ~20

---

### Strategy 3: Exponential Backoff for Retries (Medium Priority)

**Implement smart retry logic**:
```typescript
async function downloadWithRetry(url: string, maxRetries = 3) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await downloadDocument(url);
    } catch (error) {
      if (attempt === maxRetries) throw error;
      
      const backoffMs = Math.min(1000 * Math.pow(2, attempt), 30000);
      await new Promise(r => setTimeout(r, backoffMs));
    }
  }
}
```

**Benefits**:
- Handles temporary 503s
- Gives servers time to recover
- Catches transient network issues

**Expected Impact**: 503s drop from 34 → ~5

---

### Strategy 4: 404 URL Correction (Low Priority)

**Attempt common URL fixes**:
```typescript
async function attemptUrlCorrection(url: string) {
  // Try common fixes
  const fixes = [
    url,                           // Original
    url.replace('.pdf.pdf', '.pdf'), // Double extension
    url.replace('//', '/'),          // Double slash
    url.toLowerCase(),               // Case sensitivity
  ];
  
  for (const fixedUrl of [...new Set(fixes)]) {
    try {
      return await downloadDocument(fixedUrl);
    } catch (error) {
      continue;
    }
  }
  
  throw new Error('All URL corrections failed');
}
```

**Expected Impact**: 404s drop from 20 → ~10

---

### Strategy 5: Progressive Slowdown (Medium Priority)

**Detect rate limiting and back off automatically**:
```typescript
let consecutiveFailures = 0;
let currentBatchDelay = 2000;

async function processWithAdaptiveRate() {
  try {
    await processBatch();
    consecutiveFailures = 0;
    currentBatchDelay = Math.max(2000, currentBatchDelay * 0.9); // Speed up
  } catch (error) {
    if (error.status === 403 || error.status === 503) {
      consecutiveFailures++;
      currentBatchDelay = Math.min(30000, currentBatchDelay * 1.5); // Slow down
      console.log(`⚠️  Rate limit detected, increasing delay to ${currentBatchDelay}ms`);
    }
  }
  
  await new Promise(r => setTimeout(r, currentBatchDelay));
}
```

**Expected Impact**: Prevents cascade failures

---

## Implementation Plan for Retry

### Phase 1: Quick Wins (30 min)
1. Add per-domain rate limiting (5-10 sec delays)
2. Add exponential backoff retries (3 attempts)
3. Run retry on current failures

**Expected**: ~650 failures → ~150 failures

### Phase 2: Browser Fallback (1 hour)
1. Integrate Playwright for 403 retry
2. Run on remaining ~150 failures

**Expected**: ~150 failures → ~30 failures

### Phase 3: Manual Review (15 min)
1. Review remaining ~30 failures
2. Identify patterns (dead domains, moved sites, etc.)
3. Mark as permanent failures or investigate manually

**Final Expected Failure Rate**: 0.3% (~30 out of 10,000)

---

## Enhanced Download Worker v2

```typescript
/**
 * Enhanced download with all strategies
 */
async function downloadEnhanced(doc: Document): Promise<Buffer> {
  const domain = new URL(doc.url).hostname;
  
  // Strategy 1: Domain rate limiting
  await respectDomainRateLimit(domain);
  
  try {
    // Strategy 2: Standard fetch with retry
    return await downloadWithRetry(doc.url, 3);
    
  } catch (error) {
    if (error.status === 403) {
      // Strategy 3: Browser fallback
      console.log(`[Fallback] Using browser for ${doc.url}`);
      return await downloadViaBrowser(doc.url);
      
    } else if (error.status === 404) {
      // Strategy 4: URL correction
      console.log(`[Correction] Attempting URL fixes for ${doc.url}`);
      return await attemptUrlCorrection(doc.url);
      
    } else {
      throw error;
    }
  }
}
```

---

## Success Metrics

**Current Run (Baseline)**:
- Success rate: 84.3%
- Failures: 407 (9.5%)
- Rate: 277 docs/min

**After Strategy 1-3 (Target)**:
- Success rate: 99.5%
- Failures: ~50 (0.5%)
- Rate: 150 docs/min (slower but higher success)

**Final (After all strategies)**:
- Success rate: 99.7%
- Failures: ~30 (0.3%)
- Rate: 150-200 docs/min

---

## Next Steps

1. **Let current run complete** (~20 min remaining)
2. **Analyze final failure list** by domain/error
3. **Implement Strategy 1 (domain rate limiting)** - highest ROI
4. **Run retry pass 1** with Strategies 1-3
5. **Implement Strategy 2 (browser fallback)** for remaining 403s
6. **Run retry pass 2** with browser fallback
7. **Manual review** of final failures

**Total time to <1% failure rate**: ~2 hours after current run completes
