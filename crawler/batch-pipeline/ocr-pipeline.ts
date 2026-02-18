#!/usr/bin/env npx tsx
/**
 * OCR Pipeline: Extract text from PDFs and embed into pgvector
 * 
 * 1. Downloads PDF from S3
 * 2. Runs Tesseract OCR
 * 3. Updates file_blobs with extracted text
 * 4. Chunks and embeds into document_chunks
 * 
 * Usage:
 *   npx tsx batch-pipeline/ocr-pipeline.ts [--limit 100] [--town Ossipee]
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execSync } from 'child_process';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { sql, closeDb } from './utils/db';
import { chunkText } from './utils/chunker';

// Config
const LIMIT = parseInt(process.argv.find(a => a.startsWith('--limit='))?.split('=')[1] || '100');
const TOWN_FILTER = process.argv.find(a => a.startsWith('--town='))?.split('=')[1];
const WORKER_ID = TOWN_FILTER || process.pid.toString();
const TEMP_DIR = path.join(os.tmpdir(), `ocr-pipeline-${WORKER_ID}`);
const GEMINI_API_KEY = process.env.GEMINI_API_KEY!;
const EMBEDDING_URL = `https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001:embedContent?key=${GEMINI_API_KEY}`;

// S3 Client
const s3 = new S3Client({
  region: process.env.AWS_REGION || 'us-east-1',
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID!,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!,
  }
});

// Stats
let processed = 0;
let extracted = 0;
let embedded = 0;
let failed = 0;

async function downloadFromS3(s3Path: string, localPath: string): Promise<boolean> {
  try {
    // Parse s3://bucket/key format
    const match = s3Path.match(/^s3:\/\/([^/]+)\/(.+)$/);
    if (!match) return false;
    
    const [, bucket, key] = match;
    const response = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    
    if (!response.Body) return false;
    
    const chunks: Buffer[] = [];
    for await (const chunk of response.Body as any) {
      chunks.push(chunk);
    }
    fs.writeFileSync(localPath, Buffer.concat(chunks));
    return true;
  } catch (e) {
    console.error(`  ❌ S3 download failed: ${e}`);
    return false;
  }
}

async function runOCR(pdfPath: string): Promise<string | null> {
  try {
    const outputBase = pdfPath.replace('.pdf', '');
    
    // Convert PDF to images and OCR
    execSync(`pdftoppm -png -r 150 "${pdfPath}" "${outputBase}"`, { stdio: 'pipe' });
    
    // Find all generated images
    const dir = path.dirname(pdfPath);
    const base = path.basename(outputBase);
    const images = fs.readdirSync(dir).filter(f => f.startsWith(base) && f.endsWith('.png'));
    
    if (images.length === 0) {
      // Try direct OCR on PDF
      execSync(`tesseract "${pdfPath}" "${outputBase}" -l eng`, { stdio: 'pipe' });
      const textFile = `${outputBase}.txt`;
      if (fs.existsSync(textFile)) {
        return fs.readFileSync(textFile, 'utf-8');
      }
      return null;
    }
    
    // OCR each image and concatenate
    let fullText = '';
    for (const img of images.sort()) {
      const imgPath = path.join(dir, img);
      const textBase = imgPath.replace('.png', '');
      execSync(`tesseract "${imgPath}" "${textBase}" -l eng`, { stdio: 'pipe' });
      const textFile = `${textBase}.txt`;
      if (fs.existsSync(textFile)) {
        fullText += fs.readFileSync(textFile, 'utf-8') + '\n\n--- Page Break ---\n\n';
        fs.unlinkSync(textFile);
      }
      fs.unlinkSync(imgPath);
    }
    
    return fullText.trim() || null;
  } catch (e) {
    console.error(`  ❌ OCR failed: ${e}`);
    return null;
  }
}

async function getEmbedding(text: string): Promise<number[] | null> {
  try {
    const response = await fetch(EMBEDDING_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content: { parts: [{ text: text.slice(0, 8000) }] },
        outputDimensionality: 768
      })
    });
    
    if (!response.ok) {
      if (response.status === 429) {
        console.log('  ⏳ Rate limited, waiting...');
        await new Promise(r => setTimeout(r, 60000));
        return getEmbedding(text);
      }
      return null;
    }
    
    const data = await response.json();
    return data.embedding?.values || null;
  } catch (e) {
    return null;
  }
}

async function main() {
  console.log('🔍 OCR Pipeline');
  console.log('===============');
  console.log(`Limit: ${LIMIT}`);
  if (TOWN_FILTER) console.log(`Town: ${TOWN_FILTER}`);
  console.log('');
  
  // Ensure temp directory exists
  if (!fs.existsSync(TEMP_DIR)) {
    fs.mkdirSync(TEMP_DIR, { recursive: true });
  }
  
  // Check for pdftoppm
  try {
    execSync('which pdftoppm', { stdio: 'pipe' });
  } catch {
    console.error('❌ pdftoppm not found. Install with: sudo apt-get install poppler-utils');
    process.exit(1);
  }

  // Get documents needing OCR
  let query = `
    SELECT 
      fb.id as file_blob_id,
      fb.storage_path,
      dv.id as version_id,
      dv.document_id,
      ld.town,
      ld.category,
      ld.board,
      dv.year
    FROM file_blobs fb
    JOIN document_versions dv ON dv.file_blob_id = fb.id
    JOIN logical_documents ld ON dv.document_id = ld.id
    WHERE dv.is_current = true
      AND fb.storage_path LIKE 's3://%'
      AND (fb.ocr_text IS NULL OR LENGTH(fb.ocr_text) < 100)
      AND fb.mime_type = 'application/pdf'
  `;
  
  if (TOWN_FILTER) {
    query += ` AND LOWER(ld.town) = LOWER('${TOWN_FILTER}')`;
  }
  
  query += ` ORDER BY ld.town LIMIT ${LIMIT}`;
  
  const docs = await sql.unsafe(query);
  console.log(`📄 Found ${docs.length} documents to process\n`);

  for (const doc of docs) {
    processed++;
    const pdfPath = path.join(TEMP_DIR, `${doc.file_blob_id}.pdf`);
    
    process.stdout.write(`\r[${processed}/${docs.length}] ${doc.town}: ${doc.storage_path.slice(-40)}...`);
    
    // Download
    if (!await downloadFromS3(doc.storage_path, pdfPath)) {
      failed++;
      continue;
    }
    
    // OCR
    const text = await runOCR(pdfPath);
    
    // Cleanup PDF
    if (fs.existsSync(pdfPath)) fs.unlinkSync(pdfPath);
    
    if (!text || text.length < 100) {
      // Update as failed
      await sql.unsafe(`
        UPDATE file_blobs SET ocr_status = 'completed', ocr_text = $2 
        WHERE id = $1
      `, [doc.file_blob_id, text || '']);
      continue;
    }
    
    extracted++;
    
    // Update file_blobs with extracted text
    await sql.unsafe(`
      UPDATE file_blobs 
      SET ocr_text = $2, ocr_status = 'completed', ocr_completed_at = NOW()
      WHERE id = $1
    `, [doc.file_blob_id, text]);
    
    // Chunk and embed
    const chunks = chunkText(text);
    for (const chunk of chunks) {
      const embedding = await getEmbedding(chunk.content);
      if (!embedding) continue;
      
      await sql.unsafe(`
        INSERT INTO document_chunks 
          (document_version_id, chunk_index, content, embedding, town, category, board, year)
        VALUES ($1, $2, $3, $4::vector, $5, $6, $7, $8)
        ON CONFLICT (document_version_id, chunk_index) 
        DO UPDATE SET embedding = EXCLUDED.embedding, content = EXCLUDED.content
      `, [
        doc.version_id, 
        chunk.index, 
        chunk.content, 
        `[${embedding.join(',')}]`,
        doc.town,
        doc.category,
        doc.board,
        doc.year
      ]);
      
      embedded++;
      await new Promise(r => setTimeout(r, 100)); // Rate limit
    }
  }
  
  await closeDb();
  
  console.log('\n\n✅ OCR Pipeline Complete!');
  console.log(`   Processed: ${processed}`);
  console.log(`   Extracted text: ${extracted}`);
  console.log(`   Chunks embedded: ${embedded}`);
  console.log(`   Failed: ${failed}`);
}

main().catch(e => { console.error(e); process.exit(1); });
