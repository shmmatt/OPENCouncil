import fs from "fs/promises";
import path from "path";
import crypto from "crypto";
import { objectStorageClient, ObjectStorageService } from "../replit_integrations/object_storage";

const objectStorageService = new ObjectStorageService();

export interface BlobStorageResult {
  storagePath: string;
  size: number;
}

export class BlobStorageError extends Error {
  constructor(message: string, public readonly code: string) {
    super(message);
    this.name = "BlobStorageError";
  }
}

function parseObjectPath(fullPath: string): { bucketName: string; objectName: string } {
  const normalizedPath = fullPath.startsWith("/") ? fullPath : `/${fullPath}`;
  const parts = normalizedPath.split("/").filter(Boolean);
  if (parts.length < 2) {
    throw new Error("Invalid path: must contain at least bucket and object name");
  }
  return {
    bucketName: parts[0],
    objectName: parts.slice(1).join("/"),
  };
}

export const blobStorage = {
  async saveFile(buffer: Buffer, originalFilename: string): Promise<BlobStorageResult> {
    const hash = crypto.createHash("md5").update(buffer).digest("hex");
    const ext = path.extname(originalFilename);
    const objectName = `${hash}${ext}`;
    
    try {
      const privateDir = objectStorageService.getPrivateObjectDir();
      const fullPath = `${privateDir}/blobs/${objectName}`;
      const { bucketName, objectName: objPath } = parseObjectPath(fullPath);
      
      const bucket = objectStorageClient.bucket(bucketName);
      const file = bucket.file(objPath);
      
      await file.save(buffer, {
        metadata: {
          contentType: getMimeType(originalFilename),
        },
      });
      
      return {
        storagePath: fullPath,
        size: buffer.length,
      };
    } catch (error) {
      console.error("Object storage save failed, falling back to local:", error);
      return this.saveFileLocal(buffer, objectName);
    }
  },

  async saveFileLocal(buffer: Buffer, filename: string): Promise<BlobStorageResult> {
    const uploadsDir = "uploads/blobs";
    await fs.mkdir(uploadsDir, { recursive: true });
    const filePath = path.join(uploadsDir, filename);
    await fs.writeFile(filePath, buffer);
    return {
      storagePath: filePath,
      size: buffer.length,
    };
  },

  async readFile(storagePath: string): Promise<Buffer> {
    if (storagePath.startsWith("/replit-objstore") || storagePath.includes("replit-objstore")) {
      return this.readFromObjectStorage(storagePath);
    }
    
    try {
      return await fs.readFile(storagePath);
    } catch (error: any) {
      if (error.code === "ENOENT") {
        const normalizedPath = storagePath.replace(/^uploads\/blobs\//, "");
        try {
          const privateDir = objectStorageService.getPrivateObjectDir();
          const objectPath = `${privateDir}/blobs/${normalizedPath}`;
          return await this.readFromObjectStorage(objectPath);
        } catch (objError) {
          throw new BlobStorageError(
            `File not found: ${storagePath}`,
            "ENOENT"
          );
        }
      }
      throw error;
    }
  },

  async readFromObjectStorage(storagePath: string): Promise<Buffer> {
    try {
      const { bucketName, objectName } = parseObjectPath(storagePath);
      const bucket = objectStorageClient.bucket(bucketName);
      const file = bucket.file(objectName);
      
      const [exists] = await file.exists();
      if (!exists) {
        throw new BlobStorageError(`Object not found: ${storagePath}`, "ENOENT");
      }
      
      const [contents] = await file.download();
      return contents;
    } catch (error: any) {
      if (error instanceof BlobStorageError) throw error;
      throw new BlobStorageError(
        `Failed to read from object storage: ${error.message}`,
        "OBJECT_STORAGE_ERROR"
      );
    }
  },

  async fileExists(storagePath: string): Promise<boolean> {
    if (storagePath.startsWith("/replit-objstore") || storagePath.includes("replit-objstore")) {
      try {
        const { bucketName, objectName } = parseObjectPath(storagePath);
        const bucket = objectStorageClient.bucket(bucketName);
        const file = bucket.file(objectName);
        const [exists] = await file.exists();
        return exists;
      } catch {
        return false;
      }
    }

    try {
      await fs.access(storagePath);
      return true;
    } catch {
      return false;
    }
  },

  async migrateToObjectStorage(
    localPath: string,
    originalFilename: string
  ): Promise<{ newPath: string; migrated: boolean }> {
    try {
      const buffer = await fs.readFile(localPath);
      const result = await this.saveFile(buffer, originalFilename);
      
      if (result.storagePath.startsWith("/replit-objstore") || result.storagePath.includes("replit-objstore")) {
        return { newPath: result.storagePath, migrated: true };
      }
      
      return { newPath: localPath, migrated: false };
    } catch (error: any) {
      if (error.code === "ENOENT") {
        throw new BlobStorageError(`Local file not found: ${localPath}`, "ENOENT");
      }
      throw error;
    }
  },

  async deleteFile(storagePath: string): Promise<void> {
    if (storagePath.startsWith("/replit-objstore") || storagePath.includes("replit-objstore")) {
      const { bucketName, objectName } = parseObjectPath(storagePath);
      const bucket = objectStorageClient.bucket(bucketName);
      const file = bucket.file(objectName);
      await file.delete({ ignoreNotFound: true });
    } else {
      try {
        await fs.unlink(storagePath);
      } catch (error: any) {
        if (error.code !== "ENOENT") throw error;
      }
    }
  },

  isObjectStoragePath(storagePath: string): boolean {
    return storagePath.startsWith("/replit-objstore") || storagePath.includes("replit-objstore");
  },
};

function getMimeType(filename: string): string {
  const ext = path.extname(filename).toLowerCase();
  const mimeTypes: Record<string, string> = {
    ".pdf": "application/pdf",
    ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".doc": "application/msword",
    ".txt": "text/plain",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
  };
  return mimeTypes[ext] || "application/octet-stream";
}
