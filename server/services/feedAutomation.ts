/**
 * Feed Automation Service — Two-Tier Pipeline (Task #19)
 *
 * Triggered fire-and-forget after each document version is indexed (isCurrent=true).
 *
 * Tier 1 — Automated Digest (always):
 *   - Generate a concise 150-250 word factual digest of the document.
 *   - Auto-publish immediately (status = 'published', feedType = 'automated_digest').
 *
 * Tier 2 — Feature Article Draft (only when high-impact topics found, score >= 8):
 *   - Generate a full 400-800 word journalistic article.
 *   - INSERT the draft row IMMEDIATELY (status = 'pending_review', feedType = 'automated_feature').
 *   - THEN attempt header image generation in a separate try/catch; patch the row if successful.
 *   - Admin approves/rejects via the Publishing Inbox (Task #20).
 *
 * Safety invariant: image generation failures NEVER prevent the draft from being saved.
 */

import * as fs from "fs/promises";
import * as path from "path";
import crypto from "crypto";
import { GoogleGenAI } from "@google/genai";
import { db, schema, eq } from "../storage/db";
import { createTownFeedItem, updateTownFeedItem } from "../storage/townFeed";
import { logInfo, logError, logWarn } from "../utils/logger";
import type { ScoredTopic, RoutineTopic, TownFeedPayload } from "@shared/schema";

const ai = new GoogleGenAI({ apiKey: process.env.GEM_API_KEY || "" });
const FAST_MODEL = "gemini-2.0-flash";
const PRO_MODEL = "gemini-2.5-pro-preview-05-06";
const FEED_IMAGES_DIR = "uploads/feed-images";

// ---------------------------------------------------------------------------
// Public entry point — called fire-and-forget from ingestion.ts
// ---------------------------------------------------------------------------

export async function processDocumentForFeed(versionId: string): Promise<void> {
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

  if (!version.isMinutes) {
    logInfo(`[feedAutomation] Skipping non-minutes document version ${versionId}`);
    return;
  }

  // 2. Fetch logical document (for town + canonical title)
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
  const meetingDateStr = version.meetingDate
    ? new Date(version.meetingDate).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" })
    : null;
  const boardLabel = logDoc.board || "Board";

  // 4. Tier 1 — Generate and auto-publish factual digest
  try {
    await generateAndPublishDigest(versionId, town, boardLabel, meetingDateStr, truncatedText);
  } catch (err) {
    logError(`[feedAutomation] Tier 1 digest failed for version ${versionId}`, { error: String(err) });
    // Do not rethrow — Tier 2 should still be attempted independently
  }

  // 5. Tier 2 — Score topics; create pending_review feature article if high-impact
  try {
    await evaluateAndCreateFeatureArticle(versionId, town, boardLabel, meetingDateStr, truncatedText);
  } catch (err) {
    logError(`[feedAutomation] Tier 2 feature article failed for version ${versionId}`, { error: String(err) });
  }
}

// ---------------------------------------------------------------------------
// Tier 1 — Automated digest (auto-published)
// ---------------------------------------------------------------------------

async function generateAndPublishDigest(
  versionId: string,
  town: string,
  board: string,
  meetingDate: string | null,
  text: string
): Promise<void> {
  const dateLabel = meetingDate ? ` — ${meetingDate}` : "";

  const prompt = `You are a wire-service reporter for ${town}, New Hampshire. Read the following meeting minutes and write a concise factual digest for the general public.

STRICT RULES:
- Length: 150-250 words only
- Tone: dry, neutral, factual — like a wire service report
- First sentence must be a newspaper-style lede with Who, What, When, Where
- No exclamation marks, no rhetorical questions
- No subjective adjectives: exciting, important, significant, concerning
- Bold key names, dollar figures, vote counts, and dates using Markdown **bold**
- No editorial commentary

MEETING MINUTES (${board}${dateLabel}):
${text}

Respond with JSON:
{ "title": "Headline (newspaper style, factual, no hype)", "digest": "Digest text here" }`;

  const response = await ai.models.generateContent({
    model: FAST_MODEL,
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    config: {
      temperature: 0.1,
      maxOutputTokens: 1024,
      responseMimeType: "application/json",
      responseSchema: {
        type: "object" as const,
        properties: {
          title: { type: "string" as const },
          digest: { type: "string" as const },
        },
        required: ["title", "digest"],
      },
    },
  });

  const raw = response.text || "{}";
  let parsed: { title?: string; digest?: string } = {};
  try {
    parsed = JSON.parse(raw);
  } catch {
    const m = raw.match(/\{[\s\S]*\}/);
    if (m) parsed = JSON.parse(m[0]);
  }

  const title = parsed.title || `${town} ${board} Meeting Update`;
  const digest = parsed.digest || "";

  if (!digest || digest.length < 50) {
    throw new Error("LLM returned empty digest");
  }

  const feedItem = await createTownFeedItem({
    town,
    title,
    summary: digest,
    topics: [],
    routineTopics: [],
    sourceMinutesIds: [],
    newsArticles: [],
    status: "published",
    publishedAt: new Date(),
    feedType: "automated_digest",
    automationSourceVersionId: versionId,
  } as any);

  logInfo(`[feedAutomation] Tier 1 digest published: ${feedItem.id} — "${title}"`);
}

// ---------------------------------------------------------------------------
// Tier 2 — Evaluate impact and create feature article draft
// ---------------------------------------------------------------------------

async function evaluateAndCreateFeatureArticle(
  versionId: string,
  town: string,
  board: string,
  meetingDate: string | null,
  text: string
): Promise<void> {
  // 5a. Extract and score topics
  const scoredTopics = await extractAndScoreTopics(text, town, board);

  const highImpactTopics = scoredTopics.filter(t => t.score >= 8);

  if (highImpactTopics.length === 0) {
    logInfo(`[feedAutomation] Tier 2 skipped for version ${versionId}: no high-impact topics (max score: ${Math.max(0, ...scoredTopics.map(t => t.score))})`);
    return;
  }

  logInfo(`[feedAutomation] Tier 2 triggered: ${highImpactTopics.length} high-impact topics for ${town}`);

  // 5b. Generate full journalistic article
  const { title, summary, topics, routineTopics, payload } = await generateFeatureArticle(
    text, town, board, meetingDate, highImpactTopics, scoredTopics
  );

  // 5c. INSERT the draft row IMMEDIATELY — image failure must never block this
  const feedItem = await createTownFeedItem({
    town,
    title,
    summary,
    topics,
    routineTopics,
    sourceMinutesIds: [],
    newsArticles: [],
    status: "pending_review",
    generatedPayload: payload,
    feedType: "automated_feature",
    automationSourceVersionId: versionId,
  } as any);

  logInfo(`[feedAutomation] Tier 2 draft created: ${feedItem.id} — "${title}" (pending_review)`);

  // 5d. Attempt header image generation — separate try/catch, never blocks
  try {
    const imageUrl = await generateHeaderImage(feedItem.id, town, highImpactTopics[0].topic, title);
    if (imageUrl) {
      await updateTownFeedItem(feedItem.id, { headerImageUrl: imageUrl } as any);
      logInfo(`[feedAutomation] Header image saved for ${feedItem.id}: ${imageUrl}`);
    }
  } catch (imgErr) {
    logError(`[feedAutomation] Header image generation failed for ${feedItem.id} — draft saved without image`, {
      error: String(imgErr),
    });
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
- score (1-10): overall newsworthiness, weighted average of the above

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
                score: { type: "number" as const },
                financialImpact: { type: "number" as const },
                publicFriction: { type: "number" as const },
                qualityOfLife: { type: "number" as const },
                board: { type: "string" as const, nullable: true },
                keyPoints: { type: "array" as const, items: { type: "string" as const } },
              },
              required: ["topic", "score", "financialImpact", "publicFriction", "qualityOfLife", "keyPoints"],
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

  const topics: ScoredTopic[] = (parsed.topics || []).map((t: any) => ({
    topic: t.topic || "Unknown Topic",
    score: Math.min(10, Math.max(1, Math.round(t.score || 5))),
    relevance: Math.min(10, Math.max(1, Math.round(t.score || 5))),
    financialImpact: Math.min(10, Math.max(1, Math.round(t.financialImpact || 1))),
    publicFriction: Math.min(10, Math.max(1, Math.round(t.publicFriction || 1))),
    qualityOfLife: Math.min(10, Math.max(1, Math.round(t.qualityOfLife || 1))),
    board: t.board || null,
    meetingDate: null,
    keyPoints: Array.isArray(t.keyPoints) ? t.keyPoints : [],
  }));

  return topics;
}

// ---------------------------------------------------------------------------
// Feature article generation
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
}> {
  const dateLabel = meetingDate ? ` at its ${meetingDate} meeting` : "";
  const topicList = highImpactTopics
    .map((t, i) => `${i + 1}. "${t.topic}" — ${t.keyPoints.join("; ")}`)
    .join("\n");

  const prompt = `You are a municipal affairs reporter covering ${town}, New Hampshire. Write a full journalistic feature article based on the meeting minutes below.

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

MEETING MINUTES (${board}${dateLabel}):
${text}

Respond with JSON:
{
  "title": "Newspaper-style headline — factual, no hype",
  "summary": "Full 400-800 word journalistic article",
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

  const routineTopics: RoutineTopic[] = allTopics
    .filter(t => t.score < 8)
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
      suggestedQuestions: [`What led to the decision on ${t.topic}?`, `What happens next with ${t.topic}?`],
    }))).map((s: any) => ({
      title: s.title || "",
      description: s.description || "",
      suggestedQuestions: Array.isArray(s.suggestedQuestions) ? s.suggestedQuestions : [],
    })),
    highLevelQuestions: Array.isArray(parsed.highLevelQuestions)
      ? parsed.highLevelQuestions
      : [`What should ${town} residents watch for in the coming months?`],
  };

  return { title, summary, topics: highImpactTopics, routineTopics, payload };
}

// ---------------------------------------------------------------------------
// Header image generation (Tier 2 only)
// ---------------------------------------------------------------------------

async function generateHeaderImage(
  feedItemId: string,
  town: string,
  topTopic: string,
  title: string
): Promise<string | null> {
  await fs.mkdir(FEED_IMAGES_DIR, { recursive: true });

  const safeTitle = title.slice(0, 100);
  const imagePrompt = `A photorealistic landscape photograph representing local New Hampshire town governance. Scene: ${topTopic} in a small New England town. Show a town hall building, selectboard meeting room, or relevant municipal setting. No people, no text, no signs. Neutral, journalistic aesthetic. Wide aspect ratio (16:9). Golden hour lighting, high quality.`;

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
