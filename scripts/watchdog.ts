
import { db, schema, eq, sql } from "../server/storage/db";
import { spawn, execSync } from "child_process";
import * as fs from "fs";

const STATE_FILE = "ingestion-state.json";

async function checkAndHeal() {
  // 1. Get DB State
  const synced = await db.select({ count: sql`count(*)` }).from(schema.s3GeminiSync).where(eq(schema.s3GeminiSync.status, "synced"));
  const pending = await db.select({ count: sql`count(*)` }).from(schema.s3GeminiSync).where(eq(schema.s3GeminiSync.status, "pending"));
  
  const currentSynced = parseInt(synced[0].count.toString());
  const currentPending = parseInt(pending[0].count.toString());

  // 2. Load Previous State
  let lastState = { synced: -1, timestamp: 0 };
  if (fs.existsSync(STATE_FILE)) {
    lastState = JSON.parse(fs.readFileSync(STATE_FILE, "utf-8"));
  }

  // 3. Save Current State
  fs.writeFileSync(STATE_FILE, JSON.stringify({ synced: currentSynced, timestamp: Date.now() }));

  console.log(`[Watchdog] Synced: ${currentSynced} (+${currentSynced - lastState.synced}), Pending: ${currentPending}`);

  // 4. Check Process
  const isRunning = isSupervisorRunning();
  
  if (!isRunning) {
    console.log("[Watchdog] ⚠️ Supervisor NOT running. Restarting...");
    startSupervisor();
    return "Restarted (Missing)";
  }

  // 5. Check Stall (If running but no progress in 10 mins)
  // Only check stall if we have pending items
  if (currentPending > 0 && currentSynced === lastState.synced) {
     // Give it a grace period? For now, aggressive restart.
     console.log("[Watchdog] ⚠️ Supervisor STALLED (No progress). Restarting...");
     killSupervisor();
     startSupervisor();
     return "Restarted (Stalled)";
  }

  return "Healthy";
}

function isSupervisorRunning() {
  try {
    const output = execSync("ps aux | grep 'scripts/supervisor' | grep -v grep").toString();
    return output.length > 0;
  } catch {
    return false;
  }
}

function killSupervisor() {
  try {
    execSync("pkill -f 'scripts/supervisor'");
  } catch {}
}

function startSupervisor() {
  const child = spawn("npx", ["tsx", "scripts/supervisor-v2.ts"], {
    detached: true,
    stdio: "ignore",
    cwd: process.cwd(),
    env: { ...process.env, ...loadEnv() }
  });
  child.unref();
}

function loadEnv() {
    // Basic .env parser since we are spawning detached
    try {
        const content = fs.readFileSync("OPENCouncil/.env", "utf-8");
        const env: any = {};
        content.split("\n").forEach(line => {
            const [k, v] = line.split("=");
            if (k && v) env[k.trim()] = v.trim();
        });
        return env;
    } catch { return {}; }
}

checkAndHeal();
