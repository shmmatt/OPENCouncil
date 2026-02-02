import { ingestionWorker } from "./workers/ingestionProcessor";

console.log("Starting Background Worker...");

ingestionWorker.on("completed", (job) => {
  console.log(`Job ${job.id} completed!`);
});

ingestionWorker.on("failed", (job, err) => {
  console.error(`Job ${job?.id} failed with ${err.message}`);
});

// Keep process alive
process.on("SIGTERM", async () => {
  console.log("Worker shutting down...");
  await ingestionWorker.close();
  process.exit(0);
});
