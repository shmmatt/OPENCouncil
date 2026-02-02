import { Queue } from "bullmq";
import { connection } from "../config/redis";

export const ingestionQueue = new Queue("ingestion-queue", {
  connection,
  defaultJobOptions: {
    attempts: 3, // Retry 3 times max
    backoff: {
      type: "exponential",
      delay: 5000, // Wait 5s, then 10s, then 20s
    },
    removeOnComplete: true,
    removeOnFail: false, // Keep failed jobs for inspection
  },
});
