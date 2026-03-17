import { Router } from "express";
import { randomUUID } from "crypto";
import { storage } from "../storage";
import { requireRole } from "../auth/middleware";
import type { IdentityRequest } from "../auth/types";
import type { ActorIdentifier } from "@shared/schema";
import { db, schema, eq, and, sql } from "../storage/db";
import { detectMinutesHeuristics, parseDateToISO, suggestMetadataFromPreview } from "../services/metadataExtraction";

interface BackfillJob {
  status: "running" | "completed" | "error";
  total: number;
  processed: number;
  updated: number;
  error?: string;
}

const backfillJobs = new Map<string, BackfillJob>();

const router = Router();

router.get("/meta/towns", async (req, res) => {
  try {
    const towns = await storage.getAvailableTowns();
    res.json({ towns });
  } catch (error) {
    console.error("Error fetching available towns:", error);
    res.status(500).json({ message: "Failed to fetch available towns" });
  }
});

router.post("/preferences/town", async (req: IdentityRequest, res) => {
  try {
    const { town } = req.body;

    if (!town || typeof town !== "string") {
      return res.status(400).json({ message: "Town is required" });
    }

    const availableTowns = await storage.getAvailableTowns();
    if (!availableTowns.includes(town)) {
      return res.status(400).json({ message: "Invalid town selection" });
    }

    const actor: ActorIdentifier = req.user 
      ? { type: 'user', userId: req.user.id }
      : req.anonId 
        ? { type: 'anon', anonId: req.anonId }
        : { type: 'anon' };

    if (actor.userId || actor.anonId) {
      await storage.setActorDefaultTown(actor, town);
    }

    const sessionId = req.body.sessionId;
    if (sessionId) {
      await storage.setSessionTownPreference(sessionId, town);
    }

    res.json({ success: true, town });
  } catch (error) {
    console.error("Error setting town preference:", error);
    res.status(500).json({ message: "Failed to set town preference" });
  }
});

router.get("/preferences/town", async (req: IdentityRequest, res) => {
  try {
    const actor: ActorIdentifier = req.user 
      ? { type: 'user', userId: req.user.id }
      : req.anonId 
        ? { type: 'anon', anonId: req.anonId }
        : { type: 'anon' };

    let town: string | null = null;

    const sessionId = req.query.sessionId as string | undefined;
    if (sessionId) {
      town = await storage.getSessionTownPreference(sessionId);
    }

    if (!town && (actor.userId || actor.anonId)) {
      town = await storage.getActorDefaultTown(actor);
    }

    town = town || "Ossipee";

    res.json({ town });
  } catch (error) {
    console.error("Error fetching town preference:", error);
    res.status(500).json({ message: "Failed to fetch town preference" });
  }
});

router.get("/updates/minutes", async (req: IdentityRequest, res) => {
  try {
    let town = req.query.town as string | undefined;
    const limit = parseInt(req.query.limit as string) || 5;

    if (!town) {
      const actor: ActorIdentifier = req.user 
        ? { type: 'user', userId: req.user.id }
        : req.anonId 
          ? { type: 'anon', anonId: req.anonId }
          : { type: 'anon' };

      if (actor.userId || actor.anonId) {
        town = await storage.getActorDefaultTown(actor) || undefined;
      }
    }

    town = town || "Ossipee";

    const items = await storage.getRecentMinutesUpdates({ town, limit });
    res.json({ items });
  } catch (error) {
    console.error("Error fetching recent minutes updates:", error);
    res.status(500).json({ message: "Failed to fetch recent minutes updates" });
  }
});

router.get(
  "/admin/updates/minutes",
  requireRole("admin", "municipal_admin"),
  async (req: IdentityRequest, res) => {
    try {
      const town = req.query.town as string | undefined;
      const board = req.query.board as string | undefined;
      const limit = parseInt(req.query.limit as string) || 50;

      const items = await storage.getRecentMinutesUpdatesAdmin({ town, board, limit });
      res.json({ items });
    } catch (error) {
      console.error("Error fetching admin minutes updates:", error);
      res.status(500).json({ message: "Failed to fetch admin minutes updates" });
    }
  }
);

router.get(
  "/admin/backfill/meeting-dates/:jobId",
  requireRole("admin", "municipal_admin"),
  (req, res) => {
    const job = backfillJobs.get(req.params.jobId);
    if (!job) return res.status(404).json({ message: "Job not found" });
    return res.json(job);
  }
);

router.post(
  "/admin/backfill/meeting-dates",
  requireRole("admin", "municipal_admin"),
  async (req: IdentityRequest, res) => {
    const townFilter = (req.query.town as string) || "";
    const jobId = randomUUID();

    backfillJobs.set(jobId, { status: "running", total: 0, processed: 0, updated: 0 });

    res.json({ jobId });

    runBackfill(jobId, townFilter).catch((err) => {
      const job = backfillJobs.get(jobId);
      if (job) backfillJobs.set(jobId, { ...job, status: "error", error: String(err) });
    });
  }
);

async function runBackfill(jobId: string, townFilter: string): Promise<void> {
  const job = backfillJobs.get(jobId)!;

  try {
    const conditions: ReturnType<typeof eq>[] = [
      eq(schema.documentVersions.isMinutes, true),
      eq(schema.documentVersions.isCurrent, true),
      sql`${schema.documentVersions.meetingDate} IS NULL`,
      sql`${schema.fileBlobs.previewText} IS NOT NULL`,
    ] as any[];

    if (townFilter) {
      conditions.push(eq(schema.logicalDocuments.town, townFilter) as any);
    }

    const candidates = await db
      .select({
        versionId: schema.documentVersions.id,
        filename: schema.fileBlobs.originalFilename,
        previewText: schema.fileBlobs.previewText,
      })
      .from(schema.documentVersions)
      .innerJoin(schema.fileBlobs, eq(schema.documentVersions.fileBlobId, schema.fileBlobs.id))
      .innerJoin(schema.logicalDocuments, eq(schema.documentVersions.documentId, schema.logicalDocuments.id))
      .where(and(...conditions))
      .limit(500);

    backfillJobs.set(jobId, { ...job, total: candidates.length });

    const needsLlm: typeof candidates = [];
    let updated = 0;
    let processed = 0;

    for (const row of candidates) {
      const text = row.previewText || "";
      const hints = detectMinutesHeuristics(row.filename, text);
      const isoDate = hints.possibleDateText ? parseDateToISO(hints.possibleDateText) : null;

      if (isoDate) {
        await db
          .update(schema.documentVersions)
          .set({ meetingDate: new Date(isoDate) })
          .where(eq(schema.documentVersions.id, row.versionId));
        updated++;
      } else {
        needsLlm.push(row);
      }

      processed++;
      backfillJobs.set(jobId, { ...backfillJobs.get(jobId)!, processed, updated });
    }

    const CONCURRENCY = 3;
    for (let i = 0; i < needsLlm.length; i += CONCURRENCY) {
      const batch = needsLlm.slice(i, i + CONCURRENCY);
      await Promise.all(
        batch.map(async (row) => {
          try {
            const suggested = await suggestMetadataFromPreview(row.filename, row.previewText || "", undefined);
            if (suggested.meetingDate) {
              await db
                .update(schema.documentVersions)
                .set({ meetingDate: new Date(suggested.meetingDate) })
                .where(eq(schema.documentVersions.id, row.versionId));
              const cur = backfillJobs.get(jobId)!;
              backfillJobs.set(jobId, { ...cur, updated: cur.updated + 1 });
            }
          } catch {
          }
          const cur = backfillJobs.get(jobId)!;
          backfillJobs.set(jobId, { ...cur, processed: cur.processed + 1 });
        })
      );
    }

    const final = backfillJobs.get(jobId)!;
    backfillJobs.set(jobId, { ...final, status: "completed" });
  } catch (err) {
    const cur = backfillJobs.get(jobId);
    if (cur) backfillJobs.set(jobId, { ...cur, status: "error", error: String(err) });
  }
}

export default router;
