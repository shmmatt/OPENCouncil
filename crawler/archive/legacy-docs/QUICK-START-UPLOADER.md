# Quick Start: Uploader Service + Resume

## 1. Install Uploader Service (One-Time)

```bash
cd OPENCouncil
sudo bash scripts/install-uploader-service.sh
```

✅ Service is now running and will handle all uploads in background

## 2. Run Batch Crawl with Resume

```bash
# Start batch (will run ~30 min then timeout)
tsx scripts/batch-universal-v2-crawler.ts --resume --queue-upload

# Killed? Just run again - continues where it left off
tsx scripts/batch-universal-v2-crawler.ts --resume --queue-upload

# Repeat until all 18 towns complete
```

## 3. Monitor Uploads

```bash
# Watch live upload progress
tail -f logs/uploader-service.log

# Check service status
sudo systemctl status opencouncil-uploader
```

## How It Works

1. **Crawl** = Fast (just downloads, no S3 upload delays)
2. **Upload** = Background service (no timeouts)
3. **Resume** = Batch picks up where it left off
4. **Result** = Complete all 18 towns in 2-3 batch runs (~90 min total crawl time)

## Run 4 Key Towns Now

```bash
# Quick wins (~20 min total)
npm run crawl:universal:v2 -- --town Madison --url https://madison-nh.org --resume --queue-upload
npm run crawl:universal:v2 -- --town Ossipee --url https://www.ossipee.org --resume --queue-upload
npm run crawl:universal:v2 -- --town Tuftonboro --url https://www.tuftonboronh.gov --resume --queue-upload
npm run crawl:universal:v2 -- --town Wakefield --url https://www.wakefieldnh.gov --resume --queue-upload
```

Result: +1,192 documents in ~20 minutes! 🎉
