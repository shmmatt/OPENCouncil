# Crawl Results Analysis

## Overall Statistics

- **Total towns:** 18
- **Successful:** 18
- **Failed:** 0
- **Total documents:** 4622
- **Average per town:** 257

## CMS Distribution

- **WordPress:** 7 towns, avg 471 docs/town
- **Custom:** 6 towns, avg 84 docs/town
- **CivicPlus:** 5 towns, avg 165 docs/town

## Strategy Effectiveness

- **Index pages only:** 4 towns
  - Avg docs: 0
- **Required navigation:** 14 towns
  - Avg docs: 330

## Most Effective Index Pages

- `/AgendaCenter`: 4 towns (22%)
- `/FormCenter`: 4 towns (22%)
- `/documents`: 3 towns (17%)
- `/applications`: 3 towns (17%)
- `/DocumentCenter`: 2 towns (11%)
- `/regulations`: 2 towns (11%)
- `/minutes`: 1 towns (6%)
- `/boards`: 1 towns (6%)

## CMS-Specific Patterns

### WordPress (7 towns)

Top working pages:
- `/applications`: 43%
- `/regulations`: 29%
- `/documents`: 14%
- `/minutes`: 14%
- `/boards`: 14%

### CivicPlus (5 towns)

Top working pages:
- `/AgendaCenter`: 80%
- `/FormCenter`: 80%
- `/DocumentCenter`: 40%

### Custom (6 towns)

Top working pages:
- `/documents`: 33%

## Document Categories

- **misc:** 2825 docs (61%)
- **minutes:** 915 docs (20%)
- **agendas:** 507 docs (11%)
- **forms:** 221 docs (5%)
- **reports:** 97 docs (2%)
- **ordinances:** 37 docs (1%)
- **regulations:** 12 docs (0%)
- **budget:** 8 docs (0%)

## High Coverage Towns (100+ docs)

- **Freedom:** 1594 docs (WordPress)
  - Minutes: 326, Agendas: 3
  - Strategies: Index Pages → Navigation Following
- **Albany:** 1249 docs (WordPress)
  - Minutes: 170, Agendas: 0
  - Strategies: Index Pages → Navigation Following
- **Tamworth:** 378 docs (CivicPlus)
  - Minutes: 96, Agendas: 277
  - Strategies: Index Pages → Navigation Following
- **Effingham:** 262 docs (Custom)
  - Minutes: 11, Agendas: 5
  - Strategies: Index Pages → Navigation Following
- **Chatham:** 253 docs (WordPress)
  - Minutes: 211, Agendas: 0
  - Strategies: Index Pages → Navigation Following
- **Conway:** 239 docs (Custom)
  - Minutes: 0, Agendas: 0
  - Strategies: Index Pages → Navigation Following
- **Moultonborough:** 162 docs (CivicPlus)
  - Minutes: 34, Agendas: 81
  - Strategies: Index Pages → Navigation Following
- **Bartlett:** 160 docs (CivicPlus)
  - Minutes: 31, Agendas: 99
  - Strategies: Index Pages → Navigation Following
- **Wolfeboro:** 120 docs (CivicPlus)
  - Minutes: 26, Agendas: 42
  - Strategies: Index Pages → Navigation Following

## Low Coverage Towns (< 50 docs)

- **Brookfield:** 0 docs (Custom)
  - Working pages: none
  - Categories: none
- **Madison:** 0 docs (WordPress)
  - Working pages: none
  - Categories: none
- **Ossipee:** 0 docs (Custom)
  - Working pages: none
  - Categories: none
- **Sandwich:** 0 docs (Custom)
  - Working pages: none
  - Categories: none
- **Tuftonboro:** 0 docs (Custom)
  - Working pages: none
  - Categories: none
- **Wakefield:** 7 docs (CivicPlus)
  - Working pages: none
  - Categories: misc
- **Hart's Location:** 35 docs (WordPress)
  - Working pages: none
  - Categories: misc, reports, ordinances, forms, regulations

## Recommendations

### Coverage Threshold Tuning
8 towns had 50+ docs in Strategy 1 but benefited from Strategy 2.
Consider raising the "adequate coverage" threshold or always running Strategy 2 in thorough mode.

