# 30-Minute Timeout Investigation

**Date**: 2026-02-12 03:02 UTC  
**Issue**: Batch crawls consistently killed at exactly 30 minutes

---

## Evidence

### Pattern
- **Run #1**: 22:48 - 23:18 UTC = 30 minutes exactly
- **Run #2**: 01:04 - 01:34 UTC = 30 minutes exactly
- **Signal**: SIGKILL
- **Context**: Both runs had different towns at different stages

### What We've Ruled Out

1. **Batch script timeout** ❌
   - Script has 20-minute timeout per town
   - Madison only ran 2 minutes before batch was killed
   
2. **System ulimits** ❌
   - `ulimit -a` shows: cpu time unlimited
   - No process or memory limits hit
   
3. **Memory pressure** ❌
   - 6.5 GB available
   - No swap usage
   - No OOM killer activity
   
4. **Systemd timeouts** ❌
   - User service has no relevant timeouts
   - JobTimeoutUSec=infinity
   
5. **Code-level timeouts** ❌
   - Searched codebase for 30-minute or 1800-second timeouts
   - Only found Playwright page.goto timeouts (30 seconds, not 30 minutes)

---

## Hypotheses

### Hypothesis 1: OpenClaw Exec Tool Default Timeout
**Evidence**:
- Using `background: true` with `yieldMs: 3600000`
- Process still killed at 30 minutes
- Suggests: yieldMs might not control max execution time

**Test**: Running `sleep 1860` (31 minutes) with background exec
- Session: gentle-crustacean
- Started: 03:02 UTC
- Expected: Will tell us if 30-min limit exists in exec tool

**If killed at 30 min**: Exec tool has hard 30-minute limit  
**If completes**: Problem is specific to npm/node processes

### Hypothesis 2: Node.js/NPM Process Manager
**Evidence**:
- Only npm processes get killed
- Simple exec commands might work longer

**Test**: Same as above (sleep vs npm command)

### Hypothesis 3: Gateway Process Management
**Evidence**:
- OpenClaw Gateway might have session limits
- Background processes might have different limits than foreground

**Investigation needed**: Check Gateway config or docs

### Hypothesis 4: Resource Exhaustion Over Time
**Evidence**:
- Multiple Chrome instances spawn during crawl
- Each town opens new browser
- After 10-11 towns (30 min), system might hit resource limit

**Counter-evidence**:
- Memory usage looks fine (6.5 GB available)
- No OOM killer activity

---

## Tests in Progress

1. **Long sleep test** (gentle-crustacean)
   - Command: `sleep 1860` (31 minutes)
   - Started: 03:02 UTC
   - Check at: 03:33 UTC
   - Will tell us: If 30-min limit is universal or npm-specific

---

## Workarounds (Until We Find Root Cause)

### Option A: Split Into Smaller Batches
Run 3 batches of 6 towns each:

**Batch 1** (already done):
- Albany, Bartlett, Brookfield, Chatham, Conway, Eaton
- Time: ~15-20 minutes

**Batch 2**:
- Effingham, Freedom, Madison, Moultonborough, Ossipee, Sandwich
- Time: ~20-25 minutes (Madison is slow)

**Batch 3**:
- Tamworth, Tuftonboro, Wakefield, Wolfeboro, Hart's Location, Jackson
- Time: ~15-20 minutes

Each batch < 30 minutes, all complete successfully.

### Option B: Run Without Background Flag
Try running foreground with manual monitoring:
```bash
cd OPENCouncil
npm run crawl:universal:v2:batch -- --dry-run
```

No `background: true` means no automatic timeout management.

### Option C: Run Key Towns Individually
Just get the 4 missing improvements:
```bash
npm run crawl:universal:v2 -- --town Madison --url https://madison-nh.org --dry-run
npm run crawl:universal:v2 -- --town Ossipee --url https://www.ossipee.org --dry-run
npm run crawl:universal:v2 -- --town Tuftonboro --url https://www.tuftonboronh.gov --dry-run
npm run crawl:universal:v2 -- --town Wakefield --url https://www.wakefieldnh.gov --dry-run
```

Total time: ~20 minutes, +1,088 docs

### Option D: Increase Batch Speed
Reduce max-pages from 100 to 50:
- Faster crawls (2-3 min per town avg)
- 18 towns × 3 min = ~54 min total
- Still might hit 30-min limit, but closer to completion

---

## Next Steps

1. **Check sleep test at 03:33 UTC** 
   - If killed: Exec tool has 30-min hard limit
   - If running: Problem is npm/node specific

2. **If exec tool has limit**:
   - File bug/question with OpenClaw
   - Use Option A (split batches) or Option C (manual towns)

3. **If npm-specific**:
   - Try running batch without background flag
   - Or use Option C (manual towns for quick win)

4. **Documentation search**:
   - Check OpenClaw docs for exec timeout behavior
   - Check if there's a config option to extend limits

---

## Immediate Recommendation

**Don't wait for investigation** - Use **Option C now**:

Run the 4 key towns individually (20 minutes total):
- Gets us +1,088 docs (the big wins)
- Avoids timeout issues
- Proven to work from individual tests

Then investigate timeout issue separately for future batch runs.

---

*Investigation started: 2026-02-12 03:02 UTC*  
*Test in progress: sleep 1860 (31 min)*  
*Check results at: 03:33 UTC*
