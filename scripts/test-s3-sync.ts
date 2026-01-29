/**
 * Test script for S3 to Gemini sync
 * 
 * Run from Replit with: npx tsx scripts/test-s3-sync.ts
 * 
 * Prerequisites:
 * 1. Run migration: npx drizzle-kit push
 * 2. Ensure AWS credentials are configured
 * 3. Ensure GEMINI_API_KEY is set
 */

import { getSyncStatus, syncTown, listS3Town, extractMetadataFromPath } from "../server/services/s3GeminiSync";

async function main() {
  const town = process.argv[2] || "conway";
  const action = process.argv[3] || "status";
  const limit = parseInt(process.argv[4] || "5");
  
  console.log(`\n🔄 S3-to-Gemini Sync Test`);
  console.log(`Town: ${town}`);
  console.log(`Action: ${action}`);
  console.log(`Limit: ${limit}\n`);
  
  try {
    switch (action) {
      case "status": {
        console.log("📊 Getting sync status...\n");
        const status = await getSyncStatus(town);
        console.log("Status:", JSON.stringify(status, null, 2));
        break;
      }
      
      case "list": {
        console.log("📁 Listing S3 files...\n");
        const files = await listS3Town(town);
        console.log(`Found ${files.length} PDFs\n`);
        
        for (const file of files.slice(0, limit)) {
          const meta = extractMetadataFromPath(file.key);
          console.log(`  ${file.key}`);
          console.log(`    → Town: ${meta.town}, Category: ${meta.category}`);
          if (meta.board) console.log(`    → Board: ${meta.board}`);
          if (meta.year) console.log(`    → Year: ${meta.year}`);
          console.log();
        }
        
        if (files.length > limit) {
          console.log(`  ... and ${files.length - limit} more`);
        }
        break;
      }
      
      case "sync": {
        console.log(`🚀 Running sync (limit: ${limit})...\n`);
        const result = await syncTown(town, { limit });
        console.log("\nResult:", JSON.stringify(result, null, 2));
        break;
      }
      
      case "dry-run": {
        console.log(`🧪 Dry run (limit: ${limit})...\n`);
        const result = await syncTown(town, { limit, dryRun: true });
        console.log("\nResult:", JSON.stringify(result, null, 2));
        break;
      }
      
      default:
        console.log("Unknown action. Use: status, list, sync, or dry-run");
    }
  } catch (error) {
    console.error("Error:", error);
    process.exit(1);
  }
}

main();
