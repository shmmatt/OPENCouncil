
import { spawn } from "child_process";
import { db, schema, eq } from "../server/storage/db";

const MAX_RETRIES_PER_FILE = 3;
const SCRIPT = "scripts/run-ingestion.ts";
const ARGS = ["worker"];

// Keep track of failures in memory (since supervisor stays alive)
// Map<FileID, FailureCount>
const failureTracker = new Map<string, number>();

async function getNextPendingFileId() {
  try {
    const job = await db.query.s3GeminiSync.findFirst({
      where: eq(schema.s3GeminiSync.status, "pending"),
      columns: { id: true, s3Key: true }
    });
    return job ? { id: job.id, key: job.s3Key } : null;
  } catch (e) {
    console.error("[Supervisor] DB Error:", e);
    return null;
  }
}

async function markAsFailed(id: string, reason: string) {
  try {
    await db.update(schema.s3GeminiSync)
      .set({ status: "failed", errorMessage: reason })
      .where(eq(schema.s3GeminiSync.id, id));
    console.log(`[Supervisor] ❌ Marked job ${id} as FAILED: ${reason}`);
  } catch (e) {
    console.error("[Supervisor] Failed to update DB:", e);
  }
}

async function runLoop() {
  console.log("[Supervisor] Starting Robust Loop...");

  while (true) {
    // 1. Identify what we are about to process
    const nextJob = await getNextPendingFileId();
    
    if (!nextJob) {
      console.log("[Supervisor] No pending jobs found. Exiting.");
      break;
    }

    // 2. Check Strike Count
    const strikes = failureTracker.get(nextJob.id) || 0;
    if (strikes >= MAX_RETRIES_PER_FILE) {
      console.log(`[Supervisor] 💀 Job ${nextJob.key} has failed ${strikes} times. Skipping.`);
      await markAsFailed(nextJob.id, `Supervisor: Crashed worker ${strikes} times (OOM/Timeout)`);
      continue; // Loop again to pick next file
    }

    // 3. Run Worker
    console.log(`[Supervisor] Launching worker for ${nextJob.key} (Attempt ${strikes + 1}/${MAX_RETRIES_PER_FILE})...`);
    const exitCode = await runWorker();

    // 4. Handle Result
    if (exitCode === 0) {
      // Success! Clear tracking for this ID (if any)
      failureTracker.delete(nextJob.id);
      
      // Check if queue is actually empty or just that batch finished
      const check = await getNextPendingFileId();
      if (!check) break;
    } else {
      // Crash!
      console.error(`[Supervisor] Worker crashed with code ${exitCode}.`);
      failureTracker.set(nextJob.id, strikes + 1);
      // Brief cooldown
      await new Promise(r => setTimeout(r, 2000));
    }
  }
}

function runWorker(): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn("node", [
      "--max-old-space-size=4096", 
      "--import", "tsx/esm",
      SCRIPT, 
      ...ARGS
    ], {
      stdio: "inherit",
      cwd: process.cwd(),
      env: { ...process.env, BATCH_SIZE: "1" }
    });

    child.on("close", (code) => {
      resolve(code === null ? 1 : code);
    });
  });
}

runLoop();
