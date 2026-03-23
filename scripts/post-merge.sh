#!/bin/bash
set -e
npm install
# --force bypasses interactive prompts for unique constraint additions.
# This is intentional: the app uses push-based schema sync (no migrations),
# and all destructive changes are reviewed before merging.
npm run db:push -- --force
