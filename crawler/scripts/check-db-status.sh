#!/bin/bash
# Check database status of crawler documents

echo "========================================"
echo "💾 Database Status"
echo "========================================"
echo ""

# Load database URL from .env
export $(grep -v '^#' /home/ubuntu/.openclaw/workspace/OPENCouncil/.env | grep DATABASE_URL | xargs)

if [ -z "$DATABASE_URL" ]; then
    echo "❌ DATABASE_URL not found in .env"
    exit 1
fi

echo "📊 Documents by Status:"
echo "----------------------------------------"
psql "$DATABASE_URL" -c "
SELECT 
    status, 
    COUNT(*) as count,
    ROUND(COUNT(*) * 100.0 / SUM(COUNT(*)) OVER (), 1) as pct
FROM crawler_documents 
GROUP BY status 
ORDER BY status;
" 2>/dev/null

echo ""
echo "📊 Documents by Town (top 10):"
echo "----------------------------------------"
psql "$DATABASE_URL" -c "
SELECT 
    town_slug, 
    COUNT(*) as total,
    SUM(CASE WHEN status='discovered' THEN 1 ELSE 0 END) as discovered,
    SUM(CASE WHEN status='uploaded' THEN 1 ELSE 0 END) as uploaded
FROM crawler_documents 
GROUP BY town_slug 
ORDER BY total DESC 
LIMIT 10;
" 2>/dev/null

echo ""
echo "📊 Recent Activity:"
echo "----------------------------------------"
psql "$DATABASE_URL" -c "
SELECT 
    DATE(discovered_at) as date,
    COUNT(*) as documents
FROM crawler_documents 
WHERE discovered_at > NOW() - INTERVAL '7 days'
GROUP BY DATE(discovered_at)
ORDER BY date DESC;
" 2>/dev/null

echo ""
echo "💡 Total documents in system: $(psql "$DATABASE_URL" -t -c 'SELECT COUNT(*) FROM crawler_documents;' 2>/dev/null | xargs)"
echo ""
