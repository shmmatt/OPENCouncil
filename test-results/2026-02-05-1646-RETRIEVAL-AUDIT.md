# Retrieval Audit: Document Database vs Test Performance
**Date:** 2026-02-05 16:46 UTC

---

## 🎯 Conclusion: **Retrieval is Working, Documents are Missing**

The pipeline is **correctly retrieving documents** from the database. The problem is that **the documents don't contain the information users are asking for**.

---

## 📊 Database Inventory

### **Ossipee:**
- **Legacy table:** 228 documents
- **V2 pipeline:** 229 + 734 = **963 total documents**
- **Breakdown:** 640 meeting minutes, 71 general documents, 9 ordinances, 6 permits, 4 reports, 2 tax records, 2 financials

### **Conway:**
- **V2 pipeline:** **1,044 documents**
- **Breakdown:** 714 meeting minutes, 239 general documents, 44 reports, 31 permits, 9 tax records, 6 ordinances, 1 financial

### **Statewide:**
- **409 documents** (RSAs, state laws, guides)

### **Total:** ~2,417 documents

---

## 🔍 What's Actually in the Database?

### ✅ **What We Have:**
1. **Meeting minutes (historical):** 640+ Ossipee, 714 Conway
   - From 2018-2026 (Board of Selectmen, Planning Board, ZBA, Budget Committee)
   - Example: `selectmens_meeting_1-27-2025.pdf`, `bos_meeting_minutes_1-5-2026.pdf`

2. **Fee schedules (partial):**
   - Ossipee: Planning Board fee schedule (2023), ZBA fee schedule (2018)
   - Conway: Rental inspection fees, tax rates (2019-2025), water/sewer rates
   - Ossipee: Transfer station fees (2024)

3. **Tax rates:**
   - Conway: 2019-2025 tax rates
   - Statewide: Municipal tax rates (2023-2025)

4. **Zoning ordinances:**
   - Ossipee: Zoning ordinance 2025, building codes
   - State: NH RSAs

5. **Policies & regulations:**
   - Public input policies, cemetery rules, planning board procedures
   - State: Right-to-Know law, town meeting guides

### ❌ **What We DON'T Have:**

1. **Current/Future Meeting Schedules:**
   - ❌ Board calendars for 2026
   - ❌ Upcoming meeting dates/times
   - ❌ Current agendas
   - ✅ Found: `SB_Meeting_Schedule_2025-2026.pdf` (statewide, not town-specific)
   - ✅ Found: `budget_committee_schedule_2026.pdf` (Ossipee - ONE board only!)

2. **Office Hours:**
   - ❌ Town hall hours
   - ❌ Department hours (clerk, tax collector, etc.)
   - ❌ Weekend/holiday schedules

3. **Contact Information:**
   - ❌ Phone numbers
   - ❌ Email addresses
   - ❌ Staff directory with current names
   - ❌ Department contact sheets

4. **Comprehensive Fee Schedules:**
   - ✅ Have: Planning Board, ZBA, transfer station
   - ❌ Missing: Building permits, other permit fees, beach passes, recreation fees

5. **Service Schedules:**
   - ❌ Trash pickup schedules
   - ❌ Transfer station hours
   - ❌ Recycling schedules
   - ❌ Hazardous waste collection events

6. **Recreation Information:**
   - ❌ Beach locations
   - ❌ Program registration info
   - ❌ Park rules
   - ❌ Facility fees

7. **Budget Documents:**
   - ❌ Current town budget (detailed)
   - ❌ Warrant articles (current year)
   - ❌ Vote results

8. **Current Operational Data:**
   - ❌ Current town administrator name
   - ❌ Current board member rosters
   - ❌ Current tax due dates (specific to 2026)

---

## 🧪 Test Case Analysis: "When is the next Ossipee Select Board meeting?"

### What the Pipeline Retrieved:
- **9 local chunks + 5 state chunks**
- **Tier C** (lowest quality)

### What Was in Those Documents:
1. `bos_public_input_policy.pdf` - Public participation policy (no dates)
2. Meeting minutes from 2021-2025 (historical dates, not future)
3. NH Right-to-Know Law (24-hour notice requirement, not actual schedule)

### Why Tier C?
The answer started with:
> "The provided documents do not explicitly state a regular meeting schedule for the Ossipee Select Board... Past meeting dates are mentioned from 2021, but no future dates are listed..."

**Translation:** The pipeline found relevant documents (policies, past minutes) but they don't answer the question.

---

## 📈 Keyword Search Results

### Documents with "schedule", "agenda", "meeting":
- **83 legacy + 307 v2** = **390 documents**
- **BUT:** Almost all are past meeting **minutes**, not future **schedules**
- **Exception:** `budget_committee_schedule_2026.pdf` (ONE board only)

### Documents with "contact", "directory", "phone", "hours":
- **2 legacy + 4 v2** = **6 documents**
- **None** are actual contact directories or office hours
- Example: "FY2027_New_Staff_Requests.pdf" (irrelevant)

### Documents with "fee", "cost", "rate":
- **15 legacy + 31 v2** = **46 documents**
- **Good coverage** for tax rates (statewide + Conway)
- **Partial coverage** for permit fees (Ossipee: PB, ZBA; Conway: rental inspection)
- **Missing** many other fee schedules

---

## 🎭 Retrieval vs Content Problem

### ✅ **Retrieval is Working:**
- Pipeline correctly finds documents with relevant keywords
- 9 local + 5 state chunks retrieved for meeting question = good coverage
- Search queries are well-formed: "Ossipee Select Board meeting schedule", "upcoming meetings", etc.

### ❌ **Content is the Problem:**
- Documents contain **past** information (minutes from 2021-2025)
- Documents lack **future** information (2026 meeting schedule)
- Documents lack **current** operational data (office hours, contacts)

### **Example:**
- **Query:** "When is the next Ossipee Select Board meeting?"
- **Retrieved:** Meeting minutes from Jan 2026, policy on public input
- **What user needs:** "2nd Monday of each month at 6 PM, next meeting Feb 10"
- **What documents say:** "The meeting on January 27th was held... public is welcome per policy"
- **Gap:** Minutes tell you a meeting **happened**, not when the **next** one is

---

## 💡 Why Voting & Zoning Did Better

**Voting:** 80% Tier B+  
**Zoning:** 80% Tier B+

### Why?
1. **State law is comprehensive:** NH RSAs cover voter registration, absentee voting, zoning variance procedures in detail
2. **Procedures are standardized:** Statewide processes work for all towns
3. **We have zoning ordinances:** Ossipee zoning ordinance 2025 is in the database

### But...
This isn't ideal! Users want **local** answers:
- "Where is my polling place?" (town-specific) vs "How do I register to vote?" (statewide)
- "What are Ossipee setback requirements?" (local ordinance) vs "What is a zoning variance?" (state law)

When we answer with state law, it's technically correct but not as helpful as town-specific info.

---

## 🛠️ Recommended Actions

### **1. Acquire Forward-Looking Documents (High Priority)**
**What:** Current board meeting schedules for 2026
**Where to get:**
- Town websites (calendar pages)
- Town hall (request printed schedules)
- Board secretary emails

**Format:** Simple structured doc:
```
Ossipee Board of Selectmen - 2026 Meeting Schedule
Regular meetings: 2nd and 4th Monday of each month, 6:00 PM
Location: Town Hall conference room
Agendas posted: 24 hours in advance at Town Hall and www.ossipee.org
Contact for agenda items: Town Administrator, 603-539-4181
```

### **2. Create Town Contact Directories (High Priority)**
**What:** Office hours, phone numbers, staff names, email addresses
**Where to get:**
- Town websites (contact pages)
- Town hall (staff directory)
- Phone the office and ask

**Format:**
```
Ossipee Town Hall
Address: 195 Main St, Ossipee, NH 03864
Phone: 603-539-4181
Hours: Monday-Friday 8:00 AM - 4:00 PM
Closed: Weekends and legal holidays

Town Administrator: [Name], ext 101, [email]
Town Clerk: [Name], ext 102, [email]
Tax Collector: [Name], ext 103, [email]
```

### **3. Add Current Fee Schedules (Medium Priority)**
**What:** Building permits, beach passes, recreation programs, etc.
**Status:** Partial coverage (have PB, ZBA, transfer station)
**Missing:** Building permits, beach/recreation fees, many others

### **4. Scrape Town Websites Regularly (Medium Priority)**
**What:** Automated scraping of town websites for current info
**Targets:**
- Calendar pages
- Contact pages
- Fee schedule pages
- Notice/agenda boards

**Frequency:** Weekly or monthly

### **5. Add Metadata: Document Type & Freshness (Medium Priority)**
**What:** Tag documents with:
- `type`: "schedule" | "contact" | "minutes" | "ordinance" | "fee_schedule"
- `temporal`: "current" | "historical" | "annual" | "evergreen"
- `last_verified`: Date

**Benefit:** Pipeline can prefer current documents over stale ones

### **6. Don't Add More Historical Minutes (Low Priority)**
**What:** Stop prioritizing historical minutes
**Why:** We have 640+ Ossipee minutes, 714 Conway minutes - diminishing returns
**Exception:** Add if they contain policy changes or unique info

---

## 📊 Document Gap Priority Matrix

| Category | Current Coverage | User Demand | Priority | Effort |
|----------|------------------|-------------|----------|---------|
| Meeting schedules (future) | 1 doc (budget committee only) | High | **CRITICAL** | Low (scrape websites) |
| Contact directories | 0 docs | High | **CRITICAL** | Low (scrape websites) |
| Office hours | 0 docs | High | **CRITICAL** | Low (scrape websites) |
| Service schedules (trash) | 0 docs | Medium | High | Low (scrape websites) |
| Recreation info | 0 docs | Medium | High | Medium (contact rec dept) |
| Comprehensive fee schedules | Partial | Medium | High | Medium (request from town) |
| Budget documents | Minimal | Medium | Medium | Medium (annual reports) |
| Current operational data | Minimal | High | High | Low (scrape + call) |

---

## 🎯 Success Metrics

### Current State:
- **Documents in DB:** 2,417
- **Tier A answers:** 0%
- **Tier B answers:** 24%
- **Tier C answers:** 76%

### Target After Document Acquisition:
- **New documents added:** ~100 (operational/current)
- **Tier A answers:** 20%+ (confident, complete, actionable)
- **Tier B answers:** 50%+ (good with minor gaps)
- **Tier C answers:** <30% (hedging/apologetic)

### Key Test Questions to Improve:
1. "When is the next Ossipee Select Board meeting?" → Tier A
2. "What are the office hours for the Conway town clerk?" → Tier A
3. "How do I contact the Ossipee tax collector?" → Tier A
4. "What day is trash pickup in Ossipee?" → Tier B
5. "How much does a building permit cost in Ossipee?" → Tier B

---

## ✅ Final Verdict

**The pipeline is NOT broken.** Retrieval works correctly - it's finding relevant documents and synthesizing answers from them.

**The problem is GIGO (Garbage In, Garbage Out):** If the documents don't contain future schedules, office hours, or contact info, the pipeline can't magically create that information.

**Solution:** Get the right documents. Focus on:
1. Forward-looking (schedules, calendars)
2. Current operational (hours, contacts)
3. Less historical (we have enough meeting minutes)

**Quick Win:** Scrape town websites for contact pages, calendars, and fee schedules. Should take <1 day and dramatically improve Tier C → Tier B conversion.
