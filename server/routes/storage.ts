import { Router } from "express";
import { storage } from "../storage";
import { authenticateAdmin } from "../middleware/auth";
import { blobStorage } from "../services/blobStorage";

const router = Router();

router.post("/storage/migrate", authenticateAdmin, async (req, res) => {
  try {
    const BATCH_SIZE = 20;
    
    const allBlobs = await storage.getFileBlobsWithLocalPaths();
    
    if (allBlobs.length === 0) {
      return res.json({
        success: true,
        message: "No files need migration to object storage.",
        migrated: 0,
        failed: 0,
        remaining: 0,
      });
    }
    
    const blobsToProcess = allBlobs.slice(0, BATCH_SIZE);
    const remaining = allBlobs.length - blobsToProcess.length;
    
    let migrated = 0;
    let failed = 0;
    const errors: string[] = [];
    
    for (const blob of blobsToProcess) {
      try {
        const result = await blobStorage.migrateToObjectStorage(blob.storagePath, blob.originalFilename);
        
        if (result.migrated) {
          await storage.updateFileBlob(blob.id, { storagePath: result.newPath });
          migrated++;
          console.log(`Migrated ${blob.originalFilename} to ${result.newPath}`);
        } else {
          errors.push(`${blob.originalFilename}: Could not migrate (object storage unavailable)`);
          failed++;
        }
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : "Unknown error";
        errors.push(`${blob.originalFilename}: ${errorMessage}`);
        failed++;
      }
    }
    
    res.json({
      success: true,
      message: `Migrated ${migrated} files to object storage.${failed > 0 ? ` ${failed} failed.` : ''}${remaining > 0 ? ` ${remaining} files remaining.` : ''}`,
      migrated,
      failed,
      remaining,
      errors: errors.length > 0 ? errors : undefined,
    });
  } catch (error) {
    console.error("Error migrating files:", error);
    res.status(500).json({ message: "Failed to migrate files" });
  }
});

router.get("/storage/migration-count", authenticateAdmin, async (req, res) => {
  try {
    const blobs = await storage.getFileBlobsWithLocalPaths();
    res.json({ count: blobs.length });
  } catch (error) {
    console.error("Error getting migration count:", error);
    res.status(500).json({ message: "Failed to get count" });
  }
});

router.get("/s3-sync/status", authenticateAdmin, async (req, res) => {
  try {
    const town = req.query.town as string;
    
    if (!town) {
      return res.status(400).json({ message: "town parameter is required" });
    }
    
    const { getSyncStatus } = await import("../services/s3GeminiSync");
    const status = await getSyncStatus(town);
    
    res.json(status);
  } catch (error) {
    console.error("Error getting sync status:", error);
    res.status(500).json({ 
      message: error instanceof Error ? error.message : "Failed to get sync status" 
    });
  }
});

router.post("/s3-sync/run", authenticateAdmin, async (req, res) => {
  try {
    const { town, limit = 50, dryRun = false } = req.body;
    
    if (!town) {
      return res.status(400).json({ message: "town is required in request body" });
    }
    
    const { syncTown } = await import("../services/s3GeminiSync");
    const result = await syncTown(town, { limit, dryRun });
    
    res.json(result);
  } catch (error) {
    console.error("Error running sync:", error);
    res.status(500).json({ 
      message: error instanceof Error ? error.message : "Failed to run sync" 
    });
  }
});

router.get("/s3-sync/files", authenticateAdmin, async (req, res) => {
  try {
    const town = req.query.town as string;
    const limit = parseInt(req.query.limit as string) || 100;
    
    if (!town) {
      return res.status(400).json({ message: "town parameter is required" });
    }
    
    const { listS3Town, extractMetadataFromPath } = await import("../services/s3GeminiSync");
    const files = await listS3Town(town);
    
    const filesWithMetadata = files.slice(0, limit).map(f => ({
      ...f,
      metadata: extractMetadataFromPath(f.key),
    }));
    
    res.json({
      total: files.length,
      files: filesWithMetadata,
    });
  } catch (error) {
    console.error("Error listing S3 files:", error);
    res.status(500).json({ 
      message: error instanceof Error ? error.message : "Failed to list S3 files" 
    });
  }
});

export default router;
