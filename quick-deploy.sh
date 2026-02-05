#!/bin/bash
set -e

# Quick Deploy - for rapid iteration (skip git, use rsync)
# Use for testing changes without committing

PROD_SERVER="ubuntu@18.205.155.136"
PROD_PATH="/home/ubuntu/app"
SSH_KEY="$HOME/.openclaw/workspace/.ssh/openclaw_ec2"

echo "⚡ Quick Deploy (rsync + hot-reload)"
echo "===================================="
echo ""

# Sync files (excluding heavy stuff)
echo "📦 Syncing files..."
rsync -avz --delete \
  --exclude 'node_modules' \
  --exclude '.git' \
  --exclude 'dist' \
  --exclude 'uploads' \
  --exclude '.env' \
  -e "ssh -i $SSH_KEY" \
  ./ $PROD_SERVER:$PROD_PATH/

# Rebuild inside container (fast - uses existing node_modules)
echo "🔨 Rebuilding inside container..."
ssh -i $SSH_KEY $PROD_SERVER "sudo docker exec app-api-1 npm run build"

# Restart API only
echo "♻️  Restarting API..."
ssh -i $SSH_KEY $PROD_SERVER "cd $PROD_PATH && sudo docker compose restart api"

# Wait and check
echo "⏳ Waiting..."
sleep 2

echo "📋 Recent logs:"
ssh -i $SSH_KEY $PROD_SERVER "sudo docker logs app-api-1 --tail 10"

echo ""
echo "✅ Quick deploy complete!"
echo "⚠️  Remember to commit and run ./deploy.sh when ready!"
