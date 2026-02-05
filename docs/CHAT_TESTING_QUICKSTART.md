# Chat Testing - Quick Start

Get testing in 2 minutes!

## 🚀 Run Your First Test

```bash
cd /home/ubuntu/.openclaw/workspace/OPENCouncil
npm run test:chat:basic
```

You'll see output like:
```
🧪 Running 3 tests...

Testing basic-01: "When is the next Ossipee Select Board meeting?..." ✅ PASS (1234ms)
Testing basic-02: "What are the office hours for the Conway town clerk?..." ✅ PASS (987ms)
Testing basic-03: "How do I register to vote in Carroll County?..." ❌ FAIL
   - Expected ≥1 state chunks, got 0

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📊 CHAT PIPELINE TEST REPORT
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

📈 SUMMARY
  Total Tests:     3
  Passed:          2 ✅
  Failed:          1 ❌
  Pass Rate:       66.7%
  Avg Duration:    1103ms

💡 RECOMMENDATIONS
  • Add more comprehensive documentation
  • Improve query generation or add more documents
```

## 🎯 Quick Commands

```bash
# Run different test sets
npm run test:chat:basic       # Quick smoke test (3 questions)
npm run test:chat:permits     # Permit/zoning tests (3 questions)
npm run test:chat:legal       # Legal questions (3 questions)
npm run test:chat:all         # Everything (15+ questions)

# Save results for analysis
npm run test:chat:all --output results.json

# Analyze saved results
npm run test:chat -- analyze results.json

# List available test sets
npm run test:chat -- list
```

## 🔍 What Gets Tested

Each test validates:
- ✅ Retrieved enough source documents
- ✅ Got minimum required chunks (local & state)
- ✅ Achieved expected quality tier (A/B/C)
- ✅ Answer mentions expected topics
- ✅ Answer doesn't mention forbidden topics

## 📊 Reading Results

### PASS Example ✅
```
Testing permit-01: "How do I apply for a building permit?" ✅ PASS (2104ms)
```
**Meaning:** Answer met all expected criteria

### FAIL Example ❌
```
Testing legal-01: "What is governmental immunity?" ❌ FAIL
   - Expected ≥3 state chunks, got 1
   - Should mention "RSA"
```
**Meaning:** 
- Only retrieved 1 state chunk (needed 3)
- Answer didn't mention "RSA"

**Action:** Add more NH state law documents about governmental immunity

## 🛠️ Using API Instead

### 1. Get Admin Token

```bash
curl -X POST http://localhost:5000/api/admin/login \
  -H "Content-Type: application/json" \
  -d '{"email":"admin@example.com","password":"your_password"}'

# Response: {"token":"eyJ...","email":"admin@example.com"}
```

### 2. Run Tests

```bash
export TOKEN="your_token_here"

curl -X POST http://localhost:5000/api/admin/test/chat-batch \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"questionSetIds":["basic"]}'
```

### 3. Get Analysis

```bash
curl -X POST http://localhost:5000/api/admin/test/chat-analyze \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d @results.json
```

## 🎨 Example Workflow

### Scenario: Adding new documents for Conway

**Before adding docs:**
```bash
npm run test:chat:permits --output before.json
# Pass Rate: 40%
```

**Add Conway zoning documents**
```bash
# Upload docs via admin UI
```

**After adding docs:**
```bash
npm run test:chat:permits --output after.json
# Pass Rate: 80%
```

**Compare:**
```bash
diff <(npm run test:chat -- analyze before.json) \
     <(npm run test:chat -- analyze after.json)
```

## 💡 Pro Tips

1. **Start small** - Run `test:chat:basic` first
2. **Focus failures** - One category at a time
3. **Track progress** - Save results with dates: `results-2025-02-05.json`
4. **Check debug info** - Look at `retrievalCounts` to diagnose issues
5. **Use in CI** - Add to GitHub Actions for automatic testing

## 🐛 Quick Troubleshooting

**"Cannot find module"**
```bash
npm install
```

**"Tests fail immediately"**
- Check database connection
- Verify Gemini API key in .env
- Ensure vector stores are populated

**"All tests get 0 chunks"**
- Vector store might be empty
- Run document ingestion first

**"401 Unauthorized (API)"**
- Get fresh admin token
- Check Authorization header format

## 📝 Next Steps

1. Run basic tests now to establish baseline
2. Review [full testing guide](./CHAT_TESTING.md)
3. Create custom tests for your specific use cases
4. Set up CI integration

## 🆘 Need Help?

The test output tells you exactly what's wrong:
- **Low retrieval** → Add more documents
- **High repair rate** → Improve synthesis prompts
- **Wrong tier** → Adjust config thresholds
- **Missing topics** → Add specific documentation

For detailed explanations, see [CHAT_TESTING.md](./CHAT_TESTING.md)

---

That's it! Start with `npm run test:chat:basic` and go from there. 🚀
