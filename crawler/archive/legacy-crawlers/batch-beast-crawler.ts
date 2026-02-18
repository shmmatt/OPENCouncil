/**
 * Batch Beast Document Crawler
 * 
 * Runs the beast crawler across all Carroll County towns
 * 
 * Usage:
 *   npm run crawl:beast:batch
 *   npm run crawl:beast:batch -- --dry-run
 */

import * as fs from "fs/promises";
import { spawn } from "child_process";

interface Town {
  name: string;
  url: string;
}

const TOWNS_FILE = "scripts/carroll-county-towns.json";

async function runBeastCrawler(town: Town, dryRun: boolean = false): Promise<{ success: boolean; error?: string }> {
  return new Promise((resolve) => {
    const args = [
      "--env-file=.env",
      "scripts/beast-document-crawler.ts",
      "--town", town.name,
      "--url", town.url,
      "--max-docs", "2000",
    ];
    
    if (dryRun) {
      args.push("--dry-run");
    }
    
    console.log(`\n${"=".repeat(80)}`);
    console.log(`🦁 Starting beast crawl: ${town.name}`);
    console.log(`${"=".repeat(80)}\n`);
    
    const process = spawn("tsx", args, {
      stdio: "inherit",
      shell: true,
    });
    
    process.on("close", (code) => {
      if (code === 0) {
        resolve({ success: true });
      } else {
        resolve({ success: false, error: `Exit code ${code}` });
      }
    });
    
    process.on("error", (error) => {
      resolve({ success: false, error: error.message });
    });
  });
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  
  console.log(`\n🦁 BATCH BEAST DOCUMENT CRAWLER`);
  console.log(`Dry run: ${dryRun}\n`);
  
  // Load towns
  const townsData = await fs.readFile(TOWNS_FILE, "utf-8");
  const towns: Town[] = JSON.parse(townsData);
  
  console.log(`📋 Loaded ${towns.length} towns from ${TOWNS_FILE}\n`);
  
  const results: { town: string; success: boolean; error?: string }[] = [];
  const startTime = Date.now();
  
  // Run sequentially
  for (const town of towns) {
    const result = await runBeastCrawler(town, dryRun);
    
    results.push({
      town: town.name,
      success: result.success,
      error: result.error,
    });
    
    // Status update
    if (result.success) {
      console.log(`✅ ${town.name}`);
    } else {
      console.log(`❌ ${town.name} - ${result.error}`);
    }
  }
  
  const endTime = Date.now();
  const durationMinutes = Math.round((endTime - startTime) / 1000 / 60);
  
  // Summary
  console.log(`\n${"=".repeat(80)}`);
  console.log(`📊 BATCH SUMMARY`);
  console.log(`${"=".repeat(80)}\n`);
  
  const successful = results.filter(r => r.success);
  const failed = results.filter(r => !r.success);
  
  console.log(`Total: ${results.length}`);
  console.log(`Successful: ${successful.length}`);
  console.log(`Failed: ${failed.length}`);
  console.log(`Duration: ${durationMinutes} minutes\n`);
  
  if (failed.length > 0) {
    console.log(`Failed towns:`);
    failed.forEach(r => {
      console.log(`  ❌ ${r.town} - ${r.error}`);
    });
    console.log('');
  }
  
  // Save summary
  const summary = {
    completedAt: new Date().toISOString(),
    durationMinutes,
    total: results.length,
    successful: successful.length,
    failed: failed.length,
    results,
  };
  
  const summaryPath = `town-profiles/batch-beast-${new Date().toISOString().split('T')[0]}.json`;
  await fs.writeFile(summaryPath, JSON.stringify(summary, null, 2));
  
  console.log(`Summary saved: ${summaryPath}\n`);
  
  if (failed.length > 0) {
    process.exit(1);
  }
}

main().catch(error => {
  console.error(`\n❌ Fatal error: ${error.message}`);
  console.error(error.stack);
  process.exit(1);
});
