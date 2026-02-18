/**
 * Batch Document Crawler
 * 
 * Crawls all Carroll County town websites for documents
 */

import * as fs from "fs/promises";
import { spawn } from "child_process";

interface Town {
  name: string;
  url: string;
}

const TOWNS_FILE = "./scripts/carroll-county-towns.json";
const DELAY_BETWEEN_TOWNS_MS = 10000; // 10 seconds to avoid rate limiting

async function crawlTownDocuments(town: Town): Promise<{ success: boolean; count?: number; error?: string }> {
  return new Promise((resolve) => {
    console.log(`\n${"=".repeat(80)}`);
    console.log(`📄 ${town.name.toUpperCase()} - DOCUMENTS`);
    console.log(`🌐 ${town.url}`);
    console.log(`${"=".repeat(80)}\n`);

    const child = spawn(
      "npm",
      ["run", "crawl:documents", "--", "--town", town.name, "--url", town.url],
      {
        cwd: process.cwd(),
        stdio: "inherit",
        shell: true,
      }
    );

    child.on("close", (code) => {
      if (code === 0) {
        console.log(`\n✅ ${town.name} - Documents crawled successfully\n`);
        resolve({ success: true });
      } else {
        console.log(`\n❌ ${town.name} - Document crawl failed (exit code ${code})\n`);
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
  console.log(`\n📚 CARROLL COUNTY DOCUMENT BATCH CRAWLER\n`);
  console.log(`Reading town list from: ${TOWNS_FILE}\n`);

  const townsData = await fs.readFile(TOWNS_FILE, "utf-8");
  const allTowns: Town[] = JSON.parse(townsData);
  
  // Filter to successfully crawled towns (those with comprehensive profiles)
  const successfulTowns: Town[] = [];
  
  for (const town of allTowns) {
    const profilePath = `town-profiles/${town.name.toLowerCase()}-comprehensive-2026-02-09.json`;
    try {
      await fs.access(profilePath);
      successfulTowns.push(town);
    } catch (e) {
      console.log(`⏭️  Skipping ${town.name} (no successful profile found)`);
    }
  }

  console.log(`Found ${successfulTowns.length} towns with successful profiles to crawl\n`);
  console.log(`Delay between towns: ${DELAY_BETWEEN_TOWNS_MS}ms\n`);

  const results: Array<{ town: string; success: boolean; count?: number; error?: string }> = [];
  const startTime = Date.now();

  for (let i = 0; i < successfulTowns.length; i++) {
    const town = successfulTowns[i];
    console.log(`\n[${i + 1}/${successfulTowns.length}] Starting: ${town.name}...`);

    const result = await crawlTownDocuments(town);
    results.push({ town: town.name, ...result });

    // Delay between towns (except after last one)
    if (i < successfulTowns.length - 1) {
      console.log(`\n⏳ Waiting ${DELAY_BETWEEN_TOWNS_MS / 1000}s before next town...\n`);
      await sleep(DELAY_BETWEEN_TOWNS_MS);
    }
  }

  const endTime = Date.now();
  const durationMinutes = Math.round((endTime - startTime) / 60000);

  // Summary
  console.log(`\n\n${"=".repeat(80)}`);
  console.log(`📊 BATCH DOCUMENT CRAWL COMPLETE`);
  console.log(`${"=".repeat(80)}\n`);

  const successful = results.filter((r) => r.success);
  const failed = results.filter((r) => !r.success);

  console.log(`Total towns: ${successfulTowns.length}`);
  console.log(`✅ Successful: ${successful.length}`);
  console.log(`❌ Failed: ${failed.length}`);
  console.log(`⏱️  Duration: ${durationMinutes} minutes\n`);

  if (successful.length > 0) {
    console.log(`Successful:`);
    successful.forEach((r) => console.log(`  ✅ ${r.town}`));
    console.log("");
  }

  if (failed.length > 0) {
    console.log(`Failed:`);
    failed.forEach((r) => console.log(`  ❌ ${r.town} - ${r.error}`));
    console.log("");
  }

  // Save summary
  const summary = {
    completedAt: new Date().toISOString(),
    durationMinutes,
    total: successfulTowns.length,
    successful: successful.length,
    failed: failed.length,
    results,
  };

  const summaryPath = `town-profiles/batch-documents-${new Date().toISOString().split("T")[0]}.json`;
  await fs.writeFile(summaryPath, JSON.stringify(summary, null, 2));
  console.log(`Summary saved: ${summaryPath}\n`);
  
  console.log(`\n🎯 NEXT STEPS:\n`);
  console.log(`1. Run discovery for all towns:`);
  console.log(`   npm run ingest:discover\n`);
  console.log(`2. Process the queue:`);
  console.log(`   npm run ingest:worker\n`);
}

main().catch((error) => {
  console.error(`\n❌ Batch document crawl error: ${error.message}`);
  console.error(error.stack);
  process.exit(1);
});
