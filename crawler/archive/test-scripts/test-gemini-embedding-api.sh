#!/bin/bash
API_KEY=$(grep GEMINI_API_KEY .env | cut -d= -f2)

curl -s -X POST \
  "https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001:embedContent?key=$API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"content":{"parts":[{"text":"test document about zoning regulations"}]},"taskType":"RETRIEVAL_DOCUMENT"}' \
  | python3 -c 'import json, sys; d=json.load(sys.stdin); print(f"✅ Embedding works! Dimensions: {len(d[\"embedding\"][\"values\"])}")'
