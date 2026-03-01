import * as fs from "fs";
import * as path from "path";

interface TownEntry {
  name: string;
  url: string;
}

interface CountyConfig {
  county: string;
  file: string;
}

const COUNTIES: CountyConfig[] = [
  { county: "Coos", file: "coos-county-towns.json" },
  { county: "Grafton", file: "grafton-county-towns.json" },
  { county: "Belknap", file: "belknap-county-towns.json" },
];

const BASE_URL = process.env.API_BASE_URL || "http://localhost:5000";
const API_KEY = process.env.CRAWLER_BOT_API_KEY || "";

async function seedCounty(county: string, towns: TownEntry[]): Promise<{ success: number; skipped: number; failed: number }> {
  let success = 0;
  let skipped = 0;
  let failed = 0;

  for (const town of towns) {
    try {
      const res = await fetch(`${BASE_URL}/api/crawler-intel/towns`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(API_KEY ? { Authorization: `Bearer ${API_KEY}` } : {}),
        },
        body: JSON.stringify({
          name: town.name,
          url: town.url,
          county,
          state: "NH",
        }),
      });

      if (res.status === 201) {
        console.log(`  ✓ ${town.name} — registered`);
        success++;
      } else if (res.status === 409) {
        console.log(`  - ${town.name} — already exists, skipped`);
        skipped++;
      } else {
        const body = await res.json().catch(() => ({}));
        console.log(`  ✗ ${town.name} — HTTP ${res.status}: ${(body as any)?.error?.message || "unknown error"}`);
        failed++;
      }
    } catch (err: any) {
      console.log(`  ✗ ${town.name} — ${err.message}`);
      failed++;
    }
  }

  return { success, skipped, failed };
}

async function main() {
  console.log("=== Seeding New County Towns ===\n");

  const scriptsDir = path.dirname(new URL(import.meta.url).pathname);
  let totalSuccess = 0;
  let totalSkipped = 0;
  let totalFailed = 0;

  for (const { county, file } of COUNTIES) {
    const filePath = path.join(scriptsDir, file);
    if (!fs.existsSync(filePath)) {
      console.log(`[${county}] File not found: ${filePath}`);
      continue;
    }

    const towns: TownEntry[] = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    console.log(`[${county} County] — ${towns.length} towns`);

    const result = await seedCounty(county, towns);
    totalSuccess += result.success;
    totalSkipped += result.skipped;
    totalFailed += result.failed;

    console.log(`  Summary: ${result.success} registered, ${result.skipped} skipped, ${result.failed} failed\n`);
  }

  console.log("=== Final Summary ===");
  console.log(`  Registered: ${totalSuccess}`);
  console.log(`  Skipped:    ${totalSkipped}`);
  console.log(`  Failed:     ${totalFailed}`);
  console.log(`  Total:      ${totalSuccess + totalSkipped + totalFailed}`);

  if (totalFailed > 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
