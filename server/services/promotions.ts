import { GoogleGenAI } from "@google/genai";
import { getTownFeedItemById } from "../storage/townFeed";
import { createPromotion, getPromotionByFeedItemId, updatePromotion } from "../storage/promotions";
import type { PromotionContentMatrix, PromotionDeepLink, TownFeedPayload } from "@shared/schema";

const ai = new GoogleGenAI({ apiKey: process.env.GEM_API_KEY || "" });
const MODEL = "gemini-2.5-flash";

function buildTextMatrixPrompt(title: string, summary: string, topicDetails: string): string {
  return `You are a municipal communications specialist. Generate social media and email marketing content for the following town governance update. Your goal is to inform residents and drive them to learn more.

IMPORTANT TONE DIRECTIVES:
- Make hooks engaging using the "Information Gap" technique (hint at surprising or important information without revealing the full answer).
- Maintain a strictly objective, non-partisan, and factual tone when delivering information.
- Do NOT use evaluative adjectives to praise or criticize the town's actions.
- Do NOT use promotional language, exclamation marks in excess, or "PR spin."
- Write as a trusted local news source, not a marketing agency.

SOURCE MATERIAL:
Title: ${title}
Summary: ${summary}
Topic Details: ${topicDetails}

Generate the following as a JSON object with exactly these keys:
{
  "facebookPost": "A 150-250 word Facebook post. Start with an Information Gap hook that makes residents curious. Include the key facts. End with a call-to-action to learn more via the town's AI assistant.",
  "instagramCaption": "A 100-150 word Instagram caption. Start with a bold, curiosity-driven opening line. Use line breaks for readability. Include 3-5 relevant hashtags at the end (e.g., #LocalGov #YourTownName).",
  "emailSubject": "A single email subject line using the Information Gap technique. It should create genuine curiosity about a specific, factual detail from the update. Max 60 characters.",
  "emailBody": "A 200-300 word email body. Open with a brief, factual hook. Summarize the key points clearly. Close with a link placeholder [LINK] to learn more via the AI assistant."
}

Return ONLY the JSON object, no markdown fences or other text.`;
}

function buildVideoMatrixPrompt(title: string, summary: string, topicDetails: string): string {
  return `You are a short-form video scriptwriter specializing in local government content. Generate scripts for TikTok, YouTube Shorts, and Instagram Reels about the following town governance update.

IMPORTANT TONE DIRECTIVES:
- Scripts must be engaging and conversational but strictly factual.
- Do NOT use evaluative adjectives to praise or criticize the town's actions.
- Maintain an objective, non-partisan tone throughout.
- Use the "Trivia Question Hook" structure: open with a surprising question, provide factual context, then answer the hook at the end.
- Include bracketed visual/audio tags for production guidance (e.g., [VISUAL: Town Hall exterior], [CUT TO: Document closeup], [TEXT ON SCREEN: $2.3M budget]).
- Each script must be under 60 seconds when read aloud (approximately 130-160 words).

SOURCE MATERIAL:
Title: ${title}
Summary: ${summary}
Topic Details: ${topicDetails}

Generate the following as a JSON object with exactly these keys:
{
  "tiktokScript": "A TikTok script. Start with a trivia-style question hook directed at the viewer. Middle section provides factual context with visual tags. End by answering the opening question with the key takeaway. Include [VISUAL] and [TEXT ON SCREEN] tags throughout.",
  "youtubeShortScript": "A YouTube Shorts script. Same trivia hook structure. Slightly more informational tone than TikTok. Include [VISUAL], [CUT TO], and [TEXT ON SCREEN] tags.",
  "reelsScript": "An Instagram Reels script. Same trivia hook structure. Punchier and more visual-forward. Include [VISUAL], [TRANSITION], and [TEXT ON SCREEN] tags."
}

Return ONLY the JSON object, no markdown fences or other text.`;
}

function flattenSuggestedQuestions(payload: TownFeedPayload): string[] {
  const questions: string[] = [];
  if (payload.sections) {
    for (const section of payload.sections) {
      if (section.suggestedQuestions) {
        questions.push(...section.suggestedQuestions);
      }
    }
  }
  if (payload.highLevelQuestions) {
    questions.push(...payload.highLevelQuestions);
  }
  return questions;
}

function generateDeepLinks(feedItemId: string, questions: string[]): PromotionDeepLink[] {
  return questions.map((question, index) => ({
    question,
    url: `/chat?feedId=${feedItemId}&qId=${index}`,
  }));
}

async function callGemini(prompt: string): Promise<Record<string, string>> {
  const response = await ai.models.generateContent({
    model: MODEL,
    contents: prompt,
    config: {
      responseMimeType: "application/json",
    },
  });

  const text = response.text?.trim() || "{}";
  try {
    return JSON.parse(text);
  } catch (e) {
    console.error("Failed to parse Gemini JSON response:", text.slice(0, 500));
    throw new Error("LLM returned invalid JSON. Please retry generation.");
  }
}

export async function generatePromotionAssets(feedItemId: string) {
  const feedItem = await getTownFeedItemById(feedItemId);
  if (!feedItem) {
    throw new Error(`Town feed item not found: ${feedItemId}`);
  }
  if (feedItem.status !== "published") {
    throw new Error(`Town feed item is not published: ${feedItemId}`);
  }

  const topicDetails = (feedItem.topics || [])
    .map((t: any) => `- ${t.topic}: ${(t.keyPoints || []).join("; ")}`)
    .join("\n");

  const textPrompt = buildTextMatrixPrompt(feedItem.title, feedItem.summary, topicDetails);
  const videoPrompt = buildVideoMatrixPrompt(feedItem.title, feedItem.summary, topicDetails);

  const [textResult, videoResult] = await Promise.all([
    callGemini(textPrompt),
    callGemini(videoPrompt),
  ]);

  const contentMatrix: PromotionContentMatrix = {
    facebookPost: textResult.facebookPost || "",
    instagramCaption: textResult.instagramCaption || "",
    emailSubject: textResult.emailSubject || "",
    emailBody: textResult.emailBody || "",
    tiktokScript: videoResult.tiktokScript || "",
    youtubeShortScript: videoResult.youtubeShortScript || "",
    reelsScript: videoResult.reelsScript || "",
  };

  const payload = feedItem.generatedPayload as TownFeedPayload | null;
  const questions = payload ? flattenSuggestedQuestions(payload) : [];
  const deepLinks = generateDeepLinks(feedItemId, questions);

  const existing = await getPromotionByFeedItemId(feedItemId);
  let promotion;

  if (existing) {
    promotion = await updatePromotion(existing.id, {
      contentMatrix,
      deepLinks,
      status: "draft",
    });
  } else {
    promotion = await createPromotion({
      feedItemId,
      status: "draft",
      contentMatrix,
      deepLinks,
      mediaAssets: {},
    });
  }

  return promotion;
}
