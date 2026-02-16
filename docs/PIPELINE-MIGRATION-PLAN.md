# Pipeline Migration Plan - Standalone Deployment

**Goal**: Package the crawler→ingestion pipeline into a standalone service on a new EC2 instance with git version control and Claude Code workflow.

---

## 📦 **What to Package**

### Core Pipeline Components
```
opencouncil-crawler/
├── scripts/
│   ├── crawler-v3.ts                    # Main crawler
│   ├── batch-v3-parallel.ts             # Batch runner
│   ├── run-download-worker.ts           # S3 upload worker
│   ├── run-metadata-extraction.ts       # Metadata extraction
│   ├── bridge-v3-to-ingestion.ts        # Bridge to ingestion
│   ├── run-ingestion.ts                 # Gemini ingestion
│   └── monitoring/
│       ├── check-db-status.ts
│       ├── check-ingestion-status.ts
│       ├── analyze-failures.ts
│       └── test-gfs-ocr.ts
├── server/
│   ├── services/
│   │   ├── crawlerState.ts              # State tracking
│   │   ├── crawlerStateExtensions.ts    # S3 key generation
│   │   ├── s3Sync.ts                    # Gemini store management
│   │   ├── ingestionWorker.ts           # Gemini upload
│   │   ├── fileProcessing.ts            # PDF text extraction
│   │   └── ingestionDiscovery.ts        # S3 discovery
│   ├── workers/
│   │   ├── downloadWorker.ts            # Document downloads
│   │   └── ocrWorkerUtils.ts            # OCR processing
│   └── storage/
│       └── db.ts                        # Database connection
├── shared/
│   ├── crawler-schema.ts                # Database schema
│   └── schema.ts                        # Legacy schema
├── config/
│   ├── towns.json                       # Town list (all NH)
│   └── ocr.ts                          # OCR config
├── docs/
│   ├── CRAWLER-REDESIGN.md
│   ├── DOWNLOAD-FAILURE-STRATEGIES.md
│   ├── PIPELINE-RUN-2026-02-15-RESULTS.md
│   └── V3-INTEGRATION-PLAN.md
├── package.json
├── tsconfig.json
├── drizzle.config.ts
├── .env.example
└── README.md
```

### Database Schema
```sql
-- Export from existing Neon database
-- Tables needed:
- crawler_towns
- crawler_documents
- crawler_runs
- s3_gemini_sync
- (exclude chat app tables: fileBlobs, logicalDocuments, etc.)
```

### Configuration Files
```bash
.env.example:
  DATABASE_URL=postgresql://...
  GEMINI_API_KEY=...
  AWS_ACCESS_KEY_ID=...
  AWS_SECRET_ACCESS_KEY=...
  AWS_REGION=us-east-1
  S3_BUCKET=opencouncil-municipal-docs
  BATCH_SIZE=5
```

---

## 🏗️ **New EC2 Instance Setup**

### Instance Specs
```yaml
Instance Type: t3.large (2 vCPU, 8GB RAM)
  - Need CPU for OCR processing
  - 8GB RAM for parallel batch processing

Storage: 30GB SSD
  - Temp storage for PDFs during ingestion
  - Logs and crawl results

OS: Ubuntu 24.04 LTS
  - Same as current instance for consistency

Region: us-east-1
  - Same as S3 bucket and Neon DB
```

### System Dependencies
```bash
# Base tools
sudo apt-get update
sudo apt-get install -y \
  git \
  curl \
  tmux \
  postgresql-client

# Node.js 22.x (via nvm or official repos)
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs

# OCR tools
sudo apt-get install -y \
  poppler-utils \
  tesseract-ocr \
  tesseract-ocr-eng

# Process management
sudo npm install -g pm2
```

---

## 📂 **Git Repository Structure**

### Repo: `opencouncil-crawler`

```
opencouncil-crawler/
├── .github/
│   └── workflows/
│       └── deploy.yml               # Optional: GitHub Actions for deployment
├── src/
│   ├── crawler/
│   │   ├── v3-crawler.ts
│   │   ├── batch-runner.ts
│   │   └── town-config.ts
│   ├── workers/
│   │   ├── download-worker.ts
│   │   ├── metadata-worker.ts
│   │   └── ingestion-worker.ts
│   ├── services/
│   │   ├── state-tracking.ts
│   │   ├── s3-manager.ts
│   │   ├── gemini-client.ts
│   │   └── ocr-processor.ts
│   ├── db/
│   │   ├── schema.ts
│   │   ├── client.ts
│   │   └── migrations/
│   └── utils/
│       ├── logger.ts
│       └── config.ts
├── scripts/
│   ├── setup.sh                     # Initial setup script
│   ├── run-crawler.sh               # Wrapper for crawler
│   ├── run-ingestion.sh             # Wrapper for ingestion
│   └── migrate-db.sh                # Database migration
├── config/
│   ├── towns/
│   │   ├── carroll-county.json
│   │   └── all-nh-towns.json
│   └── pm2.config.js                # PM2 process config
├── docs/
│   ├── SETUP.md
│   ├── ARCHITECTURE.md
│   ├── TROUBLESHOOTING.md
│   └── API.md
├── tests/
│   ├── crawler.test.ts
│   └── ingestion.test.ts
├── logs/                            # .gitignore
├── crawl-results/                   # .gitignore
├── .env.example
├── .gitignore
├── package.json
├── tsconfig.json
├── drizzle.config.ts
├── README.md
└── LICENSE
```

### `.gitignore`
```
# Environment
.env
.env.*
!.env.example

# Dependencies
node_modules/
.pnpm-store/

# Logs
logs/
*.log
crawl-results/
crawl-logs/

# Temp files
tmp/
temp/
*.tmp

# Database
*.sqlite
*.db

# IDE
.vscode/
.idea/
*.swp
*.swo

# OS
.DS_Store
Thumbs.db
```

---

## 🔄 **Migration Process**

### Phase 1: Extract & Clean Code (2-3 hours)
1. **Create new repo structure**
   ```bash
   mkdir opencouncil-crawler && cd opencouncil-crawler
   git init
   ```

2. **Copy core files from OPENCouncil**
   - Strip out chat app dependencies
   - Remove unused v1/v2 crawler code
   - Consolidate utility functions

3. **Refactor for standalone use**
   - Remove chat app imports
   - Make database schema self-contained
   - Externalize all config to .env

4. **Add documentation**
   - README with setup instructions
   - Architecture diagrams
   - API documentation

### Phase 2: Database Setup (1 hour)
1. **Export schema**
   ```bash
   # From existing Neon database
   pg_dump $DATABASE_URL --schema-only \
     -t crawler_towns \
     -t crawler_documents \
     -t crawler_runs \
     -t s3_gemini_sync \
     > schema.sql
   ```

2. **Create new Neon database**
   - Separate from chat app database
   - Apply schema
   - Configure backups

3. **Migration script**
   ```typescript
   // scripts/migrate-data.ts
   // Copy crawler_towns, crawler_documents, crawler_runs
   // from old DB to new DB
   ```

### Phase 3: EC2 Setup (1-2 hours)
1. **Launch instance**
   - t3.large, Ubuntu 24.04
   - Security group: SSH (22), optional monitoring (3000)
   - Attach IAM role for S3 access (or use keys)

2. **Install dependencies**
   ```bash
   ssh ubuntu@new-instance
   sudo apt-get update
   sudo apt-get install -y git nodejs npm tmux postgresql-client poppler-utils tesseract-ocr
   sudo npm install -g pm2 pnpm
   ```

3. **Clone repo**
   ```bash
   git clone git@github.com:your-org/opencouncil-crawler.git
   cd opencouncil-crawler
   pnpm install
   ```

4. **Configure environment**
   ```bash
   cp .env.example .env
   nano .env  # Add DB credentials, API keys, etc.
   ```

5. **Test run**
   ```bash
   # Test crawler on one town
   pnpm run crawler --town="Berlin" --maxPages=10
   
   # Test ingestion on one doc
   pnpm run ingest --limit=1
   ```

### Phase 4: PM2 Setup (30 min)
```javascript
// config/pm2.config.js
module.exports = {
  apps: [
    {
      name: 'crawler-scheduler',
      script: './dist/scripts/scheduler.js',
      cron_restart: '0 2 * * 0',  // Weekly Sunday 2 AM
      watch: false,
      instances: 1,
      autorestart: false
    },
    {
      name: 'download-worker',
      script: './dist/workers/download-worker.js',
      instances: 1,
      autorestart: true,
      max_restarts: 10,
      min_uptime: '10s'
    },
    {
      name: 'ingestion-worker',
      script: './dist/workers/ingestion-worker.js',
      instances: 1,
      autorestart: true,
      max_memory_restart: '2G'
    }
  ]
};
```

```bash
pm2 start config/pm2.config.js
pm2 save
pm2 startup  # Enable on boot
```

### Phase 5: Monitoring Setup (1 hour)
1. **CloudWatch agent** (optional)
   - CPU, memory, disk metrics
   - Log shipping

2. **Simple HTTP health check endpoint**
   ```typescript
   // server.ts
   app.get('/health', async (req, res) => {
     const stats = await getIngestionStats();
     res.json({
       status: 'ok',
       pending: stats.pending,
       synced: stats.synced,
       failed: stats.failed
     });
   });
   ```

3. **Log rotation**
   ```bash
   # /etc/logrotate.d/opencouncil-crawler
   /home/ubuntu/opencouncil-crawler/logs/*.log {
     daily
     rotate 14
     compress
     delaycompress
     notifempty
     create 0640 ubuntu ubuntu
   }
   ```

---

## 👨‍💻 **Claude Code Workflow**

### Setup for Claude Code Integration

1. **Install Claude Code in VS Code**
   ```bash
   # On your local machine
   code --install-extension anthropic.claude-code
   ```

2. **SSH configuration**
   ```bash
   # ~/.ssh/config
   Host crawler-prod
     HostName <EC2-IP>
     User ubuntu
     IdentityFile ~/.ssh/your-key.pem
     ForwardAgent yes
   ```

3. **VS Code Remote SSH**
   - Install Remote-SSH extension
   - Connect to crawler-prod
   - Open `/home/ubuntu/opencouncil-crawler`

4. **Claude Code will have access to**:
   - Full codebase
   - Git history
   - Running processes (via terminal)
   - Database (via connection)

### Typical Claude Code Workflow

**Example: Add retry logic to download worker**
```
You: "Add exponential backoff retry logic to the download worker 
      for 503 errors. Max 3 retries with 2^n second delays."

Claude Code:
  1. Reads workers/download-worker.ts
  2. Identifies download function
  3. Implements retry logic
  4. Tests locally
  5. Commits changes
  6. You review & approve
```

**Example: Debug failure rate spike**
```
You: "Check why download failures spiked today. 
      Analyze logs and suggest fixes."

Claude Code:
  1. Reads recent logs in logs/
  2. Queries database for failure patterns
  3. Identifies problematic domains
  4. Suggests rate limiting per domain
  5. Implements fix with your approval
```

### Development Best Practices

1. **Feature branches**
   ```bash
   git checkout -b feature/improve-ocr-accuracy
   # Make changes with Claude Code
   git commit -m "Improve OCR accuracy by preprocessing images"
   git push origin feature/improve-ocr-accuracy
   # Create PR, review, merge
   ```

2. **Testing before deploy**
   ```bash
   # Test on one town first
   pnpm run crawler --town="Sandwich" --maxPages=50
   
   # Check results
   pnpm run test:results
   
   # Deploy if good
   pm2 restart all
   ```

3. **Rollback plan**
   ```bash
   # If something breaks
   git log --oneline  # Find last good commit
   git revert <commit-hash>
   pm2 restart all
   ```

---

## 📊 **Migration Checklist**

### Pre-Migration
- [ ] Document current pipeline state
- [ ] Export database schema & data
- [ ] List all environment variables
- [ ] Archive current crawl results
- [ ] Note Gemini store IDs per town

### Code Packaging
- [ ] Create new git repo
- [ ] Copy & refactor core files
- [ ] Remove chat app dependencies
- [ ] Write README & setup docs
- [ ] Add .env.example
- [ ] Test locally (if possible)

### Infrastructure
- [ ] Launch new EC2 instance
- [ ] Install system dependencies
- [ ] Create new Neon database
- [ ] Run database migrations
- [ ] Configure S3 access
- [ ] Set up PM2 processes

### Testing
- [ ] Test crawler on 1 town
- [ ] Test download worker on 10 docs
- [ ] Test ingestion on 5 docs
- [ ] Verify Gemini stores work
- [ ] Test monitoring endpoints

### Cutover
- [ ] Stop current ingestion (when complete)
- [ ] Migrate any pending documents
- [ ] Start new workers on new instance
- [ ] Monitor for 24 hours
- [ ] Decommission old instance

### Documentation
- [ ] Update architecture docs
- [ ] Document new instance details
- [ ] Create troubleshooting guide
- [ ] Write deployment checklist

---

## 🚀 **Estimated Timeline**

| Phase | Duration | Can Start |
|-------|----------|-----------|
| Code extraction & refactoring | 3-4 hours | Now (parallel with ingestion) |
| Database setup | 1 hour | After code ready |
| EC2 instance setup | 1-2 hours | After DB ready |
| Testing & validation | 2-3 hours | After instance ready |
| Documentation | 2 hours | Ongoing |
| **Total** | **9-12 hours** | Can start immediately |

**Ingestion completion**: ~2 days (independent)  
**Migration can happen in parallel** while ingestion runs

---

## 💰 **Cost Estimate**

**New EC2 t3.large** (on-demand):
- Compute: ~$0.08/hour × 730 hours = **$58/month**
- Storage: 30GB × $0.10/GB = **$3/month**
- **Total: ~$61/month**

**Reserved Instance** (1-year):
- ~$0.04/hour = **$30/month** (save 50%)

**Spot Instance** (if acceptable downtime):
- ~$0.02/hour = **$15/month** (save 75%)

---

## 🎯 **Success Criteria**

- [ ] Full pipeline runs independently on new instance
- [ ] Weekly crawls execute automatically
- [ ] Documents ingest successfully to Gemini
- [ ] Monitoring shows system health
- [ ] Git repo tracks all changes
- [ ] Claude Code can make changes easily
- [ ] Documentation is complete
- [ ] Old instance can be terminated

---

**Ready to start packaging as soon as ingestion completes (or we can start the code extraction now in parallel)?**
