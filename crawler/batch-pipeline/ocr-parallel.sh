#!/bin/bash
# Parallel OCR - runs multiple workers by town
cd /home/ubuntu/.openclaw/workspace/OPENCouncil
export $(grep -v '^#' .env | xargs)

# Create log directory
mkdir -p batch-pipeline/ocr-logs

# Get list of towns with docs needing OCR
TOWNS=$(psql "$DATABASE_URL" -t -c "
  SELECT DISTINCT ld.town 
  FROM file_blobs fb
  JOIN document_versions dv ON dv.file_blob_id = fb.id
  JOIN logical_documents ld ON dv.document_id = ld.id
  WHERE dv.is_current = true
    AND fb.storage_path LIKE 's3://%'
    AND (fb.ocr_text IS NULL OR LENGTH(fb.ocr_text) < 100)
    AND fb.mime_type = 'application/pdf'
  ORDER BY 1
" | tr -d ' ')

echo "Starting parallel OCR for towns:"
echo "$TOWNS"
echo ""

# Run OCR for each town in parallel (max 4 concurrent)
for town in $TOWNS; do
  echo "Starting: $town"
  npx tsx batch-pipeline/ocr-pipeline.ts --town="$town" --limit=500 \
    > "batch-pipeline/ocr-logs/${town}.log" 2>&1 &
  
  # Limit parallelism to 2 (memory constrained)
  while [ $(jobs -r | wc -l) -ge 2 ]; do
    sleep 10
  done
done

echo "All workers started. Monitor with: tail -f batch-pipeline/ocr-logs/*.log"
wait
echo "All OCR complete!"
