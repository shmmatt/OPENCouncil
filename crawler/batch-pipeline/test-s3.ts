#!/usr/bin/env npx tsx
import { S3Client, GetObjectCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';

const s3 = new S3Client({
  region: process.env.AWS_REGION || 'us-east-1',
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID!,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!,
  }
});

async function main() {
  console.log('Testing S3 access...');
  console.log('Bucket:', process.env.S3_BUCKET);
  
  try {
    // List objects
    const list = await s3.send(new ListObjectsV2Command({
      Bucket: 'opencouncil-municipal-docs',
      MaxKeys: 5
    }));
    console.log('Objects found:', list.KeyCount);
    for (const obj of list.Contents || []) {
      console.log(' -', obj.Key);
    }
  } catch (e) {
    console.error('S3 error:', e);
  }
}

main();
