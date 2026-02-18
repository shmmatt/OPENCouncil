
import { spawn } from "child_process";

const MAX_RESTARTS = 10000;
const SCRIPT = "scripts/run-ingestion.ts";
const ARGS = ["worker"]; // Run in worker mode

async function runLoop() {
  let restarts = 0;

  while (restarts < MAX_RESTARTS) {
    console.log(`\n[Supervisor] Starting worker (Attempt ${restarts + 1})...`);
    
    const code = await runWorker();
    
    if (code === 0) {
      console.log("[Supervisor] Worker finished successfully (Queue empty).");
      break;
    }
    
    console.log(`[Supervisor] Worker crashed with code ${code}. Restarting in 5s...`);
    restarts++;
    await new Promise(r => setTimeout(r, 5000));
  }
}

function runWorker(): Promise<number> {
  return new Promise((resolve) => {
    // Run with increased memory limit
    const child = spawn("node", [
      "--max-old-space-size=4096", 
      "--import", "tsx/esm",
      SCRIPT, 
      ...ARGS
    ], {
      stdio: "inherit",
      cwd: process.cwd(),
      env: { ...process.env, BATCH_SIZE: "1" } // Pass batch size env var
    });

    child.on("close", (code) => {
      resolve(code === null ? 1 : code);
    });
  });
}

runLoop();
