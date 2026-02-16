# Town Profile System

## Overview

Town profiles are structured documents containing operational information about a municipality:
- Meeting schedules
- Contact information (staff, departments, office hours)
- Service details (trash, recycling, transfer station)
- Recreation facilities
- Permit requirements and fees
- Tax information

These profiles solve the **"forward-looking information gap"** - users ask "when is the next meeting?" but we only have past meeting minutes.

---

## Three Approaches

### 1. **Automated Crawler** (for sites without protection)

**When:** Site allows web scraping (no Cloudflare, no bot protection)

**Command:**
```bash
npm run crawl:town -- --town TownName --url https://townwebsite.org --max-pages 15
```

**Output:**
- `town-profiles/{town}-profile-{date}.json` - Structured data
- `town-profiles/{town}-profile-{date}.md` - Human-readable markdown

**Process:**
1. Crawls multiple likely URLs (contact, departments, boards, calendar, etc.)
2. Combines page content
3. Uses LLM (Gemini) to extract structured information
4. Generates JSON + markdown outputs
5. **Human reviews** markdown for accuracy
6. Approve → index into database

---

### 2. **Manual Template** (for protected sites)

**When:** Site has Cloudflare or blocks automated access (like ossipee.org)

**Process:**
1. Use template: `town-profiles/ossipee-profile-2026-02-05-TEMPLATE.md`
2. Research information manually:
   - Call town hall
   - Visit in person
   - Check posted notices
   - Review documents already in database
3. Fill in `[NEEDS RESEARCH]` sections
4. Save as `{town}-profile-{date}.md`
5. Index into database

**Quick Research:**
- Town hall: Main number, ask for department extensions
- Website: Check calendar pages (even if manual browsing required)
- Posted notices: Take photos of physical bulletin boards
- Staff: Ask "who should I talk to about X?" 

---

### 3. **Hybrid: Extract from Existing Documents** (future enhancement)

**When:** We have some information scattered across existing documents

**Process:**
1. Run LLM analysis on all existing documents for a town
2. Extract mentions of contacts, schedules, fees
3. Generate partial profile with confidence scores
4. Human fills remaining gaps
5. Index final version

*Not yet implemented - could build if needed.*

---

## Schema

See `shared/town-profile-schema.ts` for full TypeScript interface.

**Key sections:**
```typescript
{
  townHall: { address, phone, hours },
  boards: { 
    select_board: { meetingSchedule, location, contact, members }
  },
  departments: {
    town_clerk: { staffName, phone, email, hours }
  },
  services: { trash, recycling, transferStation },
  recreation: { beaches, parks, programs },
  permits: { building, septic, etc. },
  taxes: { taxRate, dueDate, paymentMethods }
}
```

---

## Workflow

### Initial Creation

1. **Try automated crawler first**
   ```bash
   npm run crawl:town -- --town Conway --url https://conwaynh.com
   ```

2. **If fails (403/Cloudflare):** Use manual template
   - Copy `town-profiles/ossipee-profile-2026-02-05-TEMPLATE.md`
   - Rename to `{town}-profile-{date}-TEMPLATE.md`
   - Research and fill in sections

3. **Human review**
   - Check for hallucinations (LLM made up info)
   - Verify phone numbers, hours, schedules
   - Cross-reference with existing documents in database

4. **Finalize**
   - Remove `[NEEDS RESEARCH]` markers (or note as unknown)
   - Remove `-TEMPLATE` from filename
   - Mark status as `✅ COMPLETE` in header

5. **Index into database**
   - Upload as document with category: `town_profile`
   - Town: `{TownName}`
   - Metadata: `last_updated: {date}`

### Updates (Monthly or Quarterly)

1. **Check for changes**
   - New board members elected?
   - Office hours changed?
   - Fee schedules updated?
   - Tax rates changed?

2. **Update profile**
   - Edit existing markdown
   - Update `lastUpdated` date
   - Note what changed in commit message

3. **Re-index**
   - Mark old version as superseded
   - Index new version as current

---

## Testing Impact

### Before Town Profiles

**Test results (50 questions):**
- Tier A: 0%
- Tier B: 24%
- Tier C: 76%

**Typical Tier C answer:**
> "The provided documents do not explicitly state a regular meeting schedule for the Ossipee Select Board... Past meeting dates are mentioned from 2021, but no future dates are listed..."

### After Town Profiles (Expected)

**Target:**
- Tier A: 20-30% (meetings, contact, basic info)
- Tier B: 50-60% (most questions)
- Tier C: 20-30% (only truly missing info)

**Expected Tier A answer:**
> "The Ossipee Board of Selectmen meets on the 2nd and 4th Monday of each month at 6:00 PM in the Town Hall conference room [Ossipee Town Profile, 2026]. The next meeting is Monday, February 10th at 6:00 PM. Agendas are posted 24 hours in advance at Town Hall and online. To add an item to the agenda, contact the Town Administrator at 603-539-4181 at least one week before the meeting."

---

## File Organization

```
town-profiles/
  ossipee-profile-2026-02-05-TEMPLATE.md  # Template with research notes
  ossipee-profile-2026-03-01.md           # Completed v1 (after research)
  ossipee-profile-2026-03-01.json         # Structured data
  conway-profile-2026-02-10.md            # Conway completed
  conway-profile-2026-02-10.json
```

**Naming convention:** `{town}-profile-{YYYY-MM-DD}[.md|.json]`

**Add to .gitignore if sensitive:** Generally OK to commit (public info), but exclude if it contains unpublished contact details.

---

## Priority Towns

1. **Ossipee** - Manual template created, needs research
2. **Conway** - Try automated crawler (different site)
3. **Carroll County towns** (when expanding):
   - Albany, Bartlett, Brookfield, Chatham, Eaton, Effingham, Freedom, 
     Hart's Location, Jackson, Madison, Moultonborough, Sandwich, 
     Tamworth, Tuftonboro, Wakefield, Wolfeboro

---

## Future Enhancements

### 1. Admin UI for Profile Management
- Web form to create/edit profiles
- Preview markdown before saving
- Direct index button

### 2. Browser Automation for Cloudflare Sites
- Add Playwright/Puppeteer support
- Solve Cloudflare challenges
- Still requires human review

### 3. Change Detection
- Monitor town websites for changes
- Alert when info might be stale
- Suggest profile updates

### 4. Integration with Existing Documents
- Cross-link profiles with supporting documents
- "See pb_fee_schedule_final_2023.pdf for details"
- Auto-detect when referenced docs are updated

---

## Research Tips

### Phone Script

"Hi, I'm working on an informational website about Carroll County towns. Could you help me verify a few quick facts?"

**Ask for:**
1. Office hours (weekdays, weekends)
2. Board meeting schedules (regular schedule, not specific dates)
3. Best contact for various departments (extensions, emails)
4. Where agendas/calendars are posted (online URL or physical location)
5. Any public documents I can reference (annual reports, guides)

**DO NOT:**
- Claim official affiliation
- Request private/confidential information
- Be vague about purpose

### Website Exploration (Manual)

For Cloudflare-protected sites, manually browse and document:
1. Homepage → look for "Contact Us", "Departments", "Calendar"
2. Take screenshots of key pages
3. Copy/paste text into a working document
4. Note URLs for reference

### Physical Visit (If Local)

Town halls often have:
- Posted meeting schedules on bulletin boards
- Printed annual reports
- Brochures for services (beach passes, transfer station)
- Staff who can answer questions in person

---

## Quality Checklist

Before marking a profile as complete:

- [ ] Town hall address, phone, hours verified
- [ ] At least 3 board meeting schedules documented
- [ ] Town Clerk and Tax Collector contacts included
- [ ] Service information (trash/recycling/transfer station) included
- [ ] Tax payment information (due dates, methods) included
- [ ] All `[NEEDS RESEARCH]` markers removed or noted as "Unknown"
- [ ] Sources listed (URLs, phone calls, dates)
- [ ] Last updated date is accurate

---

## Questions?

See `scripts/crawl-town-profile.ts` for automation code.  
See `shared/town-profile-schema.ts` for data structure.  
See test results in `test-results/2026-02-05-1646-RETRIEVAL-AUDIT.md` for impact analysis.
