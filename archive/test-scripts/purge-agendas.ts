
import { S3Client, ListObjectsV2Command, DeleteObjectsCommand } from "@aws-sdk/client-s3";

const S3_BUCKET = process.env.S3_BUCKET || "opencouncil-municipal-docs";
const s3 = new S3Client({ region: process.env.AWS_REGION || "us-east-1" });

async function purgeAgendas() {
  console.log(`[Purge] Scanning bucket ${S3_BUCKET} for 'agenda' files...`);
  
  let continuationToken: string | undefined;
  let deletedCount = 0;
  let scannedCount = 0;

  do {
    const listCmd = new ListObjectsV2Command({
      Bucket: S3_BUCKET,
      ContinuationToken: continuationToken
    });

    const response = await s3.send(listCmd);
    
    if (response.Contents && response.Contents.length > 0) {
      const keysToDelete: { Key: string }[] = [];
      
      for (const obj of response.Contents) {
        if (!obj.Key) continue;
        scannedCount++;
        
        const lowerKey = obj.Key.toLowerCase();
        // Check for 'agenda' in filename or path
        // BUT be careful not to delete 'minutes' that happen to be in an 'agenda' folder (rare but possible)
        // We target files that explicitly say 'agenda' in their name OR reside in an 'agendas' folder
        
        const isAgenda = lowerKey.includes("/agenda/") || lowerKey.includes("agenda");
        
        if (isAgenda) {
          keysToDelete.push({ Key: obj.Key });
        }
      }

      if (keysToDelete.length > 0) {
        console.log(`[Purge] Deleting batch of ${keysToDelete.length}...`);
        
        // S3 delete batch limit is 1000
        for (let i = 0; i < keysToDelete.length; i += 1000) {
          const batch = keysToDelete.slice(i, i + 1000);
          await s3.send(new DeleteObjectsCommand({
            Bucket: S3_BUCKET,
            Delete: { Objects: batch }
          }));
        }
        
        deletedCount += keysToDelete.length;
        // console.log(`[Purge] Deleted: ${keysToDelete.map(k => k.Key).join(', ')}`);
      }
    }
    
    continuationToken = response.NextContinuationToken;
    process.stdout.write(`\rScanned: ${scannedCount} | Deleted: ${deletedCount}    `);
    
  } while (continuationToken);

  console.log(`\n[Purge] Complete. Removed ${deletedCount} agenda files.`);
}

purgeAgendas().catch(console.error);
