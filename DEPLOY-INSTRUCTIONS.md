# pgvector Deployment Instructions

## Status: Schema Ready, Code Ready, Needs Docker Build

✅ Database tables created successfully  
✅ USE_PGVECTOR=true enabled in .env  
✅ All code files in place  
⏳ Needs Docker build and deploy on production server  

## What's Been Done

1. ✅ Added pgvector schema to `shared/schema.ts`
2. ✅ Created embedding services (`embeddingService.ts`, `embeddingStorage.ts`, `pgvectorRetrieval.ts`)
3. ✅ Integrated pgvector into `twoLaneRetrieve.ts`
4. ✅ Updated `ingestionWorker.ts` to auto-generate embeddings
5. ✅ Created migration script (`migrate-to-pgvector.ts`)
6. ✅ Created database tables and indexes in production DB
7. ✅ Enabled `USE_PGVECTOR=true` in `.env`

## Next Steps (Run on Production Server)

### 1. Sync Code to Production

From your local machine, sync the updated files to the production server:

```bash
rsync -av --progress \
  /path/to/local/OPENCouncil/server/services/embedding*.ts \
  /path/to/local/OPENCouncil/server/services/pgvectorRetrieval.ts \
  /path/to/local/OPENCouncil/server/chatV2/twoLaneRetrieve.ts \
  /path/to/local/OPENCouncil/server/services/ingestionWorker.ts \
  /path/to/local/OPENCouncil/shared/schema.ts \
  /path/to/local/OPENCouncil/scripts/migrate-to-pgvector.ts \
  ubuntu@18.205.155.136:/home/ubuntu/OPENCouncil/
```

Or copy the entire updated OPENCouncil directory.

### 2. SSH to Production Server

```bash
ssh ubuntu@18.205.155.136
cd /home/ubuntu/OPENCouncil
```

### 3. Verify .env File

```bash
grep USE_PGVECTOR .env
# Should output: USE_PGVECTOR=true
```

### 4. Build Docker Images

```bash
sudo docker compose build
```

This will take ~2-3 minutes.

### 5. Deploy Containers

```bash
sudo docker compose down
sudo docker compose up -d
```

### 6. Verify Containers Running

```bash
sudo docker compose ps
# All containers should show "Up"
```

### 7. Run Migration Script

This will embed all existing documents (~700 docs, ~10-15 minutes):

```bash
sudo docker compose exec api npx tsx scripts/migrate-to-pgvector.ts
```

Watch the output - it will show progress for each document.

### 8. Test with a Query

Visit the chat interface and ask:
```
What are the zoning regulations in Ossipee?
```

### 9. Check Logs

```bash
sudo docker logs app-api-1 -f | grep pgvector
```

Expected output:
```
[twoLaneRetrieve] Using pgvector retrieval (feature flag enabled)
[pgvectorRetrieval] Retrieved 14 local + 6 statewide chunks (269ms)
```

## Verification Checklist

- [ ] Code synced to production server
- [ ] Docker images built successfully
- [ ] Containers running (`docker compose ps`)
- [ ] Migration script completed
- [ ] Test query returns relevant results
- [ ] Logs show `[pgvectorRetrieval]` messages
- [ ] No errors in logs

## Rollback (if needed)

If something goes wrong:

```bash
sed -i 's/USE_PGVECTOR=true/USE_PGVECTOR=false/' .env
sudo docker compose restart api
```

System will immediately fall back to Gemini File Search.

## Files That Need to Be Synced

### New Files:
- `server/services/embeddingService.ts`
- `server/services/embeddingStorage.ts`
- `server/services/pgvectorRetrieval.ts`
- `scripts/migrate-to-pgvector.ts`
- `scripts/reset-pgvector-tables.ts`
- `scripts/check-pgvector-tables.ts`

### Modified Files:
- `shared/schema.ts`
- `server/chatV2/twoLaneRetrieve.ts`
- `server/services/ingestionWorker.ts`

### Configuration:
- `.env` (USE_PGVECTOR=true should be added)

## Expected Results

After deployment:

1. **Query logs show pgvector usage**
2. **Response times <300ms**
3. **Similarity scores >0.7 average**
4. **No fallbacks to Gemini** (unless error occurs)
5. **~700 documents embedded**
6. **~3,500-5,000 total chunks**

## Support

If you encounter issues:

1. Check logs: `sudo docker logs app-api-1 -f`
2. Verify tables: `sudo docker compose exec api npx tsx scripts/check-pgvector-tables.ts`
3. Check embedding stats (after migration):
   ```bash
   sudo docker compose exec api npx tsx -e "
   import { getEmbeddingStats } from './server/services/embeddingStorage.js';
   const stats = await getEmbeddingStats();
   console.log(stats);
   process.exit(0);
   "
   ```

## Cost Savings

Once deployed:
- **Before:** $300-1,500/month for 1,000 queries/day
- **After:** $0/month (after initial embedding cost of <$0.05)
- **ROI:** Immediate

---

**Ready to deploy!** Follow steps 1-9 above on the production server.
