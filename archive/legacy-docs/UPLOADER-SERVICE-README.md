# Document Uploader Service & Checkpoint/Resume System

## Overview

The OPENCouncil crawler now has two major new features:

1. **Persistent Upload Service** - A systemd service that runs independently of OpenClaw and handles document uploads in the background
2. **Checkpoint/Resume System** - Save crawler progress and resume from where you left off if interrupted

These features solve the 30-minute timeout problem by:
- **Separating crawling from uploading** - Crawl can finish quickly, uploads happen in background
- **Resuming interrupted crawls** - If killed at 30 minutes, resume from checkpoint instead of starting over

---

## 1. Document Uploader Service

### What It Does

The uploader service is a **persistent background process** that:
- Watches a directory for upload queue files
- Processes document uploads to S3 automatically
- Runs **independently of OpenClaw** (no timeout issues)
- Survives server reboots (starts automatically)
- Logs all activity to `logs/uploader-service.log`

### Installation

```bash
cd OPENCouncil
sudo bash scripts/install-uploader-service.sh
```

This will:
1. Install the systemd service
2. Create upload queue directory: `upload-queue/`
3. Create logs directory: `logs/`
4. Start the service
5. Enable auto-start on boot

### Managing the Service

```bash
# Check status
sudo systemctl status opencouncil-uploader

# Stop service
sudo systemctl stop opencouncil-uploader

# Start service
sudo systemctl start opencouncil-uploader

# Restart service
sudo systemctl restart opencouncil-uploader

# View live logs
sudo journalctl -u opencouncil-uploader -f

# View service log file
tail -f logs/uploader-service.log
```

### How To Use

#### Option 1: With Individual Town Crawl

```bash
# Crawl and queue for upload (no immediate upload)
npm run crawl:universal:v2 -- \
  --town Madison \
  --url https://madison-nh.org \
  --queue-upload

# Documents are downloaded, upload queue is saved
# Service picks it up automatically and uploads in background
```

#### Option 2: With Batch Crawl

```bash
# Run batch with upload queueing
tsx scripts/batch-universal-v2-crawler.ts --queue-upload --resume

# All towns queue their docs
# Service processes all uploads in background
# Can take hours - no problem!
```

#### How It Works

1. Crawler downloads documents to `/tmp/opencouncil-docs/`
2. Crawler creates upload queue file: `upload-queue/madison-1739334567890.json`
3. Service detects new file within 1 second
4. Service uploads all documents to S3
5. Service moves queue file to `upload-queue/processed/`
6. Service deletes temporary local files after successful upload

### Upload Queue Format

```json
{
  "townName": "Madison",
  "documents": [
    {
      "localPath": "/tmp/opencouncil-docs/budget-2024.pdf",
      "s3Key": "madison/budget/general/2024/budget-2024.pdf",
      "url": "https://madison-nh.org/docs/budget-2024.pdf",
      "title": "budget-2024.pdf"
    }
  ]
}
```

### Monitoring

Watch for upload activity:
```bash
# Real-time service logs
tail -f logs/uploader-service.log

# System logs
sudo journalctl -u opencouncil-uploader -f
```

You'll see:
- `📦 Processing upload queue: madison-1739334567890.json`
- `✅ Completed Madison: 904 uploaded, 0 skipped, 0 failed (12.3 min)`

---

## 2. Checkpoint/Resume System

### What It Does

The checkpoint system:
- **Saves crawler state every 20 pages** (visited URLs, queue, discovered docs)
- **Resumes from checkpoint** if crawler is interrupted
- **Works for individual towns** and **batch crawls**
- **Automatic cleanup** - deletes checkpoints on successful completion

### Individual Town Resume

```bash
# Start crawl with resume enabled
npm run crawl:universal:v2 -- \
  --town Madison \
  --url https://madison-nh.org \
  --resume

# If interrupted (timeout, crash, Ctrl+C):
# Just run the same command again - it picks up where it left off
npm run crawl:universal:v2 -- \
  --town Madison \
  --url https://madison-nh.org \
  --resume
```

### Batch Resume

```bash
# Start batch crawl with resume
tsx scripts/batch-universal-v2-crawler.ts --resume --queue-upload

# If interrupted at 30 minutes (after completing 10/18 towns):
# Run again - it skips the 10 completed towns
tsx scripts/batch-universal-v2-crawler.ts --resume --queue-upload

# Continues with the remaining 8 towns
```

### Checkpoint Storage

**Individual town checkpoints**: `checkpoints/<town-name>.json`
**Batch checkpoint**: `checkpoints/batch-checkpoint.json`

Example individual checkpoint:
```json
{
  "townName": "Madison",
  "baseUrl": "https://www.madison-nh.org",
  "visitedUrls": ["https://...", "https://..."],
  "queueUrls": ["https://...", "https://..."],
  "discoveredDocs": ["https://...", "https://..."],
  "pagesVisited": 120,
  "stats": {
    "downloaded": 45,
    "uploaded": 45,
    "skipped": 12,
    "failed": 0,
    "byCategory": {"minutes": 30, "agendas": 15}
  },
  "timestamp": "2026-02-12T04:15:23.456Z"
}
```

Example batch checkpoint:
```json
{
  "completedTowns": ["Albany", "Bartlett", "Chatham"],
  "inProgressTown": "Conway",
  "timestamp": "2026-02-12T04:15:23.456Z"
}
```

### Managing Checkpoints

```bash
# View checkpoints
ls -lh checkpoints/

# View specific checkpoint
cat checkpoints/madison.json

# Manually delete checkpoint (start fresh)
rm checkpoints/madison.json

# Delete all checkpoints
rm -rf checkpoints/
```

### Checkpoint Behavior

- **Saved every 20 pages** during crawl
- **Loaded automatically** when `--resume` flag is used
- **Deleted automatically** when town completes successfully
- **Preserved on failure** so you can resume

---

## 3. Complete Workflow Examples

### Example 1: Individual Town with Upload Service

```bash
# 1. Ensure uploader service is running
sudo systemctl status opencouncil-uploader

# 2. Crawl with resume + queue upload
npm run crawl:universal:v2 -- \
  --town Madison \
  --url https://madison-nh.org \
  --resume \
  --queue-upload

# 3. If interrupted, just re-run same command
# Picks up from checkpoint, continues where it left off

# 4. Watch uploads happen in background
tail -f logs/uploader-service.log
```

### Example 2: Batch Crawl with Resume

```bash
# 1. Start batch (will run for ~30 min then get killed)
tsx scripts/batch-universal-v2-crawler.ts --resume --queue-upload

# Output:
# [1/18] Albany ✓ (2.5 min)
# [2/18] Bartlett ✓ (1.8 min)
# ...
# [10/18] Madison ✓ (3.2 min)
# KILLED at 30 minutes

# 2. Resume batch (skips completed towns)
tsx scripts/batch-universal-v2-crawler.ts --resume --queue-upload

# Output:
# ✅ Resuming from checkpoint: 10 towns already completed
# [11/18] Moultonborough ...
# [12/18] Ossipee ...
# ...continues

# 3. Repeat until all 18 towns complete

# 4. Service uploads everything in background (no rush)
```

### Example 3: Quick Individual Town Runs

For the 4 key towns that need immediate improvements:

```bash
# Madison (904 docs)
npm run crawl:universal:v2 -- --town Madison --url https://madison-nh.org --resume --queue-upload

# Ossipee (114 docs)
npm run crawl:universal:v2 -- --town Ossipee --url https://www.ossipee.org --resume --queue-upload

# Tuftonboro (126 docs)
npm run crawl:universal:v2 -- --town Tuftonboro --url https://www.tuftonboronh.gov --resume --queue-upload

# Wakefield (48 docs)
npm run crawl:universal:v2 -- --town Wakefield --url https://www.wakefieldnh.gov --resume --queue-upload

# Total: ~20 minutes crawling, +1,192 docs
# Uploads happen automatically in background
```

---

## 4. Flags Reference

### Individual Crawler Flags

| Flag | Description |
|------|-------------|
| `--town <name>` | Town name (required) |
| `--url <url>` | Town website URL (required) |
| `--dry-run` | Discover only, no downloads |
| `--max-pages <n>` | Max pages to visit (default: 200) |
| `--resume` | Resume from checkpoint if available |
| `--queue-upload` | Queue for upload service (don't upload immediately) |

### Batch Crawler Flags

| Flag | Description |
|------|-------------|
| `--dry-run` | Discovery mode for all towns |
| `--resume` | Skip completed towns, resume batch |
| `--queue-upload` | All towns queue for upload service |

---

## 5. Benefits Summary

### Without These Features (Old Way)
- ❌ 30-minute timeout kills entire batch
- ❌ Lose all progress, start from scratch
- ❌ Can't separate fast crawling from slow uploads
- ❌ Hours-long uploads blocked by OpenClaw timeouts

### With These Features (New Way)
- ✅ **Crawl finishes in <30 min** (downloads only, no S3 upload delays)
- ✅ **Resume from checkpoint** if interrupted
- ✅ **Uploads happen in background** (no time limit)
- ✅ **Batch runs can span multiple 30-min windows** (just re-run with `--resume`)
- ✅ **Service survives reboots** (continues after server restart)

---

## 6. Troubleshooting

### Service won't start

```bash
# Check service status
sudo systemctl status opencouncil-uploader

# View error logs
sudo journalctl -u opencouncil-uploader -n 50

# Common fixes:
# 1. Verify tsx is installed globally
npm install -g tsx

# 2. Check permissions
sudo chown -R ubuntu:ubuntu /home/ubuntu/.openclaw/workspace/OPENCouncil/upload-queue
sudo chown -R ubuntu:ubuntu /home/ubuntu/.openclaw/workspace/OPENCouncil/logs

# 3. Reinstall service
sudo systemctl stop opencouncil-uploader
sudo bash scripts/install-uploader-service.sh
```

### Uploads not processing

```bash
# 1. Check service is running
sudo systemctl status opencouncil-uploader

# 2. Check upload queue directory
ls -lh upload-queue/

# 3. Check for errors in log
tail -n 100 logs/uploader-service.log

# 4. Verify AWS credentials
echo $AWS_SECRET_ACCESS_KEY
```

### Resume not working

```bash
# 1. Check if checkpoint exists
ls -lh checkpoints/

# 2. View checkpoint contents
cat checkpoints/madison.json

# 3. If corrupted, delete and start fresh
rm checkpoints/madison.json

# 4. Make sure you're using --resume flag
npm run crawl:universal:v2 -- --town Madison --url https://madison-nh.org --resume
```

---

## 7. Performance Tips

### For Fastest Crawling

```bash
# Use resume + queue-upload together
npm run crawl:universal:v2 -- \
  --town <name> \
  --url <url> \
  --resume \
  --queue-upload \
  --max-pages 150  # Increase if needed
```

### For Batch Runs

```bash
# 1. Always use resume + queue-upload
tsx scripts/batch-universal-v2-crawler.ts --resume --queue-upload

# 2. If killed at 30 min, just run again (continues where it left off)

# 3. Monitor upload service
tail -f logs/uploader-service.log
```

### For Large Towns

```bash
# Increase page limit for CivicPlus sites
npm run crawl:universal:v2 -- \
  --town Bartlett \
  --url https://www.townofbartlett.nh.gov \
  --resume \
  --queue-upload \
  --max-pages 200  # Default, but can go higher if needed
```

---

## Files Created

- `scripts/document-uploader-service.ts` - Upload service implementation
- `systemd/opencouncil-uploader.service` - Systemd service definition
- `scripts/install-uploader-service.sh` - Installation script
- Modified `scripts/universal-document-crawler-v2.ts` - Added checkpoint/resume + queue support
- Modified `scripts/batch-universal-v2-crawler.ts` - Added batch resume support

All changes are backward compatible - old commands still work!
