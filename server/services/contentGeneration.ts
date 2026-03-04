import { GoogleGenAI } from "@google/genai";
import { db, schema, eq, and, desc, sql, gte } from "../storage/db";
import { generateQueryEmbedding } from "./embeddingService";
import { semanticSearch } from "./embeddingStorage";
import { logInfo, logError, logDebug } from "../utils/logger";
import type { ScoredTopic, RoutineTopic, TownFeedNewsArticle, TownFeedItem } from "@shared/schema";

const ai = new GoogleGenAI({ apiKey: process.env.GEM_API_KEY || "" });
const MODEL = "gemini-2.5-flash";
const SUMMARY_MODEL = "gemini-3.1-pro-preview";

interface RawTopic {
  topic: string;
  board: string | null;
  meetingDate: string | null;
  keyPoints: string[];
}

export async function extractTopicsFromMinutes(town: string): Promise<{ topics: RawTopic[]; sourceMinutesIds: string[] }> {
  const thirtyDaysAgo = new Date();
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

  const recentMinutes = await db
    .select({
      versionId: schema.documentVersions.id,
      documentId: schema.documentVersions.documentId,
      board: schema.logicalDocuments.board,
      meetingDate: schema.documentVersions.meetingDate,
      fileBlobId: schema.documentVersions.fileBlobId,
    })
    .from(schema.documentVersions)
    .innerJoin(schema.logicalDocuments, eq(schema.documentVersions.documentId, schema.logicalDocuments.id))
    .where(and(
      eq(schema.logicalDocuments.town, town),
      eq(schema.documentVersions.isMinutes, true),
      eq(schema.documentVersions.isCurrent, true),
      gte(schema.documentVersions.createdAt, thirtyDaysAgo),
    ))
    .orderBy(desc(schema.documentVersions.createdAt))
    .limit(20);

  if (recentMinutes.length === 0) {
    logInfo(`[contentGeneration] No recent minutes found for ${town}`);
    return { topics: [], sourceMinutesIds: [] };
  }

  const sourceMinutesIds = recentMinutes.map(m => m.documentId);

  const chunks = await db
    .select({
      content: schema.documentChunks.content,
      metadata: schema.documentChunks.metadata,
    })
    .from(schema.documentChunks)
    .where(and(
      sql`lower(metadata->>'town') = ${town.toLowerCase()}`,
      sql`metadata->>'documentType' = 'meeting_minutes'`,
    ))
    .orderBy(desc(schema.documentChunks.createdAt))
    .limit(50);

  if (chunks.length === 0) {
    logInfo(`[contentGeneration] No minute chunks found for ${town}`);
    return { topics: [], sourceMinutesIds };
  }

  const concatenatedText = chunks
    .map(c => {
      const meta = c.metadata || {};
      const header = [meta.board, meta.date].filter(Boolean).join(" - ");
      return header ? `[${header}]\n${c.content}` : c.content;
    })
    .join("\n\n---\n\n")
    .slice(0, 60000);

  const prompt = `You are analyzing municipal meeting minutes from ${town}, New Hampshire.
Extract distinct topics discussed across these minutes. For each topic, identify:
- topic: A clear, concise name for the topic (e.g., "Water District Budget Increase", "Short-Term Rental Ordinance")
- board: Which board discussed it (e.g., "Select Board", "Planning Board", "ZBA") or null if unclear
- meetingDate: The date of the meeting where this was discussed (ISO format YYYY-MM-DD) or null if unclear
- keyPoints: 2-4 bullet points summarizing the key discussion points

Focus on substantive topics — skip procedural items like roll call, approval of prior minutes, adjournment.
Return 5-15 topics depending on how much substantive content exists.

Meeting minutes text:
${concatenatedText}`;

  try {
    const response = await ai.models.generateContent({
      model: MODEL,
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
                  board: { type: "string" as const, nullable: true },
                  meetingDate: { type: "string" as const, nullable: true },
                  keyPoints: { type: "array" as const, items: { type: "string" as const } },
                },
                required: ["topic", "keyPoints"],
              },
            },
          },
          required: ["topics"],
        },
      },
    });

    const rawText = response.text || "{}";
    const parsed = JSON.parse(rawText);
    const topics: RawTopic[] = (parsed.topics || []).map((t: any) => ({
      topic: t.topic || "Unknown Topic",
      board: t.board || null,
      meetingDate: t.meetingDate || null,
      keyPoints: Array.isArray(t.keyPoints) ? t.keyPoints : [],
    }));

    logInfo(`[contentGeneration] Extracted ${topics.length} topics from ${town} minutes`);
    return { topics, sourceMinutesIds };
  } catch (error) {
    logError(`[contentGeneration] Topic extraction failed for ${town}`, { error: String(error) });
    throw error;
  }
}

export async function judgeStoryWorthiness(topics: RawTopic[]): Promise<ScoredTopic[]> {
  if (topics.length === 0) return [];

  const topicSummaries = topics.map((t, i) =>
    `${i + 1}. "${t.topic}" (Board: ${t.board || "unknown"}, Date: ${t.meetingDate || "unknown"})\n   Key points: ${t.keyPoints.join("; ")}`
  ).join("\n\n");

  const prompt = `You are a local news editor evaluating municipal meeting topics for story-worthiness.

Score each topic on three axes (each 1-10):
- financialImpact: How significant is the financial impact on residents? (tax changes, large expenditures, budget cuts = high)
- publicFriction: How much public controversy or debate does this generate? (contested votes, citizen complaints, legal disputes = high)
- qualityOfLife: How directly does this affect residents' daily quality of life? (zoning changes, infrastructure, public safety = high)

Also provide an overall "relevance" score (1-10) that reflects how newsworthy this topic is for local residents. The overall score should be a weighted combination that emphasizes financial impact and public friction slightly more.

Topics to evaluate:
${topicSummaries}`;

  try {
    const response = await ai.models.generateContent({
      model: MODEL,
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      config: {
        temperature: 0.1,
        responseMimeType: "application/json",
        responseSchema: {
          type: "object" as const,
          properties: {
            scored_topics: {
              type: "array" as const,
              items: {
                type: "object" as const,
                properties: {
                  index: { type: "number" as const },
                  financialImpact: { type: "number" as const },
                  publicFriction: { type: "number" as const },
                  qualityOfLife: { type: "number" as const },
                  relevance: { type: "number" as const },
                },
                required: ["index", "financialImpact", "publicFriction", "qualityOfLife", "relevance"],
              },
            },
          },
          required: ["scored_topics"],
        },
      },
    });

    const rawText = response.text || "{}";
    const parsed = JSON.parse(rawText);
    const scoredResults = parsed.scored_topics || [];

    const scoredTopics: ScoredTopic[] = topics.map((t, i) => {
      const scoreData = scoredResults.find((s: any) => s.index === i + 1) || {};
      const financialImpact = scoreData.financialImpact || 1;
      const publicFriction = scoreData.publicFriction || 1;
      const qualityOfLife = scoreData.qualityOfLife || 1;
      const relevance = scoreData.relevance || Math.round((financialImpact + publicFriction + qualityOfLife) / 3);

      return {
        topic: t.topic,
        score: relevance,
        financialImpact,
        publicFriction,
        qualityOfLife,
        relevance,
        board: t.board,
        meetingDate: t.meetingDate,
        keyPoints: t.keyPoints,
      };
    });

    logInfo(`[contentGeneration] Scored ${scoredTopics.length} topics, ${scoredTopics.filter(t => t.score >= 8).length} high-scoring`);
    return scoredTopics;
  } catch (error) {
    logError(`[contentGeneration] Story worthiness judging failed`, { error: String(error) });
    throw error;
  }
}

export async function enrichWithHistoricalContext(
  scoredTopics: ScoredTopic[],
  town: string
): Promise<ScoredTopic[]> {
  const enriched: ScoredTopic[] = [];

  for (const topic of scoredTopics) {
    try {
      const queryText = `${topic.topic} ${topic.keyPoints.slice(0, 2).join(" ")} ${town}`;
      const queryEmbedding = await generateQueryEmbedding(queryText);

      const results = await semanticSearch(queryEmbedding, {
        town,
        limit: 5,
        similarityThreshold: 0.4,
      });

      if (results.length === 0) {
        enriched.push({ ...topic, historicalContext: undefined });
        continue;
      }

      const contextChunks = results.map((r, i) => {
        const meta = r.chunk.metadata || {};
        const header = [meta.board, meta.year, meta.documentType].filter(Boolean).join(" | ");
        return `[Source ${i + 1}: ${header}]\n${r.chunk.content.slice(0, 1500)}`;
      }).join("\n\n");

      const contextPrompt = `Based on these historical municipal documents from ${town}, NH, write a brief historical context paragraph (2-4 sentences) for this topic:

Topic: "${topic.topic}"
Key points from recent minutes: ${topic.keyPoints.join("; ")}

Historical documents:
${contextChunks}

Write a concise narrative connecting historical context to the current discussion. Focus on precedents, prior decisions, and evolution of the issue. If no meaningful historical context exists, say so briefly.`;

      const response = await ai.models.generateContent({
        model: MODEL,
        contents: [{ role: "user", parts: [{ text: contextPrompt }] }],
        config: { temperature: 0.2, maxOutputTokens: 500 },
      });

      const contextText = response.text || "";
      enriched.push({ ...topic, historicalContext: contextText.trim() || undefined });

      logDebug(`[contentGeneration] Enriched topic "${topic.topic}" with ${results.length} historical sources`);
    } catch (error) {
      logError(`[contentGeneration] Failed to enrich topic "${topic.topic}"`, { error: String(error) });
      enriched.push({ ...topic, historicalContext: undefined });
    }
  }

  return enriched;
}

export function formatRoutineRollup(scoredTopics: ScoredTopic[]): RoutineTopic[] {
  return scoredTopics.map(t => ({
    topic: t.topic,
    score: t.score,
    board: t.board,
    rollupSentence: `${t.board || "The board"} discussed ${t.topic.toLowerCase()}${t.keyPoints.length > 0 ? ` — ${t.keyPoints[0].toLowerCase()}` : ""}.`,
  }));
}

export async function generateSummary(
  highScoringTopics: ScoredTopic[],
  routineRollup: RoutineTopic[],
  town: string
): Promise<string> {
  const highTopicText = highScoringTopics.map((t, i) => {
    const ctx = t.historicalContext ? `\n   Historical context: ${t.historicalContext}` : "";
    return `${i + 1}. "${t.topic}" (Score: ${t.score}/10, Board: ${t.board || "unknown"})
   Key points: ${t.keyPoints.join("; ")}${ctx}`;
  }).join("\n\n");

  const routineText = routineRollup.map(r => `- ${r.rollupSentence}`).join("\n");

  const prompt = `ROLE: You are a wire-service reporter for a New Hampshire municipal affairs desk. You write like the Associated Press covers city council meetings: flat, factual, zero editorial voice. You are not a storyteller, commentator, or newsletter writer.

ABSOLUTE PROHIBITIONS — violating any of these is a failure:
1. No exclamation marks anywhere in the output, including headers/titles
2. No rhetorical questions of any kind
3. No conversational openers or closers: "Let's dive in," "Here's what you need to know," "What does this mean for you?," "Big news," "Stay tuned," "In a nutshell," "The bottom line," "Looking ahead"
4. No subjective/editorial adjectives: "exciting," "impressive," "concerning," "remarkable," "important," "significant," "notable," "dramatic," "key," "major," "groundbreaking," "controversial"
5. No narrative flair: "In a move that...," "After months of...," "Residents may be surprised to learn..."
6. No first or second person: no "we," "you," "your," "our"
7. No informal contractions in prose: "it's," "they're," "don't" — use "it is," "they are," "do not"
8. No headers or titles containing the town name with an exclamation mark or casual phrasing

NEGATIVE EXAMPLES (never write anything like these):
- "${town} Update!" or "What's Happening in ${town}"
- "Big changes are coming to ${town}!"
- "Residents should take note of an important vote."
- "In an exciting development, the board approved..."
- "Here's what you need to know about the latest meeting."

POSITIVE EXAMPLES (match this register):
- "The ${town} Select Board approved a $2.1M bond for road repairs at its Feb. 12 meeting."
- "The Planning Board tabled a site-plan review for a proposed 24-unit housing development on Route 16."
- "The vote was 3-2, with members Smith and Doe dissenting."

HIGH-PRIORITY TOPICS:
${highTopicText || "(None — all topics were routine this period)"}

ROUTINE ITEMS:
${routineText || "(None)"}

STRUCTURE REQUIREMENTS:
- Open with the single most consequential action, stated as a declarative sentence with the deciding body, the action, and the date
- One topic per paragraph, 2-4 sentences each
- For each topic: state what was decided, by whom (name the board/committee), the vote count if available, and what changes for residents
- Where context is useful, include a single sentence prefixed with "Why it matters:" — this sentence must be a verifiable fact, not an opinion
- Bold names, dollar figures, vote counts, and dates using markdown **bold**
- End with "Also on the agenda:" followed by routine items compressed into one sentence each
- Target 400-800 words
- Always complete the full summary through the final routine item — do not stop mid-sentence, mid-paragraph, or before the routine items section`;

  try {
    const response = await ai.models.generateContent({
      model: SUMMARY_MODEL,
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      config: { temperature: 0.2, maxOutputTokens: 8192 },
    });

    const summary = response.text || "Unable to generate summary.";
    logInfo(`[contentGeneration] Generated summary for ${town} (${summary.length} chars)`);
    return summary.trim();
  } catch (error) {
    logError(`[contentGeneration] Summary generation failed for ${town}`, { error: String(error) });
    throw error;
  }
}

export async function runContentGenerationPipeline(town: string): Promise<{
  title: string;
  summary: string;
  topics: ScoredTopic[];
  routineTopics: RoutineTopic[];
  sourceMinutesIds: string[];
}> {
  logInfo(`[contentGeneration] Starting pipeline for ${town}`);

  const { topics: rawTopics, sourceMinutesIds } = await extractTopicsFromMinutes(town);

  if (rawTopics.length === 0) {
    return {
      title: `${town} Municipal Update`,
      summary: `No recent meeting minutes were found for ${town} in the last 30 days.`,
      topics: [],
      routineTopics: [],
      sourceMinutesIds,
    };
  }

  const scoredTopics = await judgeStoryWorthiness(rawTopics);

  const highScoring = scoredTopics.filter(t => t.score >= 8);
  const lowScoring = scoredTopics.filter(t => t.score < 8);

  const enrichedHighScoring = highScoring.length > 0
    ? await enrichWithHistoricalContext(highScoring, town)
    : [];

  const routineTopics = formatRoutineRollup(lowScoring);

  const summary = await generateSummary(enrichedHighScoring, routineTopics, town);

  const title = enrichedHighScoring.length > 0
    ? `${town}: ${enrichedHighScoring[0].topic}`
    : `${town} Municipal Update`;

  logInfo(`[contentGeneration] Pipeline complete for ${town}: ${enrichedHighScoring.length} high-scoring, ${routineTopics.length} routine`);

  return {
    title,
    summary,
    topics: enrichedHighScoring,
    routineTopics,
    sourceMinutesIds,
  };
}

export async function scoreArticleRelevancy(
  articles: TownFeedNewsArticle[],
  topics: ScoredTopic[],
  town: string
): Promise<TownFeedNewsArticle[]> {
  if (articles.length === 0) return [];

  const topicSummaries = topics.map((t, i) =>
    `${i + 1}. "${t.topic}" — ${t.keyPoints.slice(0, 3).join("; ")}`
  ).join("\n");

  const articleSummaries = articles.map((a, i) =>
    `${i + 1}. [${a.source}] "${a.title}" — ${a.snippet.slice(0, 200)}`
  ).join("\n");

  const prompt = `You are evaluating the relevancy of news articles to municipal meeting topics from ${town}, New Hampshire.

CRITICAL: Geographic relevance is essential. These topics are specifically about ${town}, NH.

For each article, score how relevant it is to the topics on a scale of 1-10:
- 10: Directly covers the same issue in ${town}, references the same entities/decisions
- 7-9: Strongly related to the same issue in ${town}, provides meaningful additional context
- 4-6: Related topic in the same geographic region (Carroll County, Lakes Region) but not specifically about ${town}
- 1-3: Same general theme (e.g., "police station") but about a DIFFERENT town or unrelated location — these must score low regardless of topic similarity

An article about a police station in Wolfeboro is NOT relevant to a police station topic in ${town}. An article about zoning in Conway is NOT relevant to a zoning topic in ${town}. The town must match for a score of 7 or above.

TOPICS FROM ${town.toUpperCase()} MUNICIPAL MEETINGS:
${topicSummaries}

NEWS ARTICLES TO SCORE:
${articleSummaries}`;

  try {
    const response = await ai.models.generateContent({
      model: MODEL,
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      config: {
        temperature: 0.1,
        responseMimeType: "application/json",
        responseSchema: {
          type: "object" as const,
          properties: {
            scores: {
              type: "array" as const,
              items: {
                type: "object" as const,
                properties: {
                  index: { type: "number" as const },
                  relevancyScore: { type: "number" as const },
                },
                required: ["index", "relevancyScore"],
              },
            },
          },
          required: ["scores"],
        },
      },
    });

    const rawText = response.text || "{}";
    const parsed = JSON.parse(rawText);
    const scores = parsed.scores || [];

    const scored = articles.map((a, i) => {
      const scoreData = scores.find((s: any) => s.index === i + 1);
      return {
        ...a,
        relevancyScore: Math.max(1, Math.min(10, Math.round(scoreData?.relevancyScore ?? 1))),
      };
    });

    scored.sort((a, b) => (b.relevancyScore ?? 0) - (a.relevancyScore ?? 0));

    logInfo(`[contentGeneration] Scored ${scored.length} articles, ${scored.filter(a => (a.relevancyScore ?? 0) >= 7).length} high-relevancy`);
    return scored;
  } catch (error) {
    logError(`[contentGeneration] Article relevancy scoring failed`, { error: String(error) });
    return articles.map(a => ({ ...a, relevancyScore: 1 }));
  }
}

export async function regenerateSummaryWithNews(item: TownFeedItem): Promise<string> {
  const topics = (item.topics || []) as ScoredTopic[];
  const routineTopics = (item.routineTopics || []) as RoutineTopic[];
  const newsArticles = (item.newsArticles || []) as TownFeedNewsArticle[];

  const highScoringTopics = topics.filter(t => t.score >= 8);
  const topArticles = newsArticles
    .filter(a => (a.relevancyScore ?? 0) >= 7)
    .sort((a, b) => (b.relevancyScore ?? 0) - (a.relevancyScore ?? 0))
    .slice(0, 5);

  const highTopicText = highScoringTopics.map((t, i) => {
    const ctx = t.historicalContext ? `\n   Historical context: ${t.historicalContext}` : "";
    return `${i + 1}. "${t.topic}" (Score: ${t.score}/10, Board: ${t.board || "unknown"})
   Key points: ${t.keyPoints.join("; ")}${ctx}`;
  }).join("\n\n");

  const routineText = routineTopics.map(r => `- ${r.rollupSentence}`).join("\n");

  const newsText = topArticles.map((a, i) =>
    `${i + 1}. [${a.source}] "${a.title}" (Relevancy: ${a.relevancyScore}/10)\n   ${a.snippet}`
  ).join("\n\n");

  const prompt = `ROLE: You are a wire-service reporter for a New Hampshire municipal affairs desk. You write like the Associated Press covers city council meetings: flat, factual, zero editorial voice. You are not a storyteller, commentator, or newsletter writer.

ABSOLUTE PROHIBITIONS — violating any of these is a failure:
1. No exclamation marks anywhere in the output, including headers/titles
2. No rhetorical questions of any kind
3. No conversational openers or closers: "Let's dive in," "Here's what you need to know," "What does this mean for you?," "Big news," "Stay tuned," "In a nutshell," "The bottom line," "Looking ahead"
4. No subjective/editorial adjectives: "exciting," "impressive," "concerning," "remarkable," "important," "significant," "notable," "dramatic," "key," "major," "groundbreaking," "controversial"
5. No narrative flair: "In a move that...," "After months of...," "Residents may be surprised to learn..."
6. No first or second person: no "we," "you," "your," "our"
7. No informal contractions in prose: "it's," "they're," "don't" — use "it is," "they are," "do not"
8. No headers or titles containing the town name with an exclamation mark or casual phrasing

NEGATIVE EXAMPLES (never write anything like these):
- "${item.town} Update!" or "What's Happening in ${item.town}"
- "Big changes are coming to ${item.town}!"
- "Residents should take note of an important vote."
- "In an exciting development, the board approved..."
- "Here's what you need to know about the latest meeting."

POSITIVE EXAMPLES (match this register):
- "The ${item.town} Select Board approved a $2.1M bond for road repairs at its Feb. 12 meeting."
- "The Planning Board tabled a site-plan review for a proposed 24-unit housing development on Route 16."
- "The vote was 3-2, with members Smith and Doe dissenting."

HIGH-PRIORITY TOPICS:
${highTopicText || "(None — all topics were routine this period)"}

RELEVANT LOCAL NEWS ARTICLES (incorporate verified facts from these sources only):
${newsText || "(No relevant news articles found)"}

ROUTINE ITEMS:
${routineText || "(None)"}

STRUCTURE REQUIREMENTS:
- Open with the single most consequential action, stated as a declarative sentence with the deciding body, the action, and the date
- One topic per paragraph, 2-4 sentences each
- For each topic: state what was decided, by whom (name the board/committee), the vote count if available, and what changes for residents
- Where context is useful, include a single sentence prefixed with "Why it matters:" — this sentence must be a verifiable fact, not an opinion
- When citing a fact sourced from a news article, attribute it inline: "as reported by the Conway Daily Sun" or "according to the Carroll County Independent" — only attribute facts from news articles, never from meeting minutes
- Bold names, dollar figures, vote counts, and dates using markdown **bold**
- End with "Also on the agenda:" followed by routine items compressed into one sentence each
- Target 400-800 words
- Always complete the full summary through the final routine item — do not stop mid-sentence, mid-paragraph, or before the routine items section`;

  try {
    const response = await ai.models.generateContent({
      model: SUMMARY_MODEL,
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      config: { temperature: 0.2, maxOutputTokens: 8192 },
    });

    const summary = response.text || "Unable to generate summary.";
    logInfo(`[contentGeneration] Regenerated summary with news for ${item.town} (${summary.length} chars, ${topArticles.length} articles incorporated)`);
    return summary.trim();
  } catch (error) {
    logError(`[contentGeneration] Summary regeneration with news failed for ${item.town}`, { error: String(error) });
    throw error;
  }
}
