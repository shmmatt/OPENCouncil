# pgvector Quick Start

## One-Command Deployment

```bash
cd /home/ubuntu/.openclaw/workspace/OPENCouncil
./scripts/deploy-pgvector.sh
```

This will:
1. ✅ Generate database migrations
2. ✅ Run migrations to create tables
3. ✅ Enable pgvector extension
4. ✅ Create indexes
5. ✅ Enable feature flag
6. ✅ Build Docker containers
7. ✅ Deploy to production
8. ✅ Optionally migrate existing documents

## Verification

### 1. Check Containers
```bash
sudo docker compose ps
```

Expected: All containers `Up`

### 2. Check Logs
```bash
sudo docker logs app-api-1 -f | grep pgvector
```

Expected after a query:
```
[twoLaneRetrieve] Using pgvector retrieval (feature flag enabled)
[pgvectorRetrieval] Retrieved X local + Y statewide chunks
```

### 3. Test Query

Visit the chat interface and ask:
```
What are the zoning regulations in Ossipee?
```

Look for fast response (<500ms) with relevant results.

## Quick Commands

### Enable/Disable pgvector

```bash
# Enable
echo "USE_PGVECTOR=true" >> .env
sudo docker compose restart api

# Disable
sed -i 's/USE_PGVECTOR=true/USE_PGVECTOR=false/' .env
sudo docker compose restart api
```

### Check Embedding Stats

```bash
sudo docker compose exec api npx tsx -e "
import { getEmbeddingStats } from './server/services/embeddingStorage.js';
getEmbeddingStats().then(stats => {
  console.log('Total chunks:', stats.totalChunks);
  console.log('Total documents:', stats.totalDocuments);
  console.log('By town:', stats.byTown);
  process.exit(0);
});
"
```

### Re-run Migration

```bash
sudo docker compose exec api npx tsx scripts/migrate-to-pgvector.ts
```

## Troubleshooting

### Problem: No pgvector logs

1. Check flag: `grep USE_PGVECTOR .env`
2. Restart: `sudo docker compose restart api`
3. Rebuild if needed: `sudo docker compose build`

### Problem: Database errors

1. Check extension: `psql $DATABASE_URL -c "CREATE EXTENSION IF NOT EXISTS vector;"`
2. Check tables: `psql $DATABASE_URL -c "\dt document_chunks"`

### Problem: Slow queries

1. Check index: `psql $DATABASE_URL -c "\d document_chunks"`
2. Should see `hnsw` index on `embedding` column

## Success Checklist

- [ ] Deployment script completed without errors
- [ ] All Docker containers running
- [ ] pgvector logs appear after queries
- [ ] Query response time <500ms
- [ ] Results are relevant
- [ ] No errors in logs

## Next Steps After Deployment

1. **Monitor for 24-48 hours** - Watch logs, check performance
2. **Tune thresholds** - Adjust similarity threshold if needed
3. **Scale to more towns** - Migration handles new documents automatically
4. **Remove Gemini fallback** - Once confident, simplify code

## Rollback

If something goes wrong:

```bash
sed -i 's/USE_PGVECTOR=true/USE_PGVECTOR=false/' .env
sudo docker compose restart api
```

System will immediately revert to Gemini File Search.

---

**Ready to deploy?** Run the deployment script and follow the prompts!
