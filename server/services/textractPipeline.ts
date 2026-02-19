import {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
  HeadObjectCommand,
} from "@aws-sdk/client-s3";
import {
  TextractClient,
  StartDocumentTextDetectionCommand,
  GetDocumentTextDetectionCommand,
} from "@aws-sdk/client-textract";
import { gzipSync } from "node:zlib";
import crypto from "crypto";

const S3_BUCKET = process.env.S3_BUCKET || "opencouncil-municipal-docs";
const S3_REGION = process.env.AWS_REGION || "us-east-1";
const NATIVE_TEXT_THRESHOLD_CHARS = 1000;
const MAX_TEXTRACT_RETRIES = 2;

let s3Client: S3Client | null = null;
let textractClient: TextractClient | null = null;

export function getS3Client(): S3Client {
  if (!s3Client) {
    const config: any = { region: S3_REGION };
    if (process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY) {
      config.credentials = {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
      };
    }
    s3Client = new S3Client(config);
  }
  return s3Client;
}

export function getTextractClient(): TextractClient {
  if (!textractClient) {
    const config: any = { region: S3_REGION };
    if (process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY) {
      config.credentials = {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
      };
    }
    textractClient = new TextractClient(config);
  }
  return textractClient;
}

export function getDefaultBucket(): string {
  return S3_BUCKET;
}

export function getNativeTextThreshold(): number {
  return NATIVE_TEXT_THRESHOLD_CHARS;
}

export function getMaxRetries(): number {
  return MAX_TEXTRACT_RETRIES;
}

async function streamToBuffer(stream: any): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks);
}

export async function headBytesIsPdf(
  bucket: string,
  key: string
): Promise<boolean> {
  try {
    const s3 = getS3Client();
    const res = await s3.send(
      new GetObjectCommand({
        Bucket: bucket,
        Key: key,
        Range: "bytes=0-7",
      })
    );
    const buf = await streamToBuffer(res.Body);
    return buf.toString("utf8").startsWith("%PDF-");
  } catch (error) {
    console.error(`[TextractPipeline] headBytesIsPdf failed for ${key}:`, error);
    return false;
  }
}

export async function downloadFromS3(
  bucket: string,
  key: string
): Promise<Buffer> {
  const s3 = getS3Client();
  const res = await s3.send(
    new GetObjectCommand({ Bucket: bucket, Key: key })
  );
  return streamToBuffer(res.Body);
}

export async function getS3ObjectSize(
  bucket: string,
  key: string
): Promise<number> {
  const s3 = getS3Client();
  const res = await s3.send(
    new HeadObjectCommand({ Bucket: bucket, Key: key })
  );
  return res.ContentLength || 0;
}

export async function s3ObjectExists(
  bucket: string,
  key: string
): Promise<boolean> {
  try {
    const s3 = getS3Client();
    await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    return true;
  } catch {
    return false;
  }
}

export async function extractNativeText(pdfBuffer: Buffer): Promise<{
  text: string;
  charCount: number;
  pageCount: number;
}> {
  try {
    // Use direct path to avoid pdf-parse trying to load test files
    // @ts-ignore - pdf-parse types don't include this path but it works at runtime
    const mod = await import("pdf-parse/lib/pdf-parse.js");
    const pdfParse = (mod as any).default || mod;
    const result = await pdfParse(pdfBuffer);
    return {
      text: result.text || "",
      charCount: (result.text || "").length,
      pageCount: result.numpages || 0,
    };
  } catch (error) {
    console.error("[TextractPipeline] Native text extraction failed:", error);
    return { text: "", charCount: 0, pageCount: 0 };
  }
}

export async function startTextractJob(
  bucket: string,
  key: string
): Promise<string> {
  const textract = getTextractClient();
  const res = await textract.send(
    new StartDocumentTextDetectionCommand({
      DocumentLocation: {
        S3Object: { Bucket: bucket, Name: key },
      },
    })
  );
  if (!res.JobId) {
    throw new Error("Textract returned no JobId");
  }
  console.log(`[TextractPipeline] Started Textract job ${res.JobId} for s3://${bucket}/${key}`);
  return res.JobId;
}

export interface TextractPollResult {
  status: "IN_PROGRESS" | "SUCCEEDED" | "FAILED" | "PARTIAL_SUCCESS";
  text?: string;
  charCount?: number;
  errorMessage?: string;
}

export async function pollTextractJob(
  jobId: string
): Promise<TextractPollResult> {
  const textract = getTextractClient();
  let nextToken: string | undefined = undefined;
  const lines: string[] = [];
  let jobStatus: string | undefined;

  const firstRes = await textract.send(
    new GetDocumentTextDetectionCommand({ JobId: jobId })
  );

  jobStatus = firstRes.JobStatus;

  if (jobStatus === "IN_PROGRESS") {
    return { status: "IN_PROGRESS" };
  }

  if (jobStatus === "FAILED") {
    return {
      status: "FAILED",
      errorMessage: firstRes.StatusMessage || "Textract job failed",
    };
  }

  if (jobStatus === "PARTIAL_SUCCESS") {
    return {
      status: "PARTIAL_SUCCESS",
      errorMessage: firstRes.StatusMessage || "Textract job partially succeeded",
    };
  }

  for (const b of firstRes.Blocks ?? []) {
    if (b.BlockType === "LINE" && b.Text) lines.push(b.Text);
  }
  nextToken = firstRes.NextToken;

  while (nextToken) {
    const res = await textract.send(
      new GetDocumentTextDetectionCommand({
        JobId: jobId,
        NextToken: nextToken,
      })
    );
    for (const b of res.Blocks ?? []) {
      if (b.BlockType === "LINE" && b.Text) lines.push(b.Text);
    }
    nextToken = res.NextToken;
  }

  const text = lines.join("\n");
  return {
    status: "SUCCEEDED",
    text,
    charCount: text.length,
  };
}

export async function putGzText(
  bucket: string,
  key: string,
  text: string
): Promise<{ sha256: string }> {
  const s3 = getS3Client();
  const gz = gzipSync(Buffer.from(text, "utf8"));
  const sha256 = crypto.createHash("sha256").update(text).digest("hex");

  await s3.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: gz,
      ContentType: "text/plain",
      ContentEncoding: "gzip",
    })
  );

  console.log(`[TextractPipeline] Wrote text artifact to s3://${bucket}/${key} (${text.length} chars, sha256=${sha256.slice(0, 12)}...)`);
  return { sha256 };
}

export function derivedTextKey(documentId: string): string {
  return `derived/text/${documentId}.txt.gz`;
}

export function derivedTextractJsonKey(
  documentId: string,
  jobId: string
): string {
  return `derived/textract/${documentId}/${jobId}.json.gz`;
}

export function computeBackoffMs(attempts: number): number {
  const baseMs = 30_000;
  const maxMs = 120_000;
  return Math.min(baseMs * Math.pow(2, attempts), maxMs);
}

export interface DiscoveredS3Object {
  key: string;
  size: number;
  lastModified: string | null;
  etag: string | null;
  town: string | null;
}

export async function discoverS3Documents(prefix?: string): Promise<{
  total: number;
  pdfs: DiscoveredS3Object[];
}> {
  const { ListObjectsV2Command } = await import("@aws-sdk/client-s3");
  const s3 = getS3Client();
  const bucket = getDefaultBucket();
  const pdfs: DiscoveredS3Object[] = [];

  let continuationToken: string | undefined;
  do {
    const res = await s3.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: prefix || "",
        ContinuationToken: continuationToken,
      })
    );

    if (res.Contents) {
      for (const obj of res.Contents) {
        if (!obj.Key || !obj.Key.toLowerCase().endsWith(".pdf")) continue;
        const parts = obj.Key.split("/");
        const town = parts.length > 1 ? parts[0] : null;
        pdfs.push({
          key: obj.Key,
          size: obj.Size || 0,
          lastModified: obj.LastModified?.toISOString() || null,
          etag: obj.ETag || null,
          town,
        });
      }
    }
    continuationToken = res.NextContinuationToken;
  } while (continuationToken);

  return { total: pdfs.length, pdfs };
}
