/**
 * Retry Failed Towns
 * 
 * Re-runs crawler on towns that failed in the batch crawl
 */

import * as fs from "fs/promises";
import { spawn } from "child_process";

interface Town {
  name: string;
  url: string;
}

const TOWNS_FILE = "./scripts/failed-towns.json";
const DELAY_BETWEEN_TOWNS_MS = 5000;

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
  console.log(`\n🔄 RETRY FAILED TOWNS\n`);
  console.log(`Reading failed towns from: ${TOWNS_FILE}\n`);

  const townsData = await fs.readFile(TOWNS_FILE, "utf-8");
  const towns: Town[] = JSON.parse(townsData);

  console.log(`Found ${towns.length} failed towns to retry\n`);

  const results: Array<{ town: string; success: boolean; error?: string }> = [];
  const startTime = Date.now();

  for (let i = 0; i < towns.length; i++) {
    const town = towns[i];
    console.log(`\n[${i + 1}/${towns.length}] Retrying: ${town.name}...`);

    const result = await crawlTown(town);
    results.push({ town: town.name, ...result });

    if (i < towns.length - 1) {
      console.log(`\n⏳ Waiting ${DELAY_BETWEEN_TOWNS_MS / 1000}s before next town...\n`);
      await sleep(DELAY_BETWEEN_TOWNS_MS);
    }
  }

  const endTime = Date.now();
  const durationMinutes = Math.round((endTime - startTime) / 60000);

  // Summary
  console.log(`\n\n${"=".repeat(80)}`);
  console.log(`📊 RETRY COMPLETE`);
  console.log(`${"=".repeat(80)}\n`);

  const successful = results.filter((r) => r.success);
  const failed = results.filter((r) => !r.success);

  console.log(`Total retried: ${towns.length}`);
  console.log(`✅ Now successful: ${successful.length}`);
  console.log(`❌ Still failed: ${failed.length}`);
  console.log(`⏱️  Duration: ${durationMinutes} minutes\n`);

  if (successful.length > 0) {
    console.log(`Now working:`);
    successful.forEach((r) => console.log(`  ✅ ${r.town}`));
    console.log("");
  }

  if (failed.length > 0) {
    console.log(`Still failing:`);
    failed.forEach((r) => console.log(`  ❌ ${r.town} - ${r.error}`));
    console.log("");
  }

  const summary = {
    completedAt: new Date().toISOString(),
    durationMinutes,
    total: towns.length,
    successful: successful.length,
    failed: failed.length,
    results,
  };

  const summaryPath = `town-profiles/retry-${new Date().toISOString().split("T")[0]}.json`;
  await fs.writeFile(summaryPath, JSON.stringify(summary, null, 2));
  console.log(`Summary saved: ${summaryPath}\n`);
}

main().catch((error) => {
  console.error(`\n❌ Retry error: ${error.message}`);
  console.error(error.stack);
  process.exit(1);
});
