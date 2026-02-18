import 'dotenv/config';
import { db } from '../server/storage/db';
import { eq } from 'drizzle-orm';
import { s3GeminiSync } from '../shared/schema';

async function main() {
  const result = await db.select({ sizeBytes: s3GeminiSync.sizeBytes })
    .from(s3GeminiSync)
    .where(eq(s3GeminiSync.status, 'synced'));
  
  const totalBytes = result.reduce((sum, r) => sum + (r.sizeBytes || 0), 0);
  const totalGB = (totalBytes / 1024 / 1024 / 1024).toFixed(2);
  const avgMB = (totalBytes / result.length / 1024 / 1024).toFixed(2);
  
  console.log('📊 Gemini Storage Used:');
  console.log(`   ${result.length.toLocaleString()} files synced`);
  console.log(`   ${totalGB} GB total (limit: 10 GB)`);
  console.log(`   ${avgMB} MB average per file`);
  console.log('');
  console.log(`⚠️  ${((totalBytes / 10000000000) * 100).toFixed(1)}% of quota used`);
}

main().catch(console.error);
