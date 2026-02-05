# OPENCouncil Deployment Process

## Overview

**Workspace (Development):** `/home/ubuntu/.openclaw/workspace/OPENCouncil`  
**Production Server:** `ubuntu@18.205.155.136:/home/ubuntu/app`  
**SSH Key:** `/home/ubuntu/.openclaw/workspace/.ssh/openclaw_ec2`  
**GitHub Repo:** `git@github.com:shmmatt/OPENCouncil.git`

## Architecture

```
┌─────────────────────┐      git push/pull       ┌─────────────────┐
│  Workspace Server   │ ◄──────────────────────► │     GitHub      │
│  (Development)      │                           │  (Source Repo)  │
└─────────────────────┘                           └─────────────────┘
         │                                                 ▲
         │ deploy.sh / quick-deploy.sh                    │
         ▼                                                 │
┌─────────────────────┐                                   │
│  Production Server  │ ◄─────────────────────────────────┘
│  (18.205.155.136)   │            git pull
│  Docker: api,       │
│  worker, redis      │
└─────────────────────┘
```

## Setup (One-Time)

### 1. GitHub SSH Key
Add this SSH public key to your GitHub account (Settings → SSH Keys):

```
ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAID9G7RPjouyyn0wCaFbJpxLe1aCdiDDRqcvdu3cGcCNo matt@opencouncil.ai
```

**To add:**
1. Go to https://github.com/settings/keys
2. Click "New SSH key"
3. Paste the key above
4. Title it "OpenClaw Workspace Server"

### 2. Test SSH Connection
```bash
ssh -T git@github.com
# Should see: "Hi shmmatt! You've successfully authenticated..."
```

### 3. Git Configuration
Already configured:
- Name: Matt
- Email: matt@opencouncil.ai
- Remote: git@github.com:shmmatt/OPENCouncil.git (SSH)

## Deployment Methods

### Method 1: Full Deployment (Recommended)
**When to use:** Production-ready changes, dependency updates, clean deployments  
**Process:** Commit → Push to GitHub → Pull on server → Docker rebuild

```bash
cd /home/ubuntu/.openclaw/workspace/OPENCouncil

# 1. Make sure changes are committed
git add .
git commit -m "Your commit message"

# 2. Run deployment script
./deploy.sh
```

**What it does:**
1. ✅ Checks for uncommitted changes
2. ⬆️ Pushes to GitHub
3. ⬇️ Pulls on production server
4. 🔨 Rebuilds Docker images
5. ♻️ Restarts API container
6. 📋 Shows recent logs

**Time:** ~2-5 minutes (includes Docker rebuild)

---

### Method 2: Quick Deploy (Development Iteration)
**When to use:** Testing changes, rapid iteration, debugging  
**Process:** rsync files → rebuild inside container → restart

```bash
cd /home/ubuntu/.openclaw/workspace/OPENCouncil

# Run quick deploy (no git commit needed)
./quick-deploy.sh
```

**What it does:**
1. 📦 Syncs files via rsync (excludes node_modules, .git, dist)
2. 🔨 Rebuilds inside running container (`npm run build`)
3. ♻️ Restarts API only
4. 📋 Shows logs

**⚠️ Important:** Quick-deploy bypasses git. Remember to commit and run `./deploy.sh` when ready!

**Time:** ~30-60 seconds

---

### Method 3: Manual Deployment
For special cases or troubleshooting.

```bash
# SSH into workspace
PROD="ubuntu@18.205.155.136"
SSH_KEY="$HOME/.openclaw/workspace/.ssh/openclaw_ec2"

# Push changes
cd /home/ubuntu/.openclaw/workspace/OPENCouncil
git push origin main

# Pull on production
ssh -i $SSH_KEY $PROD "cd /home/ubuntu/app && git pull origin main"

# Rebuild and restart
ssh -i $SSH_KEY $PROD "cd /home/ubuntu/app && sudo docker compose build api"
ssh -i $SSH_KEY $PROD "cd /home/ubuntu/app && sudo docker compose up -d api"

# Check logs
ssh -i $SSH_KEY $PROD "sudo docker logs app-api-1 --tail 30"
```

---

## Git Workflow

### Branch Strategy

**main** - Production-ready code  
**feature/*** - Feature branches  
**fix/*** - Bug fix branches

### Standard Workflow

```bash
# Create feature branch
git checkout -b feature/my-feature

# Make changes, commit
git add .
git commit -m "feat: add my feature"

# Push to GitHub
git push origin feature/my-feature

# When ready to deploy, merge to main
git checkout main
git merge feature/my-feature
git push origin main

# Deploy
./deploy.sh
```

---

## Production Server Details

**Host:** ubuntu@18.205.155.136  
**App Path:** `/home/ubuntu/app`  
**Deployment:** Docker Compose (3 containers)

### Containers
- **app-api-1** - Main API server (port 80 → 5000)
- **app-worker-1** - Background OCR worker
- **app-redis-1** - Redis cache/queue

### Stack
- **Runtime:** Node.js 20 (ESM)
- **Build:** TypeScript → esbuild → `/app/dist/index.js`
- **Frontend:** Vite → `/app/dist/public/`

---

## Common Operations

### Check Production Status
```bash
ssh -i ~/.openclaw/workspace/.ssh/openclaw_ec2 ubuntu@18.205.155.136 \
  "cd /home/ubuntu/app && sudo docker ps && sudo docker logs app-api-1 --tail 20"
```

### Rebuild Without Deploy
```bash
ssh -i ~/.openclaw/workspace/.ssh/openclaw_ec2 ubuntu@18.205.155.136 \
  "cd /home/ubuntu/app && sudo docker compose build api"
```

### Restart API Only
```bash
ssh -i ~/.openclaw/workspace/.ssh/openclaw_ec2 ubuntu@18.205.155.136 \
  "cd /home/ubuntu/app && sudo docker compose restart api"
```

### View Live Logs
```bash
ssh -i ~/.openclaw/workspace/.ssh/openclaw_ec2 ubuntu@18.205.155.136 \
  "sudo docker logs app-api-1 -f"
```

### Check Build Timestamp
```bash
ssh -i ~/.openclaw/workspace/.ssh/openclaw_ec2 ubuntu@18.205.155.136 \
  "sudo docker exec app-api-1 ls -lh /app/dist/index.js"
```

---

## Troubleshooting

### Issue: Changes don't appear after deploy
**Cause:** TypeScript not recompiled or wrong branch

**Solution:**
```bash
# Verify branch
ssh -i ~/.openclaw/workspace/.ssh/openclaw_ec2 ubuntu@18.205.155.136 \
  "cd /home/ubuntu/app && git branch && git status"

# Force rebuild
ssh -i ~/.openclaw/workspace/.ssh/openclaw_ec2 ubuntu@18.205.155.136 \
  "cd /home/ubuntu/app && sudo docker exec app-api-1 rm -rf dist && sudo docker exec app-api-1 npm run build && sudo docker compose restart api"
```

### Issue: Container won't start
**Solution:**
```bash
ssh -i ~/.openclaw/workspace/.ssh/openclaw_ec2 ubuntu@18.205.155.136 \
  "sudo docker logs app-api-1 --tail 100"
```

### Issue: Git push fails
**Cause:** SSH key not added to GitHub

**Solution:** Add the SSH public key shown in Setup section to https://github.com/settings/keys

### Issue: Build gets killed (OOM)
**Solution:** Use quick-deploy instead (builds inside container with more memory)

---

## Database Changes

### Run SQL on Production
```bash
ssh -i ~/.openclaw/workspace/.ssh/openclaw_ec2 ubuntu@18.205.155.136 \
  "sudo docker exec app-api-1 node -e \"
import pg from 'pg';
const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();
await client.query('YOUR SQL HERE');
await client.end();
\""
```

### Run Drizzle Migrations
```bash
ssh -i ~/.openclaw/workspace/.ssh/openclaw_ec2 ubuntu@18.205.155.136 \
  "cd /home/ubuntu/app && sudo docker exec app-api-1 npm run db:push"
```

---

## Rollback

### Quick Rollback (Git)
```bash
# On production server
cd /home/ubuntu/app
git log --oneline -10  # Find good commit
git reset --hard <commit-hash>
sudo docker compose build api
sudo docker compose up -d api
```

### Rollback from Workspace
```bash
ssh -i ~/.openclaw/workspace/.ssh/openclaw_ec2 ubuntu@18.205.155.136 \
  "cd /home/ubuntu/app && git reset --hard HEAD~1 && sudo docker compose build api && sudo docker compose up -d api"
```

---

## Health Checks (Post-Deploy)

Run after every deployment:

```bash
# 1. Check containers
sudo docker ps

# 2. Check recent logs for errors
sudo docker logs app-api-1 --tail 50 | grep -i error

# 3. Test endpoint
curl http://18.205.155.136/api/meta/towns

# 4. Check build timestamp
sudo docker exec app-api-1 ls -lh /app/dist/index.js
```

**Expected:**
- All 3 containers running
- No build errors in logs
- API returns JSON
- Build timestamp is recent

---

## Configuration

### Environment Variables
Managed via `.env` file on production server (not in git)

**Key variables:**
- `DATABASE_URL` - PostgreSQL connection
- `GEMINI_API_KEY` - Google AI API key
- `ADMIN_EMAIL` / `ADMIN_PASSWORD` - Admin account

### Secrets Management
- `.env` file is **not** synced via rsync or git
- Changes to `.env` require container restart
- Store sensitive values only on production server

---

## Notes

### File Sync Exclusions
Both rsync and Docker exclude:
- `node_modules/` - Rebuilt on server
- `.git/` - Git managed separately
- `dist/` - Build output
- `uploads/blobs/` - User-uploaded data
- `.env` - Server-specific secrets

### Build Cache
Docker layer caching speeds up rebuilds. Force clean build:
```bash
sudo docker compose build --no-cache api
```

### Branch Drift Prevention
- Always merge to `main` before deploying to production
- Keep production server on `main` branch
- Use feature branches for development
- Run `./deploy.sh` (not manual commands) to ensure consistency

---

## Quick Reference

| Task | Command |
|------|---------|
| Deploy to production | `./deploy.sh` |
| Quick test deploy | `./quick-deploy.sh` |
| Check prod status | `ssh ubuntu@18.205.155.136 "sudo docker ps"` |
| View logs | `ssh ubuntu@18.205.155.136 "sudo docker logs app-api-1 -f"` |
| Rebuild container | `ssh ubuntu@18.205.155.136 "cd ~/app && sudo docker compose build api"` |
| Restart API | `ssh ubuntu@18.205.155.136 "cd ~/app && sudo docker compose restart api"` |

---

**Last Updated:** 2026-02-05  
**Maintained By:** Marvin (OpenClaw AI)
