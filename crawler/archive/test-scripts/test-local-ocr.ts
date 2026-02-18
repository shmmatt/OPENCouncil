#!/usr/bin/env tsx
/**
 * Test local OCR on a problematic PDF
 */

import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import * as fs from 'fs/promises';
import { Readable } from 'stream';
import { performOcrOnPdf } from '../server/workers/ocrWorkerUtils';

const S3_BUCKET = process.env.S3_BUCKET || 'opencouncil-municipal-docs';
const s3 = new S3Client({ region: process.env.AWS_REGION || 'us-east-1' });

async function testOcr() {
  console.log('======================================================================');
  console.log('🧪 Testing Local OCR on Sample PDF');
  console.log('======================================================================\n');
  
  // Test with one of the problematic PDFs
  const testKey = 'albany/minutes/2020/ASB-Minutes_1.29.20.pdf';
  
  console.log(`📥 Downloading test PDF: ${testKey}\n`);
  
  try {
    // Download from S3
    const s3Stream = await s3.send(new GetObjectCommand({
      Bucket: S3_BUCKET,
      Key: testKey
    }));
    
    const chunks: Buffer[] = [];
    const stream = s3Stream.Body as Readable;
    
    for await (const chunk of stream) {
      chunks.push(chunk);
    }
    
    const buffer = Buffer.concat(chunks);
    
    // Write to temp file
    const tempPath = '/tmp/test-ocr.pdf';
    await fs.writeFile(tempPath, buffer);
    
    console.log(`📄 PDF size: ${(buffer.length / 1024).toFixed(1)} KB`);
    console.log(`\n🔍 Running OCR (this may take 10-20 seconds)...\n`);
    
    // Run OCR
    const startTime = Date.now();
    const ocrText = await performOcrOnPdf(tempPath);
    const duration = ((Date.now() - startTime) / 1000).toFixed(1);
    
    console.log(`✅ OCR Complete in ${duration}s`);
    console.log(`\n📊 Results:`);
    console.log(`   Extracted text length: ${ocrText.length} characters`);
    console.log(`   First 500 characters:\n`);
    console.log('─'.repeat(70));
    console.log(ocrText.substring(0, 500));
    console.log('─'.repeat(70));
    
    // Cleanup
    await fs.unlink(tempPath).catch(() => {});
    
    if (ocrText.length > 100) {
      console.log(`\n✅ SUCCESS: OCR is working properly!`);
      console.log(`   We can now proceed with ingestion.\n`);
      process.exit(0);
    } else {
      console.log(`\n⚠️  WARNING: OCR extracted very little text (${ocrText.length} chars)`);
      console.log(`   This PDF may be blank or have issues.\n`);
      process.exit(1);
    }
    
  } catch (error) {
    console.error(`\n❌ ERROR: ${error instanceof Error ? error.message : 'Unknown'}\n`);
    process.exit(1);
  }
}

testOcr();
