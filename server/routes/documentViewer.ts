import { Router } from "express";
import { getFileBlobById } from "../storage/fileBlobs";
import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
const router = Router();

const S3_BUCKET = process.env.S3_BUCKET || "opencouncil-municipal-docs";
const S3_REGION = process.env.AWS_REGION || "us-east-1";
const PRESIGNED_TTL_SECONDS = 15 * 60;

function getS3Client(): S3Client | null {
  if (!process.env.AWS_ACCESS_KEY_ID || !process.env.AWS_SECRET_ACCESS_KEY) {
    return null;
  }
  return new S3Client({
    region: S3_REGION,
    credentials: {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID!,
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!,
    },
  });
}

function parseObjectPath(fullPath: string): { bucketName: string; objectName: string } {
  const normalizedPath = fullPath.startsWith("/") ? fullPath : `/${fullPath}`;
  const parts = normalizedPath.split("/").filter(Boolean);
  if (parts.length < 2) {
    throw new Error("Invalid object storage path");
  }
  return {
    bucketName: parts[0],
    objectName: parts.slice(1).join("/"),
  };
}

router.get("/:fileBlobId", async (req, res) => {
  try {
    const { fileBlobId } = req.params;

    const fileBlob = await getFileBlobById(fileBlobId);
    if (!fileBlob) {
      return res.status(404).json({ error: "Document not found" });
    }

    const storagePath = fileBlob.storagePath;

    if (fileBlob.s3Key && fileBlob.s3Bucket) {
      const s3 = getS3Client();
      if (!s3) {
        return res.status(503).json({ error: "S3 not configured" });
      }

      const command = new GetObjectCommand({
        Bucket: fileBlob.s3Bucket,
        Key: fileBlob.s3Key,
        ResponseContentDisposition: `inline; filename="${encodeURIComponent(fileBlob.originalFilename)}"`,
      });

      const presignedUrl = await getSignedUrl(s3, command, { expiresIn: PRESIGNED_TTL_SECONDS });
      return res.redirect(302, presignedUrl);
    }

    if (storagePath.startsWith("s3://")) {
      const s3 = getS3Client();
      if (!s3) {
        return res.status(503).json({ error: "S3 not configured" });
      }

      const match = storagePath.match(/^s3:\/\/([^/]+)\/(.+)$/);
      if (!match) {
        return res.status(500).json({ error: "Invalid S3 storage path" });
      }

      const command = new GetObjectCommand({
        Bucket: match[1],
        Key: match[2],
        ResponseContentDisposition: `inline; filename="${encodeURIComponent(fileBlob.originalFilename)}"`,
      });

      const presignedUrl = await getSignedUrl(s3, command, { expiresIn: PRESIGNED_TTL_SECONDS });
      return res.redirect(302, presignedUrl);
    }

    if (storagePath.startsWith("/replit-objstore") || storagePath.includes("replit-objstore")) {
      const { bucketName, objectName } = parseObjectPath(storagePath);

      const REPLIT_SIDECAR_ENDPOINT = "http://127.0.0.1:1106";
      const request = {
        bucket_name: bucketName,
        object_name: objectName,
        method: "GET" as const,
        expires_at: new Date(Date.now() + PRESIGNED_TTL_SECONDS * 1000).toISOString(),
      };

      const response = await fetch(
        `${REPLIT_SIDECAR_ENDPOINT}/object-storage/signed-object-url`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(request),
        }
      );

      if (!response.ok) {
        return res.status(503).json({ error: "Failed to generate signed URL for object storage" });
      }

      const { signed_url: signedUrl } = await response.json();
      return res.redirect(302, signedUrl);
    }

    return res.status(404).json({ error: "Document storage backend not recognized" });
  } catch (error: any) {
    console.error("Error in document viewer:", error);
    return res.status(500).json({ error: "Failed to generate document URL" });
  }
});

export default router;
