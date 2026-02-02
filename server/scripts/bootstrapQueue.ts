import { db, schema, eq } from "../storage/db";
import { ingestionQueue } from "../queue/ingestionQueue";
import { discoverS3Files } from "../services/ingestionDiscovery";

async function main() {
  console.log("=== Bootstrapping Ingestion Queue ===");

  // 1. Discover new files from S3
  console.log("Running discovery...");
  await discoverS3Files("conway");
  await discoverS3Files("ossipee");

  // 2. Find pending jobs
  const pendingJobs = await db.query.s3GeminiSync.findMany({
    where: eq(schema.s3GeminiSync.status, "pending"),
  });

  console.log(`Found ${pendingJobs.length} pending jobs.`);

  // 3. Add to Queue
  for (const job of pendingJobs) {
    await ingestionQueue.add("ingest-s3", { syncId: job.id }, {
      jobId: `sync-${job.id}`, // Deduplication ID
    });
    console.log(`Added job for ${job.s3Key}`);
  }

  console.log("Done.");
  process.exit(0);
}

main();
