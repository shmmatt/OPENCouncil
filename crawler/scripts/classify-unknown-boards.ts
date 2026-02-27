#!/usr/bin/env tsx
import { db } from "../../server/storage/db";
import { sql, eq } from "drizzle-orm";
import * as schema from "../../shared/schema";
import { GoogleGenAI } from "@google/genai";

const ai = new GoogleGenAI({ apiKey: process.env.GEM_API_KEY || "" });
const MODEL = "gemini-2.5-flash";
const CONCURRENCY = 2;
const DRY_RUN = process.argv.includes("--dry-run");
const MAX_RETRIES = 3;

const PROMPT = `You are classifying a New Hampshire municipal meeting document. Based on the text below, determine:

1. **boardName**: The specific municipal board, committee, or body that held this meeting. Use one of these standard names if it matches:
   - "Board of Selectmen" (also called Select Board, Selectmen's Meeting)
   - "Planning Board"
   - "Zoning Board of Adjustment" (also called ZBA)
   - "Budget Committee"
   - "Conservation Commission"
   - "School Board"
   - "Library Trustees"
   - "Parks and Recreation"
   - "Historic District Commission"
   - "Town Meeting" (annual/special town meetings, deliberative sessions)
   - "Water Commission" or "Water/Sewer Commission"
   - "Fire Commission" or "Fire Department"
   - "Cemetery Trustees"
   If it's a different committee/board, return the exact name (e.g., "Citizens Advisory Committee", "Energy Committee").

2. **meetingDate**: The date of the meeting in ISO format (YYYY-MM-DD). Look for date patterns near the beginning of the document.

Return ONLY valid JSON, no markdown:
{"boardName": "...", "meetingDate": "YYYY-MM-DD" or null}

Document text (first 800 characters):
`;

interface ClassifyResult {
  boardName: string;
  meetingDate: string | null;
}

async function classifyDocument(ocrText: string, retryCount = 0): Promise<ClassifyResult | null> {
  const textSample = ocrText.substring(0, 800);
  try {
    const response = await ai.models.generateContent({
      model: MODEL,
      contents: [{ role: "user", parts: [{ text: PROMPT + textSample }] }],
      config: {
        temperature: 0.1,
        maxOutputTokens: 500,
        responseMimeType: "application/json",
      },
    });

    const raw = (response.text || "").trim();
    let parsed: any;
    try {
      parsed = JSON.parse(raw);
    } catch {
      const jsonMatch = raw.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        console.error(`  No JSON in response: ${raw.substring(0, 80)}`);
        return null;
      }
      try {
        parsed = JSON.parse(jsonMatch[0]);
      } catch {
        console.error(`  Bad JSON: ${raw.substring(0, 80)}`);
        return null;
      }
    }
    if (!parsed.boardName || typeof parsed.boardName !== "string") return null;

    return {
      boardName: parsed.boardName.trim(),
      meetingDate: parsed.meetingDate && parsed.meetingDate !== "null" ? parsed.meetingDate : null,
    };
  } catch (e: any) {
    const msg = e.message || "";
    if ((msg.includes("429") || msg.includes("rate") || msg.includes("503") || msg.includes("overloaded")) && retryCount < MAX_RETRIES) {
      const delay = 3000 * (retryCount + 1) + Math.random() * 2000;
      await new Promise(r => setTimeout(r, delay));
      return classifyDocument(ocrText, retryCount + 1);
    }
    console.error(`  Gemini error (retry ${retryCount}): ${msg.substring(0, 120)}`);
    return null;
  }
}

interface DocRow {
  ld_id: string;
  dv_id: string;
  town: string;
  canonical_title: string;
  ocr_text: string;
  meeting_date: string | null;
}

async function main() {
  console.log("=".repeat(70));
  console.log("Classify Unknown Board minutes using Gemini");
  console.log(`Mode: ${DRY_RUN ? "DRY RUN" : "LIVE"}, Model: ${MODEL}, Concurrency: ${CONCURRENCY}`);
  console.log("=".repeat(70));

  const rows = await db.execute(sql`
    SELECT 
      ld.id as ld_id,
      dv.id as dv_id,
      ld.town,
      ld.canonical_title,
      left(COALESCE(fb.ocr_text, fb.preview_text, ''), 800) as ocr_text,
      dv.meeting_date
    FROM logical_documents ld
    JOIN document_versions dv ON ld.id = dv.document_id
    JOIN file_blobs fb ON dv.file_blob_id = fb.id
    WHERE ld.board = 'Unknown Board'
      AND ld.category = 'meeting_minutes'
    ORDER BY ld.town, ld.canonical_title
  `);

  const docs = rows.rows as unknown as DocRow[];
  console.log(`\nFound ${docs.length} documents to classify\n`);

  if (docs.length === 0) {
    console.log("Nothing to do!");
    process.exit(0);
  }

  const townStats: Record<string, { boards: Record<string, number>; datesFixed: number; errors: number }> = {};
  let totalClassified = 0, totalDatesFixed = 0, totalErrors = 0;
  const startTime = Date.now();

  for (let i = 0; i < docs.length; i += CONCURRENCY) {
    const batch = docs.slice(i, i + CONCURRENCY);
    const results = await Promise.all(
      batch.map(async (doc) => {
        const result = await classifyDocument(doc.ocr_text);
        return { doc, result };
      })
    );

    for (const { doc, result } of results) {
      if (!townStats[doc.town]) {
        townStats[doc.town] = { boards: {}, datesFixed: 0, errors: 0 };
      }

      if (!result) {
        totalErrors++;
        townStats[doc.town].errors++;
        continue;
      }

      totalClassified++;
      townStats[doc.town].boards[result.boardName] = (townStats[doc.town].boards[result.boardName] || 0) + 1;

      if (!DRY_RUN) {
        await db
          .update(schema.logicalDocuments)
          .set({ board: result.boardName })
          .where(eq(schema.logicalDocuments.id, doc.ld_id));

        if (result.meetingDate && !doc.meeting_date) {
          const parsed = new Date(result.meetingDate);
          if (!isNaN(parsed.getTime()) && parsed.getFullYear() >= 1990 && parsed.getFullYear() <= 2030) {
            await db
              .update(schema.documentVersions)
              .set({
                meetingDate: parsed,
                year: String(parsed.getFullYear()),
              })
              .where(eq(schema.documentVersions.id, doc.dv_id));
            totalDatesFixed++;
            townStats[doc.town].datesFixed++;
          }
        }
      } else {
        if (result.meetingDate && !doc.meeting_date) {
          totalDatesFixed++;
          townStats[doc.town].datesFixed++;
        }
      }
    }

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
    const processed = Math.min(i + CONCURRENCY, docs.length);
    process.stdout.write(
      `\r[${elapsed}s] ${processed}/${docs.length} (${totalClassified} classified, ${totalDatesFixed} dates fixed, ${totalErrors} errors)`
    );

    if (i + CONCURRENCY < docs.length) {
      await new Promise(r => setTimeout(r, 500));
    }
  }

  console.log("\n\n" + "=".repeat(70));
  console.log(`RESULTS: ${totalClassified} classified, ${totalDatesFixed} dates fixed, ${totalErrors} errors`);
  console.log("=".repeat(70));

  console.log("\nPer-town breakdown:");
  for (const [town, stats] of Object.entries(townStats).sort((a, b) => a[0].localeCompare(b[0]))) {
    const total = Object.values(stats.boards).reduce((a, b) => a + b, 0);
    console.log(`\n  ${town}: ${total} classified, ${stats.datesFixed} dates fixed, ${stats.errors} errors`);
    for (const [board, count] of Object.entries(stats.boards).sort((a, b) => b[1] - a[1])) {
      console.log(`    - ${board}: ${count}`);
    }
  }

  if (!DRY_RUN) {
    const remaining = await db.execute(sql`
      SELECT COUNT(*) as cnt FROM logical_documents WHERE board = 'Unknown Board' AND category = 'meeting_minutes'
    `);
    console.log(`\n\nRemaining "Unknown Board" docs: ${(remaining.rows[0] as any).cnt}`);
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("Fatal:", e);
    process.exit(1);
  });
