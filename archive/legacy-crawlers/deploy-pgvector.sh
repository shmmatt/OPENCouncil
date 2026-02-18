#!/bin/bash
set -e

echo "========================================="
echo "🚀 pgvector Deployment Script"
echo "========================================="
echo ""

# Load environment
if [ -f .env ]; then
    echo "📋 Loading .env..."
    export $(cat .env | grep -v '^#' | xargs)
else
    echo "❌ .env file not found!"
    exit 1
fi

# Check DATABASE_URL
if [ -z "$DATABASE_URL" ]; then
    echo "❌ DATABASE_URL not set in .env!"
    exit 1
fi

echo "✅ DATABASE_URL configured"
echo ""

# Step 1: Generate Drizzle migration
echo "📦 Step 1: Generating database migration..."
npm run db:generate || {
    echo "❌ Failed to generate migration"
    exit 1
}
echo "✅ Migration files generated"
echo ""

# Step 2: Run database migration
echo "🗄️  Step 2: Running database migration..."
npm run db:migrate || {
    echo "❌ Failed to run migration"
    exit 1
}
echo "✅ Database migrated"
echo ""

# Step 3: Enable pgvector extension and create indexes
echo "🔧 Step 3: Setting up pgvector extension and indexes..."
npx tsx << 'EOF'
import { db, sql } from "./server/storage/db.js";

async function setup() {
  console.log("Enabling pgvector extension...");
  await db.execute(sql`CREATE EXTENSION IF NOT EXISTS vector`);
  
  console.log("Creating HNSW index...");
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS document_chunks_embedding_idx 
    ON document_chunks 
    USING hnsw (embedding vector_cosine_ops)
  `);
  
  console.log("Creating filter indexes...");
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS document_chunks_town_idx 
    ON document_chunks (town)
  `);
  
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS document_chunks_category_idx 
    ON document_chunks (category)
  `);
  
  console.log("✅ Database setup complete");
  process.exit(0);
}

setup().catch((err) => {
  console.error("❌ Setup failed:", err);
  process.exit(1);
});
EOF
echo "✅ pgvector setup complete"
echo ""

# Step 4: Enable USE_PGVECTOR flag
echo "🎛️  Step 4: Enabling USE_PGVECTOR flag..."
if grep -q "^USE_PGVECTOR=" .env; then
    sed -i 's/^USE_PGVECTOR=.*/USE_PGVECTOR=true/' .env
    echo "✅ Updated USE_PGVECTOR=true in .env"
else
    echo "USE_PGVECTOR=true" >> .env
    echo "✅ Added USE_PGVECTOR=true to .env"
fi
echo ""

# Step 5: Build and deploy Docker containers
echo "🐳 Step 5: Building and deploying Docker containers..."
sudo docker compose build || {
    echo "❌ Docker build failed"
    exit 1
}
echo "✅ Docker images built"
echo ""

echo "🔄 Restarting containers..."
sudo docker compose down
sudo docker compose up -d || {
    echo "❌ Failed to start containers"
    exit 1
}
echo "✅ Containers started"
echo ""

# Step 6: Wait for services to be ready
echo "⏳ Step 6: Waiting for services to start..."
sleep 5
echo ""

# Step 7: Check container status
echo "📊 Step 7: Checking container status..."
sudo docker compose ps
echo ""

# Step 8: Run migration script for existing documents
echo "🔄 Step 8: Migrating existing documents to pgvector..."
echo "This will process all existing documents and generate embeddings."
echo ""
read -p "Do you want to run the migration now? (y/n) " -n 1 -r
echo
if [[ $REPLY =~ ^[Yy]$ ]]; then
    sudo docker compose exec api npx tsx scripts/migrate-to-pgvector.ts || {
        echo "⚠️  Migration script encountered errors (check logs)"
        echo "You can re-run it later with:"
        echo "  sudo docker compose exec api npx tsx scripts/migrate-to-pgvector.ts"
    }
else
    echo "⏭️  Skipping migration. Run it manually later with:"
    echo "  sudo docker compose exec api npx tsx scripts/migrate-to-pgvector.ts"
fi
echo ""

echo "========================================="
echo "✅ pgvector Deployment Complete!"
echo "========================================="
echo ""
echo "📝 Next Steps:"
echo "1. Test a query on the chat interface"
echo "2. Monitor logs: sudo docker logs app-api-1 -f"
echo "3. Look for '[pgvectorRetrieval]' messages"
echo ""
echo "🔧 To disable pgvector (rollback):"
echo "  sed -i 's/USE_PGVECTOR=true/USE_PGVECTOR=false/' .env"
echo "  sudo docker compose restart api"
echo ""
