#!/usr/bin/env tsx
import { db } from "../../server/storage/db";
import { sql, eq, and } from "drizzle-orm";
import * as schema from "../../shared/schema";
import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import { Readable } from "stream";
import * as fs from "fs/promises";
import * as path from "path";
import { processFile } from "../../server/services/fileProcessing";
import { performOcrOnPdf } from "../../server/workers/ocrWorkerUtils";

const S3_BUCKET = process.env.S3_BUCKET || "opencouncil-municipal-docs";
const s3 = new S3Client({ region: process.env.AWS_REGION || "us-east-1" });

const TOWN = "Ossipee";
const CONCURRENCY = 3;
const BATCH_LIMIT = parseInt(process.argv[2] || "0", 10) || 999;

const BOARD_MAP: Record<string, string> = {
  Planning_Board: "Planning Board",
  Zoning_Board: "Zoning Board of Adjustment",
};

function extractDateFromFilename(filename: string): Date | null {
  const m1 = filename.match(/(\d{4})[-_](\d{2})[-_](\d{2})/);
  if (m1) return new Date(`${m1[1]}-${m1[2]}-${m1[3]}`);

  const m2 = filename.match(/(\d{1,2})[-_](\d{1,2})[-_](\d{2,4})/);
  if (m2) {
    const y = m2[3].length === 4 ? m2[3] : parseInt(m2[3], 10) > 50 ? `19${m2[3]}` : `20${m2[3]}`;
    return new Date(`${y}-${m2[1].padStart(2, "0")}-${m2[2].padStart(2, "0")}`);
  }
  return null;
}

function extractYearFromFilename(filename: string): string | null {
  const d = extractDateFromFilename(filename);
  if (d && !isNaN(d.getTime())) return String(d.getFullYear());
  const m = filename.match(/\b(20\d{2}|19\d{2})\b/);
  return m ? m[1] : null;
}

async function streamToBuffer(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  return new Promise((resolve, reject) => {
    stream.on("data", (c: Buffer) => chunks.push(c));
    stream.on("end", () => resolve(Buffer.concat(chunks)));
    stream.on("error", reject);
  });
}

interface CrawledDoc {
  s3_key: string;
  board: string;
  filename: string;
}

async function linkExistingBlob(fileBlob: any, doc: CrawledDoc): Promise<"ok" | "error"> {
  try {
    const normalizedBoard = BOARD_MAP[doc.board] || doc.board.replace(/_/g, " ");
    const meetingDate = extractDateFromFilename(doc.filename);
    const year = extractYearFromFilename(doc.filename);
    const canonicalTitle = doc.filename;

    let logicalDoc = await db.query.logicalDocuments.findFirst({
      where: and(
        eq(schema.logicalDocuments.canonicalTitle, canonicalTitle),
        eq(schema.logicalDocuments.town, TOWN)
      ),
    });

    if (!logicalDoc) {
      [logicalDoc] = await db
        .insert(schema.logicalDocuments)
        .values({
          canonicalTitle,
          town: TOWN,
          category: "meeting_minutes",
          board: normalizedBoard,
        })
        .returning();
    }

    const [version] = await db
      .insert(schema.documentVersions)
      .values({
        documentId: logicalDoc.id,
        fileBlobId: fileBlob.id,
        year,
        isCurrent: true,
        isMinutes: true,
        meetingDate,
      })
      .returning();

    await db
      .update(schema.logicalDocuments)
      .set({ currentVersionId: version.id })
      .where(eq(schema.logicalDocuments.id, logicalDoc.id));

    return "ok";
  } catch (e: any) {
    console.error(`  Link error: ${doc.filename}: ${e.message?.substring(0, 100)}`);
    return "error";
  }
}

async function ingestOne(doc: CrawledDoc): Promise<"ok" | "skipped" | "error"> {
  const s3Hash = `s3:${doc.s3_key}`;
  const existingBlob = await db.query.fileBlobs.findFirst({
    where: eq(schema.fileBlobs.rawHash, s3Hash),
  });

  if (existingBlob) {
    const existingVersion = await db.execute(sql`
      SELECT dv.id FROM document_versions dv WHERE dv.file_blob_id = ${existingBlob.id} LIMIT 1
    `);
    if (existingVersion.rows.length > 0) {
      return "skipped";
    }
    return await linkExistingBlob(existingBlob, doc);
  }

  let tempPath = "";
  let tempOcrPath = "";
  try {
    const s3Resp = await s3.send(
      new GetObjectCommand({ Bucket: S3_BUCKET, Key: doc.s3_key })
    );
    const buffer = await streamToBuffer(s3Resp.Body as Readable);
    const fileSize = buffer.length;

    tempPath = path.join("/tmp", `oc_ingest_${Date.now()}_${Math.random().toString(36).slice(2)}.pdf`);
    await fs.writeFile(tempPath, buffer);

    const analysis = await processFile(tempPath, doc.filename);

    let ocrText: string | null = null;
    let ocrPerformed = false;

    if (analysis.needsOcr) {
      try {
        ocrText = await performOcrOnPdf(tempPath);
        ocrPerformed = true;
      } catch (e: any) {
        console.error(`  OCR failed for ${doc.filename}: ${e.message?.substring(0, 80)}`);
      }
    }

    const previewText = analysis.previewText || null;

    const normalizedBoard = BOARD_MAP[doc.board] || doc.board.replace(/_/g, " ");
    const meetingDate = extractDateFromFilename(doc.filename);
    const year = extractYearFromFilename(doc.filename);
    const canonicalTitle = doc.filename;

    let fileBlob = existingBlob;
    if (!fileBlob) {
      [fileBlob] = await db
        .insert(schema.fileBlobs)
        .values({
          rawHash: s3Hash,
          sizeBytes: fileSize,
          mimeType: "application/pdf",
          originalFilename: doc.filename,
          storagePath: `s3://${S3_BUCKET}/${doc.s3_key}`,
          needsOcr: analysis.needsOcr,
          ocrStatus: ocrPerformed ? "completed" : analysis.needsOcr ? "pending" : "none",
          ocrText: ocrText,
          previewText: ocrText || previewText || null,
          extractedTextCharCount: ocrText
            ? ocrText.length
            : analysis.extractedTextCharCount,
        })
        .returning();
    } else {
      await db
        .update(schema.fileBlobs)
        .set({
          ocrText: ocrText || existingBlob.ocrText,
          previewText: ocrText || previewText || existingBlob.previewText,
          ocrStatus: ocrPerformed ? "completed" : existingBlob.ocrStatus,
          extractedTextCharCount: ocrText
            ? ocrText.length
            : existingBlob.extractedTextCharCount,
        })
        .where(eq(schema.fileBlobs.id, existingBlob.id));
    }

    let logicalDoc = await db.query.logicalDocuments.findFirst({
      where: and(
        eq(schema.logicalDocuments.canonicalTitle, canonicalTitle),
        eq(schema.logicalDocuments.town, TOWN)
      ),
    });

    if (!logicalDoc) {
      [logicalDoc] = await db
        .insert(schema.logicalDocuments)
        .values({
          canonicalTitle,
          town: TOWN,
          category: "meeting_minutes",
          board: normalizedBoard,
        })
        .returning();
    }

    const existingVersion = await db.query.documentVersions.findFirst({
      where: and(
        eq(schema.documentVersions.documentId, logicalDoc.id),
        eq(schema.documentVersions.fileBlobId, fileBlob.id)
      ),
    });

    if (!existingVersion) {
      const [version] = await db
        .insert(schema.documentVersions)
        .values({
          documentId: logicalDoc.id,
          fileBlobId: fileBlob.id,
          year,
          isCurrent: true,
          isMinutes: true,
          meetingDate,
        })
        .returning();

      await db
        .update(schema.logicalDocuments)
        .set({ currentVersionId: version.id })
        .where(eq(schema.logicalDocuments.id, logicalDoc.id));
    }

    return "ok";
  } catch (e: any) {
    console.error(`  Error: ${doc.filename}: ${e.message?.substring(0, 100)}`);
    return "error";
  } finally {
    if (tempPath) await fs.unlink(tempPath).catch(() => {});
    if (tempOcrPath) await fs.unlink(tempOcrPath).catch(() => {});
  }
}

async function main() {
  console.log("=".repeat(60));
  console.log(`Ingesting ${TOWN} PB/ZBA minutes (skip Gemini, extract text only)`);
  console.log(`Batch limit: ${BATCH_LIMIT}, Concurrency: ${CONCURRENCY}`);
  console.log("=".repeat(60));

  const rows = await db.execute(sql`
    SELECT cd.s3_key, cd.board, cd.filename
    FROM crawler_documents cd
    WHERE cd.town_id = (SELECT id FROM crawler_towns WHERE slug = 'ossipee')
      AND cd.category = 'minutes'
      AND (cd.board LIKE '%Planning%' OR cd.board LIKE '%Zoning%')
      AND cd.status = 'uploaded'
      AND cd.s3_key IS NOT NULL
    ORDER BY cd.board, cd.s3_key
    LIMIT ${BATCH_LIMIT}
  `);

  const docs = rows.rows as CrawledDoc[];
  console.log(`\nFound ${docs.length} documents to process\n`);

  let ok = 0,
    skipped = 0,
    errors = 0;
  const startTime = Date.now();

  for (let i = 0; i < docs.length; i += CONCURRENCY) {
    const batch = docs.slice(i, i + CONCURRENCY);
    const results = await Promise.all(batch.map((d) => ingestOne(d)));

    for (const r of results) {
      if (r === "ok") ok++;
      else if (r === "skipped") skipped++;
      else errors++;
    }

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
    const processed = i + batch.length;
    const rate = (processed / ((Date.now() - startTime) / 1000)).toFixed(1);
    process.stdout.write(
      `\r[${elapsed}s] ${processed}/${docs.length} (${ok} ok, ${skipped} skip, ${errors} err) @ ${rate}/s`
    );
  }

  console.log("\n\n" + "=".repeat(60));
  console.log(`DONE: ${ok} ingested, ${skipped} skipped, ${errors} errors`);
  console.log("=".repeat(60));

  const count = await db.execute(sql`
    SELECT COUNT(DISTINCT dv.id) as cnt
    FROM logical_documents ld
    JOIN document_versions dv ON ld.id = dv.document_id
    JOIN file_blobs fb ON dv.file_blob_id = fb.id
    WHERE lower(ld.town) = 'ossipee'
      AND (lower(ld.board) LIKE '%planning%' OR lower(ld.board) LIKE '%zoning%')
      AND ld.category = 'meeting_minutes'
      AND COALESCE(fb.ocr_text, fb.preview_text) IS NOT NULL
      AND length(COALESCE(fb.ocr_text, fb.preview_text)) > 200
  `);
  console.log(`\nAnalyzable PB/ZBA docs for ${TOWN}: ${(count.rows[0] as any).cnt}`);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("Fatal:", e);
    process.exit(1);
  });
