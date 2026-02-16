
> rest-express@1.0.0 test:chat
> tsx --env-file=.env scripts/test-chat-pipeline.ts analyze test-results/2026-02-05-0400-basic.json


━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📊 CHAT PIPELINE TEST REPORT
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

📈 SUMMARY
  Total Tests:     3
  Passed:          2 ✅
  Failed:          1 ❌
  Pass Rate:       66.7%
  Avg Duration:    17396ms

📁 BY CATEGORY
  basic-meeting             0/1 (0%)
  basic-contact             1/1 (100%)
  basic-process             1/1 (100%)

❌ FAILED TESTS

  basic-01: When is the next Ossipee Select Board meeting?
  Town: Ossipee
   - Expected tier A, got C

💡 RECOMMENDATIONS
  • 3 questions (100%) were Tier C
    → Add more comprehensive documentation

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

