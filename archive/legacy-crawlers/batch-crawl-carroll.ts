/**
 * Batch Crawl Carroll County Towns
 * 
 * Crawls all Carroll County town websites to extract:
 * - Meeting schedules
 * - Contact information
 * - Board member info
 * 
 * Usage:
 *   npm run crawl:batch
 */

import * as fs from "fs/promises";
import { spawn } from "child_process";

interface Town {
  name: string;
  url: string;
}

const TOWNS_FILE = "./scripts/carroll-county-towns.json";
const DELAY_BETWEEN_TOWNS_MS = 5000; // 5 seconds to avoid rate limiting

async function crawlTown(town: Town): Promise<{ success: boolean; error?: string }> {
  return new Promise((resolve) => {
    console.log(`\n${"=".repeat(80)}`);
    console.log(`🏛️  ${town.name.toUpperCase()}`);
    console.log(`🌐 ${town.url}`);
    console.log(`${"=".repeat(80)}\n`);

    const child = spawn(
      "npm",
      ["run", "crawl:comprehensive", "--", "--town", town.name, "--url", town.url],
      {
        cwd: process.cwd(),
        stdio: "inherit",
        shell: true,
      }
    );

    child.on("close", (code) => {
      if (code === 0) {
        console.log(`\n✅ ${town.name} - Success\n`);
        resolve({ success: true });
      } else {
        console.log(`\n❌ ${town.name} - Failed (exit code ${code})\n`);
        resolve({ success: false, error: `Exit code ${code}` });
      }
    });

    child.on("error", (error) => {
      console.log(`\n❌ ${town.name} - Error: ${error.message}\n`);
      resolve({ success: false, error: error.message });
    });
  });
}

async function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  console.log(`\n🚀 CARROLL COUNTY BATCH CRAWLER\n`);
  console.log(`Reading town list from: ${TOWNS_FILE}\n`);

  const townsData = await fs.readFile(TOWNS_FILE, "utf-8");
  const towns: Town[] = JSON.parse(townsData);

  console.log(`Found ${towns.length} towns to crawl\n`);
  console.log(`Delay between towns: ${DELAY_BETWEEN_TOWNS_MS}ms\n`);

  const results: Array<{ town: string; success: boolean; error?: string }> = [];
  const startTime = Date.now();

  for (let i = 0; i < towns.length; i++) {
    const town = towns[i];
    console.log(`\n[${i + 1}/${towns.length}] Starting: ${town.name}...`);

    const result = await crawlTown(town);
    results.push({ town: town.name, ...result });

    // Delay between towns (except after last one)
    if (i < towns.length - 1) {
      console.log(`\n⏳ Waiting ${DELAY_BETWEEN_TOWNS_MS / 1000}s before next town...\n`);
      await sleep(DELAY_BETWEEN_TOWNS_MS);
    }
  }

  const endTime = Date.now();
  const durationMinutes = Math.round((endTime - startTime) / 60000);

  // Summary
  console.log(`\n\n${"=".repeat(80)}`);
  console.log(`📊 BATCH CRAWL COMPLETE`);
  console.log(`${"=".repeat(80)}\n`);

  const successful = results.filter((r) => r.success);
  const failed = results.filter((r) => !r.success);

  console.log(`Total towns: ${towns.length}`);
  console.log(`✅ Successful: ${successful.length}`);
  console.log(`❌ Failed: ${failed.length}`);
  console.log(`⏱️  Duration: ${durationMinutes} minutes\n`);

  if (successful.length > 0) {
    console.log(`Successful towns:`);
    successful.forEach((r) => console.log(`  ✅ ${r.town}`));
    console.log("");
  }

  if (failed.length > 0) {
    console.log(`Failed towns:`);
    failed.forEach((r) => console.log(`  ❌ ${r.town} - ${r.error}`));
    console.log("");
  }

  // Save summary
  const summary = {
    completedAt: new Date().toISOString(),
    durationMinutes,
    total: towns.length,
    successful: successful.length,
    failed: failed.length,
    results,
  };

  const summaryPath = `town-profiles/batch-crawl-${new Date().toISOString().split("T")[0]}.json`;
  await fs.writeFile(summaryPath, JSON.stringify(summary, null, 2));
  console.log(`Summary saved: ${summaryPath}\n`);

  // Exit with error code if any failed
  if (failed.length > 0) {
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(`\n❌ Batch crawl error: ${error.message}`);
  console.error(error.stack);
  process.exit(1);
});
