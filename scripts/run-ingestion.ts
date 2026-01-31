
import { discoverS3Files } from "../server/services/ingestionDiscovery";
import { processPendingFiles } from "../server/services/ingestionWorker";

async function main() {
  const args = process.argv.slice(2);
  const mode = args[0] || "all"; // 'discover', 'worker', 'all'

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
        const result = await processPendingFiles(5); // Small batch
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
