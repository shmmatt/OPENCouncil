# Board Meeting Schedules - Quick Start Guide

## 🎯 Goal
Extract regular meeting schedules for all boards/committees to answer questions like:
- "When is the next Select Board meeting?"
- "What time does Planning Board meet?"
- "Where are Zoning Board hearings held?"

---

## 📋 Three Approaches

### 1. **Automated Crawler** (Current)
```bash
npm run crawl:boards -- --town Ossipee --url https://www.ossipee.org/
```

**Status:** ⚠️ Partially working
- ✅ Discovers board pages
- ✅ Extracts locations and contacts
- ❌ Schedule patterns not matching most town websites

**Why schedules aren't found:**
- Many towns don't publish schedules on their websites
- Schedules are in PDF agendas or embedded calendars
- Format variations ("1st & 3rd Tue" vs "First and third Tuesday")

---

### 2. **Manual Entry** (Recommended for Launch)
Use `board-schedules-template.json` to manually record schedules:

```json
{
  "ossipee": {
    "select_board": {
      "name": "Board of Selectmen",
      "schedule": "2nd and 4th Monday at 6:00 PM",
      "location": "Town Hall, 195 Main Street",
      "contact": "(603) 539-4181"
    }
  }
}
```

**How to populate:**
1. **Call town hall** - Most reliable source
2. **Check town website calendars** - Look for iCal/Google Calendar
3. **Review recent meeting minutes** - Often list next meeting at bottom
4. **Check town Facebook pages** - Towns often post meeting notices

**Sample call script:**
> "Hi, I'm building a civic engagement platform for Carroll County. Can you tell me the regular meeting schedule for the Select Board, Planning Board, and Zoning Board? What time and location?"

---

### 3. **Hybrid Approach** (Best Long-Term)
Combine manual baseline + automated updates:

1. **Bootstrap:** Manually fill `board-schedules-template.json` for Ossipee & Conway
2. **Ingest:** Index this JSON as a high-priority document
3. **Verify:** Periodically re-run crawler to catch changes
4. **Update:** When crawler finds conflicts, flag for manual review

---

## 🔍 Where to Find Schedules

### Priority 1: Town Website Calendar
- **Conway:** https://conwaynh.gov/calendar (if exists)
- **Ossipee:** https://www.ossipee.org/calendar (if exists)

### Priority 2: Individual Board Pages
Look for dedicated pages like:
- `/boards/selectboard`
- `/boards/planning-board`
- `/zoning-board-of-adjustment`

### Priority 3: Recent Meeting Minutes
Check bottom of recent minutes for "Next Meeting" notices:
- Select Board minutes (usually most recent)
- Planning Board minutes

### Priority 4: Town Hall Call
Direct source - ask for:
- Select Board / Board of Selectmen
- Planning Board
- Zoning Board of Adjustment (ZBA)
- Conservation Commission
- Budget Committee
- Economic Development Committee (if exists)

### Priority 5: Facebook/Social Media
Many small NH towns post meeting notices on Facebook

---

## 📊 Target Boards (Carroll County)

### Core Boards (Every Town)
1. **Select Board** (sometimes "Board of Selectmen")
2. **Planning Board**
3. **Zoning Board of Adjustment (ZBA)**

### Common Boards
4. **Conservation Commission**
5. **Budget Committee**
6. **School Board** (if separate district)

### Occasional Boards
7. **Economic Development Committee**
8. **Recreation Commission**
9. **Library Trustees**
10. **Cemetery Trustees**

---

## 🚀 Quick Action Plan (Next 2 Hours)

### Phase 1: Call Conway Town Hall (15 min)
- Number: (603) 447-3811
- Ask for Select Board, Planning Board, ZBA schedules
- Record in JSON file

### Phase 2: Call Ossipee Town Hall (15 min)
- Number: (603) 539-4181
- Same boards
- Record in JSON file

### Phase 3: Check Town Websites (30 min)
- Look for calendar pages
- Check individual board pages
- Download any PDF schedule documents

### Phase 4: Create Indexed Document (30 min)
```bash
# Convert JSON to markdown
node scripts/board-json-to-md.js board-schedules-template.json

# Ingest into vector store
node scripts/ingest-document.js town-profiles/board-schedules.md
```

### Phase 5: Test (30 min)
Run test questions through chat:
- "When is the next Conway Select Board meeting?"
- "What time does Ossipee Planning Board meet?"
- "Where are ZBA meetings held in Conway?"

**Expected improvement:**
- Meetings category: 0% → 60-80% Tier B+

---

## 📝 Sample Completed Entry

```json
{
  "ossipee": {
    "select_board": {
      "name": "Board of Selectmen",
      "schedule": "2nd and 4th Monday of each month at 6:00 PM",
      "location": "Town Hall Conference Room, 195 Main Street, Ossipee NH 03864",
      "contact": "(603) 539-4181",
      "chairperson": "John Smith",
      "members": ["John Smith", "Jane Doe", "Bob Johnson"],
      "agendaUrl": "https://www.ossipee.org/boards/select-board/agendas",
      "notes": "Agendas posted 24 hours in advance. Public input at start of meeting. Meetings may be rescheduled for holidays."
    },
    "planning_board": {
      "name": "Planning Board",
      "schedule": "1st and 3rd Thursday at 7:00 PM",
      "location": "Town Hall Conference Room",
      "contact": "(603) 539-4181 ext 3",
      "notes": "No meeting in December. Site visits scheduled as needed."
    },
    "zoning_board": {
      "name": "Zoning Board of Adjustment",
      "schedule": "2nd Tuesday at 7:00 PM (as needed)",
      "location": "Town Hall Conference Room",
      "contact": "(603) 539-4181",
      "notes": "Only meets when applications are filed. Check agenda posting for confirmation."
    }
  }
}
```

---

## 🔄 Maintenance

### Weekly
- Check for meeting cancellations/reschedulings (town Facebook pages)

### Monthly
- Verify schedules still accurate (spot-check 2-3 towns)

### Quarterly
- Re-run crawler to catch updates
- Call town halls to confirm annual schedule changes (often in January)

---

## 🐛 Known Issues

### Issue 1: Schedule Variations
**Problem:** "First Monday" vs "1st Mon" vs "Every Monday"  
**Solution:** Normalize in manual entry to: "1st Monday at 6:00 PM"

### Issue 2: "As Needed" Boards
**Problem:** ZBA/Budget Committee don't meet regularly  
**Solution:** Note "As needed - check agenda postings" in schedule field

### Issue 3: Holiday Conflicts
**Problem:** Meetings on holidays get rescheduled  
**Solution:** Add note "Subject to holiday adjustments"

### Issue 4: Multiple Meeting Locations
**Problem:** Some boards alternate locations  
**Solution:** List both: "Town Hall or Library - check agenda"

---

## 📞 Contact Info for Carroll County Towns

| Town | Phone | Website |
|------|-------|---------|
| Albany | (603) 447-2607 | albanynh.org |
| Bartlett | (603) 374-2841 | bartlettnh.gov |
| Brookfield | (603) 522-3328 | brookfieldnh.org |
| Chatham | (603) 694-3656 | chathamnh.gov |
| **Conway** | **(603) 447-3811** | **conwaynh.gov** |
| Eaton | (603) 447-2840 | eatonnh.org |
| Effingham | (603) 539-4661 | effinghamnh.org |
| Freedom | (603) 539-6332 | freedomnh.org |
| Hart's Location | (603) 374-2368 | hartslocationnh.org |
| Jackson | (603) 383-4978 | jacksonnh.org |
| Madison | (603) 367-4332 | madison-nh.org |
| Moultonborough | (603) 476-2347 | moultonboroughnh.gov |
| **Ossipee** | **(603) 539-4181** | **ossipee.org** |
| Sandwich | (603) 284-7113 | sandwichnh.org |
| Tamworth | (603) 323-7971 | tamworthnh.org |
| Tuftonboro | (603) 569-4539 | tuftonboro.org |
| Wakefield | (603) 522-6205 | wakefieldnh.org |
| Wolfeboro | (603) 569-5639 | wolfeboronh.us |

---

## ✅ Success Metrics

### Before (Current State)
- "When is the next Select Board meeting?" → **Tier C**  
  _"The provided documents do not explicitly state a regular meeting schedule..."_

### After (With Manual Schedules)
- "When is the next Select Board meeting?" → **Tier A**  
  _"The Ossipee Board of Selectmen meets on the 2nd and 4th Monday of each month at 6:00 PM in the Town Hall Conference Room at 195 Main Street. The next meeting is Monday, February 10th at 6:00 PM. Agendas are posted 24 hours in advance. Contact: (603) 539-4181."_

**Impact:** Meetings category from 0% → 70%+ Tier B+

---

## 🎓 Lessons from Crawler Tests

### What Worked
- ✅ Discovering board page URLs (Ossipee: found `/boards`, `/board-of-selectmen`)
- ✅ Extracting locations (found "Town Hall", "Library")
- ✅ Extracting contact info (found phone numbers)

### What Didn't Work
- ❌ Schedule pattern matching (0 schedules found across Conway + Ossipee)
- ❌ Member name extraction (picked up navigation links instead)
- ❌ TownCloud SPA navigation (Conway's JavaScript-based site)

### Why Automated Extraction is Hard
1. **Format variations:** "1st Mon 6pm" vs "First Monday at 6:00 PM" vs "Every Monday, 6 p.m."
2. **Not on website:** Many towns only post schedules on bulletin boards or PDF agendas
3. **Conditional meetings:** "2nd Tuesday (if applications filed)"
4. **Dynamic pages:** TownCloud/CivicPlus use JavaScript, links not in HTML

---

## 📁 Files

- `board-schedules-template.json` - Manual schedule configuration
- `board-schedules-FILLED.json` - Completed schedules (create after data collection)
- `BOARD-SCHEDULES-GUIDE.md` - This guide
- `scripts/board-schedule-crawler.ts` - Automated crawler (partial)
- `scripts/board-json-to-md.ts` - Convert JSON to markdown for ingestion (TODO)

---

**Next Step:** Call Conway & Ossipee town halls to get actual schedules, populate JSON, then ingest! 📞
