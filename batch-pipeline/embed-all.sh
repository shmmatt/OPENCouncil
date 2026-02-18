#!/bin/bash
# Run full embedding pipeline in background
# Logs to embed-all.log

cd /home/ubuntu/.openclaw/workspace/OPENCouncil
export $(grep -v '^#' .env | xargs)

echo "Starting embedding at $(date)" >> batch-pipeline/embed-all.log
npx tsx batch-pipeline/embed-realtime.ts >> batch-pipeline/embed-all.log 2>&1
echo "Finished at $(date)" >> batch-pipeline/embed-all.log
