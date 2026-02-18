#!/bin/bash
# Test script for S3-to-Gemini sync API endpoints
#
# Usage:
#   1. Start the server: npm run dev
#   2. Login and get token: TOKEN=$(curl -s -X POST http://localhost:5000/api/admin/login -H "Content-Type: application/json" -d '{"email":"shmmatt@gmail.com","password":"Lui2011#"}' | jq -r .token)
#   3. Run this script: ./scripts/test-s3-sync-api.sh $TOKEN

TOKEN=$1
BASE_URL=${2:-"http://localhost:5000"}
TOWN=${3:-"conway"}

if [ -z "$TOKEN" ]; then
    echo "Usage: $0 <token> [base_url] [town]"
    echo ""
    echo "Get token first:"
    echo '  TOKEN=$(curl -s -X POST http://localhost:5000/api/admin/login -H "Content-Type: application/json" -d '\''{"email":"shmmatt@gmail.com","password":"Lui2011#"}'\'' | jq -r .token)'
    exit 1
fi

echo "🔄 S3-to-Gemini Sync API Test"
echo "Base URL: $BASE_URL"
echo "Town: $TOWN"
echo ""

echo "📊 1. Getting sync status..."
curl -s -X GET "$BASE_URL/api/admin/s3-sync/status?town=$TOWN" \
    -H "Authorization: Bearer $TOKEN" \
    -H "Content-Type: application/json" | jq .
echo ""

echo "📁 2. Listing S3 files (first 10)..."
curl -s -X GET "$BASE_URL/api/admin/s3-sync/files?town=$TOWN&limit=10" \
    -H "Authorization: Bearer $TOKEN" \
    -H "Content-Type: application/json" | jq .
echo ""

echo "🚀 3. Running sync (limit: 5)..."
curl -s -X POST "$BASE_URL/api/admin/s3-sync/run" \
    -H "Authorization: Bearer $TOKEN" \
    -H "Content-Type: application/json" \
    -d "{\"town\":\"$TOWN\",\"limit\":5}" | jq .
echo ""

echo "📊 4. Getting updated sync status..."
curl -s -X GET "$BASE_URL/api/admin/s3-sync/status?town=$TOWN" \
    -H "Authorization: Bearer $TOKEN" \
    -H "Content-Type: application/json" | jq .
echo ""

echo "✅ Done!"
