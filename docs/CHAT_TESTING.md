# Chat Pipeline Testing Guide

This guide explains how to use the automated chat testing system to evaluate the v3 chat pipeline, analyze results, and generate recommendations for improvements.

## Overview

The chat testing system provides:
1. **Batch Testing** - Run sets of questions through the v3 pipeline
2. **Validation** - Automatically check results against expected behaviors
3. **Analysis** - Generate insights and recommendations
4. **API Endpoints** - Programmatically run tests from external tools

## Quick Start

### 1. Run Basic Tests (CLI)

```bash
# Run basic test set
npm run test:chat:basic

# Run all tests
npm run test:chat:all

# Run specific sets
npm run test:chat -- run --sets permits,legal

# Save results to file
npm run test:chat -- run --sets all --output results.json
```

### 2. Using the API (Programmatic)

The testing system exposes admin-only endpoints at `/api/admin/test/*`:

**Get Available Test Sets**
```bash
curl -H "Authorization: Bearer YOUR_ADMIN_TOKEN" \
  http://localhost:5000/api/admin/test/question-sets
```

**Run Batch Tests**
```bash
curl -X POST \
  -H "Authorization: Bearer YOUR_ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"questionSetIds": ["basic", "permits"]}' \
  http://localhost:5000/api/admin/test/chat-batch
```

**Analyze Results**
```bash
curl -X POST \
  -H "Authorization: Bearer YOUR_ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d @results.json \
  http://localhost:5000/api/admin/test/chat-analyze
```

## Test Question Sets

The system includes predefined test sets covering different use cases:

### Basic (`basic`)
- Simple meeting date questions
- Contact information lookup
- Common procedural questions

**Good for:** Quick smoke tests, regression checking

### Permits (`permits`)
- Building permit processes
- Zoning regulations
- Permit requirements

**Good for:** Testing multi-source retrieval, local+state document blending

### Legal (`legal`)
- Governmental immunity
- ADA compliance
- Liability questions

**Good for:** Testing state law retrieval, legal topic extraction

### Taxes (`taxes`)
- Property tax calculations
- Abatement processes
- Tax exemptions

**Good for:** Testing calculation explanations, procedural guidance

### Complex (`complex`)
- Multi-step processes
- Cross-domain questions
- Rights and responsibilities

**Good for:** Testing advanced synthesis, multi-document integration

### Edge Cases (`edge`)
- Out-of-scope questions
- Vague queries
- Minimal input

**Good for:** Testing pipeline robustness, graceful degradation

## Understanding Test Results

### Test Output Structure

```typescript
interface TestResult {
  questionId: string;           // Test identifier
  question: string;             // The question text
  town?: string;                // Town preference
  category: string;             // Test category
  answerText: string;           // Generated answer
  sourceDocumentNames: string[]; // Documents used
  docSourceType: string;        // "local", "statewide", "mixed", "none"
  recordStrength: {
    tier: "A" | "B" | "C";      // Quality tier
    confidence: number;          // 0-1 confidence
    reasoning: string;           // Why this tier
  };
  debug: {
    durationMs: number;          // Response time
    localSelected: number;       // Local chunks used
    stateSelected: number;       // State chunks used
    auditFlags: string[];        // Violations detected
    repairRan: boolean;          // Whether repair pass ran
    planQueries: {
      local: string[];           // Local queries generated
      state: string[];           // State queries generated
    };
    retrievalCounts: {
      localRetrieved: number;    // Total local chunks found
      localSelected: number;     // Local chunks used in answer
      stateRetrieved: number;    // Total state chunks found
      stateSelected: number;     // State chunks used in answer
    };
  };
  passed: boolean;               // Did it meet expectations?
  failureReasons: string[];      // Why it failed (if applicable)
}
```

### Expected Behaviors

Tests can specify expected behaviors to validate against:

```typescript
expectedBehaviors: {
  minSources: 2,                    // Minimum source documents
  minLocalChunks: 3,                // Minimum local chunks
  minStateChunks: 2,                // Minimum state chunks
  expectedTier: "A",                // Required quality tier
  shouldMentionTopics: ["RSA"],     // Must mention these
  shouldNotMentionTopics: ["weather"] // Must not mention these
}
```

### Analysis Report

The analysis endpoint generates recommendations in three categories:

**Documents Needed**
- Identifies categories with low pass rates
- Spots gaps where state chunks dominate local questions
- Recommends specific document additions

**Pipeline Improvements**
- High repair rates → improve initial synthesis
- Low retrieval counts → improve query generation
- Common audit flags → fix specific issues

**Config Tweaks**
- Performance issues → reduce query counts
- Answer length problems → adjust char targets
- Tier distribution issues → adjust thresholds

## Creating Custom Test Questions

Add questions to `/server/routes/chatTestRoutes.ts`:

```typescript
{
  id: "custom-01",
  message: "Your question here",
  town: "Ossipee",
  category: "custom-category",
  description: "What this tests",
  expectedBehaviors: {
    minSources: 2,
    minLocalChunks: 2,
    shouldMentionTopics: ["keyword1", "keyword2"],
  },
}
```

## Workflow: Using Tests for Development

### 1. Establish Baseline

```bash
# Run full test suite
npm run test:chat:all --output baseline.json

# Review baseline report
npm run test:chat -- analyze baseline.json
```

### 2. Make Changes

- Add documents
- Tweak config values
- Update prompts

### 3. Regression Check

```bash
# Run same tests
npm run test:chat:all --output after-changes.json

# Compare results
npm run test:chat -- analyze after-changes.json
```

### 4. Focus on Failures

Review specific failures:
```bash
# Run just the failed category
npm run test:chat:permits
```

## Interpreting Metrics

### Pass Rate
- **>90%** - Excellent, pipeline is solid
- **70-90%** - Good, but room for improvement
- **50-70%** - Needs work, significant gaps
- **<50%** - Critical issues, major revision needed

### Tier Distribution (Ideal)
- **Tier A**: 40-60% (high confidence answers)
- **Tier B**: 30-40% (decent answers, some gaps)
- **Tier C**: 10-20% (low confidence, minimal info)

### Repair Rate
- **<20%** - Good, initial synthesis is working
- **20-40%** - Acceptable, but could be better
- **>40%** - Problem, too many answers need fixing

### Retrieval Balance
For town-specific questions:
- Local chunks should typically outnumber state chunks
- If state > local × 2, likely missing local docs

### Response Time
- **<2s** - Excellent
- **2-4s** - Good
- **4-6s** - Acceptable
- **>6s** - Slow, optimize retrieval

## Common Issues & Solutions

### Issue: Low retrieval counts across the board
**Symptoms:** Most questions get <3 chunks total
**Likely Cause:** Embedding model mismatch or insufficient documents
**Solutions:**
- Verify vector store is populated
- Check embedding model consistency
- Add more documents to the collection

### Issue: High repair rate
**Symptoms:** >40% of answers trigger repair
**Likely Cause:** Initial synthesis prompt needs improvement
**Solutions:**
- Review synthesis prompts
- Adjust record strength thresholds
- Improve chunk quality in retrieval

### Issue: Many "missing_citations" audit flags
**Symptoms:** Answers don't include source references
**Likely Cause:** Synthesis not emphasizing citations
**Solutions:**
- Strengthen citation requirements in prompt
- Improve citation extraction logic
- Add examples to synthesis prompt

### Issue: State chunks dominate local questions
**Symptoms:** Conway question gets 8 state, 2 local chunks
**Likely Cause:** Missing or poor local documents
**Solutions:**
- Add more Conway-specific documents
- Improve local document metadata
- Adjust retrieval plan to prioritize local

### Issue: Tier C dominates results
**Symptoms:** >40% of answers are Tier C
**Likely Cause:** Document coverage gaps
**Solutions:**
- Identify missing document types
- Add more comprehensive sources
- Lower tier thresholds (temporarily)

## Advanced: Custom Test Suites

For ongoing development, create custom test suites:

```typescript
// In chatTestRoutes.ts
const myCustomSet: TestQuestion[] = [
  // Your specific scenarios
];

testQuestionSets["my-custom"] = myCustomSet;
```

Then run:
```bash
npm run test:chat -- run --sets my-custom
```

## Continuous Integration

Add to CI pipeline:

```yaml
# .github/workflows/test.yml
- name: Run chat tests
  run: npm run test:chat:basic
```

This catches regressions before they reach production.

## Best Practices

1. **Test before deploying** - Always run basic tests before pushing changes
2. **Document failures** - Note why tests fail and what you tried
3. **Iterate incrementally** - Fix one category at a time
4. **Track over time** - Save results to compare progress
5. **Use appropriate sets** - Don't run "all" for quick checks
6. **Review debug info** - Understand why tests pass or fail
7. **Update expectations** - As system improves, raise the bar

## Troubleshooting

### Tests won't run
- Ensure database is accessible
- Check that vector stores are initialized
- Verify Gemini API credentials

### API endpoints return 401
- Get admin token from `/api/admin/login`
- Include `Authorization: Bearer TOKEN` header

### Results seem wrong
- Check that documents are actually indexed
- Verify town preferences match document metadata
- Review retrieval query generation

## Future Enhancements

Planned additions:
- Golden answer comparison (semantic similarity scoring)
- Historical trend analysis
- Performance benchmarking
- Multi-model comparison
- User feedback integration
- A/B test framework

## Questions?

If you encounter issues or have suggestions, document them in:
- GitHub issues
- Team Slack/Discord
- Weekly retrospectives

---

**Last Updated:** 2025-02-05
**System Version:** v3 Pipeline
**Maintainer:** OPENCouncil Team
