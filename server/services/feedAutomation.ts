/**
 * Feed Automation Service — Two-Tier Pipeline (Task #19)
 *
 * Triggered fire-and-forget after each document version is indexed (isCurrent=true).
 *
 * Tier 1 — Automated Digest (always, for minutes documents):
 *   - Generate JSON { title, bullets: string[3] }.
 *   - Title pattern: "Board Type + Doc Type + Published" (e.g. "Planning Board Minutes Published").
 *   - Auto-publish immediately (status = 'published', feedType = 'automated_digest').
 *
 * Tier 2 — Feature Article Draft (when publicFriction > 6 OR financialImpact > 6):
 *   - LLM returns: Smart Brevity article text + headerImagePrompt.
 *   - INSERT the draft row IMMEDIATELY (status = 'draft', feedType = 'automated_feature').
 *   - THEN attempt header image generation using the LLM-provided headerImagePrompt.
 *   - If image generation fails or times out, the draft is left intact — failure is only logged.
 *
 * Safety invariant: errors in automation NEVER block the ingestion pipeline.
 */

import * as fs from "fs/promises";
import * as path from "path";
import { GoogleGenAI } from "@google/genai";
import { db, schema, eq } from "../storage/db";
import { createTownFeedItem, updateTownFeedItem } from "../storage/townFeed";
import { logInfo, logError, logWarn } from "../utils/logger";
import type { ScoredTopic, RoutineTopic, TownFeedPayload } from "@shared/schema";

const ai = new GoogleGenAI({ apiKey: process.env.GEM_API_KEY || "" });
const FAST_MODEL = "gemini-2.0-flash";
const PRO_MODEL = "gemini-2.5-pro-preview-05-06";
const FEED_IMAGES_DIR = "uploads/feed-images";

/**
 * Sanitize a raw board name before using it in public-facing feed titles.
 * Replaces "Needs Review", "Unknown", or empty/null values with "Municipal".
 */
function cleanBoard(raw: string | null | undefined): string {
  if (!raw) return "Municipal";
  const trimmed = raw.trim();
  if (!trimmed || trimmed === "Needs Review" || trimmed === "Unknown") return "Municipal";
  return trimmed;
}

// ---------------------------------------------------------------------------
// Public entry point — called fire-and-forget from ingestion.ts
// ---------------------------------------------------------------------------

export interface FeedOverrides {
  board?: string;
  meetingDate?: Date;
  docType?: string;
}

export async function processDocumentForFeed(versionId: string, overrides?: FeedOverrides): Promise<void> {
  logInfo(`[feedAutomation] Starting pipeline for version ${versionId}`);

  // 1. Fetch version
  const [version] = await db
    .select()
    .from(schema.documentVersions)
    .where(eq(schema.documentVersions.id, versionId))
    .limit(1);

  if (!version) {
    logWarn(`[feedAutomation] Version not found: ${versionId}`);
    return;
  }

  // When called from enrichDocumentMetadata, overrides carry the freshly extracted meetingDate.
  // Use override meetingDate if provided, otherwise fall back to stored value.
  const effectiveMeetingDate = overrides?.meetingDate ?? (version.meetingDate ? new Date(version.meetingDate as unknown as string) : null);

  // Allow meeting documents: minutes (isMinutes=true) or any doc with a meetingDate (agendas)
  const isMeetingDoc = version.isMinutes || !!effectiveMeetingDate;
  if (!isMeetingDoc) {
    logInfo(`[feedAutomation] Skipping non-meeting document version ${versionId}`);
    return;
  }

  // 2. Fetch logical document (for town + canonical title + board)
  const [logDoc] = await db
    .select()
    .from(schema.logicalDocuments)
    .where(eq(schema.logicalDocuments.id, version.documentId))
    .limit(1);

  if (!logDoc) {
    logWarn(`[feedAutomation] Logical document not found for version ${versionId}`);
    return;
  }

  const { town } = logDoc;

  // 3. Fetch blob for text
  const [blob] = await db
    .select()
    .from(schema.fileBlobs)
    .where(eq(schema.fileBlobs.id, version.fileBlobId))
    .limit(1);

  const documentText = blob?.ocrText || blob?.previewText || "";

  if (!documentText || documentText.length < 100) {
    logWarn(`[feedAutomation] Insufficient text for version ${versionId} (${documentText.length} chars) — skipping`);
    return;
  }

  const truncatedText = documentText.slice(0, 60000);
  const meetingDateStr = effectiveMeetingDate
    ? effectiveMeetingDate.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" })
    : null;

  // Board label: use override if provided, else use stored value. Sanitization happens inside each tier.
  const rawBoard = overrides?.board ?? logDoc.board ?? "";
  // Doc type label — "Minutes" for minutes, "Agenda" for agendas (override takes priority)
  const docTypeLabel = overrides?.docType ?? (version.isMinutes ? "Minutes" : "Agenda");

  // 4. Tier 1 — Generate and auto-publish factual digest
  try {
    await generateAndPublishDigest(versionId, town, rawBoard, docTypeLabel, meetingDateStr, effectiveMeetingDate, truncatedText);
  } catch (err) {
    logError(`[feedAutomation] Tier 1 digest failed for version ${versionId}`, { error: String(err) });
    // Do not rethrow — Tier 2 should still be attempted independently
  }

  // 5. Tier 2 — Score topics; create feature article draft if high-impact
  try {
    await evaluateAndCreateFeatureArticle(versionId, town, rawBoard, meetingDateStr, effectiveMeetingDate, truncatedText);
  } catch (err) {
    logError(`[feedAutomation] Tier 2 feature article failed for version ${versionId}`, { error: String(err) });
  }
}

// ---------------------------------------------------------------------------
// Tier 1 — Automated digest (auto-published)
// JSON: { title, bullets: string[3] }
// Title pattern: "Board Type + Doc Type + Published" e.g. "Planning Board Minutes Published"
// ---------------------------------------------------------------------------

async function generateAndPublishDigest(
  versionId: string,
  town: string,
  board: string,
  docType: string,
  meetingDate: string | null,
  meetingDateTimestamp: Date | null,
  text: string
): Promise<void> {
  const boardLabel = cleanBoard(board);
  // Dynamic title: "${boardLabel} Minutes — March 11, 2026" or fallback "${boardLabel} Minutes Published"
  const canonicalTitle = meetingDate
    ? `${boardLabel} ${docType} — ${meetingDate}`
    : `${boardLabel} ${docType} Published`;

  const meetingDateLabel = meetingDate ? ` — ${meetingDate}` : "";
  const prompt = `You are a wire-service reporter for ${town}, New Hampshire. Read the following meeting minutes and produce a factual digest for the general public.

RULES:
- Return exactly 3 bullets summarizing the most important decisions, votes, or announcements
- Each bullet must be factual, dry, and neutral — no editorial commentary
- Each bullet: 1-2 sentences maximum, starts with a capital letter, ends with a period
- Use **bold** for key names, dollar amounts, vote counts, and dates
- Skip purely procedural items (roll call, approval of prior minutes, adjournment)
- The title must exactly match this pattern: "${canonicalTitle}"

MEETING MINUTES (${boardLabel}${meetingDateLabel}):
${text}

Respond with JSON matching this schema exactly:
{ "title": "${canonicalTitle}", "bullets": ["bullet 1", "bullet 2", "bullet 3"] }`;

  const response = await ai.models.generateContent({
    model: FAST_MODEL,
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    config: {
      temperature: 0.1,
      maxOutputTokens: 512,
      responseMimeType: "application/json",
      responseSchema: {
        type: "object" as const,
        properties: {
          title: { type: "string" as const },
          bullets: {
            type: "array" as const,
            items: { type: "string" as const },
          },
        },
        required: ["title", "bullets"],
      },
    },
  });

  const raw = response.text || "{}";
  let parsed: { title?: string; bullets?: string[] } = {};
  try {
    parsed = JSON.parse(raw);
  } catch {
    const m = raw.match(/\{[\s\S]*\}/);
    if (m) parsed = JSON.parse(m[0]);
  }

  // Enforce the required title pattern regardless of what LLM returned
  const title = canonicalTitle;
  const bullets: string[] = Array.isArray(parsed.bullets) && parsed.bullets.length >= 1
    ? parsed.bullets.slice(0, 3)
    : ["Meeting minutes published."];

  // Format summary as a bullet list for the feed
  const summary = bullets.map(b => `• ${b}`).join("\n");

  const feedItem = await createTownFeedItem({
    town,
    title,
    summary,
    topics: [],
    routineTopics: [],
    sourceMinutesIds: [],
    newsArticles: [],
    status: "published",
    publishedAt: new Date(),
    feedType: "automated_digest",
    automationSourceVersionId: versionId,
    meetingDate: meetingDateTimestamp,
  } as any);

  logInfo(`[feedAutomation] Tier 1 digest published: ${feedItem.id} — "${title}"`);
}

// ---------------------------------------------------------------------------
// Tier 2 — Evaluate impact and create feature article draft
// Gate: publicFriction > 6 OR financialImpact > 6 on any topic
// ---------------------------------------------------------------------------

async function evaluateAndCreateFeatureArticle(
  versionId: string,
  town: string,
  board: string,
  meetingDate: string | null,
  meetingDateTimestamp: Date | null,
  text: string
): Promise<void> {
  const boardLabel = cleanBoard(board);
  // 5a. Extract and score topics
  const scoredTopics = await extractAndScoreTopics(text, town, boardLabel);

  // Gate: publicFriction > 6 OR financialImpact > 6 (per spec)
  const highImpactTopics = scoredTopics.filter(
    t => t.publicFriction > 6 || t.financialImpact > 6
  );

  if (highImpactTopics.length === 0) {
    const maxFriction = Math.max(0, ...scoredTopics.map(t => t.publicFriction));
    const maxImpact = Math.max(0, ...scoredTopics.map(t => t.financialImpact));
    logInfo(
      `[feedAutomation] Tier 2 skipped for version ${versionId}: no topic exceeds threshold ` +
      `(maxFriction=${maxFriction}, maxImpact=${maxImpact})`
    );
    return;
  }

  logInfo(`[feedAutomation] Tier 2 triggered: ${highImpactTopics.length} high-impact topics for ${town}`);

  // 5b. Generate full Smart Brevity article + headerImagePrompt from LLM
  const { title, summary, topics, routineTopics, payload, headerImagePrompt } =
    await generateFeatureArticle(text, town, boardLabel, meetingDate, highImpactTopics, scoredTopics);

  // 5c. INSERT the draft row IMMEDIATELY — image failure must never block this
  const feedItem = await createTownFeedItem({
    town,
    title,
    summary,
    topics,
    routineTopics,
    sourceMinutesIds: [],
    newsArticles: [],
    status: "draft",
    generatedPayload: payload,
    feedType: "automated_feature",
    automationSourceVersionId: versionId,
    meetingDate: meetingDateTimestamp,
  } as any);

  logInfo(`[feedAutomation] Tier 2 draft created: ${feedItem.id} — "${title}" (draft)`);

  // 5d. Attempt header image generation using LLM-provided headerImagePrompt
  try {
    const imageUrl = await generateHeaderImage(feedItem.id, headerImagePrompt);
    if (imageUrl) {
      await updateTownFeedItem(feedItem.id, { headerImageUrl: imageUrl } as any);
      logInfo(`[feedAutomation] Header image saved for ${feedItem.id}: ${imageUrl}`);
    }
  } catch (imgErr) {
    logError(
      `[feedAutomation] Header image generation failed for ${feedItem.id} — draft saved without image`,
      { error: String(imgErr) }
    );
  }
}

// ---------------------------------------------------------------------------
// Topic extraction + scoring
// ---------------------------------------------------------------------------

async function extractAndScoreTopics(text: string, town: string, board: string): Promise<ScoredTopic[]> {
  const prompt = `You are evaluating meeting minutes from ${town}, NH (${board}).

Extract 3-10 distinct topics and score each on:
- financialImpact (1-10): financial impact on residents (tax changes, large expenditures = high)
- publicFriction (1-10): public controversy or debate (contested votes, legal disputes = high)
- qualityOfLife (1-10): effect on residents' daily lives (zoning, infrastructure, safety = high)

Also provide:
- topic: clear concise name
- board: board that discussed it (or null)
- keyPoints: 2-3 bullet points

Skip purely procedural items (roll call, approval of minutes, adjournment).

MEETING TEXT:
${text}`;

  const response = await ai.models.generateContent({
    model: FAST_MODEL,
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    config: {
      temperature: 0.1,
      responseMimeType: "application/json",
      responseSchema: {
        type: "object" as const,
        properties: {
          topics: {
            type: "array" as const,
            items: {
              type: "object" as const,
              properties: {
                topic: { type: "string" as const },
                financialImpact: { type: "number" as const },
                publicFriction: { type: "number" as const },
                qualityOfLife: { type: "number" as const },
                board: { type: "string" as const, nullable: true },
                keyPoints: { type: "array" as const, items: { type: "string" as const } },
              },
              required: ["topic", "financialImpact", "publicFriction", "qualityOfLife", "keyPoints"],
            },
          },
        },
        required: ["topics"],
      },
    },
  });

  const raw = response.text || "{}";
  let parsed: any = {};
  try {
    parsed = JSON.parse(raw);
  } catch {
    const m = raw.match(/\{[\s\S]*\}/);
    if (m) parsed = JSON.parse(m[0]);
  }

  const topics: ScoredTopic[] = (parsed.topics || []).map((t: any) => {
    const financialImpact = Math.min(10, Math.max(1, Math.round(t.financialImpact || 1)));
    const publicFriction = Math.min(10, Math.max(1, Math.round(t.publicFriction || 1)));
    const qualityOfLife = Math.min(10, Math.max(1, Math.round(t.qualityOfLife || 1)));
    // Composite score for display purposes
    const score = Math.round((financialImpact + publicFriction + qualityOfLife) / 3);
    return {
      topic: t.topic || "Unknown Topic",
      score,
      relevance: score,
      financialImpact,
      publicFriction,
      qualityOfLife,
      board: t.board || null,
      meetingDate: null,
      keyPoints: Array.isArray(t.keyPoints) ? t.keyPoints : [],
    } as ScoredTopic;
  });

  return topics;
}

// ---------------------------------------------------------------------------
// Feature article generation — returns Smart Brevity text + headerImagePrompt
// ---------------------------------------------------------------------------

async function generateFeatureArticle(
  text: string,
  town: string,
  board: string,
  meetingDate: string | null,
  highImpactTopics: ScoredTopic[],
  allTopics: ScoredTopic[]
): Promise<{
  title: string;
  summary: string;
  topics: ScoredTopic[];
  routineTopics: RoutineTopic[];
  payload: TownFeedPayload;
  headerImagePrompt: string;
}> {
  const dateLabel = meetingDate ? ` at its ${meetingDate} meeting` : "";
  const topicList = highImpactTopics
    .map((t, i) => `${i + 1}. "${t.topic}" (friction=${t.publicFriction}/10, impact=${t.financialImpact}/10) — ${t.keyPoints.join("; ")}`)
    .join("\n");

  const prompt = `You are a municipal affairs reporter covering ${town}, New Hampshire. Write a full journalistic Smart Brevity article based on the meeting minutes below.

HIGH-IMPACT TOPICS TO FEATURE:
${topicList}

STRICT TONE RULES:
- Never use exclamation marks
- Never use rhetorical questions
- Never use: "Let's dive in," "Here's what you need to know," "Big news," "Stay tuned"
- Never use subjective adjectives: exciting, impressive, concerning, remarkable
- First sentence MUST be a newspaper-style lede with Who, What, When, Where
- First paragraph strictly under 40 words
- Bold key names, dollar amounts, vote counts, and dates
- 400-800 words total

Additionally, provide a headerImagePrompt: a photorealistic image generation prompt (2-3 sentences) depicting the setting or subject of the most significant topic, suitable for a New Hampshire town governance news article header. Must be a real-world scene, no people, no text or signs.

MEETING MINUTES (${board}${dateLabel}):
${text}

Respond with JSON:
{
  "title": "Newspaper-style headline — factual, no hype",
  "summary": "Full 400-800 word Smart Brevity article",
  "headerImagePrompt": "Photorealistic image generation prompt for the header image",
  "sections": [
    { "title": "Topic title", "description": "1-2 sentence summary", "suggestedQuestions": ["Q1", "Q2"] }
  ],
  "highLevelQuestions": ["Cross-cutting question 1", "Cross-cutting question 2"]
}`;

  const response = await ai.models.generateContent({
    model: PRO_MODEL,
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    config: {
      temperature: 0.2,
      maxOutputTokens: 4096,
      responseMimeType: "application/json",
      responseSchema: {
        type: "object" as const,
        properties: {
          title: { type: "string" as const },
          summary: { type: "string" as const },
          headerImagePrompt: { type: "string" as const },
          sections: {
            type: "array" as const,
            items: {
              type: "object" as const,
              properties: {
                title: { type: "string" as const },
                description: { type: "string" as const },
                suggestedQuestions: {
                  type: "array" as const,
                  items: { type: "string" as const },
                },
              },
              required: ["title", "description", "suggestedQuestions"],
            },
          },
          highLevelQuestions: {
            type: "array" as const,
            items: { type: "string" as const },
          },
        },
        required: ["title", "summary", "headerImagePrompt", "sections", "highLevelQuestions"],
      },
    },
  });

  const raw = response.text || "{}";
  let parsed: any = {};
  try {
    parsed = JSON.parse(raw);
  } catch {
    const m = raw.match(/\{[\s\S]*\}/);
    if (m) parsed = JSON.parse(m[0]);
  }

  const title = parsed.title || `${town}: ${highImpactTopics[0].topic}`;
  const summary = parsed.summary || "";
  const headerImagePrompt = parsed.headerImagePrompt ||
    `A photorealistic wide landscape photograph of a New Hampshire town hall or selectboard meeting room. Neutral, journalistic aesthetic. No people, no text, no signs.`;

  const routineTopics: RoutineTopic[] = allTopics
    .filter(t => t.publicFriction <= 6 && t.financialImpact <= 6)
    .map(t => ({
      topic: t.topic,
      score: t.score,
      board: t.board,
      rollupSentence: `${t.board || "The board"} discussed ${t.topic.toLowerCase()}${t.keyPoints.length > 0 ? ` — ${t.keyPoints[0].toLowerCase()}` : ""}.`,
    }));

  const payload: TownFeedPayload = {
    summary,
    sections: (parsed.sections || highImpactTopics.map(t => ({
      title: t.topic,
      description: t.keyPoints.join(". "),
      suggestedQuestions: [
        `What led to the decision on ${t.topic}?`,
        `What happens next with ${t.topic}?`,
      ],
    }))).map((s: any) => ({
      title: s.title || "",
      description: s.description || "",
      suggestedQuestions: Array.isArray(s.suggestedQuestions) ? s.suggestedQuestions : [],
    })),
    highLevelQuestions: Array.isArray(parsed.highLevelQuestions)
      ? parsed.highLevelQuestions
      : [`What should ${town} residents watch for in the coming months?`],
  };

  return { title, summary, topics: highImpactTopics, routineTopics, payload, headerImagePrompt };
}

// ---------------------------------------------------------------------------
// Header image generation — uses LLM-provided headerImagePrompt
// ---------------------------------------------------------------------------

async function generateHeaderImage(
  feedItemId: string,
  imagePrompt: string
): Promise<string | null> {
  await fs.mkdir(FEED_IMAGES_DIR, { recursive: true });

  const result = await ai.models.generateImages({
    model: "imagen-3.0-generate-001",
    prompt: imagePrompt,
    config: {
      numberOfImages: 1,
      aspectRatio: "16:9",
      outputMimeType: "image/png",
    },
  });

  const imageBytes = result.generatedImages?.[0]?.image?.imageBytes;
  if (!imageBytes) {
    throw new Error("Imagen returned no image bytes");
  }

  const imgBuffer = Buffer.from(imageBytes, "base64");
  const filename = `${feedItemId}.png`;
  const filePath = path.join(FEED_IMAGES_DIR, filename);
  await fs.writeFile(filePath, imgBuffer);

  return `/api/content/feed-images/${filename}`;
}
