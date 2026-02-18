
import "dotenv/config";
import { discoverS3Files } from "../server/services/ingestionDiscovery";
import { processPendingFiles } from "../server/services/ingestionWorker";

async function main() {
  const args = process.argv.slice(2);
  let mode = "all";
  let batchSize = 5;
  
  // Parse arguments
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--batch-size" && args[i + 1]) {
      batchSize = parseInt(args[i + 1]);
      i++;
    } else if (!args[i].startsWith("--")) {
      mode = args[i]; // 'discover', 'worker', 'all'
    }
  }

  console.log(`[RunIngestion] Mode: ${mode}, Batch size: ${batchSize}`);

  try {
    if (mode === "discover" || mode === "all") {
      console.log("=== PHASE 1: DISCOVERY ===");
      await discoverS3Files("conway");
      await discoverS3Files("ossipee");
    }

    if (mode === "worker" || mode === "all") {
      console.log("=== PHASE 2: PROCESSING QUEUE ===");
      let totalProcessed = 0;
      let totalErrors = 0;
      
      while (true) {
        const result = await processPendingFiles(batchSize);
        totalProcessed += result.processed;
        totalErrors += result.errors;

        if (result.processed === 0 && result.errors === 0) {
          console.log("Queue empty.");
          break;
        }

        console.log(`Batch complete. Total: ${totalProcessed} synced, ${totalErrors} failed.`);
        // Brief pause to be nice to APIs
        await new Promise(r => setTimeout(r, 1000));
      }
    }
    
    process.exit(0);
  } catch (err) {
    console.error("Fatal error:", err);
    process.exit(1);
  }
}

main();
