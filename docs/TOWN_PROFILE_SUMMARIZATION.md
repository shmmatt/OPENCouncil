# Town Profile Summarization Process

## Overview

The crawler fetches raw HTML from multiple town website pages, then uses **Gemini 2.0 Flash** to intelligently extract and structure the information into a town profile.

---

## How It Works

### **Step 1: Web Crawling (Resilient)**

**Fetches 3-15 pages** from town website:
- High priority: Homepage, Contact, Departments, Boards, Calendar
- Medium priority: Selectmen, Town Clerk, Services
- Low priority: Planning, Recreation, Permits

**Resilience features:**
- Retries failed pages (exponential backoff)
- Continues on partial success (min 3 pages)
- Stops after 5 consecutive failures
- Handles Cloudflare protection via browser automation

**Output:** 10,000-100,000 chars of cleaned text from crawled pages

---

### **Step 2: LLM Extraction (Gemini 2.0 Flash)**

**Model:** `gemini-2.0-flash-exp`  
**Why this model?**
- ✅ Fast (~2-5 seconds for extraction)
- ✅ Cheap (~$0.01 per extraction)
- ✅ Good at structured data extraction
- ✅ 1M token context (fits all crawled content)

**Process:**
1. Combine all crawled page text into single document
2. Send to Gemini with extraction prompt
3. LLM reads ALL content and extracts:
   - Town hall address, phone, hours
   - Board meeting schedules
   - Department contacts (names, phones, emails)
   - Service details (trash, recycling, transfer station)
   - Recreation facilities (beaches, parks)
   - Tax information (rates, due dates)
   - Permit details (fees, requirements)

**Prompt design:**
```
Extract town information for Ossipee, Carroll County, NH.

RULES:
1. Only extract explicitly stated facts - NO hallucinations
2. Use null for missing fields
3. Preserve exact wording for schedules/contacts
4. Return ONLY valid JSON

Content from 12 pages:
[SOURCE: https://www.ossipee.org]
...town hall is located at 195 Main St...
office hours Monday-Friday 8:00 AM - 4:00 PM...
[SOURCE: https://www.ossipee.org/contact]
...Board of Selectmen meets 2nd and 4th Monday at 6 PM...

Return JSON: { "townHall": { "address": "195 Main St", ... } }
```

**LLM's job:**
- **Find scattered info** (hours on one page, phone on another, address on a third)
- **Normalize formatting** (different pages might format dates/times differently)
- **Fill structured template** (JSON with specific fields)
- **Mark unknowns as null** (don't guess or make things up)

**Configuration:**
- `temperature: 0.1` (low = factual, no creativity)
- `maxOutputTokens: 4000` (plenty for a town profile)

**Output:** Structured JSON with ~50-200 fields populated

---

### **Step 3: Human Review & Correction**

**Why human review is critical:**
1. **LLM can hallucinate** (make up phone numbers, dates)
2. **Extraction errors** (parse "2nd Monday" as "Monday 2nd")
3. **Ambiguity** ("hours vary" → LLM guesses specific hours)
4. **Stale data** (page says "2023 hours" but doesn't clarify if current)

**Review checklist:**
- [ ] Town hall address/phone verified
- [ ] Meeting schedules match town calendar
- [ ] Contact info (names, extensions) are current
- [ ] Service schedules (trash, transfer station) accurate
- [ ] Fees/rates have year/date context
- [ ] No obviously made-up information

**Markdown output** makes review easy:
```markdown
## Town Hall

**Address:** 195 Main St, Ossipee, NH 03864  
**Phone:** 603-539-4181  ← VERIFY THIS
**Hours:** Monday-Friday 8:00 AM - 4:00 PM  ← CHECK IF CURRENT

## Boards & Committees

### Board of Selectmen
**Meeting Schedule:** 2nd and 4th Monday at 6:00 PM  ← CONFIRM
```

---

### **Step 4: Index Into Database**

Once reviewed and corrected:
1. Upload markdown as document (category: `town_profile`)
2. Tag with town name and last_updated date
3. Index into Gemini File Search store
4. Pipeline can now retrieve this during chat

**Result:** Chat pipeline answers questions like:
- "When is the next Ossipee Select Board meeting?"  
  → *Confidently* cites town profile with schedule
- "What are the town hall office hours?"  
  → No more "documents don't contain..." hedging

---

## Cost Analysis

### Per-Town Cost (Typical Run)

**Crawling:**
- 10 pages × 30s browser time = 5 min compute
- Cost: ~$0 (minimal compute, free tier)

**LLM Extraction:**
- Input: 50,000 chars ≈ 12,500 tokens
- Output: 2,000 tokens (JSON)
- Model: Gemini 2.0 Flash ($0.30/1M input, $1.20/1M output)
- **Cost: $0.004 input + $0.002 output = ~$0.006 total**

**Indexing:**
- Store markdown (5-10 KB)
- Cost: Included in Gemini storage quota

**Total per town: <$0.01**  
**All Carroll County (17 towns): <$0.20**

---

## Quality Improvements Over Time

### Current State (First Run)
- **Accuracy:** 70-80% (LLM extraction errors)
- **Completeness:** 40-60% (some pages don't load)
- **Tier A answers:** 0% → 20-30% (estimated)

### After Human Review
- **Accuracy:** 95%+ (verified facts)
- **Completeness:** 60-80% (still limited by what's on website)
- **Tier A answers:** 20-40%

### With Regular Updates (Monthly)
- **Accuracy:** 95%+
- **Completeness:** 80-95% (accumulate missing info over time)
- **Tier A answers:** 40-60%

### With Manual Supplements (Phone calls, visits)
- **Accuracy:** 98%+
- **Completeness:** 90-100%
- **Tier A answers:** 60-80%

---

## Example: What Gets Extracted

**Homepage** (`https://www.ossipee.org`):
```html
<h1>Welcome to Ossipee</h1>
<p>Town Hall is located at 195 Main Street...</p>
<p>For general inquiries, call 603-539-4181</p>
```

**Contact page** (`https://www.ossipee.org/contact`):
```html
<h2>Office Hours</h2>
<p>Monday through Friday: 8:00 AM to 4:00 PM</p>
<h2>Town Clerk</h2>
<p>Email: clerk@ossipee.org</p>
```

**Boards page** (`https://www.ossipee.org/boards`):
```html
<h3>Board of Selectmen</h3>
<p>Regular meetings: 2nd and 4th Monday at 6:00 PM</p>
<p>Location: Town Hall Conference Room</p>
```

**LLM combines all into:**
```json
{
  "townHall": {
    "address": "195 Main Street, Ossipee, NH",
    "phone": "603-539-4181",
    "hours": {
      "weekdays": "Monday through Friday: 8:00 AM to 4:00 PM",
      "weekends": null
    }
  },
  "boards": {
    "select_board": {
      "name": "Board of Selectmen",
      "meetingSchedule": "2nd and 4th Monday at 6:00 PM",
      "location": "Town Hall Conference Room"
    }
  },
  "departments": {
    "town_clerk": {
      "name": "Town Clerk",
      "email": "clerk@ossipee.org"
    }
  }
}
```

**User sees (markdown):**
```markdown
## Town Hall
**Address:** 195 Main Street, Ossipee, NH  
**Phone:** 603-539-4181  
**Hours:**  
- Weekdays: Monday through Friday: 8:00 AM to 4:00 PM  
- Weekends: Not specified

## Boards & Committees
### Board of Selectmen
**Meeting Schedule:** 2nd and 4th Monday at 6:00 PM  
**Location:** Town Hall Conference Room
```

---

## Alternative Approaches (Not Used)

### ❌ Manual Data Entry
- Pros: 100% accurate
- Cons: Slow, expensive, doesn't scale

### ❌ Web Scraping with Rules
- Pros: Deterministic
- Cons: Brittle (every site is different), maintenance nightmare

### ❌ GPT-4 for Extraction
- Pros: Slightly better accuracy
- Cons: 10x more expensive, slower, overkill for this task

### ✅ Gemini 2.0 Flash (Current)
- Pros: Fast, cheap, good enough, flexible
- Cons: Requires human review, occasional errors

---

## Future Enhancements

### 1. **Multi-Pass Extraction**
Run extraction twice with different prompts, compare results, flag discrepancies for review.

### 2. **Confidence Scores**
LLM outputs confidence per field:
```json
{
  "townHall": {
    "phone": "603-539-4181",
    "_confidence": { "phone": 0.95 }
  }
}
```

### 3. **Change Detection**
Re-crawl monthly, diff with previous version, flag changes for review.

### 4. **Source Citations**
LLM includes which page each fact came from:
```json
{
  "townHall": {
    "phone": "603-539-4181",
    "_source": "https://www.ossipee.org/contact"
  }
}
```

### 5. **Automated Verification**
Call phone numbers to verify, check meeting schedules against posted agendas.

---

## Key Takeaway

**The summarization is not magic** - it's an LLM reading multiple web pages and filling out a structured form, just like a human research assistant would. The difference is:

- **Speed:** 2 minutes vs 2 hours
- **Cost:** $0.006 vs $20-50 (human time)
- **Scale:** Can process 100 towns in an afternoon

But it **still requires human review** because LLMs make mistakes, especially with:
- Phone numbers (might transpose digits)
- Dates/times (might misparse "2nd Monday")
- Names (might spell wrong)
- Current vs historical info (might extract 2023 hours thinking they're current)

The workflow is: **AI drafts, human verifies, everyone wins.**
