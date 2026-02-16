# Municipal Document Crawler - Robust Design

## Goal
Reliably find 100% of documents on NH town websites regardless of CMS, tech stack, or design.

## Core Principles

### 1. Multiple Parallel Strategies (NOT Sequential)
Run ALL strategies, merge results. If one fails, others succeed.

```
┌─────────────────────────────────────────┐
│         DISCOVERY STRATEGIES            │
├─────────────────────────────────────────┤
│ 1. Sitemap Parsing                      │  ← 80% coverage
│ 2. Breadth-First Link Crawl             │  ← 90% coverage  
│ 3. Known Document Paths                 │  ← 50% coverage
│ 4. CMS-Specific (optional bonus)        │  ← 60% coverage
└─────────────────────────────────────────┘
              ↓ MERGE ↓
      ┌───────────────────┐
      │  Unique Doc URLs  │
      └───────────────────┘
```

### 2. Dead Simple Extraction
**Current:** Complex CMS-specific logic in page.evaluate()
**Better:** Extract ALL links, filter after

```typescript
// Get every link on the page
const allLinks = await page.$$eval('a[href]', links => 
  links.map(a => a.href)
);

// Filter for documents (outside browser context = debuggable!)
const docs = allLinks.filter(url => {
  const u = url.toLowerCase();
  return (
    u.includes('.pdf') ||
    u.includes('.doc') ||
    u.includes('/viewfile/') ||
    u.includes('/agendacenter/') ||
    u.includes('/documentcenter/') ||
    // ... clear, visible patterns
  );
});
```

### 3. Visibility Over Cleverness

**Every page should log:**
- URL being visited
- HTTP status code
- Number of links found
- Number of doc links found
- What patterns matched

**Example output:**
```
✓ https://town.gov/meetings (200)
  Links: 47 total, 12 documents
  Matched: 8 PDF, 4 ViewFile
```

### 4. Verification Built-In

After discovery, compare to known baseline:
```typescript
const discovered = crawlResults.documents.length;
const inS3 = await getS3Count(town);
const coverage = (discovered / inS3) * 100;

if (coverage < 80) {
  console.log(`⚠️  WARNING: Only found ${coverage}% of expected docs`);
  console.log(`   Expected: ${inS3}, Found: ${discovered}`);
}
```

## Proposed Architecture

### Phase 1: Discovery (Parallel)
```typescript
const results = await Promise.allSettled([
  discoverViaSitemap(url),
  discoverViaBreadthFirstCrawl(url, maxPages: 200),
  discoverViaKnownPaths(url),
  discoverViaCMSSpecific(url, cms) // optional
]);

const allUrls = new Set(results.flatMap(r => r.value || []));
```

### Phase 2: Document Extraction (Simple)
```typescript
for (const url of urlsToVisit) {
  const links = await getLinksFromPage(url); // Simple extraction
  
  // Filter for docs (outside browser = debuggable)
  const docLinks = links.filter(isDocumentLink);
  
  documents.push(...docLinks);
  
  // Log clearly
  console.log(`${url}: ${docLinks.length} docs found`);
}
```

### Phase 3: Verification
```typescript
const s3Count = await getS3DocumentCount(town);
const discoveredCount = documents.size;
const coverage = (discoveredCount / s3Count) * 100;

console.log(`Coverage: ${coverage.toFixed(1)}%`);
if (coverage < 90) {
  // Investigate why
}
```

## Key Changes from Current

### Remove
- ❌ Complex CMS-specific `page.evaluate()` logic
- ❌ Dynamic discovery that queues pages mid-crawl (hard to debug)
- ❌ Silent errors in browser context
- ❌ Different code paths for different CMS types

### Add
- ✅ Parallel discovery strategies
- ✅ Simple link extraction (all links, filter after)
- ✅ Clear, visible logging on every page
- ✅ Built-in verification against S3 baseline
- ✅ Errors that are impossible to hide

## Example: CivicPlus AgendaCenter

**Current approach:**
- Pregenerate 1,380 URLs (95% are 404s)
- Or: Dynamic discovery (complex, buggy)
- Special extraction logic in page.evaluate() (breaks silently)

**Robust approach:**
1. Start with `/AgendaCenter` (1 URL)
2. Extract all links from page (simple: `$$eval('a', a => a.href)`)
3. Filter for patterns: `ViewFile`, `pdf`, etc. (outside browser context)
4. Add navigation links to crawl queue
5. Repeat for 200 pages or until no new docs

**Why this works:**
- Finds everything naturally
- Easy to debug (filter logic is in Node, not browser)
- No 404s (only visit discovered links)
- Works for ANY CivicPlus config

## Testing Strategy

### Unit Tests
- Test URL pattern matching (easy, no browser needed)
- Test sitemap parsing
- Test link filtering

### Integration Tests  
- Test each discovery strategy separately
- Verify against known baseline (S3 counts)
- Alert if coverage drops below threshold

### End-to-End
- Run on 3 representative towns:
  1. WordPress (Madison)
  2. CivicPlus (Moultonborough)
  3. Custom (Conway)
- Verify 90%+ coverage on all three

## Migration Path

1. **Create new crawler (v3)** - don't modify v2
2. **Test in parallel** - run both, compare results
3. **Verify v3 finds ≥ v2 results** on all test towns
4. **Switch to v3** once proven
5. **Delete v2** only after full NH rollout

## Success Metrics

- ✅ 90%+ coverage on all Carroll County towns
- ✅ Works on WordPress, CivicPlus, custom sites
- ✅ Clear logs showing exactly what was found
- ✅ No silent failures
- ✅ Easy to debug specific towns
- ✅ Scales to 200+ towns without modification
