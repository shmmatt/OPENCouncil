import * as ocrJobsStore from "../storage/ocrJobs";
import * as fileBlobsStore from "../storage/fileBlobs";
import {
  headBytesIsPdf,
  downloadFromS3,
  extractNativeText,
  startTextractJob,
  pollTextractJob,
  putGzText,
  derivedTextKey,
  computeBackoffMs,
  getNativeTextThreshold,
  getMaxRetries,
  getDefaultBucket,
  s3ObjectExists,
} from "../services/textractPipeline";
import crypto from "crypto";

const WORKER_ID = `textract-worker-${process.pid}`;
const PRECHECK_INTERVAL_MS = 10_000;
const POLL_INTERVAL_MS = 15_000;

let precheckRunning = false;
let pollRunning = false;

export async function runPrecheckLoop(): Promise<void> {
  if (precheckRunning) return;
  precheckRunning = true;

  console.log(`[TextractWorker:Precheck] Starting precheck loop (worker=${WORKER_ID})`);

  while (precheckRunning) {
    try {
      const job = await ocrJobsStore.claimOcrJob(["queued"], WORKER_ID);
      if (!job) {
        await sleep(PRECHECK_INTERVAL_MS);
        continue;
      }

      console.log(`[TextractWorker:Precheck] Claimed job #${job.id} (doc=${job.documentId}, s3=${job.s3Key})`);

      try {
        await processPrecheck(job);
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        console.error(`[TextractWorker:Precheck] Job #${job.id} failed:`, msg);
        await ocrJobsStore.updateOcrJob(job.id, {
          status: "failed",
          lastError: msg,
          lockedBy: null,
          lockedAt: null,
          attempts: job.attempts + 1,
        });
        if (job.fileBlobId) {
          await fileBlobsStore.updateOcrStatus(job.fileBlobId, "failed", {
            ocrFailureReason: `precheck_error: ${msg}`,
          });
        }
      }
    } catch (error) {
      console.error("[TextractWorker:Precheck] Loop error:", error);
      await sleep(PRECHECK_INTERVAL_MS);
    }
  }
}

async function processPrecheck(job: any): Promise<void> {
  const bucket = job.s3Bucket || getDefaultBucket();
  const key = job.s3Key;

  if (!key) {
    await ocrJobsStore.updateOcrJob(job.id, {
      status: "failed",
      lastError: "No S3 key provided",
      lockedBy: null,
      lockedAt: null,
    });
    if (job.fileBlobId) {
      await fileBlobsStore.updateOcrStatus(job.fileBlobId, "failed", {
        ocrFailureReason: "no_s3_key: No S3 key provided",
      });
    }
    return;
  }

  const isPdf = await headBytesIsPdf(bucket, key);

  if (!isPdf) {
    console.log(`[TextractWorker:Precheck] Job #${job.id} is not a PDF, marking failed`);
    await ocrJobsStore.updateOcrJob(job.id, {
      status: "failed",
      lastError: "not_pdf: File does not start with %PDF- magic bytes",
      isPdf: false,
      lockedBy: null,
      lockedAt: null,
    });
    if (job.fileBlobId) {
      await fileBlobsStore.updateOcrStatus(job.fileBlobId, "failed", {
        ocrFailureReason: "not_pdf: File does not start with %PDF- magic bytes",
      });
    }
    return;
  }

  const pdfBuffer = await downloadFromS3(bucket, key);
  const nativeResult = await extractNativeText(pdfBuffer);

  console.log(`[TextractWorker:Precheck] Job #${job.id}: ${nativeResult.pageCount} pages, ${nativeResult.charCount} native chars`);

  if (nativeResult.charCount >= getNativeTextThreshold()) {
    const docId = job.documentId;
    const derivedKey = derivedTextKey(docId);
    const { sha256 } = await putGzText(bucket, derivedKey, nativeResult.text);

    if (job.fileBlobId) {
      await fileBlobsStore.updateFileBlob(job.fileBlobId, {
        extractedTextCharCount: nativeResult.charCount,
        ocrProvider: "none",
        ocrStatus: "completed",
        ocrCompletedAt: new Date(),
        needsOcr: false,
        ocrText: nativeResult.text,
        ocrTextCharCount: nativeResult.charCount,
        previewText: nativeResult.text.slice(0, 15000),
        previewHash: crypto.createHash("sha256").update(nativeResult.text).digest("hex"),
        extractedTextS3Key: derivedKey,
        extractedTextSha256: sha256,
      } as any);
    }

    await ocrJobsStore.updateOcrJob(job.id, {
      status: "skipped_native",
      nativeTextChars: nativeResult.charCount,
      pageCount: nativeResult.pageCount,
      isPdf: true,
      lockedBy: null,
      lockedAt: null,
    });

    console.log(`[TextractWorker:Precheck] Job #${job.id} has sufficient native text (${nativeResult.charCount} chars), skipping OCR`);
    return;
  }

  try {
    const textractJobId = await startTextractJob(bucket, key);

    await ocrJobsStore.updateOcrJob(job.id, {
      status: "textract_running",
      textractJobId,
      textractStartedAt: new Date(),
      nativeTextChars: nativeResult.charCount,
      pageCount: nativeResult.pageCount,
      isPdf: true,
      lockedBy: null,
      lockedAt: null,
      availableAt: new Date(Date.now() + 30_000),
    });

    if (job.fileBlobId) {
      await fileBlobsStore.updateFileBlob(job.fileBlobId, {
        ocrStatus: "processing",
        ocrStartedAt: new Date(),
        ocrProvider: "textract",
        needsOcr: true,
      } as any);
    }

    console.log(`[TextractWorker:Precheck] Job #${job.id} enqueued for Textract (jobId=${textractJobId})`);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error(`[TextractWorker:Precheck] Textract start failed for job #${job.id}:`, msg);

    await ocrJobsStore.updateOcrJob(job.id, {
      status: "failed",
      lastError: `textract_start_failed: ${msg}`,
      isPdf: true,
      nativeTextChars: nativeResult.charCount,
      pageCount: nativeResult.pageCount,
      lockedBy: null,
      lockedAt: null,
      attempts: job.attempts + 1,
    });
    if (job.fileBlobId) {
      await fileBlobsStore.updateOcrStatus(job.fileBlobId, "failed", {
        ocrFailureReason: `textract_start_failed: ${msg}`,
      });
    }
  }
}

export async function runPollLoop(): Promise<void> {
  if (pollRunning) return;
  pollRunning = true;

  console.log(`[TextractWorker:Poll] Starting Textract poll loop (worker=${WORKER_ID})`);

  while (pollRunning) {
    try {
      const job = await ocrJobsStore.claimOcrJob(["textract_running"], WORKER_ID);
      if (!job) {
        await sleep(POLL_INTERVAL_MS);
        continue;
      }

      if (!job.textractJobId) {
        await ocrJobsStore.updateOcrJob(job.id, {
          status: "failed",
          lastError: "No Textract job ID found",
          lockedBy: null,
          lockedAt: null,
        });
        if (job.fileBlobId) {
          await fileBlobsStore.updateOcrStatus(job.fileBlobId, "failed", {
            ocrFailureReason: "no_textract_job_id: No Textract job ID found",
          });
        }
        continue;
      }

      console.log(`[TextractWorker:Poll] Polling Textract job ${job.textractJobId} for job #${job.id}`);

      try {
        await processPoll(job);
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        console.error(`[TextractWorker:Poll] Job #${job.id} poll error:`, msg);

        const newAttempts = job.attempts + 1;
        if (newAttempts >= getMaxRetries()) {
          await ocrJobsStore.updateOcrJob(job.id, {
            status: "failed",
            lastError: msg,
            attempts: newAttempts,
            lockedBy: null,
            lockedAt: null,
          });
          if (job.fileBlobId) {
            await fileBlobsStore.updateOcrStatus(job.fileBlobId, "failed", {
              ocrFailureReason: `poll_max_retries: ${msg}`,
            });
          }
        } else {
          await ocrJobsStore.updateOcrJob(job.id, {
            lastError: msg,
            attempts: newAttempts,
            lockedBy: null,
            lockedAt: null,
            availableAt: new Date(Date.now() + computeBackoffMs(newAttempts)),
          });
        }
      }
    } catch (error) {
      console.error("[TextractWorker:Poll] Loop error:", error);
      await sleep(POLL_INTERVAL_MS);
    }
  }
}

async function processPoll(job: any): Promise<void> {
  const result = await pollTextractJob(job.textractJobId);

  if (result.status === "IN_PROGRESS") {
    const backoffMs = computeBackoffMs(0);
    await ocrJobsStore.updateOcrJob(job.id, {
      lockedBy: null,
      lockedAt: null,
      availableAt: new Date(Date.now() + backoffMs),
    });
    console.log(`[TextractWorker:Poll] Job #${job.id} still in progress, next poll in ${backoffMs / 1000}s`);
    return;
  }

  if (result.status === "FAILED" || result.status === "PARTIAL_SUCCESS") {
    const newAttempts = job.attempts + 1;
    const isRetryable = newAttempts < getMaxRetries();

    if (isRetryable && result.status !== "PARTIAL_SUCCESS") {
      const bucket = job.s3Bucket || getDefaultBucket();
      const key = job.s3Key;
      try {
        const newJobId = await startTextractJob(bucket, key);
        await ocrJobsStore.updateOcrJob(job.id, {
          textractJobId: newJobId,
          textractStartedAt: new Date(),
          attempts: newAttempts,
          lastError: result.errorMessage || null,
          lockedBy: null,
          lockedAt: null,
          availableAt: new Date(Date.now() + 30_000),
        });
        console.log(`[TextractWorker:Poll] Retrying job #${job.id} with new Textract job ${newJobId}`);
        return;
      } catch (retryError) {
        const retryMsg = retryError instanceof Error ? retryError.message : String(retryError);
        console.error(`[TextractWorker:Poll] Retry failed for job #${job.id}:`, retryMsg);
      }
    }

    await ocrJobsStore.updateOcrJob(job.id, {
      status: "textract_failed",
      lastError: result.errorMessage || "Textract job failed",
      attempts: newAttempts,
      textractCompletedAt: new Date(),
      lockedBy: null,
      lockedAt: null,
    });

    if (job.fileBlobId) {
      await fileBlobsStore.updateOcrStatus(job.fileBlobId, "failed", {
        ocrFailureReason: `textract_failed: ${result.errorMessage || "Unknown"}`,
      });
    }

    console.log(`[TextractWorker:Poll] Job #${job.id} Textract failed: ${result.errorMessage}`);
    return;
  }

  if (result.status === "SUCCEEDED" && result.text !== undefined) {
    const bucket = job.s3Bucket || getDefaultBucket();
    const docId = job.documentId;
    const derivedKey = derivedTextKey(docId);

    const { sha256 } = await putGzText(bucket, derivedKey, result.text);

    await ocrJobsStore.updateOcrJob(job.id, {
      status: "materialized",
      textractCompletedAt: new Date(),
      lockedBy: null,
      lockedAt: null,
    });

    if (job.fileBlobId) {
      const previewText = result.text.slice(0, 15000);
      const previewHash = crypto.createHash("sha256").update(result.text).digest("hex");

      await fileBlobsStore.updateOcrStatus(job.fileBlobId, "completed", {
        ocrText: result.text,
        ocrTextCharCount: result.charCount || result.text.length,
      });

      await fileBlobsStore.updateFileBlob(job.fileBlobId, {
        previewText,
        previewHash,
        ocrProvider: "textract",
        needsOcr: false,
        extractedTextS3Key: derivedKey,
        extractedTextSha256: sha256,
      } as any);
    }

    console.log(`[TextractWorker:Poll] Job #${job.id} materialized (${result.charCount} chars, artifact at ${derivedKey})`);
  }
}

export function stopWorkers(): void {
  precheckRunning = false;
  pollRunning = false;
}

export function startTextractWorkers(): void {
  if (!process.env.AWS_ACCESS_KEY_ID || !process.env.AWS_SECRET_ACCESS_KEY) {
    console.log("[TextractWorker] AWS credentials not configured, Textract workers disabled");
    return;
  }

  console.log("[TextractWorker] Starting Textract OCR workers...");
  runPrecheckLoop().catch((err) =>
    console.error("[TextractWorker] Precheck loop crashed:", err)
  );
  runPollLoop().catch((err) =>
    console.error("[TextractWorker] Poll loop crashed:", err)
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
