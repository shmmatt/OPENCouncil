#!/usr/bin/env npx tsx
/**
 * CLI script to sync S3 documents to Gemini
 * Usage: npx tsx scripts/sync-s3.ts --town=conway [--dry-run] [--limit=N]
 */

import { syncS3ToGemini, type SyncOptions } from "../server/services/s3Sync.js";

const args = process.argv.slice(2);
const options: SyncOptions = {};

for (const arg of args) {
  if (arg.startsWith("--town=")) options.town = arg.split("=")[1];
  if (arg === "--dry-run") options.dryRun = true;
  if (arg.startsWith("--limit=")) options.limit = parseInt(arg.split("=")[1]);
  if (arg.startsWith("--concurrency=")) options.concurrency = parseInt(arg.split("=")[1]);
}

console.log("Starting S3 sync with options:", options);

syncS3ToGemini(options)
  .then(result => {
    console.log("\n=== Sync Complete ===");
    console.log(JSON.stringify(result, null, 2));
    process.exit(result.failed > 0 ? 1 : 0);
  })
  .catch(err => {
    console.error("Fatal error:", err);
    process.exit(1);
  });
