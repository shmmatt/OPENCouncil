#!/bin/bash
set -e

# OPENCouncil Deployment Script
# Deploys current branch to production server

PROD_SERVER="ubuntu@18.205.155.136"
PROD_PATH="/home/ubuntu/app"
SSH_KEY="$HOME/.openclaw/workspace/.ssh/openclaw_ec2"

echo "🚀 OPENCouncil Deployment"
echo "========================"
echo ""

# Check we're on a clean branch
if [[ -n $(git status --porcelain) ]]; then
    echo "❌ Working directory has uncommitted changes. Commit or stash them first."
    exit 1
fi

BRANCH=$(git rev-parse --abbrev-ref HEAD)
echo "📍 Deploying branch: $BRANCH"
echo ""

# Push to GitHub
echo "⬆️  Pushing to GitHub..."
git push origin $BRANCH

# Pull on production
echo "⬇️  Pulling on production server..."
ssh -i $SSH_KEY $PROD_SERVER "cd $PROD_PATH && git fetch && git checkout $BRANCH && git pull origin $BRANCH"

# Rebuild Docker images
echo "🔨 Rebuilding Docker images..."
ssh -i $SSH_KEY $PROD_SERVER "cd $PROD_PATH && sudo docker compose build api"

# Restart services
echo "♻️  Restarting services..."
ssh -i $SSH_KEY $PROD_SERVER "cd $PROD_PATH && sudo docker compose up -d --no-deps api"

# Wait for startup
echo "⏳ Waiting for services to start..."
sleep 3

# Check logs
echo "📋 Recent logs:"
ssh -i $SSH_KEY $PROD_SERVER "sudo docker logs app-api-1 --tail 10"

echo ""
echo "✅ Deployment complete!"
echo "🌐 Check http://18.205.155.136/"
